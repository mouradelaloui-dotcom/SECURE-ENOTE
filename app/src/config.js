'use strict';
const fs = require('node:fs');

/** Lit une variable d'environnement, ou le fichier pointé par VAR_FILE (secrets Docker). */
function env(name, def) {
  const file = process.env[name + '_FILE'];
  if (file) return fs.readFileSync(file, 'utf8').trim();
  const v = process.env[name];
  return v === undefined || v === '' ? def : v;
}

const config = {
  port: parseInt(env('PORT', '3000'), 10),
  https: env('PUBLIC_HTTPS', 'false') === 'true',   // derrière le reverse-proxy TLS
  trustProxy: env('TRUST_PROXY', 'false') === 'true',
  demoMode: env('DEMO_MODE', 'false') === 'true',
  // Jeu de données fictif (démonstration). En production : DEMO_DATA=false, puis « creer-admin » et « importer ».
  demoData: env('DEMO_DATA', 'true') === 'true',
  timezone: env('ENOTE_TZ', 'Africa/Casablanca'),
  rateLimitLogin: parseInt(env('RATE_LIMIT_LOGIN', '30'), 10), // tentatives par IP / 5 min
  db: {
    host: env('PGHOST', '127.0.0.1'),
    port: parseInt(env('PGPORT', '5432'), 10),
    database: env('PGDATABASE', 'enote'),
    user: env('PGUSER', 'enote_app'),
    password: env('PGPASSWORD', ''),
  },
  migration: {
    user: env('MIGRATION_USER', ''),
    password: env('MIGRATION_PASSWORD', ''),
  },
  masterKey: env('ENOTE_MASTER_KEY', ''),          // 32 octets base64, hors base de données
  session: { idleMinutes: 30, absoluteHours: 8, preMfaMinutes: 5 },
  backup: {
    dir: env('BACKUP_DIR', './backups'),
    intervalHours: parseFloat(env('BACKUP_INTERVAL_HOURS', '4')),
    retention: parseInt(env('BACKUP_RETENTION', '30'), 10),
    pgDump: env('PG_DUMP_PATH', 'pg_dump'),
  },
};

module.exports = config;
