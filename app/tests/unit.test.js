'use strict';
/** Tests unitaires des fonctions de sécurité (exécution : node --test tests/). */
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { estAutorise, PERMISSIONS } = require('../src/security/rbac');
const cryptoSvc = require('../src/security/crypto');
const totp = require('../src/security/totp');
const password = require('../src/security/password');
const audit = require('../src/security/audit');
const qr = require('../src/lib/qr');

cryptoSvc.init(crypto.randomBytes(32).toString('base64'));

test('RBAC — un formateur ne peut pas valider ni contrôler une note', () => {
  assert.equal(estAutorise('formateur', 'note.valider'), false);
  assert.equal(estAutorise('formateur', 'note.controler'), false);
  assert.equal(estAutorise('formateur', 'journal.lire_complet'), false);
});
test('RBAC — notes et séances : formateur puis directrice ; le gestionnaire des stagiaires ne gère que les absences', () => {
  assert.equal(estAutorise('directeur', 'note.valider'), true);
  assert.equal(estAutorise('directeur', 'seance.valider'), true);
  for (const p of ['note.lire_toutes', 'note.controler', 'note.valider', 'export.notes', 'seance.lire_toutes', 'seance.controler', 'seance.valider', 'stats.lire']) {
    assert.equal(estAutorise('gestionnaire', p), false);
  }
  assert.deepEqual(PERMISSIONS.gestionnaire, ['absence.lire', 'absence.justifier', 'journal.lire_partiel', 'edt.consulter', 'stage.consulter', 'stage.gerer']);
});
test('RBAC — séparation des tâches : l\'administrateur ne saisit ni ne valide', () => {
  assert.equal(estAutorise('administrateur', 'note.saisir'), false);
  assert.equal(estAutorise('administrateur', 'note.valider'), false);
  ['comptes.gerer', 'journal.lire_complet', 'alertes.gerer', 'sauvegardes.gerer'].forEach((p) => assert.equal(estAutorise('administrateur', p), true));
});
test('RBAC — rôle inconnu : aucune permission (refus par défaut)', () => {
  assert.equal(estAutorise('pirate', 'note.saisir'), false);
  assert.deepEqual(Object.keys(PERMISSIONS), ['formateur', 'gestionnaire', 'directeur', 'administrateur', 'stagiaire', 'parent']);
});

test('RBAC — stagiaire et parent : lecture seule de leur dossier, aucune autre permission', () => {
  assert.deepEqual(PERMISSIONS.stagiaire, ['dossier.lire_soi', 'edt.consulter', 'stage.lire_soi']);
  assert.deepEqual(PERMISSIONS.parent, ['dossier.lire_enfants']);
  for (const p of ['note.lire_toutes', 'note.lire_propres', 'note.saisir', 'seance.lire_toutes', 'journal.lire_partiel', 'export.notes', 'stats.lire']) {
    assert.equal(estAutorise('stagiaire', p), false); assert.equal(estAutorise('parent', p), false);
  }
  assert.equal(estAutorise('stagiaire', 'dossier.lire_enfants'), false);
  assert.equal(estAutorise('parent', 'dossier.lire_soi'), false);
});

test('Chiffrement — AES-256-GCM aller-retour et IV unique', () => {
  const a = cryptoSvc.encrypt('15.50'); const b = cryptoSvc.encrypt('15.50');
  assert.notEqual(a, b, 'deux chiffrements du même texte doivent différer (IV aléatoire)');
  assert.equal(cryptoSvc.decrypt(a), '15.50');
  assert.ok(!a.includes('15.50'));
});
test('Chiffrement — toute altération du chiffré est détectée (tag GCM)', () => {
  const t = cryptoSvc.encrypt('12.00').split(':');
  const data = Buffer.from(t[3], 'base64'); data[0] ^= 1; t[3] = data.toString('base64');
  assert.throws(() => cryptoSvc.decrypt(t.join(':')));
});
test('Chiffrement — clés dérivées séparées par usage (HKDF)', () => {
  const t = cryptoSvc.encrypt('secret', 'mfa');
  assert.throws(() => cryptoSvc.decrypt(t, 'data'));
});

test('TOTP — vecteur de test officiel RFC 6238 (T = 59 s)', () => {
  const secret = totp.base32Encode(Buffer.from('12345678901234567890'));
  assert.equal(totp.generate(secret, 59 * 1000), '287082');
  assert.equal(totp.generate(secret, 1111111109 * 1000), '081804');
});
test('TOTP — tolérance ±1 pas et anti-rejeu', () => {
  const s = totp.generateSecret(); const now = Date.now();
  const code = totp.generate(s, now);
  const step = totp.verify(s, code, 0, now);
  assert.ok(step);
  assert.equal(totp.verify(s, code, step, now), null, 'un code déjà utilisé est refusé');
  assert.equal(totp.verify(s, totp.generate(s, now - 30000), 0, now) !== null, true);
  assert.equal(totp.verify(s, totp.generate(s, now - 120000), 0, now), null, 'code trop ancien refusé');
  assert.equal(totp.verify(s, 'abcdef'), null);
});

test('Mots de passe — hachage scrypt salé, jamais en clair', () => {
  const h1 = password.hash('Formateur@2026'); const h2 = password.hash('Formateur@2026');
  assert.notEqual(h1, h2); assert.ok(!h1.includes('Formateur'));
  assert.ok(password.verify('Formateur@2026', h1));
  assert.ok(!password.verify('formateur@2026', h1));
});
test('Mots de passe — politique de robustesse', () => {
  assert.ok(password.checkPolicy('court').length > 0);
  assert.ok(password.checkPolicy('ofppt@2026').length > 0);
  assert.ok(password.checkPolicy('Azerty123').length > 0);
  assert.deepEqual(password.checkPolicy('Sal!ma-Ntic-2026'), []);
});

test('Journal chaîné — empreinte stable et sensible à toute modification', () => {
  const e = { horodatage: '2026-10-17T10:00:00.000Z', acteur_id: 1, acteur_login: 'formateur.demo', acteur_role: 'formateur',
    action: 'note.saisie', ressource: 'note:1', details: { valeur: 'x', b: 2 }, ip: '10.0.0.1', hash_precedent: audit.GENESIS };
  const h = audit.computeHash(e);
  assert.equal(audit.computeHash({ ...e, details: { b: 2, valeur: 'x' } }), h, 'ordre des clés JSON sans effet');
  assert.notEqual(audit.computeHash({ ...e, action: 'note.modification' }), h);
  assert.notEqual(audit.computeHash({ ...e, hash_precedent: 'f'.repeat(64) }), h);
});

test('QR code — version adaptée à la longueur des données', () => {
  assert.equal(qr.encode('a').version, 1);
  const uri = totp.otpauthUri(totp.generateSecret(), 'formateur.demo');
  const q = qr.encode(uri);
  assert.ok(q.version >= 6 && q.size === q.version * 4 + 17);
});

test('Journal chaîné — un champ « undefined » n\'altère pas l\'empreinte (forme JSONB)', () => {
  const base = { horodatage: 't', acteur_login: 'x', action: 'note.controle', hash_precedent: audit.GENESIS };
  assert.equal(audit.computeHash({ ...base, details: { notes: 14, motif: undefined } }), audit.computeHash({ ...base, details: { notes: 14 } }));
});
