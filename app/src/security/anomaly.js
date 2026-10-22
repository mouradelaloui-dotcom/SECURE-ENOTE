'use strict';
/**
 * Moteur de détection d'anomalies (H3).
 * Analyse en continu chaque entrée du journal d'audit et applique des règles
 * paramétrables (seuils, corrélations temporelles) + une règle statistique
 * (z-score sur l'activité horaire de l'utilisateur).
 */
const audit = require('./audit');
const config = require('../config');

const DEFAULT_RULES = [
  { code: 'echecs_authentification', libelle: 'Échecs d\'authentification répétés', severite: 'critique',
    description: 'Plus de N échecs de connexion (mot de passe ou code MFA) pour un même compte sur une fenêtre de M minutes : force brute ou vol d\'identifiants probable.',
    parametres: { seuil: 5, fenetre_minutes: 15 } },
  { code: 'connexion_hors_plage', libelle: 'Connexion hors plage horaire', severite: 'information',
    description: 'Connexion réussie en dehors de la plage horaire habituelle de travail.',
    parametres: { debut: '07:00', fin: '19:00', jours_ouvres: [1, 2, 3, 4, 5, 6] } },
  { code: 'volume_modifications', libelle: 'Volume anormal de saisies/modifications', severite: 'avertissement',
    description: 'Plus de N saisies ou modifications de notes par un même utilisateur sur une fenêtre de M minutes.',
    parametres: { seuil: 20, fenetre_minutes: 10 } },
  { code: 'acces_refuses', libelle: 'Tentatives d\'accès non autorisé', severite: 'critique',
    description: 'Plus de N refus d\'accès (permission ou périmètre) pour un même utilisateur en M minutes : tentative d\'élévation de privilèges ou de manipulation d\'URL.',
    parametres: { seuil: 3, fenetre_minutes: 10 } },
  { code: 'nouvel_appareil', libelle: 'Connexion depuis un appareil inconnu', severite: 'information',
    description: 'Première connexion d\'un compte depuis un couple adresse IP / navigateur jamais vu. L\'utilisateur est également notifié.',
    parametres: {} },
  { code: 'modification_apres_validation', libelle: 'Modification d\'une note validée', severite: 'avertissement',
    description: 'Toute modification d\'une note déjà validée par la direction (action exceptionnelle à revue systématique).',
    parametres: {} },
  { code: 'activite_atypique', libelle: 'Activité statistiquement atypique', severite: 'avertissement',
    description: 'Le nombre d\'actions de l\'utilisateur sur la dernière heure dépasse sa moyenne horaire historique de plus de Z écarts-types (z-score).',
    parametres: { z: 3, historique_min_heures: 10, minimum_actions: 15 } },
  { code: 'integrite_journal', libelle: 'Rupture d\'intégrité du journal', severite: 'critique',
    description: 'La vérification périodique de la chaîne d\'empreintes du journal d\'audit a détecté une altération.',
    parametres: { verification_minutes: 60 } },
];

let db = null;
let rulesCache = null; let rulesAt = 0;

async function rules() {
  if (!rulesCache || Date.now() - rulesAt > 5000) {
    const r = await db.query('SELECT * FROM regles_detection');
    rulesCache = Object.fromEntries(r.rows.map((x) => [x.code, x]));
    rulesAt = Date.now();
  }
  return rulesCache;
}
function invalidate() { rulesCache = null; }

async function raise(rule, { titre, utilisateur_id = null, details = {}, dedupMinutes = 15 }) {
  const dup = await db.query(
    `SELECT id FROM alertes WHERE regle=$1 AND statut='nouvelle' AND utilisateur_id IS NOT DISTINCT FROM $2
       AND cree_le > now() - ($3 || ' minutes')::interval LIMIT 1`, [rule.code, utilisateur_id, String(dedupMinutes)]);
  if (dup.rows.length) return null;
  const r = await db.query(
    'INSERT INTO alertes (regle, severite, titre, utilisateur_id, details) VALUES ($1,$2,$3,$4,$5) RETURNING *',
    [rule.code, rule.severite, titre, utilisateur_id, details]);
  return r.rows[0];
}

function localTime(iso) {
  const parts = new Intl.DateTimeFormat('fr-FR', {
    timeZone: config.timezone, hour: '2-digit', minute: '2-digit', weekday: 'short', hour12: false,
  }).formatToParts(new Date(iso));
  const get = (t) => parts.find((p) => p.type === t)?.value;
  const days = { lun: 1, mar: 2, mer: 3, jeu: 4, ven: 5, sam: 6, dim: 0 };
  return { hhmm: `${get('hour')}:${get('minute')}`, jour: days[String(get('weekday')).replace('.', '')] };
}

async function countRecent(actions, { acteur_id, acteur_login }, minutes) {
  const r = await db.query(
    `SELECT count(*)::int AS n FROM journal_audit
      WHERE action IN (SELECT jsonb_array_elements_text($1::jsonb)) AND (acteur_id = $2 OR ($2::int IS NULL AND acteur_login = $3))
        AND horodatage > $4`,
    [actions, acteur_id ?? null, acteur_login, new Date(Date.now() - minutes * 60000).toISOString()]);
  return r.rows[0].n;
}

/** Analyse d'une entrée du journal (appelée après chaque ajout). */
async function analyse(e) {
  const R = await rules();
  const on = (code) => R[code] && R[code].active;
  const out = [];

  if ((e.action === 'auth.echec_mot_de_passe' || e.action === 'auth.echec_mfa') && on('echecs_authentification')) {
    const p = R.echecs_authentification.parametres;
    const n = await countRecent(['auth.echec_mot_de_passe', 'auth.echec_mfa'], e, p.fenetre_minutes);
    if (n >= p.seuil) {
      out.push(await raise(R.echecs_authentification, {
        titre: `${n} échecs d'authentification en ${p.fenetre_minutes} min — compte « ${e.acteur_login} »`,
        utilisateur_id: e.acteur_id, details: { echecs: n, ip: e.ip, compte: e.acteur_login }, dedupMinutes: p.fenetre_minutes,
      }));
    }
  }

  if (e.action === 'auth.connexion') {
    // Les stagiaires et les parents consultent légitimement le soir et le week-end : la règle vise le personnel.
    if (on('connexion_hors_plage') && !['stagiaire', 'parent'].includes(e.acteur_role)) {
      const p = R.connexion_hors_plage.parametres;
      const t = localTime(e.horodatage);
      const horsJour = Array.isArray(p.jours_ouvres) && !p.jours_ouvres.includes(t.jour);
      if (horsJour || t.hhmm < p.debut || t.hhmm >= p.fin) {
        out.push(await raise(R.connexion_hors_plage, {
          titre: `Connexion de « ${e.acteur_login} » à ${t.hhmm}, hors plage ${p.debut}–${p.fin}${horsJour ? ' (jour non ouvré)' : ''}`,
          utilisateur_id: e.acteur_id, details: { heure_locale: t.hhmm, ip: e.ip }, dedupMinutes: 60,
        }));
      }
    }
    if (on('nouvel_appareil') && e.details?.nouvel_appareil) {
      out.push(await raise(R.nouvel_appareil, {
        titre: `Première connexion de « ${e.acteur_login} » depuis un appareil inconnu (${e.details.appareil || e.ip})`,
        utilisateur_id: e.acteur_id, details: { ip: e.ip, appareil: e.details.appareil }, dedupMinutes: 1,
      }));
    }
  }

  if (['note.saisie', 'note.modification', 'note.modification_post_validation'].includes(e.action) && on('volume_modifications')) {
    const p = R.volume_modifications.parametres;
    const n = await countRecent(['note.saisie', 'note.modification', 'note.modification_post_validation'], e, p.fenetre_minutes);
    if (n > p.seuil) {
      out.push(await raise(R.volume_modifications, {
        titre: `Volume anormal : ${n} saisies/modifications de notes en ${p.fenetre_minutes} min par « ${e.acteur_login} »`,
        utilisateur_id: e.acteur_id, details: { operations: n, seuil: p.seuil }, dedupMinutes: p.fenetre_minutes,
      }));
    }
  }

  if (e.action === 'acces.refuse' && on('acces_refuses')) {
    const p = R.acces_refuses.parametres;
    const n = await countRecent(['acces.refuse'], e, p.fenetre_minutes);
    if (n >= p.seuil) {
      out.push(await raise(R.acces_refuses, {
        titre: `${n} tentatives d'accès non autorisé par « ${e.acteur_login} » (${e.acteur_role})`,
        utilisateur_id: e.acteur_id, details: { refus: n, derniere_ressource: e.ressource }, dedupMinutes: p.fenetre_minutes,
      }));
    }
  }

  if (e.action === 'note.modification_post_validation' && on('modification_apres_validation')) {
    out.push(await raise(R.modification_apres_validation, {
      titre: `Note validée modifiée par « ${e.acteur_login} » — motif : ${e.details?.motif || '?'}`,
      utilisateur_id: e.acteur_id, details: { ressource: e.ressource, motif: e.details?.motif }, dedupMinutes: 0,
    }));
  }

  if (e.acteur_id && on('activite_atypique') && !e.action.startsWith('auth.')) {
    const p = R.activite_atypique.parametres;
    const r = await db.query(
      `WITH h AS (
         SELECT date_trunc('hour', horodatage::timestamptz) AS heure, count(*) AS n FROM journal_audit
          WHERE acteur_id=$1 AND horodatage::timestamptz > now() - interval '30 days'
            AND horodatage::timestamptz < date_trunc('hour', now()) GROUP BY 1)
       SELECT count(*)::int AS heures, coalesce(avg(n),0)::float AS moyenne, coalesce(stddev_pop(n),0)::float AS ecart,
              (SELECT count(*)::int FROM journal_audit WHERE acteur_id=$1 AND horodatage::timestamptz > now() - interval '1 hour') AS courant
         FROM h`, [e.acteur_id]);
    const s = r.rows[0];
    if (s.heures >= p.historique_min_heures && s.courant >= p.minimum_actions) {
      const z = (s.courant - s.moyenne) / Math.max(s.ecart, 1);
      if (z > p.z) {
        out.push(await raise(R.activite_atypique, {
          titre: `Activité atypique de « ${e.acteur_login} » : ${s.courant} actions/h (moyenne ${s.moyenne.toFixed(1)}, z = ${z.toFixed(1)})`,
          utilisateur_id: e.acteur_id, details: { courant: s.courant, moyenne: s.moyenne, ecart_type: s.ecart, z }, dedupMinutes: 60,
        }));
      }
    }
  }
  return out.filter(Boolean);
}

/** Vérification périodique de l'intégrité du journal. */
async function periodicIntegrityCheck() {
  const R = await rules();
  const res = await audit.verifyChain(db);
  if (!res.integre && R.integrite_journal?.active) {
    await raise(R.integrite_journal, {
      titre: `Intégrité du journal d'audit compromise à l'entrée n° ${res.rupture}`,
      details: res, dedupMinutes: 60 * 24,
    });
  }
  return res;
}

let pending = Promise.resolve();
function start(database, onError) {
  db = database;
  audit.events.on('entry', (e) => {
    // traitement séquentiel pour des comptages cohérents
    pending = pending.then(() => analyse(e)).catch(onError);
  });
}
const idle = () => pending;

module.exports = { DEFAULT_RULES, start, analyse, periodicIntegrityCheck, invalidate, idle, raise };
