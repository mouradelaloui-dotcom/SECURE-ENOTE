'use strict';
/**
 * Sauvegardes et continuité de service (H5).
 * - pg_dump complet, chiffré AES-256-GCM (clé dérivée dédiée), empreinte SHA-256 ;
 * - ancrage de la dernière empreinte du journal d'audit dans chaque sauvegarde ;
 * - planification périodique (RPO cible ≤ 4 h), rétention, vérification de restaurabilité.
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const config = require('../config');
const cryptoSvc = require('../security/crypto');

function dump() {
  return new Promise((resolve, reject) => {
    const env = { ...process.env, PGPASSWORD: config.db.password };
    const p = spawn(config.backup.pgDump, ['-h', config.db.host, '-p', String(config.db.port), '-U', config.db.user,
      '-d', config.db.database, '--no-owner', '--no-privileges', '--format=plain'], { env });
    const chunks = []; let err = '';
    p.stdout.on('data', (d) => chunks.push(d));
    p.stderr.on('data', (d) => { err += d; });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error('pg_dump : ' + err.trim()))));
  });
}

async function createBackup(db, declencheur = 'planifiee') {
  const started = Date.now();
  fs.mkdirSync(config.backup.dir, { recursive: true, mode: 0o700 });
  const head = (await db.query('SELECT hash FROM journal_audit ORDER BY id DESC LIMIT 1')).rows[0]?.hash || null;
  const plain = await dump();
  const enc = cryptoSvc.encryptBuffer(Buffer.concat([Buffer.from(`-- ancrage_journal: ${head}\n`), plain]));
  const name = `enote-${new Date().toISOString().replace(/[:.]/g, '-')}.sql.enc`;
  fs.writeFileSync(path.join(config.backup.dir, name), enc, { mode: 0o600 });
  const r = await db.query(
    `INSERT INTO sauvegardes (fichier, taille, sha256, hash_journal, declencheur, duree_ms) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
    [name, enc.length, cryptoSvc.sha256(enc), head, declencheur, Date.now() - started]);
  await applyRetention(db);
  return r.rows[0];
}

async function applyRetention(db) {
  const all = fs.readdirSync(config.backup.dir).filter((f) => f.endsWith('.sql.enc')).sort();
  for (const f of all.slice(0, Math.max(0, all.length - config.backup.retention))) fs.unlinkSync(path.join(config.backup.dir, f));
  return db;
}

/** Vérifie l'intégrité (SHA-256), le déchiffrement (tag GCM) et la complétude du dump. */
async function verifyBackup(db, id) {
  const b = (await db.query('SELECT * FROM sauvegardes WHERE id=$1', [id])).rows[0];
  if (!b) return null;
  const started = Date.now();
  const res = { id, fichier: b.fichier, etapes: [] };
  try {
    const file = path.join(config.backup.dir, path.basename(b.fichier));
    if (!fs.existsSync(file)) throw new Error('Fichier absent (rétention ou suppression)');
    const enc = fs.readFileSync(file);
    const okHash = cryptoSvc.sha256(enc) === b.sha256;
    res.etapes.push({ etape: 'Empreinte SHA-256 du fichier', ok: okHash });
    if (!okHash) throw new Error('Empreinte différente : fichier altéré');
    const plain = cryptoSvc.decryptBuffer(enc).toString('utf8');
    res.etapes.push({ etape: 'Déchiffrement authentifié AES-256-GCM', ok: true });
    const complet = plain.includes('PostgreSQL database dump complete');
    res.etapes.push({ etape: 'Complétude du dump PostgreSQL', ok: complet });
    const tables = ['notes', 'seances', 'journal_audit', 'utilisateurs'].every((t) => plain.includes(`CREATE TABLE public.${t}`));
    res.etapes.push({ etape: 'Présence des tables critiques', ok: tables });
    const ancre = plain.startsWith(`-- ancrage_journal: ${b.hash_journal}`);
    res.etapes.push({ etape: 'Ancrage de l\'empreinte du journal d\'audit', ok: ancre });
    res.ok = okHash && complet && tables && ancre;
  } catch (e) {
    res.ok = false; res.erreur = e.message;
  }
  res.duree_ms = Date.now() - started;
  await db.query('UPDATE sauvegardes SET verifiee_le=now(), verification_ok=$2 WHERE id=$1', [id, res.ok]);
  return res;
}

function schedule(db, onError) {
  const ms = config.backup.intervalHours * 3600 * 1000;
  if (!(ms > 0)) return null;
  return setInterval(() => createBackup(db, 'planifiee').catch(onError), ms).unref();
}

module.exports = { createBackup, verifyBackup, schedule };
