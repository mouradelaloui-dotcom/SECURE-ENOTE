'use strict';
/**
 * Politique de mots de passe et hachage (H1).
 * Hachage : scrypt (fonction à mémoire dure, recommandée par l'OWASP au même titre
 * qu'Argon2id et bcrypt), sel aléatoire de 16 octets, N=2^15, r=8, p=1.
 */
const crypto = require('node:crypto');

const N = 32768; const R = 8; const P = 1; const LEN = 64;
const MAXMEM = 64 * 1024 * 1024;

function hash(password) {
  const salt = crypto.randomBytes(16);
  const dk = crypto.scryptSync(password.normalize('NFKC'), salt, LEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${dk.toString('base64')}`;
}

function verify(password, stored) {
  try {
    const [algo, n, r, p, salt, h] = String(stored).split('$');
    if (algo !== 'scrypt') return false;
    const expected = Buffer.from(h, 'base64');
    const dk = crypto.scryptSync(String(password).normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length,
      { N: +n, r: +r, p: +p, maxmem: MAXMEM });
    return crypto.timingSafeEqual(dk, expected);
  } catch { return false; }
}

// Empreinte factice : permet un temps de réponse constant quand le compte n'existe pas
// (empêche l'énumération des comptes par mesure du temps de réponse).
const DUMMY = hash('compte-inexistant-' + crypto.randomBytes(8).toString('hex'));
function verifyDummy(password) { verify(password, DUMMY); return false; }

// Extrait de mots de passe compromis / triviaux (liste de démonstration ; en production :
// interrogation k-anonyme d'un service de type "Have I Been Pwned").
const COMPROMIS = new Set([
  'password', 'motdepasse', '123456789', '1234567890', 'azerty123', 'azertyuiop', 'qwerty123', 'qwertyuiop',
  'password1', 'password123', 'motdepasse1', 'admin12345', 'administrator', 'welcome123', 'iloveyou1',
  'ofppt2026', 'ofppt2025', 'ofppt123', 'ofppt@2026', 'ofppt@2025', 'maroc2026', 'maroc123', 'safi2026',
  'bonjour123', 'soleil123', 'formateur1', 'formateur123', 'enote2026', 'enote123', 'p@ssw0rd', 'p@ssword1',
  'passw0rd!', 'azerty@123', 'abc123456', '1q2w3e4r5t', 'zaq12wsx', 'changeme123',
]);

/** Retourne la liste des règles non respectées (vide = conforme). */
function checkPolicy(password, login = '') {
  const errors = [];
  const pw = String(password || '');
  if (pw.length < 10) errors.push('au moins 10 caractères');
  if (pw.length > 128) errors.push('au plus 128 caractères');
  if (!/[a-z]/.test(pw)) errors.push('une lettre minuscule');
  if (!/[A-Z]/.test(pw)) errors.push('une lettre majuscule');
  if (!/[0-9]/.test(pw)) errors.push('un chiffre');
  if (!/[^A-Za-z0-9]/.test(pw)) errors.push('un caractère spécial');
  const lower = pw.toLowerCase();
  if (login && lower.includes(String(login).toLowerCase())) errors.push('ne pas contenir l\'identifiant');
  if (COMPROMIS.has(lower)) errors.push('ne pas figurer dans la liste des mots de passe compromis');
  return errors;
}

module.exports = { hash, verify, verifyDummy, checkPolicy };
