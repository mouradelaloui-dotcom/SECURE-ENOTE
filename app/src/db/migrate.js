'use strict';
/**
 * Migrations : exécutées avec le compte propriétaire du schéma, puis octroi au compte
 * applicatif des seuls privilèges nécessaires (principe du moindre privilège).
 */
const fs = require('node:fs');
const path = require('node:path');
const { Pool } = require('../lib/pg');
const config = require('../config');
const { DEFAULT_RULES } = require('../security/anomaly');

async function migrate() {
  if (!config.migration.user) return { skipped: true };
  const owner = new Pool({ ...config.db, user: config.migration.user, password: config.migration.password, max: 1 });
  try {
    await owner.exec(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    const app = config.db.user.replace(/[^a-z0-9_]/gi, '');
    await owner.exec(`
      REVOKE ALL ON ALL TABLES IN SCHEMA public FROM ${app};
      GRANT USAGE ON SCHEMA public TO ${app};
      GRANT SELECT, INSERT, UPDATE ON utilisateurs, filieres, groupes, modules, stagiaires, notes, seances,
            appareils_connus, regles_detection, alertes, notifications, sauvegardes, parametres TO ${app};
      GRANT SELECT, INSERT, UPDATE, DELETE ON sessions, affectations, parents_stagiaires, justifications_absences TO ${app};
      GRANT SELECT, INSERT ON journal_audit, journal_technique TO ${app};
      GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO ${app};
    `);
    for (const r of DEFAULT_RULES) {
      await owner.query(
        `INSERT INTO regles_detection (code, libelle, description, severite, parametres) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (code) DO NOTHING`, [r.code, r.libelle, r.description, r.severite, r.parametres]);
    }
    return { ok: true };
  } finally { owner.end(); }
}

module.exports = { migrate };
