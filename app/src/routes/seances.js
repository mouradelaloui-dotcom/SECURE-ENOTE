'use strict';
/** Déclaration des séances (formateur) et validation par la direction (circuit en deux étapes). */
const cryptoSvc = require('../security/crypto');
const audit = require('../security/audit');
const { HttpError } = require('../lib/http');

const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 0; };
const HEURE = /^([01]\d|2[0-3]):[0-5]\d$/;

module.exports = function seanceRoutes(router, app) {
  const { db } = app;

  const decrypt = (s) => ({ ...s, contenu: cryptoSvc.decrypt(s.contenu_chiffre), contenu_chiffre: undefined });

  const SELECT = `SELECT se.*, g.code AS groupe, m.code AS module, m.intitule, u.nom_complet AS formateur,
                         (SELECT count(*)::int FROM stagiaires s WHERE s.groupe_id=se.groupe_id) AS effectif
                    FROM seances se JOIN groupes g ON g.id=se.groupe_id JOIN modules m ON m.id=se.module_id
                    JOIN utilisateurs u ON u.id=se.formateur_id`;

  router.get('/api/seances', app.requirePerm('seance.lire_propres', 'seance.lire_toutes'), async (ctx) => {
    const toutes = app.can(ctx, 'seance.lire_toutes');
    const r = await db.query(`${SELECT} WHERE ($1::boolean OR se.formateur_id=$2) ORDER BY se.date_seance DESC, se.id DESC LIMIT 100`, [toutes, ctx.user.id]);
    return r.rows.map(decrypt);
  });

  router.get('/api/seances/:id', app.requirePerm('seance.lire_propres', 'seance.lire_toutes'), async (ctx) => {
    const r = await db.query(`${SELECT} WHERE se.id=$1`, [int(ctx.params.id)]);
    const s = r.rows[0];
    if (!s) throw new HttpError(404, 'Séance introuvable.');
    if (!app.can(ctx, 'seance.lire_toutes') && s.formateur_id !== ctx.user.id) await app.denied(ctx, `seance:${s.id}`, 'séance d\'un autre formateur');
    const stag = await db.query('SELECT id, cef, nom, prenom FROM stagiaires WHERE groupe_id=$1 ORDER BY nom, prenom', [s.groupe_id]);
    return { ...decrypt(s), stagiaires: stag.rows };
  });

  router.get('/api/groupes/:id/stagiaires', app.requirePerm('seance.saisir', 'seance.lire_toutes'), async (ctx) => {
    const g = int(ctx.params.id); const m = int(ctx.query.module_id);
    if (!app.can(ctx, 'seance.lire_toutes')) await app.checkScope(ctx, g, m);
    const r = await db.query('SELECT id, cef, nom, prenom FROM stagiaires WHERE groupe_id=$1 ORDER BY nom, prenom', [g]);
    return r.rows;
  });

  // Création ou mise à jour d'une séance (tant qu'elle n'est pas soumise)
  router.post('/api/seances', app.requirePerm('seance.saisir'), async (ctx) => {
    const b = ctx.body; const g = int(b.groupe_id); const m = int(b.module_id); const id = int(b.id);
    const contenu = String(b.contenu || '').trim().slice(0, 1000);
    if (!g || !m) throw new HttpError(400, 'Groupe et module obligatoires.');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.date_seance)) || Number.isNaN(Date.parse(b.date_seance))) throw new HttpError(400, 'Date invalide.');
    if (new Date(b.date_seance) > new Date(Date.now() + 86400000)) throw new HttpError(400, 'Impossible de déclarer une séance future.');
    if (!HEURE.test(b.heure_debut) || !HEURE.test(b.heure_fin) || b.heure_fin <= b.heure_debut) throw new HttpError(400, 'Horaires invalides.');
    if (contenu.length < 5) throw new HttpError(400, 'Le contenu dispensé doit être renseigné.');
    await app.checkScope(ctx, g, m);
    const valides = new Set((await db.query('SELECT id FROM stagiaires WHERE groupe_id=$1', [g])).rows.map((x) => x.id));
    const absents = (Array.isArray(b.absents) ? b.absents : []).map(int).filter((x) => valides.has(x));
    return db.tx(async (c) => {
      if (id) {
        const ex = (await c.query('SELECT * FROM seances WHERE id=$1 FOR UPDATE', [id])).rows[0];
        if (!ex || ex.formateur_id !== ctx.user.id) throw new HttpError(404, 'Séance introuvable.');
        if (!['brouillon', 'a_corriger'].includes(ex.statut)) throw new HttpError(409, 'Séance déjà soumise : modification impossible.');
        await c.query(
          `UPDATE seances SET groupe_id=$2, module_id=$3, date_seance=$4, heure_debut=$5, heure_fin=$6, contenu_chiffre=$7, absents=$8, modifie_le=now() WHERE id=$1`,
          [id, g, m, b.date_seance, b.heure_debut, b.heure_fin, cryptoSvc.encrypt(contenu), absents]);
        await audit.append(c, { acteur: ctx.user, action: 'seance.modification', ressource: `seance:${id}`, ip: ctx.ip, details: { absents: absents.length } });
        return { id };
      }
      const r = await c.query(
        `INSERT INTO seances (formateur_id, groupe_id, module_id, date_seance, heure_debut, heure_fin, contenu_chiffre, absents)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [ctx.user.id, g, m, b.date_seance, b.heure_debut, b.heure_fin, cryptoSvc.encrypt(contenu), absents]);
      await audit.append(c, { acteur: ctx.user, action: 'seance.declaration', ressource: `seance:${r.rows[0].id}`, ip: ctx.ip, details: { absents: absents.length } });
      return { id: r.rows[0].id };
    });
  });

  router.post('/api/seances/:id/soumettre', app.requirePerm('seance.soumettre'), async (ctx) => {
    const id = int(ctx.params.id);
    return db.tx(async (c) => {
      const ex = (await c.query('SELECT * FROM seances WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!ex || ex.formateur_id !== ctx.user.id) throw new HttpError(404, 'Séance introuvable.');
      if (!['brouillon', 'a_corriger'].includes(ex.statut)) throw new HttpError(409, 'Séance déjà soumise.');
      await c.query('UPDATE seances SET statut=\'soumise\', motif_retour=NULL, modifie_le=now() WHERE id=$1', [id]);
      await audit.append(c, { acteur: ctx.user, action: 'seance.soumission', ressource: `seance:${id}`, ip: ctx.ip });
      return { ok: true };
    });
  });

  // ------- Validation par la direction
  const etapeDe = () => ({ depuis: 'soumise', vers: 'validee', action: 'seance.validation', colonne: 'validateur_id' });

  router.get('/api/validation/seances', app.requirePerm('seance.valider'), async (ctx) => {
    const e = etapeDe(ctx);
    const r = await db.query(`${SELECT} WHERE se.statut=$1 ORDER BY se.date_seance, se.id`, [e.depuis]);
    return { etape: e.depuis, seances: r.rows.map(decrypt) };
  });

  router.post('/api/validation/seances/:id', app.requirePerm('seance.valider'), async (ctx) => {
    const e = etapeDe(ctx); const id = int(ctx.params.id);
    const decision = ctx.body.decision; const motif = String(ctx.body.motif || '').trim().slice(0, 300);
    if (!['approuver', 'renvoyer'].includes(decision)) throw new HttpError(400, 'Décision invalide.');
    if (decision === 'renvoyer' && motif.length < 10) throw new HttpError(400, 'Un motif d\'au moins 10 caractères est obligatoire pour un renvoi.');
    const s = await db.tx(async (c) => {
      const ex = (await c.query('SELECT * FROM seances WHERE id=$1 FOR UPDATE', [id])).rows[0];
      if (!ex || ex.statut !== e.depuis) throw new HttpError(409, 'Cette séance n\'est plus en attente à votre étape.');
      if (ex.formateur_id === ctx.user.id) throw new HttpError(403, 'Séparation des tâches : vous ne pouvez pas valider votre propre séance.');
      const vers = decision === 'approuver' ? e.vers : 'a_corriger';
      await c.query(`UPDATE seances SET statut=$2, motif_retour=$3, ${e.colonne}=$4, modifie_le=now() WHERE id=$1`,
        [id, vers, decision === 'renvoyer' ? motif : null, ctx.user.id]);
      await audit.append(c, { acteur: ctx.user, action: decision === 'approuver' ? e.action : 'seance.retour_correction',
        ressource: `seance:${id}`, ip: ctx.ip, details: motif ? { motif } : {} });
      return { ...ex, vers };
    });
    await app.notify(s.formateur_id, decision === 'approuver' ? 'info' : 'retour', decision === 'approuver'
      ? `Votre séance du ${s.date_seance} a été validée par la direction.`
      : `Votre séance du ${s.date_seance} vous a été renvoyée pour correction : ${motif}`);
    if (s.vers === 'validee' && Array.isArray(s.absents) && s.absents.length) {
      // Assiduité publiée : chaque stagiaire absent et ses parents sont prévenus
      const mod = (await db.query('SELECT code, intitule FROM modules WHERE id=$1', [s.module_id])).rows[0];
      const quand = `le ${String(s.date_seance).slice(0, 10).split('-').reverse().join('/')} (${s.heure_debut}–${s.heure_fin})`;
      await app.notifyFamille(s.absents, 'retour',
        () => `Absence enregistrée ${quand} — ${mod.code} ${mod.intitule}.`,
        (x) => `Absence de ${x.prenom} ${x.nom} ${quand} — ${mod.code} ${mod.intitule}.`);
    }
    return { statut: s.vers };
  });
};
