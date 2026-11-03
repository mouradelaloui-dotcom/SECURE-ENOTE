'use strict';
/**
 * Gestion des notes : saisie (formateur) -> validation (directrice).
 * Le gestionnaire des stagiaires n'intervient pas sur les notes (il gère l'assiduité).
 * Valeurs chiffrées au repos (AES-256-GCM), chaque opération journalisée.
 */
const cryptoSvc = require('../security/crypto');
const { HttpError } = require('../lib/http');

const TYPES = ['CC1', 'CC2', 'CC3', 'EFM'];
const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 0; };
const STATUTS_MODIFIABLES = ['brouillon', 'a_corriger'];

function parseNote(v) {
  if (v === '' || v === null || v === undefined) return null;
  const n = Number(String(v).replace(',', '.'));
  if (!Number.isFinite(n) || n < 0 || n > 20 || Math.abs(Math.round(n * 100) - n * 100) > 1e-6) {
    throw new HttpError(400, `Valeur de note invalide « ${v} » : nombre entre 0 et 20 (2 décimales au plus).`);
  }
  return n;
}

module.exports = function noteRoutes(router, app) {
  const { db } = app;

  const decryptNote = (n) => ({
    ...n, valeur: n.valeur_chiffree ? Number(cryptoSvc.decrypt(n.valeur_chiffree)) : null,
    observation: n.observation_chiffree ? cryptoSvc.decrypt(n.observation_chiffree) : '',
    valeur_chiffree: undefined, observation_chiffree: undefined,
  });

  // Affectations du formateur avec état d'avancement
  router.get('/api/formateur/affectations', app.requirePerm('note.lire_propres'), async (ctx) => {
    const r = await db.query(
      `SELECT g.id AS groupe_id, g.code AS groupe, g.libelle AS groupe_libelle, m.id AS module_id, m.code AS module, m.intitule,
              (SELECT count(*)::int FROM stagiaires s WHERE s.groupe_id=g.id) AS effectif,
              (SELECT coalesce(json_object_agg(statut, n), '{}') FROM (SELECT n.statut, count(*) n FROM notes n JOIN stagiaires s ON s.id=n.stagiaire_id
                 WHERE s.groupe_id=g.id AND n.module_id=m.id GROUP BY n.statut) x) AS notes_par_statut,
              (SELECT coalesce(json_object_agg(statut, n), '{}') FROM (SELECT statut, count(*) n FROM seances se
                 WHERE se.groupe_id=g.id AND se.module_id=m.id AND se.formateur_id=a.formateur_id GROUP BY statut) y) AS seances_par_statut
         FROM affectations a JOIN groupes g ON g.id=a.groupe_id JOIN modules m ON m.id=a.module_id
        WHERE a.formateur_id=$1 ORDER BY g.code, m.code`, [ctx.user.id]);
    return r.rows;
  });

  // Feuille de notes d'un groupe / module / évaluation
  router.get('/api/notes', app.requirePerm('note.lire_propres', 'note.lire_toutes'), async (ctx) => {
    const g = int(ctx.query.groupe_id); const m = int(ctx.query.module_id); const t = String(ctx.query.type_eval || 'CC1');
    if (!g || !m || !TYPES.includes(t)) throw new HttpError(400, 'Paramètres de recherche invalides.');
    await app.checkScope(ctx, g, m);
    const r = await db.query(
      `SELECT s.id AS stagiaire_id, s.cef, s.nom, s.prenom, n.id, n.valeur_chiffree, n.observation_chiffree, n.statut, n.motif_retour,
              n.version, n.modifie_le, ua.nom_complet AS auteur
         FROM stagiaires s
         LEFT JOIN notes n ON n.stagiaire_id=s.id AND n.module_id=$2 AND n.type_eval=$3
         LEFT JOIN utilisateurs ua ON ua.id=n.auteur_id
        WHERE s.groupe_id=$1 ORDER BY s.nom, s.prenom`, [g, m, t]);
    const meta = await db.query(
      'SELECT g.code AS groupe, g.libelle, m.code AS module, m.intitule FROM groupes g, modules m WHERE g.id=$1 AND m.id=$2', [g, m]);
    return { ...meta.rows[0], type_eval: t, lignes: r.rows.map(decryptNote) };
  });

  // Enregistrement (brouillon) d'une feuille de notes
  router.put('/api/notes', app.requirePerm('note.saisir'), async (ctx) => {
    const g = int(ctx.body.groupe_id); const m = int(ctx.body.module_id); const t = String(ctx.body.type_eval || '');
    const lignes = Array.isArray(ctx.body.notes) ? ctx.body.notes.slice(0, 80) : [];
    if (!g || !m || !TYPES.includes(t)) throw new HttpError(400, 'Paramètres invalides.');
    await app.checkScope(ctx, g, m);
    const stagiairesGroupe = new Set((await db.query('SELECT id FROM stagiaires WHERE groupe_id=$1', [g])).rows.map((r) => r.id));
    let creees = 0; let modifiees = 0; let ignorees = 0;
    for (const l of lignes) {
      const sid = int(l.stagiaire_id);
      if (!stagiairesGroupe.has(sid)) await app.denied(ctx, `stagiaire:${sid}`, 'stagiaire hors du groupe');
      const valeur = parseNote(l.valeur);
      const obs = String(l.observation || '').slice(0, 300);
      if (valeur === null) continue;
      await db.tx(async (c) => {
        const ex = (await c.query('SELECT * FROM notes WHERE stagiaire_id=$1 AND module_id=$2 AND type_eval=$3 FOR UPDATE', [sid, m, t])).rows[0];
        const audit = require('../security/audit');
        if (!ex) {
          const r = await c.query(
            `INSERT INTO notes (stagiaire_id, module_id, type_eval, valeur_chiffree, observation_chiffree, auteur_id)
             VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`, [sid, m, t, cryptoSvc.encrypt(valeur.toFixed(2)), obs ? cryptoSvc.encrypt(obs) : null, ctx.user.id]);
          await audit.append(c, { acteur: ctx.user, action: 'note.saisie', ressource: `note:${r.rows[0].id}`, ip: ctx.ip,
            details: { stagiaire: sid, module: m, evaluation: t, valeur: cryptoSvc.encrypt(valeur.toFixed(2)) } });
          creees++;
          return;
        }
        const avant = Number(cryptoSvc.decrypt(ex.valeur_chiffree));
        const obsAvant = ex.observation_chiffree ? cryptoSvc.decrypt(ex.observation_chiffree) : '';
        if (avant === valeur && obsAvant === obs) return;
        if (!STATUTS_MODIFIABLES.includes(ex.statut)) { ignorees++; return; } // note soumise/validée : verrouillée
        await c.query(
          `UPDATE notes SET valeur_chiffree=$2, observation_chiffree=$3, version=version+1, modifie_le=now(), auteur_id=$4 WHERE id=$1`,
          [ex.id, cryptoSvc.encrypt(valeur.toFixed(2)), obs ? cryptoSvc.encrypt(obs) : null, ctx.user.id]);
        await audit.append(c, { acteur: ctx.user, action: 'note.modification', ressource: `note:${ex.id}`, ip: ctx.ip,
          details: { avant: cryptoSvc.encrypt(avant.toFixed(2)), apres: cryptoSvc.encrypt(valeur.toFixed(2)), version: ex.version + 1 } });
        modifiees++;
      });
    }
    return { creees, modifiees, ignorees };
  });

  // Soumission d'une feuille complète à la direction
  router.post('/api/notes/soumettre', app.requirePerm('note.soumettre'), async (ctx) => {
    const g = int(ctx.body.groupe_id); const m = int(ctx.body.module_id); const t = String(ctx.body.type_eval || '');
    if (!g || !m || !TYPES.includes(t)) throw new HttpError(400, 'Paramètres invalides.');
    await app.checkScope(ctx, g, m);
    const r = await db.query(
      `SELECT count(s.id)::int AS effectif, count(n.id)::int AS saisies,
              count(n.id) FILTER (WHERE n.statut IN ('brouillon','a_corriger'))::int AS a_soumettre
         FROM stagiaires s LEFT JOIN notes n ON n.stagiaire_id=s.id AND n.module_id=$2 AND n.type_eval=$3 WHERE s.groupe_id=$1`, [g, m, t]);
    const st = r.rows[0];
    if (st.saisies < st.effectif) throw new HttpError(400, `Feuille incomplète : ${st.effectif - st.saisies} stagiaire(s) sans note.`);
    if (!st.a_soumettre) throw new HttpError(409, 'Aucune note à soumettre (déjà soumises ou validées).');
    await db.tx(async (c) => {
      await c.query(
        `UPDATE notes SET statut='soumise', motif_retour=NULL, modifie_le=now() WHERE module_id=$2 AND type_eval=$3
            AND statut IN ('brouillon','a_corriger') AND stagiaire_id IN (SELECT id FROM stagiaires WHERE groupe_id=$1)`, [g, m, t]);
      await require('../security/audit').append(c, { acteur: ctx.user, action: 'note.soumission', ressource: `lot:${g}/${m}/${t}`, ip: ctx.ip, details: { notes: st.a_soumettre } });
    });
    return { soumises: st.a_soumettre };
  });

  // ---------- Validation (directrice) : une seule étape après la soumission du formateur
  const etapes = {
    'note.valider': { depuis: 'soumise', vers: 'validee', action: 'note.validation', colonne: 'validateur_id' },
  };
  const etapeDe = () => etapes['note.valider'];

  router.get('/api/validation/notes', app.requirePerm('note.valider'), async (ctx) => {
    const e = etapeDe(ctx);
    const r = await db.query(
      `SELECT g.id AS groupe_id, g.code AS groupe, m.id AS module_id, m.code AS module, m.intitule, n.type_eval,
              count(*)::int AS nb, max(n.modifie_le) AS soumis_le, string_agg(DISTINCT u.nom_complet, ', ') AS formateurs,
              json_agg(n.valeur_chiffree) AS valeurs
         FROM notes n JOIN stagiaires s ON s.id=n.stagiaire_id JOIN groupes g ON g.id=s.groupe_id
         JOIN modules m ON m.id=n.module_id JOIN utilisateurs u ON u.id=n.auteur_id
        WHERE n.statut=$1 GROUP BY g.id, g.code, m.id, m.code, m.intitule, n.type_eval ORDER BY soumis_le`, [e.depuis]);
    return {
      etape: e.depuis,
      lots: r.rows.map((l) => {
        const vals = l.valeurs.map((x) => Number(cryptoSvc.decrypt(x)));
        return { ...l, valeurs: undefined, moyenne: vals.reduce((a, b) => a + b, 0) / vals.length, min: Math.min(...vals), max: Math.max(...vals) };
      }),
    };
  });

  router.post('/api/validation/notes', app.requirePerm('note.valider'), async (ctx) => {
    const e = etapeDe(ctx);
    const g = int(ctx.body.groupe_id); const m = int(ctx.body.module_id); const t = String(ctx.body.type_eval || '');
    const decision = ctx.body.decision; const motif = String(ctx.body.motif || '').trim().slice(0, 300);
    if (!g || !m || !TYPES.includes(t) || !['approuver', 'renvoyer'].includes(decision)) throw new HttpError(400, 'Paramètres invalides.');
    if (decision === 'renvoyer' && motif.length < 10) throw new HttpError(400, 'Un motif d\'au moins 10 caractères est obligatoire pour un renvoi.');
    const ids = await db.query(
      `SELECT n.id, n.auteur_id, n.stagiaire_id FROM notes n JOIN stagiaires s ON s.id=n.stagiaire_id
        WHERE s.groupe_id=$1 AND n.module_id=$2 AND n.type_eval=$3 AND n.statut=$4`, [g, m, t, e.depuis]);
    if (!ids.rows.length) throw new HttpError(409, 'Ce lot n\'est plus en attente à votre étape (déjà traité ?).');
    if (ids.rows.some((x) => x.auteur_id === ctx.user.id)) await app.denied(ctx, `lot:${g}/${m}/${t}`, 'séparation des tâches : auteur et validateur identiques');
    const vers = decision === 'approuver' ? e.vers : 'a_corriger';
    await db.tx(async (c) => {
      await c.query(
        `UPDATE notes SET statut=$2, motif_retour=$3, ${e.colonne}=$4, modifie_le=now(), valide_le = CASE WHEN $2='validee' THEN now() ELSE valide_le END
          WHERE id IN (SELECT jsonb_array_elements_text($1::jsonb)::int)`, [ids.rows.map((x) => x.id), vers, decision === 'renvoyer' ? motif : null, ctx.user.id]);
      await require('../security/audit').append(c, { acteur: ctx.user, action: decision === 'approuver' ? e.action : 'note.retour_correction',
        ressource: `lot:${g}/${m}/${t}`, ip: ctx.ip, details: { notes: ids.rows.length, motif: motif || undefined } });
    });
    const lib = (await db.query('SELECT g.code g, m.code m, m.intitule i FROM groupes g, modules m WHERE g.id=$1 AND m.id=$2', [g, m])).rows[0];
    if (vers === 'validee') {
      // Publication : le stagiaire et ses parents sont prévenus (sans la note, visible seulement après connexion)
      await app.notifyFamille(ids.rows.map((x) => x.stagiaire_id), 'info',
        () => `Nouvelle note publiée : ${lib.m} — ${lib.i} (${t}). Consultez « Mes notes ».`,
        (x) => `Nouvelle note publiée pour ${x.prenom} ${x.nom} : ${lib.m} — ${lib.i} (${t}).`);
    }
    for (const a of new Set(ids.rows.map((x) => x.auteur_id))) {
      await app.notify(a, decision === 'approuver' ? 'info' : 'retour', decision === 'approuver'
        ? `Les notes ${t} du groupe ${lib.g} (${lib.m}) ont été validées par la direction.`
        : `Les notes ${t} du groupe ${lib.g} (${lib.m}) vous ont été renvoyées pour correction : ${motif}`);
    }
    return { traitees: ids.rows.length, statut: vers };
  });

  // ---------- Modification exceptionnelle d'une note validée (administrateur, motif obligatoire)
  router.get('/api/admin/notes-validees', app.requirePerm('note.modifier_apres_validation'), async (ctx) => {
    const q = String(ctx.query.q || '').trim().slice(0, 40);
    const r = await db.query(
      `SELECT n.id, n.type_eval, n.valeur_chiffree, n.version, n.valide_le, s.cef, s.nom, s.prenom, g.code AS groupe, m.code AS module
         FROM notes n JOIN stagiaires s ON s.id=n.stagiaire_id JOIN groupes g ON g.id=s.groupe_id JOIN modules m ON m.id=n.module_id
        WHERE n.statut='validee' AND ($1 = '' OR s.nom ILIKE '%'||$1||'%' OR s.cef = $1 OR g.code ILIKE $1)
        ORDER BY g.code, m.code, n.type_eval, s.nom LIMIT 60`, [q]);
    return r.rows.map((n) => ({ ...n, valeur: Number(cryptoSvc.decrypt(n.valeur_chiffree)), valeur_chiffree: undefined }));
  });

  router.post('/api/admin/notes/:id/modifier', app.requirePerm('note.modifier_apres_validation'), async (ctx) => {
    const id = int(ctx.params.id); const valeur = parseNote(ctx.body.valeur);
    const motif = String(ctx.body.motif || '').trim().slice(0, 300);
    if (valeur === null) throw new HttpError(400, 'Valeur obligatoire.');
    if (motif.length < 15) throw new HttpError(400, 'Le motif est obligatoire (15 caractères minimum) : il sera consigné dans le journal d\'audit.');
    const n = (await db.query('SELECT * FROM notes WHERE id=$1 AND statut=\'validee\'', [id])).rows[0];
    if (!n) throw new HttpError(404, 'Note validée introuvable.');
    const avant = cryptoSvc.decrypt(n.valeur_chiffree);
    await db.tx(async (c) => {
      await c.query('UPDATE notes SET valeur_chiffree=$2, version=version+1, modifie_le=now() WHERE id=$1', [id, cryptoSvc.encrypt(valeur.toFixed(2))]);
      await require('../security/audit').append(c, { acteur: ctx.user, action: 'note.modification_post_validation', ressource: `note:${id}`, ip: ctx.ip,
        details: { avant: cryptoSvc.encrypt(avant), apres: cryptoSvc.encrypt(valeur.toFixed(2)), motif } });
    });
    const mod = (await db.query('SELECT code FROM modules WHERE id=$1', [n.module_id])).rows[0];
    await app.notifyFamille([n.stagiaire_id], 'securite',
      () => `Une note publiée (${mod.code} — ${n.type_eval}) a été corrigée par l'administration de l'établissement.`,
      (x) => `Une note publiée de ${x.prenom} ${x.nom} (${mod.code} — ${n.type_eval}) a été corrigée par l'administration de l'établissement.`);
    const dirs = await db.query('SELECT id FROM utilisateurs WHERE role=\'directeur\' AND statut=\'actif\'');
    for (const d of [...dirs.rows.map((x) => x.id), n.auteur_id]) {
      await app.notify(d, 'securite', `Une note validée (n° ${id}) a été modifiée par l'administrateur. Motif : ${motif}`);
    }
    return { ok: true };
  });
};
