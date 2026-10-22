'use strict';
/**
 * Gestion des absences par le gestionnaire des stagiaires : suivi de l'assiduité et justificatifs.
 *
 * Règles de sécurité appliquées :
 *  - le gestionnaire n'a aucun accès aux notes ni à la validation des séances (RBAC) ;
 *  - une absence n'existe qu'à partir d'une séance VALIDÉE par la direction : le gestionnaire ne crée
 *    ni ne supprime d'absence, il ne fait que la qualifier (justifiée ou non) ;
 *  - le commentaire éventuel est une donnée personnelle : il est chiffré en AES-256-GCM ;
 *  - chaque justification, modification ou retrait est inscrit au journal d'audit chaîné ;
 *  - le stagiaire et ses parents sont prévenus, sans le détail du commentaire.
 */
const cryptoSvc = require('../security/crypto');
const audit = require('../security/audit');
const { HttpError } = require('../lib/http');

const int = (v) => { const n = parseInt(v, 10); return Number.isFinite(n) && n > 0 ? n : 0; };
const MOTIFS = {
  certificat_medical: 'Certificat médical',
  convocation_officielle: 'Convocation officielle',
  cas_familial: 'Cas familial grave',
  autre: 'Autre motif accepté',
};
const dateFr = (d) => String(d).slice(0, 10).split('-').reverse().join('/');

module.exports = function absenceRoutes(router, app) {
  const { db } = app;

  // Toutes les absences issues des séances validées (une ligne par stagiaire absent)
  const ABSENCES = `
    SELECT se.id AS seance_id, se.date_seance, se.heure_debut, se.heure_fin, g.id AS groupe_id, g.code AS groupe,
           m.code AS module, m.intitule, u.nom_complet AS formateur,
           s.id AS stagiaire_id, s.cef, s.nom, s.prenom,
           ja.motif, ja.commentaire_chiffre, ja.saisi_le, gj.nom_complet AS saisi_par
      FROM seances se
      JOIN groupes g ON g.id = se.groupe_id JOIN modules m ON m.id = se.module_id
      JOIN utilisateurs u ON u.id = se.formateur_id
      JOIN stagiaires s ON se.absents @> to_jsonb(s.id)
      LEFT JOIN justifications_absences ja ON ja.seance_id = se.id AND ja.stagiaire_id = s.id
      LEFT JOIN utilisateurs gj ON gj.id = ja.saisi_par
     WHERE se.statut = 'validee'`;

  router.get('/api/absences', app.requirePerm('absence.lire'), async (ctx) => {
    const g = int(ctx.query.groupe_id);
    const statut = ['justifiees', 'non_justifiees'].includes(ctx.query.statut) ? ctx.query.statut : '';
    const q = String(ctx.query.q || '').trim().slice(0, 40);
    const r = await db.query(
      `${ABSENCES}
         AND ($1 = 0 OR g.id = $1)
         AND ($2 = '' OR ($2 = 'justifiees' AND ja.motif IS NOT NULL) OR ($2 = 'non_justifiees' AND ja.motif IS NULL))
         AND ($3 = '' OR s.cef = $3 OR s.nom ILIKE '%' || $3 || '%' OR s.prenom ILIKE '%' || $3 || '%')
       ORDER BY se.date_seance DESC, se.heure_debut DESC, s.nom LIMIT 300`, [g, statut, q]);
    return r.rows.map((x) => ({
      ...x, commentaire_chiffre: undefined,
      motif_libelle: x.motif ? MOTIFS[x.motif] : null,
      commentaire: x.commentaire_chiffre ? cryptoSvc.decrypt(x.commentaire_chiffre) : null,
    }));
  });

  router.get('/api/absences/synthese', app.requirePerm('absence.lire'), async () => {
    const groupes = await db.query(
      `SELECT g.id, g.code AS groupe, g.libelle,
              (SELECT count(*)::int FROM stagiaires s WHERE s.groupe_id = g.id) AS effectif,
              count(DISTINCT se.id)::int AS seances,
              coalesce(sum(jsonb_array_length(se.absents)), 0)::int AS absences
         FROM groupes g LEFT JOIN seances se ON se.groupe_id = g.id AND se.statut = 'validee'
        GROUP BY g.id, g.code, g.libelle ORDER BY g.code`);
    const just = await db.query(
      `SELECT s.groupe_id, count(*)::int AS n FROM justifications_absences ja
         JOIN stagiaires s ON s.id = ja.stagiaire_id JOIN seances se ON se.id = ja.seance_id AND se.statut = 'validee'
        GROUP BY s.groupe_id`);
    const jg = Object.fromEntries(just.rows.map((x) => [x.groupe_id, x.n]));
    const top = await db.query(
      `SELECT x.stagiaire_id, x.cef, x.nom, x.prenom, x.groupe, count(*)::int AS absences,
              count(*) FILTER (WHERE x.motif IS NULL)::int AS non_justifiees
         FROM (${ABSENCES}) x GROUP BY x.stagiaire_id, x.cef, x.nom, x.prenom, x.groupe
        HAVING count(*) FILTER (WHERE x.motif IS NULL) > 0
        ORDER BY non_justifiees DESC, absences DESC, x.nom LIMIT 8`);
    const lignes = groupes.rows.map((x) => {
      const justifiees = jg[x.id] || 0;
      return { ...x, justifiees, non_justifiees: x.absences - justifiees,
        taux_absence: x.seances && x.effectif ? x.absences / (x.seances * x.effectif) : 0 };
    });
    const tot = (k) => lignes.reduce((a, l) => a + l[k], 0);
    return { groupes: lignes, a_suivre: top.rows,
      totaux: { seances: tot('seances'), absences: tot('absences'), justifiees: tot('justifiees'), non_justifiees: tot('non_justifiees') } };
  });

  async function absenceExistante(c, seanceId, stagiaireId) {
    const r = await c.query(
      `SELECT se.id, se.date_seance, se.heure_debut, se.heure_fin, m.code AS module, m.intitule, s.cef
         FROM seances se JOIN modules m ON m.id = se.module_id JOIN stagiaires s ON s.id = $2
        WHERE se.id = $1 AND se.statut = 'validee' AND se.absents @> to_jsonb($2::int)`, [seanceId, stagiaireId]);
    if (!r.rows.length) throw new HttpError(404, 'Absence introuvable : seules les absences des séances validées par la direction peuvent être justifiées.');
    return r.rows[0];
  }

  router.post('/api/absences/justification', app.requirePerm('absence.justifier'), async (ctx) => {
    const seanceId = int(ctx.body.seance_id); const stagiaireId = int(ctx.body.stagiaire_id);
    const motif = String(ctx.body.motif || '');
    const commentaire = String(ctx.body.commentaire || '').trim().slice(0, 300);
    if (!seanceId || !stagiaireId || !MOTIFS[motif]) throw new HttpError(400, 'Paramètres invalides : séance, stagiaire et motif sont obligatoires.');
    const a = await db.tx(async (c) => {
      const abs = await absenceExistante(c, seanceId, stagiaireId);
      const avant = (await c.query('SELECT motif FROM justifications_absences WHERE seance_id=$1 AND stagiaire_id=$2 FOR UPDATE', [seanceId, stagiaireId])).rows[0];
      await c.query(
        `INSERT INTO justifications_absences (seance_id, stagiaire_id, motif, commentaire_chiffre, saisi_par)
         VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (seance_id, stagiaire_id) DO UPDATE SET motif=EXCLUDED.motif, commentaire_chiffre=EXCLUDED.commentaire_chiffre,
           saisi_par=EXCLUDED.saisi_par, saisi_le=now()`,
        [seanceId, stagiaireId, motif, commentaire ? cryptoSvc.encrypt(commentaire) : null, ctx.user.id]);
      await audit.append(c, { acteur: ctx.user, action: avant ? 'absence.modification_justification' : 'absence.justification',
        ressource: `seance:${seanceId}/stagiaire:${stagiaireId}`, ip: ctx.ip,
        details: { stagiaire: abs.cef, date: String(abs.date_seance).slice(0, 10), motif, ...(avant ? { motif_avant: avant.motif } : {}),
          ...(commentaire ? { commentaire: cryptoSvc.encrypt(commentaire) } : {}) } });
      return abs;
    });
    const quand = `du ${dateFr(a.date_seance)} (${a.heure_debut}–${a.heure_fin}, ${a.module})`;
    await app.notifyFamille([stagiaireId], 'info',
      () => `Votre absence ${quand} a été justifiée : ${MOTIFS[motif]}.`,
      (x) => `L'absence de ${x.prenom} ${x.nom} ${quand} a été justifiée : ${MOTIFS[motif]}.`);
    return { ok: true, motif, motif_libelle: MOTIFS[motif] };
  });

  router.post('/api/absences/justification/retirer', app.requirePerm('absence.justifier'), async (ctx) => {
    const seanceId = int(ctx.body.seance_id); const stagiaireId = int(ctx.body.stagiaire_id);
    const raison = String(ctx.body.raison || '').trim().slice(0, 300);
    if (raison.length < 10) throw new HttpError(400, 'La raison du retrait est obligatoire (10 caractères minimum) : elle est consignée au journal.');
    await db.tx(async (c) => {
      const abs = await absenceExistante(c, seanceId, stagiaireId);
      const r = await c.query('DELETE FROM justifications_absences WHERE seance_id=$1 AND stagiaire_id=$2 RETURNING motif', [seanceId, stagiaireId]);
      if (!r.rows.length) throw new HttpError(409, 'Cette absence n\'est pas justifiée.');
      await audit.append(c, { acteur: ctx.user, action: 'absence.retrait_justification', ressource: `seance:${seanceId}/stagiaire:${stagiaireId}`,
        ip: ctx.ip, details: { stagiaire: abs.cef, motif_avant: r.rows[0].motif, raison } });
    });
    return { ok: true };
  });

  app.MOTIFS_ABSENCE = MOTIFS;
};
