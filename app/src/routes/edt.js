'use strict';
/** Module « Emploi du temps » : planning hebdomadaire par groupe (consultation + édition par la direction). */
const { HttpError } = require('../lib/http');

const JOURS = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
const HHMM = /^([01]\d|2[0-3]):[0-5]\d$/;

module.exports = function edtRoutes(router, app) {
  const { db } = app;

  // Référentiel pour l'éditeur.
  router.get('/api/edt/ref', app.requirePerm('edt.consulter'), async () => {
    const g = await db.query('SELECT id, code, libelle FROM groupes ORDER BY code');
    const m = await db.query('SELECT id, code, intitule FROM modules ORDER BY code');
    const f = await db.query("SELECT id, nom_complet FROM utilisateurs WHERE role='formateur' AND statut='actif' ORDER BY nom_complet");
    return { groupes: g.rows, modules: m.rows, formateurs: f.rows, jours: JOURS };
  });

  // Emploi du temps d'un groupe (ou de tous si aucun groupe précisé).
  router.get('/api/edt', app.requirePerm('edt.consulter'), async (ctx) => {
    const gid = parseInt(ctx.query.groupe_id, 10);
    const params = [];
    let where = '';
    if (Number.isInteger(gid)) { params.push(gid); where = 'WHERE e.groupe_id = $1'; }
    const r = await db.query(`
      SELECT e.id, e.groupe_id, g.code AS groupe, e.jour, e.heure_debut, e.heure_fin,
             e.module_id, m.intitule AS module, e.formateur_id, u.nom_complet AS formateur, e.salle
      FROM emploi_du_temps e
      JOIN groupes g ON g.id = e.groupe_id
      JOIN modules m ON m.id = e.module_id
      JOIN utilisateurs u ON u.id = e.formateur_id
      ${where}
      ORDER BY e.jour, e.heure_debut`, params);
    return { seances: r.rows, jours: JOURS };
  });

  // Ajouter un créneau (direction).
  router.post('/api/edt', app.requirePerm('edt.modifier'), async (ctx) => {
    const b = ctx.body || {};
    const gid = parseInt(b.groupe_id, 10);
    const mid = parseInt(b.module_id, 10);
    const fid = parseInt(b.formateur_id, 10);
    const jour = parseInt(b.jour, 10);
    const hd = String(b.heure_debut || '');
    const hf = String(b.heure_fin || '');
    const salle = b.salle ? String(b.salle).slice(0, 40) : null;
    if (![gid, mid, fid].every(Number.isInteger)) throw new HttpError(400, 'Groupe, module et formateur requis.');
    if (!(jour >= 1 && jour <= 6)) throw new HttpError(400, 'Jour invalide.');
    if (!HHMM.test(hd) || !HHMM.test(hf) || hf <= hd) throw new HttpError(400, 'Horaires invalides (HH:MM, la fin doit suivre le début).');
    // Conflit : le groupe a déjà cours sur ce créneau.
    const c1 = await db.query(
      'SELECT 1 FROM emploi_du_temps WHERE groupe_id=$1 AND jour=$2 AND NOT (heure_fin <= $3 OR heure_debut >= $4)',
      [gid, jour, hd, hf]);
    if (c1.rows.length) throw new HttpError(409, 'Ce groupe a déjà un cours sur ce créneau.');
    // Conflit : le formateur est déjà occupé sur ce créneau.
    const c2 = await db.query(
      'SELECT 1 FROM emploi_du_temps WHERE formateur_id=$1 AND jour=$2 AND NOT (heure_fin <= $3 OR heure_debut >= $4)',
      [fid, jour, hd, hf]);
    if (c2.rows.length) throw new HttpError(409, 'Ce formateur est déjà occupé sur ce créneau.');
    let r;
    try {
      r = await db.query(
        `INSERT INTO emploi_du_temps (groupe_id, jour, heure_debut, heure_fin, module_id, formateur_id, salle)
         VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
        [gid, jour, hd, hf, mid, fid, salle]);
    } catch (e) {
      throw new HttpError(400, "Module Emploi du temps non installé : lancez d'abord la migration module_edt.sql.");
    }
    await app.log(ctx, 'edt.ajout', `edt:${r.rows[0].id}`, { groupe_id: gid, jour, heure_debut: hd });
    return { ok: true, id: r.rows[0].id };
  });

  // Supprimer un créneau (direction).
  router.delete('/api/edt/:id', app.requirePerm('edt.modifier'), async (ctx) => {
    const id = parseInt(ctx.params.id, 10);
    if (!Number.isInteger(id)) throw new HttpError(400, 'Identifiant invalide.');
    const r = await db.query('DELETE FROM emploi_du_temps WHERE id=$1 RETURNING id', [id]);
    if (!r.rows.length) throw new HttpError(404, 'Créneau introuvable.');
    await app.log(ctx, 'edt.suppression', `edt:${id}`, {});
    return { ok: true };
  });
};
