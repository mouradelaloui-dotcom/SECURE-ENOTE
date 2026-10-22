'use strict';
/** Client HTTP de test avec gestion des cookies et du jeton anti-CSRF. */
class Client {
  constructor(base, ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/130.0 Test') { this.base = base; this.cookies = {}; this.csrf = null; this.ua = ua; }
  async req(method, path, body) {
    const headers = { 'User-Agent': this.ua, Cookie: Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ') };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (this.csrf) headers['X-CSRF-Token'] = this.csrf;
    const r = await fetch(this.base + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    for (const c of r.headers.getSetCookie()) {
      const [kv] = c.split(';'); const i = kv.indexOf('=');
      const v = kv.slice(i + 1);
      if (v) this.cookies[kv.slice(0, i)] = v; else delete this.cookies[kv.slice(0, i)];
    }
    const ct = r.headers.get('content-type') || '';
    const data = ct.includes('json') ? await r.json() : await r.text();
    return { status: r.status, data, headers: r.headers };
  }
  get(p) { return this.req('GET', p); }
  post(p, b = {}) { return this.req('POST', p, b); }
  put(p, b = {}) { return this.req('PUT', p, b); }
  del(p) { return this.req('DELETE', p); }

  /** Connexion complète (mot de passe + code TOTP lu via le point de démonstration). */
  async login(login, password) {
    const a = await this.post('/api/auth/login', { login, password });
    if (a.status !== 200) return a;
    let c = await this.get('/api/auth/demo-code');
    let b = await this.post('/api/auth/mfa', { code: c.data.code });
    if (b.status === 401) {
      // Anti-rejeu : un code déjà utilisé pour ce compte est refusé ; on attend le pas suivant (30 s).
      await new Promise((r) => setTimeout(r, (c.data.secondes + 1) * 1000));
      c = await this.get('/api/auth/demo-code');
      b = await this.post('/api/auth/mfa', { code: c.data.code });
    }
    if (b.status === 200) this.csrf = b.data.csrf;
    return b;
  }
}
module.exports = { Client };
