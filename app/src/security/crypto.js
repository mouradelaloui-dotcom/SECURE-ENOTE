'use strict';
/**
 * Module de chiffrement (H4).
 * - Clé maîtresse fournie hors base (variable/secret Docker), jamais stockée en base.
 * - Dérivation de sous-clés indépendantes par HKDF-SHA256 (séparation des usages).
 * - Chiffrement authentifié AES-256-GCM, IV aléatoire de 96 bits par opération.
 * - Format : "v1:<iv b64>:<tag b64>:<données b64>" (le préfixe permet la rotation de clés).
 */
const crypto = require('node:crypto');

let keys = null;

function init(masterKeyB64) {
  const master = Buffer.from(masterKeyB64 || '', 'base64');
  if (master.length !== 32) {
    throw new Error('ENOTE_MASTER_KEY doit contenir exactement 32 octets encodés en base64');
  }
  const derive = (info) => Buffer.from(crypto.hkdfSync('sha256', master, Buffer.from('secure-enote'), Buffer.from(info), 32));
  keys = {
    data: derive('donnees-pedagogiques'),
    mfa: derive('secrets-mfa'),
    backup: derive('sauvegardes'),
  };
}

function key(usage) {
  if (!keys) throw new Error('Module de chiffrement non initialisé');
  return keys[usage];
}

function encrypt(plaintext, usage = 'data') {
  if (plaintext === null || plaintext === undefined) return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(usage), iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), data.toString('base64')].join(':');
}

function decrypt(token, usage = 'data') {
  if (token === null || token === undefined) return null;
  const [v, iv, tag, data] = String(token).split(':');
  if (v !== 'v1') throw new Error('Format de chiffrement inconnu');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(usage), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64')); // toute altération => exception
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

/** Chiffrement de fichiers binaires (sauvegardes) : en-tête magique | iv | tag | données */
function encryptBuffer(buf) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key('backup'), iv);
  const data = Buffer.concat([cipher.update(buf), cipher.final()]);
  return Buffer.concat([Buffer.from('ENOTEBK1'), iv, cipher.getAuthTag(), data]);
}
function decryptBuffer(buf) {
  if (buf.subarray(0, 8).toString() !== 'ENOTEBK1') throw new Error('Fichier de sauvegarde non reconnu');
  const iv = buf.subarray(8, 20); const tag = buf.subarray(20, 36);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key('backup'), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(buf.subarray(36)), decipher.final()]);
}

const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');
const randomToken = (bytes = 32) => crypto.randomBytes(bytes).toString('base64url');
const safeEqual = (a, b) => {
  const ba = Buffer.from(String(a)); const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
};

module.exports = { init, encrypt, decrypt, encryptBuffer, decryptBuffer, sha256, randomToken, safeEqual };
