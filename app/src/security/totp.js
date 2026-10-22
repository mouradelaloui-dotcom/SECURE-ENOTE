'use strict';
/**
 * TOTP conforme RFC 6238 (HOTP RFC 4226), HMAC-SHA1, 6 chiffres, pas de 30 s.
 * Compatible Google Authenticator / Microsoft Authenticator / FreeOTP.
 */
const crypto = require('node:crypto');

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0; let value = 0; let out = '';
  for (const byte of buf) {
    value = (value << 8) | byte; bits += 8;
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5; }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(str) {
  const clean = str.replace(/=+$/, '').replace(/\s+/g, '').toUpperCase();
  let bits = 0; let value = 0; const out = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx === -1) throw new Error('Secret base32 invalide');
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8; }
  }
  return Buffer.from(out);
}

function generateSecret() { return base32Encode(crypto.randomBytes(20)); } // 160 bits (RFC 4226 §4)

function hotp(secretB32, counter) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', base32Decode(secretB32)).update(msg).digest();
  const offset = h[h.length - 1] & 0x0f;                       // troncature dynamique
  const bin = ((h[offset] & 0x7f) << 24) | (h[offset + 1] << 16) | (h[offset + 2] << 8) | h[offset + 3];
  return String(bin % 1_000_000).padStart(6, '0');
}

const STEP = 30;
const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP);
const generate = (secret, now = Date.now()) => hotp(secret, currentStep(now));

/**
 * Vérifie un code avec une tolérance de ±1 pas (dérive d'horloge).
 * Retourne le pas utilisé (pour l'anti-rejeu) ou null.
 */
function verify(secret, code, lastUsedStep = 0, now = Date.now()) {
  if (!/^\d{6}$/.test(String(code || ''))) return null;
  const step = currentStep(now);
  for (const s of [step, step - 1, step + 1]) {
    const expected = hotp(secret, s);
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(code))) && s > lastUsedStep) return s;
  }
  return null;
}

function otpauthUri(secret, login, issuer = 'SECURE-eNOTE') {
  return `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(login)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`;
}

const secondsRemaining = (now = Date.now()) => STEP - (Math.floor(now / 1000) % STEP);

module.exports = { generateSecret, generate, verify, hotp, otpauthUri, base32Encode, base32Decode, secondsRemaining, currentStep };
