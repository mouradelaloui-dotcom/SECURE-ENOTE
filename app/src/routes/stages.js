'use strict';
/** Module « Stages » : suivi des stages des stagiaires (entreprise, encadrant, statut). */
const { HttpError } = require('../lib/http');

const STATUTS = ['en_recherche', 'en_cours', 'termine', 'valide'];
const strOrNull = (v, max) => { const t = v == null ? '' : String(v).trim(); return t ? t.slice(0, max) : null; };
const dateOrNull = (v) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null);

module.exports = function stagesRoutes(router, app) {
  const { db } = app;

  // Référentiel pour l'éditeur.
  router.get('/api/stages/ref', app.requirePerm('stage.consulter'), async () => {
    const s = await db.query('SELECT s.id, s.cef, s.nom, s.prenom, g.code AS groupe FROM stagiaires s JOIN groupes g ON g.id = s.groupe_id ORDER BY s.nom, s.prenom');
    const f = await db.query("SELECT id, nom_complet FROM utilisateurs WHERE role='formateur' AND statut='actif' ORDER BY nom_complet");
    return { stagiaires: s.rows, formateurs: f.rows, statuts: STATUTS };
  });

  // Liste des stages (filtrable par statut).
  router.get('/api/stages', app.requirePerm('stage.consulter'), async (ctx) => {
    const statut = STATUTS.includes(String(ctx.query.statut)) ? String(ctx.query.statut) : null;
    const params = [];
    let where = '';
    if (statut) { params.push(statut); where = 'WHERE st.statut = $1'; }
    const r = await db.query(`
      SELECT st.id, st.stagiaire_id, st.entreprise, st.ville, st.tuteur, st.encadrant_id,
             st.date_debut, st.date_fin, st.sujet, st.statut,
             s.cef, s.nom AS stagiaire_nom, s.prenom AS stagiaire_prenom, g.code AS groupe,
             u.nom_complet AS encadrant
      FROM stages st
      JOIN stagiaires s ON s.id = st.stagiaire_id
      JOIN groupes g ON g.id = s.groupe_id
      LEFT JOIN utilisateurs u ON u.id = st.encadrant_id
      ${where}
      ORDER BY st.statut, s.nom, s.prenom`, params);
    return { stages: r.rows, statuts: STATUTS };
  });

  // Le stagiaire consulte son propre stage.
  router.get('/api/stages/moi', app.requirePerm('stage.lire_soi'), async (ctx) => {
    const s = (await db.query('SELECT id FROM stagiaires WHERE utilisateur_id = $1', [ctx.user.id])).rows[0];
    if (!s) return { stage: null };
    const r = await db.query(
      'SELECT st.*, u.nom_complet AS encadrant FROM stages st LEFT JOIN utilisateurs u ON u.id = st.encadrant_id WHERE st.stagiaire_id = $1',
      [s.id]);
    return { stage: r.rows[0] || null };
  });

  // Créer un stage (direction / gestionnaire).
  router.post('/api/stages', app.requirePerm('stage.gerer'), async (ctx) => {
    const b = ctx.body || {};
    const sid = parseInt(b.stagiaire_id, 10);
    const entreprise = strOrNull(b.entreprise, 120);
    if (!Number.isInteger(sid)) throw new HttpError(400, 'Stagiaire requis.');
    if (!entreprise) throw new HttpError(400, 'Entreprise requise.');
    const enc = b.encadrant_id ? parseInt(b.encadrant_id, 10) : null;
    const statut = STATUTS.includes(String(b.statut)) ? String(b.statut) : 'en_recherche';
    let r;
    try {
      r = await db.query(
        `INSERT INTO stages (stagiaire_id, entreprise, ville, tuteur, encadrant_id, date_debut, date_fin, sujet, statut)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
        [sid, entreprise, strOrNull(b.ville, 60), strOrNull(b.tuteur, 80), enc,
          dateOrNull(b.date_debut), dateOrNull(b.date_fin), strOrNull(b.sujet, 200), statut]);
    } catch (e) {
      throw new HttpError(400, "Module Stages non installé : lancez d'abord la migration module_stages.sql.");
    }
    await app.log(ctx, 'stage.creation', `stage:${r.rows[0].id}`, { stagiaire_id: sid, entreprise });
    return { ok: true, id: r.rows[0].id };
  });

  // Modifier un stage (direction / gestionnaire).
  router.put('/api/stages/:id', app.requirePerm('stage.gerer'), async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    if (!Number.isInteger(id)) throw new HttpError(400, 'Identifiant invalide.');
    const b = ctx.body || {};
    const statut = STATUTS.includes(String(b.statut)) ? String(b.statut) : null;
    const r = await db.query(
      `UPDATE stages SET entreprise = COALESCE($2, entreprise), ville = $3, tuteur = $4, encadrant_id = $5,
         date_debut = $6, date_fin = $7, sujet = $8, statut = COALESCE($9, statut), maj_le = now()
       WHERE id = $1 RETURNING id`,
      [id, strOrNull(b.entreprise, 120), strOrNull(b.ville, 60), strOrNull(b.tuteur, 80),
        b.encadrant_id ? parseInt(b.encadrant_id, 10) : null,
        dateOrNull(b.date_debut), dateOrNull(b.date_fin), strOrNull(b.sujet, 200), statut]);
    if (!r.rows.length) throw new HttpError(404, 'Stage introuvable.');
    await app.log(ctx, 'stage.modification', `stage:${id}`, { statut });
    return { ok: true };
  });

  // Supprimer un stage (direction / gestionnaire).
  router.delete('/api/stages/:id', app.requirePerm('stage.gerer'), async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    if (!Number.isInteger(id)) throw new HttpError(400, 'Identifiant invalide.');
    const r = await db.query('DELETE FROM stages WHERE id = $1 RETURNING id', [id]);
    if (!r.rows.length) throw new HttpError(404, 'Stage introuvable.');
    await app.log(ctx, 'stage.suppression', `stage:${id}`, {});
    return { ok: true };
  });
};
