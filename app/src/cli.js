'use strict';
/**
 * Outils d'exploitation (à lancer dans le conteneur : docker compose exec app node src/cli.js <commande>)
 *   generer-cle                 génère une clé maîtresse de 32 octets (base64)
 *   verifier-journal            vérifie l'intégrité de la chaîne du journal d'audit
 *   sauvegarder                 crée une sauvegarde chiffrée immédiate
 *   test-restauration [id]      restaure une sauvegarde dans une base temporaire et mesure le RTO
 *   restaurer <fichier.sql.enc> restaure une sauvegarde dans la base de production (PRA)
 *   creer-admin <login> <nom>   crée le premier compte administrateur (mot de passe provisoire affiché une fois)
 *   importer <dossier>          importe le référentiel depuis des fichiers CSV (séparateur ;) : filieres.csv,
 *                               groupes.csv, modules.csv, stagiaires.csv, affectations.csv
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const config = require('./config');
const cryptoSvc = require('./security/crypto');
const { Pool } = require('./lib/pg');

function psql(db, sql) {
  return new Promise((resolve, reject) => {
    const bin = config.backup.pgDump.replace(/pg_dump$/, 'psql');
    const p = spawn(bin, ['-h', config.db.host, '-p', String(config.db.port), '-U', config.migration.user, '-d', db, '-q', '-v', 'ON_ERROR_STOP=1'],
      { env: { ...process.env, PGPASSWORD: config.migration.password } });
    let err = ''; p.stderr.on('data', (d) => { err += d; });
    p.on('close', (c) => (c === 0 ? resolve() : reject(new Error(err.trim()))));
    p.stdin.end(sql);
  });
}

const SYS = { id: null, login: 'systeme', role: null };

/** Premier compte administrateur d'une installation de production (base vide, DEMO_DATA=false). */
async function creerAdmin(db, login, nom) {
  const password = require('./security/password');
  const audit = require('./security/audit');
  login = String(login || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,40}$/.test(login) || String(nom || '').trim().length < 3) {
    throw new Error('Usage : creer-admin <identifiant> "<Nom complet>"');
  }
  let tmp;
  do { tmp = `Ofppt-${require('node:crypto').randomBytes(6).toString('base64url')}#${Math.floor(Math.random() * 90 + 10)}`; }
  while (password.checkPolicy(tmp, login).length);
  await db.tx(async (c) => {
    const r = await c.query(
      `INSERT INTO utilisateurs (login, nom_complet, role, mot_de_passe, doit_changer_mdp) VALUES ($1,$2,'administrateur',$3,true) RETURNING id`,
      [login, String(nom).trim().slice(0, 80), password.hash(tmp)]);
    await audit.append(c, { acteur: SYS, action: 'compte.creation', ressource: `utilisateur:${r.rows[0].id}`, details: { login, role: 'administrateur', origine: 'cli' } });
  });
  console.log(`Compte administrateur « ${login} » créé.\nMot de passe provisoire (affiché une seule fois) : ${tmp}\n` +
    'À la première connexion : activation du second facteur puis changement du mot de passe.');
}

/** Lecture d'un CSV simple (séparateur ;, première ligne = en-têtes). */
function lireCsv(file) {
  if (!fs.existsSync(file)) return null;
  const lignes = fs.readFileSync(file, 'utf8').replace(/^﻿/, '').split(/\r?\n/).filter((l) => l.trim());
  const entetes = lignes.shift().split(';').map((h) => h.trim().toLowerCase());
  return lignes.map((l) => Object.fromEntries(l.split(';').map((v, i) => [entetes[i], v.trim()])));
}

/** Import du référentiel pédagogique (fichiers exportés du système d'information de l'OFPPT). */
async function importer(db, dossier) {
  if (!dossier || !fs.existsSync(dossier)) throw new Error('Usage : importer <dossier contenant les fichiers CSV>');
  const audit = require('./security/audit');
  const bilan = {};
  await db.tx(async (c) => {
    const f = (n) => lireCsv(path.join(dossier, n));
    const filieres = f('filieres.csv') || [];
    for (const x of filieres) {
      await c.query('INSERT INTO filieres (code, libelle) VALUES ($1,$2) ON CONFLICT (code) DO UPDATE SET libelle=EXCLUDED.libelle', [x.code, x.libelle]);
    }
    const idFiliere = async (code) => {
      const r = (await c.query('SELECT id FROM filieres WHERE code=$1', [code])).rows[0];
      if (!r) throw new Error(`Filière inconnue : ${code}`);
      return r.id;
    };
    const groupes = f('groupes.csv') || [];
    for (const x of groupes) {
      await c.query(`INSERT INTO groupes (code, libelle, filiere_id, annee) VALUES ($1,$2,$3,$4)
                     ON CONFLICT (code) DO UPDATE SET libelle=EXCLUDED.libelle, filiere_id=EXCLUDED.filiere_id, annee=EXCLUDED.annee`,
      [x.code, x.libelle, await idFiliere(x.filiere), x.annee]);
    }
    const modules = f('modules.csv') || [];
    for (const x of modules) {
      await c.query(`INSERT INTO modules (code, intitule, filiere_id, masse_horaire) VALUES ($1,$2,$3,$4)
                     ON CONFLICT (code, filiere_id) DO UPDATE SET intitule=EXCLUDED.intitule, masse_horaire=EXCLUDED.masse_horaire`,
      [x.code, x.intitule, await idFiliere(x.filiere), parseInt(x.masse_horaire, 10) || 0]);
    }
    const groupe = async (code) => {
      const r = (await c.query('SELECT id, filiere_id FROM groupes WHERE code=$1', [code])).rows[0];
      if (!r) throw new Error(`Groupe inconnu : ${code}`);
      return r;
    };
    const stagiaires = f('stagiaires.csv') || [];
    for (const x of stagiaires) {
      const g = await groupe(x.groupe);
      const enc = (v) => (v ? cryptoSvc.encrypt(v) : null);    // données personnelles chiffrées (loi 09-08)
      await c.query(`INSERT INTO stagiaires (cef, nom, prenom, groupe_id, cin_chiffre, date_naissance_chiffree, telephone_chiffre)
                     VALUES ($1,$2,$3,$4,$5,$6,$7)
                     ON CONFLICT (cef) DO UPDATE SET nom=EXCLUDED.nom, prenom=EXCLUDED.prenom, groupe_id=EXCLUDED.groupe_id,
                       cin_chiffre=EXCLUDED.cin_chiffre, date_naissance_chiffree=EXCLUDED.date_naissance_chiffree, telephone_chiffre=EXCLUDED.telephone_chiffre`,
      [x.cef, x.nom, x.prenom, g.id, enc(x.cin), enc(x.date_naissance), enc(x.telephone)]);
    }
    const affectations = f('affectations.csv') || [];
    for (const x of affectations) {
      const u = (await c.query("SELECT id FROM utilisateurs WHERE login=$1 AND role='formateur'", [x.formateur])).rows[0];
      if (!u) throw new Error(`Formateur inconnu (créez d'abord son compte) : ${x.formateur}`);
      const g = await groupe(x.groupe);
      const m = (await c.query('SELECT id FROM modules WHERE code=$1 AND filiere_id=$2', [x.module, g.filiere_id])).rows[0];
      if (!m) throw new Error(`Module ${x.module} inconnu pour la filière du groupe ${x.groupe}`);
      await c.query('INSERT INTO affectations (formateur_id, groupe_id, module_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING', [u.id, g.id, m.id]);
    }
    Object.assign(bilan, { filieres: filieres.length, groupes: groupes.length, modules: modules.length,
      stagiaires: stagiaires.length, affectations: affectations.length });
    await audit.append(c, { acteur: SYS, action: 'referentiel.import', ressource: path.basename(dossier), details: bilan });
  });
  console.log('Import terminé (tout ou rien, dans une seule transaction) :', bilan);
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === 'generer-cle') { console.log(require('node:crypto').randomBytes(32).toString('base64')); return; }
  cryptoSvc.init(config.masterKey);
  const db = new Pool({ ...config.db, max: 2 });
  try {
    if (cmd === 'verifier-journal') {
      console.log(await require('./security/audit').verifyChain(db));
    } else if (cmd === 'sauvegarder') {
      console.log(await require('./services/backup').createBackup(db, 'manuelle (CLI)'));
    } else if (cmd === 'test-restauration' || cmd === 'restaurer') {
      if (!config.migration.user) throw new Error('MIGRATION_USER/MIGRATION_PASSWORD requis');
      let file;
      if (cmd === 'restaurer') file = arg;
      else {
        const b = (await db.query(arg ? 'SELECT * FROM sauvegardes WHERE id=$1' : 'SELECT * FROM sauvegardes ORDER BY id DESC LIMIT 1', arg ? [arg] : [])).rows[0];
        if (!b) throw new Error('Aucune sauvegarde');
        file = path.join(config.backup.dir, b.fichier);
      }
      const t0 = Date.now();
      const sql = cryptoSvc.decryptBuffer(fs.readFileSync(file)).toString('utf8');
      const target = cmd === 'restaurer' ? config.db.database : 'enote_test_restauration';
      const owner = new Pool({ ...config.db, database: 'postgres', user: config.migration.user, password: config.migration.password, max: 1 });
      if (cmd === 'test-restauration') {
        await owner.exec(`DROP DATABASE IF EXISTS ${target}`); await owner.exec(`CREATE DATABASE ${target}`);
      } else {
        console.log('Restauration dans la base de production : arrêtez le service applicatif avant de poursuivre.');
        await psql(target, 'DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
      }
      await psql(target, sql);
      const check = new Pool({ ...config.db, database: target, user: config.migration.user, password: config.migration.password, max: 1 });
      const n = (await check.query(`SELECT (SELECT count(*) FROM notes)::int notes, (SELECT count(*) FROM seances)::int seances,
        (SELECT count(*) FROM journal_audit)::int journal, (SELECT count(*) FROM utilisateurs)::int utilisateurs`)).rows[0];
      check.end();
      if (cmd === 'test-restauration') await owner.exec(`DROP DATABASE ${target}`);
      owner.end();
      console.log(JSON.stringify({ fichier: path.basename(file), base: target, duree_restauration_ms: Date.now() - t0, lignes_restaurees: n }, null, 2));
    } else if (cmd === 'creer-admin') {
      await creerAdmin(db, arg, process.argv.slice(4).join(' '));
    } else if (cmd === 'importer') {
      await importer(db, arg);
    } else {
      console.log(fs.readFileSync(__filename, 'utf8').split('\n').slice(2, 12).join('\n'));
    }
  } finally { db.end(); }
}

main().catch((e) => { console.error('Erreur :', e.message); process.exit(1); });
