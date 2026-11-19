'use strict';
/**
 * Module « Magasin de modules » : l'administrateur active / désactive des
 * modules DÉJÀ installés et vérifiés. Aucune exécution de code téléchargé —
 * on ne fait qu'allumer ou éteindre des modules présents dans le dépôt.
 * Un module désactivé voit ses routes renvoyer 404 (garde-fou dans server.js)
 * et son entrée de menu masquée côté interface.
 */
const { HttpError } = require('../lib/http');

module.exports = function modulesRoutes(router, app) {
  const { db } = app;

  // Liste des modules installés et de leur état.
  router.get('/api/admin/modules', app.requirePerm('modules.gerer'), async () => {
    let rows;
    try {
      rows = (await db.query(
        'SELECT id, nom, description, categorie, version, verrou, actif, maj_le FROM modules_installes ORDER BY verrou DESC, categorie, nom')).rows;
    } catch (e) {
      throw new HttpError(400, "Registre des modules non installé : lancez d'abord la migration module_registre.sql.");
    }
    return { modules: rows };
  });

  // Activer / désactiver un module. Le socle (verrou) est intouchable.
  router.post('/api/admin/modules/:id', app.requirePerm('modules.gerer'), async (ctx) => {
    const id = String(ctx.params.id || '').slice(0, 60);
    const actif = ctx.body && ctx.body.actif === true;
    const m = (await db.query('SELECT id, nom, verrou, actif FROM modules_installes WHERE id = $1', [id])).rows[0];
    if (!m) throw new HttpError(404, 'Module inconnu.');
    if (m.verrou) throw new HttpError(409, 'Le socle eNote ne peut pas être désactivé.');
    if (m.actif === actif) return { ok: true, inchange: true };
    await db.query('UPDATE modules_installes SET actif = $2, maj_le = now() WHERE id = $1', [id, actif]);
    await app.rechargerModules();
    await app.log(ctx, actif ? 'module.activation' : 'module.desactivation', `module:${id}`, { nom: m.nom });
    return { ok: true, actif };
  });
};
