'use strict';
/**
 * Scénarios de sécurité T1 à T7 (chapitre 26 du mémoire) + tests complémentaires,
 * exécutés contre une instance en fonctionnement (mode démonstration).
 *   BASE_URL=http://localhost:3000 node --test tests/
 * Le scénario T5 nécessite les identifiants du propriétaire de la base (MIGRATION_USER).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { Client } = require('./client');

const BASE = process.env.BASE_URL || 'http://localhost:3000';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let up = false;

test.before(async () => {
  try { up = (await fetch(BASE + '/api/sante')).ok; } catch { up = false; }
});
const live = (name, fn) => test(name, async (t) => { if (!up) return t.skip('serveur non démarré'); await fn(t); });

// Une session par compte, réutilisée (l'anti-rejeu TOTP interdit deux connexions avec le même code)
const PWD = { 'admin.dr': 'Admin@2026', 'm.elaloui': 'Formateur@2026', 'e.talil': 'Gestion@2026', 'w.jakjoud': 'Directeur@2026' };
const { MDP_STAGIAIRE, MDP_PARENT } = require('../src/db/seed');
const sessions = {};
async function as(login) {
  if (!sessions[login]) { const c = new Client(BASE); assert.equal((await c.login(login, PWD[login])).status, 200); sessions[login] = c; }
  return sessions[login];
}
const admin = () => as('admin.dr');
async function alertsFor(a, regle) { await sleep(400); return (await a.get('/api/alertes?statut=nouvelle')).data.filter((x) => x.regle === regle); }

live('T1 — mot de passe correct mais code MFA incorrect : accès refusé', async () => {
  const c = new Client(BASE);
  assert.equal((await c.post('/api/auth/login', { login: 'e.talil', password: 'Gestion@2026' })).status, 200);
  const r = await c.post('/api/auth/mfa', { code: '000000' });
  assert.equal(r.status, 401);
  assert.equal((await c.get('/api/me')).status, 401, 'aucune session ouverte');
});

live('T1 bis — message générique : pas d\'énumération des comptes', async () => {
  const c = new Client(BASE);
  const a = await c.post('/api/auth/login', { login: 'compte.inexistant', password: 'x' });
  const b = await c.post('/api/auth/login', { login: 'w.jakjoud', password: 'mauvais' });
  assert.equal(a.status, 401); assert.equal(a.data.erreur, b.data.erreur);
});

live('T2 — cinq échecs consécutifs : verrouillage temporaire + alerte critique', async () => {
  const c = new Client(BASE); let last;
  for (let i = 0; i < 5; i++) last = await c.post('/api/auth/login', { login: 'z.nadifi', password: 'Mauvais#' + i });
  assert.equal(last.status, 423);
  const ok = await c.post('/api/auth/login', { login: 'z.nadifi', password: 'Zineb#Ntic2026' });
  assert.equal(ok.status, 423, 'même le bon mot de passe est refusé pendant le verrouillage');
  const a = await admin();
  assert.ok((await alertsFor(a, 'echecs_authentification')).length >= 1);
  const u = (await a.get('/api/admin/utilisateurs')).data.find((x) => x.login === 'z.nadifi');
  assert.equal(u.verrouille, true);
  await a.post(`/api/admin/utilisateurs/${u.id}/action`, { action: 'deverrouiller' });
});

live('T3 — un formateur tente de valider une note : refusé', async () => {
  const f = await as('m.elaloui');
  const r = await f.post('/api/validation/notes', { groupe_id: 1, module_id: 2, type_eval: 'CC2', decision: 'approuver' });
  assert.equal(r.status, 403);
});

live('T4 — un formateur tente de consulter le journal d\'audit : refusé', async () => {
  const f = await as('m.elaloui');
  assert.equal((await f.get('/api/journal')).status, 403);
  assert.equal((await f.get('/api/admin/utilisateurs')).status, 403);
});

live('T4 bis — manipulation d\'URL (IDOR) hors périmètre : refusée et détectée', async () => {
  const f = await as('m.elaloui');
  assert.equal((await f.get('/api/notes?groupe_id=4&module_id=7&type_eval=CC1')).status, 403);
  const a = await admin();
  assert.ok((await alertsFor(a, 'acces_refuses')).length >= 1, 'les refus répétés génèrent une alerte critique');
});

live('T4 ter — requête sans jeton anti-CSRF : refusée', async () => {
  const f = await as('m.elaloui');
  const forged = new Client(BASE); forged.cookies = { ...f.cookies }; forged.csrf = 'faux'; // cookie de session volé/rejoué sans jeton
  assert.equal((await forged.post('/api/notes/soumettre', { groupe_id: 1, module_id: 3, type_eval: 'CC1' })).status, 403);
});

live('T5 — altération directe d\'une entrée du journal : rupture de chaîne détectée', async (t) => {
  const config = require('../src/config');
  if (!config.migration.user) return t.skip('identifiants propriétaire non fournis');
  const { Pool } = require('../src/lib/pg');
  const owner = new Pool({ ...config.db, user: config.migration.user, password: config.migration.password, max: 1 });
  const a = await admin();
  assert.equal((await a.post('/api/journal/verifier')).data.integre, true);
  // 1) le compte applicatif ne peut pas modifier le journal (déclencheur append-only)
  await assert.rejects(owner.query('UPDATE journal_audit SET action=$1 WHERE id=10', ['x']), /append-only/);
  // 2) un administrateur de base malveillant désactive le déclencheur et falsifie une note du journal
  await owner.exec(`ALTER TABLE journal_audit DISABLE TRIGGER trg_journal_append_only;
    UPDATE journal_audit SET details = jsonb_set(details, '{evaluation}', '"EFM"') WHERE id = 20;
    ALTER TABLE journal_audit ENABLE TRIGGER trg_journal_append_only;`);
  const r = (await a.post('/api/journal/verifier')).data;
  assert.equal(r.integre, false); assert.equal(r.rupture, 20);
  assert.ok((await alertsFor(a, 'integrite_journal')).length >= 1);
  owner.end();
});

live('T6 — connexion hors plage horaire : alerte générée', async () => {
  const a = await admin();
  const h = new Date(Date.now() + 3 * 3600000).toISOString().slice(11, 13); // plage décalée excluant l'heure courante
  await a.put('/api/admin/regles/connexion_hors_plage', { parametres: { debut: `${h}:00`, fin: `${h}:30` } });
  const d = new Client(BASE); await d.login('w.jakjoud', 'Directeur@2026');
  assert.ok((await alertsFor(a, 'connexion_hors_plage')).some((x) => x.titre.includes('w.jakjoud')));
  await a.put('/api/admin/regles/connexion_hors_plage', { parametres: { debut: '07:00', fin: '19:00' } });
});

live('T7 — volume anormal de saisies sur une courte période : alerte', async () => {
  const a = await admin();
  await a.put('/api/admin/regles/volume_modifications', { parametres: { seuil: 10, fenetre_minutes: 10 } });
  const f = await as('m.elaloui');
  const sheet = (await f.get('/api/notes?groupe_id=4&module_id=2&type_eval=CC1')).data;
  const r = await f.put('/api/notes', { groupe_id: 4, module_id: 2, type_eval: 'CC1', notes: sheet.lignes.map((l, i) => ({ stagiaire_id: l.stagiaire_id, valeur: 8 + (i % 10) })) });
  assert.equal(r.status, 200);
  assert.ok((await alertsFor(a, 'volume_modifications')).length >= 1);
  await a.put('/api/admin/regles/volume_modifications', { parametres: { seuil: 20, fenetre_minutes: 10 } });
});

// ---------- Espaces Stagiaire et Parent
async function comptesSuivi() {
  const list = (await (await admin()).get('/api/admin/utilisateurs')).data;
  const stagiaire = list.find((u) => u.role === 'stagiaire' && u.rattachement && u.rattachement.includes('IDOSR201'));
  const parent = list.find((u) => u.role === 'parent');
  if (!sessions[stagiaire.login]) { const c = new Client(BASE); assert.equal((await c.login(stagiaire.login, MDP_STAGIAIRE)).status, 200); sessions[stagiaire.login] = c; }
  if (!sessions[parent.login]) { const c = new Client(BASE); assert.equal((await c.login(parent.login, MDP_PARENT)).status, 200); sessions[parent.login] = c; }
  return { s: sessions[stagiaire.login], p: sessions[parent.login] };
}

live('Stagiaire — consulte uniquement son dossier : notes validées seules, aucune donnée sensible', async () => {
  const { s } = await comptesSuivi();
  const d = await s.get('/api/stagiaire/dossier');
  assert.equal(d.status, 200);
  for (const m of d.data.modules) {
    for (const e of Object.values(m.evaluations)) if (e.etat !== 'publiee') assert.equal(e.valeur, undefined, 'aucune valeur avant validation');
  }
  assert.ok(d.data.modules.some((m) => Object.values(m.evaluations).some((e) => e.etat === 'en_validation')));
  assert.doesNotMatch(JSON.stringify(d.data), /cin|telephone|naissance/i, 'minimisation des données personnelles');
  assert.equal((await s.get('/api/notes?groupe_id=1&module_id=1&type_eval=CC1')).status, 403);
  assert.equal((await s.get('/api/journal')).status, 403);
  assert.equal((await s.get('/api/parent/enfants')).status, 403);
});

live('T8 — un parent tente de consulter le dossier d\'un autre stagiaire : refusé et tracé', async () => {
  const { p } = await comptesSuivi();
  const enfants = (await p.get('/api/parent/enfants')).data;
  assert.ok(enfants.length >= 1);
  assert.equal((await p.get(`/api/parent/enfants/${enfants[0].id}`)).status, 200);
  const autre = [2, 3, 4, 5].find((id) => !enfants.some((e) => e.id === id));
  assert.equal((await p.get(`/api/parent/enfants/${autre}`)).status, 403);
  const j = (await (await admin()).get('/api/journal?action=acces.refuse')).data.entrees;
  assert.ok(j.some((e) => e.acteur_role === 'parent' && e.ressource === `stagiaire:${autre}`));
});

live('Publication — à la validation finale, la note devient visible et le stagiaire et son parent sont notifiés', async () => {
  const { s, p } = await comptesSuivi();
  const d = await as('w.jakjoud');
  const lot = (await d.get('/api/validation/notes')).data.lots.find((l) => l.groupe === 'IDOSR201' && l.module === 'M201' && l.type_eval === 'CC2');
  assert.ok(lot, 'lot IDOSR201 / M201 / CC2 en attente de validation');
  const body = { groupe_id: lot.groupe_id, module_id: lot.module_id, type_eval: 'CC2', decision: 'approuver' };
  const avant = (await s.get('/api/stagiaire/dossier')).data.modules.find((m) => m.code === 'M201').evaluations.CC2;
  assert.equal(avant.etat, 'en_validation', 'soumise mais pas encore validée : la valeur reste masquée');
  assert.equal(avant.valeur, undefined);
  assert.equal((await d.post('/api/validation/notes', body)).status, 200);
  const apres = (await s.get('/api/stagiaire/dossier')).data.modules.find((m) => m.code === 'M201').evaluations.CC2;
  assert.equal(apres.etat, 'publiee'); assert.equal(typeof apres.valeur, 'number');
  assert.ok((await s.get('/api/me/notifications')).data.some((n) => /Nouvelle note publiée : M201/.test(n.message)));
  assert.ok((await p.get('/api/me/notifications')).data.some((n) => /Nouvelle note publiée pour .* M201/.test(n.message)));
});

live('Circuit complet — saisie, soumission, validation par la direction, verrouillage', async () => {
  const f = await as('m.elaloui');
  assert.equal((await f.post('/api/notes/soumettre', { groupe_id: 4, module_id: 2, type_eval: 'CC1' })).status, 200);
  const d = await as('w.jakjoud');
  assert.equal((await d.post('/api/validation/notes', { groupe_id: 4, module_id: 2, type_eval: 'CC1', decision: 'approuver' })).status, 200);
  const sheet = (await f.get('/api/notes?groupe_id=4&module_id=2&type_eval=CC1')).data;
  assert.ok(sheet.lignes.every((l) => l.statut === 'validee'));
  const r = await f.put('/api/notes', { groupe_id: 4, module_id: 2, type_eval: 'CC1', notes: [{ stagiaire_id: sheet.lignes[0].stagiaire_id, valeur: 20 }] });
  assert.equal(r.data.ignorees, 1, 'une note validée ne peut plus être modifiée par le formateur');
});

live('T9 — le gestionnaire des stagiaires n\'accède ni aux notes ni à la validation des séances', async () => {
  const g = await as('e.talil');
  assert.equal((await g.get('/api/validation/notes')).status, 403);
  assert.equal((await g.post('/api/validation/notes', { groupe_id: 1, module_id: 2, type_eval: 'CC2', decision: 'approuver' })).status, 403);
  assert.equal((await g.get('/api/notes?groupe_id=1&module_id=2&type_eval=CC1')).status, 403);
  assert.equal((await g.get('/api/export/lots')).status, 403);
  assert.equal((await g.get('/api/validation/seances')).status, 403);
  assert.equal((await g.get('/api/seances')).status, 403);
  assert.equal((await g.get('/api/stats')).status, 403);
  const j = (await (await admin()).get('/api/journal?action=acces.refuse&acteur=e.talil')).data.entrees;
  assert.ok(j.length >= 7, 'chaque tentative est tracée « ACCÈS REFUSÉ »');
});

live('Absences — le gestionnaire justifie une absence : tracée, visible par le stagiaire et notifiée', async () => {
  const { s } = await comptesSuivi();
  const g = await as('e.talil');
  const moi = (await s.get('/api/stagiaire/dossier')).data;
  const abs = (await g.get(`/api/absences?q=${moi.stagiaire.cef}&statut=non_justifiees`)).data[0];
  assert.ok(abs, 'au moins une absence non justifiée pour le stagiaire de démonstration');
  const r = await g.post('/api/absences/justification', { seance_id: abs.seance_id, stagiaire_id: abs.stagiaire_id, motif: 'certificat_medical', commentaire: 'Certificat de 1 jour' });
  assert.equal(r.status, 200);
  const apres = (await s.get('/api/stagiaire/dossier')).data;
  assert.ok(apres.absences.some((a) => a.justification === 'certificat_medical'));
  assert.ok(!JSON.stringify(apres).includes('Certificat de 1 jour'), 'le commentaire n\'est pas transmis au stagiaire');
  assert.ok((await s.get('/api/me/notifications')).data.some((n) => /a été justifiée/.test(n.message)));
  const j = (await g.get('/api/journal?action=absence.')).data.entrees;
  assert.ok(j.length >= 1 && j.every((e) => e.action.startsWith('absence.')), 'journal partiel : absences uniquement');
  assert.equal((await g.post('/api/absences/justification', { seance_id: 99999, stagiaire_id: abs.stagiaire_id, motif: 'autre' })).status, 404);
});

live('Injection SQL — les entrées malveillantes sont neutralisées', async () => {
  const c = new Client(BASE);
  const r = await c.post('/api/auth/login', { login: "admin.dr' OR '1'='1", password: "' OR 1=1 --" });
  assert.equal(r.status, 401);
});

live('En-têtes de sécurité HTTP présents', async () => {
  const r = await fetch(BASE + '/');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
});
