'use strict';
/**
 * Module « Bibliothèque numérique » : catalogue de ressources pédagogiques.
 * Aucun fichier binaire n'est téléversé — uniquement le descriptif et un lien
 * optionnel — afin de préserver le plafond anti-DoS (corps <= 1 Mo) et de
 * garder une surface d'attaque minimale. Les liens sont validés (http/https).
 *
 * Droits : tous les rôles internes consultent. Les formateurs publient et ne
 * gèrent QUE leurs propres fiches ; gestionnaire et directeur gèrent toutes
 * les fiches. L'administrateur consulte seulement (séparation des tâches :
 * il n'intervient pas sur le contenu pédagogique).
 */
const { HttpError } = require('../lib/http');

const TYPES = ['support_cours', 'livre', 'article', 'lien', 'logiciel', 'autre'];
const CATEGORIES = [
  'Développement', 'Réseaux & Systèmes', 'Bases de données', 'Sécurité informatique',
  'Culture numérique', 'Langues & Communication', 'Entrepreneuriat', 'Autre',
];

const strOrNull = (v, max) => { const t = v == null ? '' : String(v).trim(); return t ? t.slice(0, max) : null; };

function lienOrNull(v) {
  const t = strOrNull(v, 500);
  if (!t) return null;
  if (!/^https?:\/\//i.test(t)) throw new HttpError(400, 'Le lien doit commencer par http:// ou https://');
  return t;
}

module.exports = function biblioRoutes(router, app) {
  const { db } = app;

  // Référentiel (catégories, types) pour l'éditeur et les filtres.
  router.get('/api/biblio/ref', app.requirePerm('biblio.consulter'), async () => {
    return { categories: CATEGORIES, types: TYPES };
  });

  // Liste filtrable : par catégorie, type, et recherche plein-texte simple.
  router.get('/api/biblio', app.requirePerm('biblio.consulter'), async (ctx) => {
    const params = [];
    const cond = [];
    if (CATEGORIES.includes(String(ctx.query.categorie))) { params.push(String(ctx.query.categorie)); cond.push(`r.categorie = $${params.length}`); }
    if (TYPES.includes(String(ctx.query.type))) { params.push(String(ctx.query.type)); cond.push(`r.type = $${params.length}`); }
    const q = strOrNull(ctx.query.q, 80);
    if (q) { params.push(`%${q.replace(/[%_]/g, (m) => '\\' + m)}%`); cond.push(`(r.titre ILIKE $${params.length} OR r.auteur ILIKE $${params.length} OR r.description ILIKE $${params.length})`); }
    const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
    const r = await db.query(`
      SELECT r.id, r.titre, r.auteur, r.categorie, r.type, r.filiere, r.description, r.lien,
             r.ajoute_par, r.cree_le, u.nom_complet AS auteur_fiche
      FROM ressources r
      LEFT JOIN utilisateurs u ON u.id = r.ajoute_par
      ${where}
      ORDER BY r.cree_le DESC, r.id DESC`, params);
    return { ressources: r.rows, categories: CATEGORIES, types: TYPES };
  });

  // Publier une ressource (formateur / gestionnaire / directeur).
  router.post('/api/biblio', app.requirePerm('biblio.gerer'), async (ctx) => {
    const b = ctx.body || {};
    const titre = strOrNull(b.titre, 160);
    if (!titre) throw new HttpError(400, 'Titre requis.');
    const categorie = CATEGORIES.includes(String(b.categorie)) ? String(b.categorie) : null;
    if (!categorie) throw new HttpError(400, 'Catégorie invalide.');
    const type = TYPES.includes(String(b.type)) ? String(b.type) : 'support_cours';
    const lien = lienOrNull(b.lien);
    let r;
    try {
      r = await db.query(
        `INSERT INTO ressources (titre, auteur, categorie, type, filiere, description, lien, ajoute_par)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
        [titre, strOrNull(b.auteur, 120), categorie, type, strOrNull(b.filiere, 40), strOrNull(b.description, 800), lien, ctx.user.id]);
    } catch (e) {
      throw new HttpError(400, "Module Bibliothèque non installé : lancez d'abord la migration module_biblio.sql.");
    }
    await app.log(ctx, 'biblio.publication', `ressource:${r.rows[0].id}`, { titre, categorie });
    return { ok: true, id: r.rows[0].id };
  });

  // Charge la fiche et vérifie le droit de la modifier (propriétaire ou gestion globale).
  async function chargerModifiable(ctx) {
    const id = parseInt(ctx.params.id, 10);
    if (!Number.isInteger(id)) throw new HttpError(400, 'Identifiant invalide.');
    const r = (await db.query('SELECT id, ajoute_par FROM ressources WHERE id = $1', [id])).rows[0];
    if (!r) throw new HttpError(404, 'Ressource introuvable.');
    const global = app.can(ctx, 'biblio.gerer_tout');
    if (!global && r.ajoute_par !== ctx.user.id) throw new HttpError(403, 'Vous ne pouvez modifier que vos propres ressources.');
    return id;
  }

  // Modifier une ressource.
  router.put('/api/biblio/:id', app.requirePerm('biblio.gerer'), async (ctx) => {
    const id = await chargerModifiable(ctx);
    const b = ctx.body || {};
    const titre = strOrNull(b.titre, 160);
    const categorie = CATEGORIES.includes(String(b.categorie)) ? String(b.categorie) : null;
    const type = TYPES.includes(String(b.type)) ? String(b.type) : null;
    await db.query(
      `UPDATE ressources SET titre = COALESCE($2, titre), auteur = $3, categorie = COALESCE($4, categorie),
         type = COALESCE($5, type), filiere = $6, description = $7, lien = $8
       WHERE id = $1`,
      [id, titre, strOrNull(b.auteur, 120), categorie, type, strOrNull(b.filiere, 40), strOrNull(b.description, 800), lienOrNull(b.lien)]);
    await app.log(ctx, 'biblio.modification', `ressource:${id}`, {});
    return { ok: true };
  });

  // Supprimer une ressource.
  router.delete('/api/biblio/:id', app.requirePerm('biblio.gerer'), async (ctx) => {
    const id = await chargerModifiable(ctx);
    await db.query('DELETE FROM ressources WHERE id = $1', [id]);
    await app.log(ctx, 'biblio.suppression', `ressource:${id}`, {});
    return { ok: true };
  });
};
