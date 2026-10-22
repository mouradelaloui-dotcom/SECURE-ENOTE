'use strict';
/**
 * Journal d'audit chaîné (H2) — non-répudiation et détection d'altération.
 * Chaque entrée contient l'empreinte SHA-256 de l'entrée précédente ; l'empreinte
 * de l'entrée courante couvre l'ensemble de ses champs + l'empreinte précédente.
 * Toute modification, suppression ou insertion rétroactive rompt la chaîne.
 *
 * Défense en profondeur :
 *  1. le compte applicatif n'a que les droits SELECT/INSERT sur la table ;
 *  2. un déclencheur PostgreSQL refuse UPDATE/DELETE ;
 *  3. la chaîne d'empreintes détecte une altération faite en contournant 1 et 2
 *     (ex. administrateur de base de données malveillant) ;
 *  4. la dernière empreinte est ancrée dans chaque sauvegarde.
 */
const { EventEmitter } = require('node:events');
const { sha256 } = require('./crypto');

const GENESIS = '0'.repeat(64);
const events = new EventEmitter();

/** Sérialisation canonique (clés triées) : indépendante de l'ordre JSONB. */
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function computeHash(e) {
  return sha256(canonical({
    horodatage: e.horodatage, acteur_id: e.acteur_id ?? null, acteur_login: e.acteur_login,
    acteur_role: e.acteur_role ?? null, action: e.action, ressource: e.ressource ?? null,
    details: e.details || {}, ip: e.ip ?? null, hash_precedent: e.hash_precedent,
  }));
}

/**
 * Ajoute une entrée. `client` doit être une transaction ouverte (pool.tx) afin
 * que l'opération métier et sa trace soient atomiques.
 */
async function append(client, { acteur, action, ressource = null, details = {}, ip = null, at = null }) {
  await client.query('SELECT pg_advisory_xact_lock(7340001)'); // sérialise l'écriture de la chaîne
  const last = await client.query('SELECT hash FROM journal_audit ORDER BY id DESC LIMIT 1');
  const entry = {
    horodatage: at ? new Date(at).toISOString() : new Date().toISOString(), // `at` : réservé à l'initialisation
    acteur_id: acteur?.id ?? null,
    acteur_login: acteur?.login || 'anonyme',
    acteur_role: acteur?.role ?? null,
    action, ressource, ip,
    details: JSON.parse(JSON.stringify(details || {})), // forme exacte stockée en JSONB (clés « undefined » retirées)
    hash_precedent: last.rows[0]?.hash || GENESIS,
  };
  entry.hash = computeHash(entry);
  const r = await client.query(
    `INSERT INTO journal_audit (horodatage, acteur_id, acteur_login, acteur_role, action, ressource, details, ip, hash_precedent, hash)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [entry.horodatage, entry.acteur_id, entry.acteur_login, entry.acteur_role, action, ressource, entry.details, ip, entry.hash_precedent, entry.hash]);
  entry.id = r.rows[0].id;
  // Notification du moteur de détection après validation de la transaction
  const emit = () => setImmediate(() => events.emit('entry', entry));
  if (client.afterCommit) client.afterCommit(emit); else emit();
  return entry;
}

/** Raccourci : trace isolée dans sa propre transaction. */
async function log(db, data) { return db.tx((c) => append(c, data)); }

/** Vérifie l'intégralité de la chaîne. */
async function verifyChain(db) {
  const started = Date.now();
  let prev = GENESIS; let lastId = 0; let count = 0;
  for (;;) {
    const r = await db.query('SELECT * FROM journal_audit WHERE id > $1 ORDER BY id LIMIT 2000', [lastId]);
    if (!r.rows.length) break;
    for (const e of r.rows) {
      count++;
      if (e.hash_precedent !== prev) {
        return { integre: false, entrees: count, rupture: e.id, raison: 'Chaînage rompu : une entrée précédente a été supprimée ou insérée', duree_ms: Date.now() - started };
      }
      if (computeHash(e) !== e.hash) {
        return { integre: false, entrees: count, rupture: e.id, raison: 'Empreinte invalide : le contenu de l\'entrée a été modifié', duree_ms: Date.now() - started };
      }
      prev = e.hash; lastId = e.id;
    }
  }
  return { integre: true, entrees: count, derniere_empreinte: prev, duree_ms: Date.now() - started };
}

module.exports = { append, log, verifyChain, computeHash, canonical, events, GENESIS };
