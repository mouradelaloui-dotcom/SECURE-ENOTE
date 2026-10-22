'use strict';
/**
 * Client PostgreSQL minimal (protocole frontend/backend v3), sans dépendance externe.
 * - Authentification SCRAM-SHA-256 (défaut PostgreSQL >= 14), MD5 et cleartext
 * - Requêtes paramétrées (protocole étendu Parse/Bind/Execute) : aucune
 *   concaténation de valeurs dans le SQL => protection contre l'injection SQL.
 * - Pool de connexions et transactions.
 *
 * Choix "zéro dépendance" : réduit la surface d'attaque de la chaîne
 * d'approvisionnement logicielle (OWASP Top 10 — composants vulnérables).
 */
const net = require('node:net');
const crypto = require('node:crypto');

class PgError extends Error {
  constructor(fields) {
    super(fields.M || 'Erreur PostgreSQL');
    this.code = fields.C;
    this.severity = fields.S;
    this.detail = fields.D;
    this.constraint = fields.n;
  }
}

function cstr(s) { return Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]); }
function i32(n) { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; }
function i16(n) { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; }
function msg(type, body) {
  const head = Buffer.alloc(5);
  head.write(type, 0, 'ascii');
  head.writeInt32BE(body.length + 4, 1);
  return Buffer.concat([head, body]);
}

function encodeParam(v) {
  if (v === null || v === undefined) return null;
  if (Buffer.isBuffer(v)) return Buffer.from('\\x' + v.toString('hex'), 'utf8');
  if (v instanceof Date) return Buffer.from(v.toISOString(), 'utf8');
  if (typeof v === 'boolean') return Buffer.from(v ? 't' : 'f');
  if (typeof v === 'object') return Buffer.from(JSON.stringify(v), 'utf8');
  return Buffer.from(String(v), 'utf8');
}

function parseValue(oid, text) {
  if (text === null) return null;
  switch (oid) {
    case 16: return text === 't';
    case 20: case 21: case 23: case 26: return parseInt(text, 10);
    case 700: case 701: case 1700: return parseFloat(text);
    case 114: case 3802: return JSON.parse(text);
    case 17: return Buffer.from(text.slice(2), 'hex');
    case 1184: case 1114: {
      // TimeZone=UTC imposé à la connexion : "2026-10-17 13:41:12.123+00"
      let s = text.replace(' ', 'T');
      if (/[+-]00$/.test(s)) s = s.slice(0, -3) + 'Z';
      else if (!/[Zz]|[+-]\d\d(:?\d\d)?$/.test(s)) s += 'Z';
      return new Date(s).toISOString();
    }
    case 1082: return text; // date
    default: return text;
  }
}

class Connection {
  constructor(opts) {
    this.opts = opts;
    this.buf = Buffer.alloc(0);
    this.queue = [];
    this.current = null;
    this.ready = false;
    this.dead = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      const { host = '127.0.0.1', port = 5432 } = this.opts;
      this.socket = net.createConnection({ host, port });
      this.socket.setNoDelay(true);
      this._onReady = resolve;
      this._onFail = reject;
      this.socket.on('connect', () => {
        const params = Buffer.concat([
          cstr('user'), cstr(this.opts.user),
          cstr('database'), cstr(this.opts.database),
          cstr('client_encoding'), cstr('UTF8'),
          cstr('TimeZone'), cstr('UTC'),
          cstr('application_name'), cstr('secure-enote'),
          Buffer.from([0]),
        ]);
        const body = Buffer.concat([i32(196608), params]);
        this.socket.write(Buffer.concat([i32(body.length + 4), body]));
      });
      this.socket.on('data', (d) => this._onData(d));
      this.socket.on('error', (e) => this._die(e));
      this.socket.on('close', () => this._die(new Error('Connexion PostgreSQL fermée')));
    });
  }

  _die(err) {
    if (this.dead) return;
    this.dead = true;
    if (!this.ready && this._onFail) this._onFail(err);
    if (this.current) { this.current.reject(err); this.current = null; }
    for (const q of this.queue) q.reject(err);
    this.queue = [];
  }

  _onData(d) {
    this.buf = Buffer.concat([this.buf, d]);
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) break;
      const type = String.fromCharCode(this.buf[0]);
      const body = this.buf.subarray(5, len + 1);
      this.buf = this.buf.subarray(len + 1);
      try { this._handle(type, body); } catch (e) { this._die(e); }
    }
  }

  _parseFields(body) {
    const f = {};
    let i = 0;
    while (i < body.length && body[i] !== 0) {
      const code = String.fromCharCode(body[i]);
      const end = body.indexOf(0, i + 1);
      f[code] = body.toString('utf8', i + 1, end);
      i = end + 1;
    }
    return f;
  }

  _handle(type, body) {
    switch (type) {
      case 'R': return this._auth(body);
      case 'S': case 'K': case 'N': return; // ParameterStatus, BackendKeyData, Notice
      case 'Z':
        if (!this.ready) { this.ready = true; this._onReady(this); return; }
        if (this.current) {
          const c = this.current; this.current = null;
          if (c.error) c.reject(c.error); else c.resolve(c.result);
        }
        return this._next();
      case 'E': {
        const err = new PgError(this._parseFields(body));
        if (!this.ready) return this._die(err);
        if (this.current) this.current.error = err;
        return;
      }
      case '1': case '2': case 'n': case 's': case 'I': return;
      case 'T': {
        const n = body.readInt16BE(0); let i = 2; const fields = [];
        for (let k = 0; k < n; k++) {
          const end = body.indexOf(0, i);
          const name = body.toString('utf8', i, end); i = end + 1;
          const oid = body.readInt32BE(i + 6); i += 18;
          fields.push({ name, oid });
        }
        if (this.current) this.current.result.fields = fields;
        return;
      }
      case 'D': {
        const c = this.current; if (!c) return;
        const n = body.readInt16BE(0); let i = 2; const row = {};
        for (let k = 0; k < n; k++) {
          const len = body.readInt32BE(i); i += 4;
          const f = c.result.fields[k];
          if (len === -1) { row[f.name] = null; continue; }
          row[f.name] = parseValue(f.oid, body.toString('utf8', i, i + len)); i += len;
        }
        c.result.rows.push(row);
        return;
      }
      case 'C': {
        const tag = body.toString('utf8', 0, body.length - 1);
        if (this.current) {
          const m = tag.match(/(\d+)$/);
          this.current.result.command = tag.split(' ')[0];
          this.current.result.rowCount = m ? parseInt(m[1], 10) : 0;
        }
        return;
      }
      default: return;
    }
  }

  _auth(body) {
    const code = body.readInt32BE(0);
    const { user, password = '' } = this.opts;
    if (code === 0) return;
    if (code === 3) return this.socket.write(msg('p', cstr(password)));
    if (code === 5) {
      const salt = body.subarray(4, 8);
      const inner = crypto.createHash('md5').update(password + user).digest('hex');
      const outer = crypto.createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex');
      return this.socket.write(msg('p', cstr('md5' + outer)));
    }
    if (code === 10) {
      this.scram = { nonce: crypto.randomBytes(18).toString('base64') };
      this.scram.clientFirstBare = 'n=*,r=' + this.scram.nonce;
      const first = Buffer.from('n,,' + this.scram.clientFirstBare);
      return this.socket.write(msg('p', Buffer.concat([cstr('SCRAM-SHA-256'), i32(first.length), first])));
    }
    if (code === 11) {
      const serverFirst = body.toString('utf8', 4);
      const attrs = Object.fromEntries(serverFirst.split(',').map((p) => [p[0], p.slice(2)]));
      if (!attrs.r.startsWith(this.scram.nonce)) throw new Error('SCRAM : nonce serveur invalide');
      const salted = crypto.pbkdf2Sync(password.normalize('NFKC'), Buffer.from(attrs.s, 'base64'), parseInt(attrs.i, 10), 32, 'sha256');
      const clientKey = crypto.createHmac('sha256', salted).update('Client Key').digest();
      const storedKey = crypto.createHash('sha256').update(clientKey).digest();
      const finalNoProof = 'c=biws,r=' + attrs.r;
      const authMessage = this.scram.clientFirstBare + ',' + serverFirst + ',' + finalNoProof;
      const sig = crypto.createHmac('sha256', storedKey).update(authMessage).digest();
      const proof = Buffer.alloc(32); for (let k = 0; k < 32; k++) proof[k] = clientKey[k] ^ sig[k];
      const serverKey = crypto.createHmac('sha256', salted).update('Server Key').digest();
      this.scram.expected = crypto.createHmac('sha256', serverKey).update(authMessage).digest('base64');
      return this.socket.write(msg('p', Buffer.from(finalNoProof + ',p=' + proof.toString('base64'))));
    }
    if (code === 12) {
      const v = body.toString('utf8', 4).split(',').find((p) => p.startsWith('v='));
      if (!v || v.slice(2) !== this.scram.expected) throw new Error('SCRAM : signature serveur invalide');
      return;
    }
    throw new Error('Méthode d\'authentification PostgreSQL non supportée : ' + code);
  }

  query(text, params) {
    return new Promise((resolve, reject) => {
      if (this.dead) return reject(new Error('Connexion PostgreSQL indisponible'));
      this.queue.push({ text, params, resolve, reject });
      if (!this.current) this._next();
    });
  }

  _next() {
    if (this.current || !this.queue.length || this.dead) return;
    const q = this.queue.shift();
    this.current = { ...q, result: { rows: [], fields: [], rowCount: 0 } };
    if (q.params === undefined) {
      this.socket.write(msg('Q', cstr(q.text)));
      return;
    }
    const params = q.params.map(encodeParam);
    const parts = [i16(0), i16(params.length)];
    for (const p of params) {
      if (p === null) parts.push(i32(-1)); else parts.push(i32(p.length), p);
    }
    parts.push(i16(1), i16(0));
    this.socket.write(Buffer.concat([
      msg('P', Buffer.concat([cstr(''), cstr(q.text), i16(0)])),
      msg('B', Buffer.concat([cstr(''), cstr(''), ...parts])),
      msg('D', Buffer.concat([Buffer.from('P'), cstr('')])),
      msg('E', Buffer.concat([cstr(''), i32(0)])),
      msg('S', Buffer.alloc(0)),
    ]));
  }

  end() { this.dead = true; try { this.socket.write(msg('X', Buffer.alloc(0))); this.socket.end(); } catch { /* ignore */ } }
}

class Pool {
  constructor(opts) { this.opts = opts; this.max = opts.max || 10; this.idle = []; this.count = 0; this.waiters = []; }

  async _acquire() {
    while (this.idle.length) {
      const c = this.idle.pop();
      if (!c.dead) return c;
      this.count--;
    }
    if (this.count < this.max) {
      this.count++;
      try { return await new Connection(this.opts).connect(); } catch (e) { this.count--; throw e; }
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  _release(c) {
    if (c.dead) { this.count--; return; }
    const w = this.waiters.shift();
    if (w) w(c); else this.idle.push(c);
  }

  async query(text, params = []) {
    const c = await this._acquire();
    try { return await c.query(text, params); } finally { this._release(c); }
  }

  /** Exécute fn(client) dans une transaction (BEGIN/COMMIT/ROLLBACK). */
  async tx(fn) {
    const c = await this._acquire();
    const hooks = [];
    const client = { query: (t, p = []) => c.query(t, p), afterCommit: (h) => hooks.push(h) };
    try {
      await c.query('BEGIN', []);
      const r = await fn(client);
      await c.query('COMMIT', []);
      for (const h of hooks) h(); // ex. : notification du moteur de détection une fois les données visibles
      return r;
    } catch (e) {
      try { await c.query('ROLLBACK', []); } catch { /* ignore */ }
      throw e;
    } finally { this._release(c); }
  }

  /** Requête "simple" multi-instructions (migrations). */
  async exec(sql) {
    const c = await this._acquire();
    try { return await c.query(sql); } finally { this._release(c); }
  }

  end() { for (const c of this.idle) c.end(); this.idle = []; }
}

module.exports = { Pool, PgError };
