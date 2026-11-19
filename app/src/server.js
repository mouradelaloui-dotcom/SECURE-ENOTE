'use strict';
/**
 * SECURE-eNOTE — point d'entrée du serveur.
 * Architecture : Node.js 22 (aucune dépendance externe) + PostgreSQL 16, derrière un
 * reverse-proxy TLS (Nginx) dans la composition Docker.
 */
const http = require('node:http');
const path = require('node:path');
const { URL } = require('node:url');
const config = require('./config');
const { Pool } = require('./lib/pg');
const { Router, HttpError, parseCookies, readJson, securityHeaders, serveStatic, sendJson } = require('./lib/http');
const cryptoSvc = require('./security/crypto');
const anomaly = require('./security/anomaly');
const backup = require('./services/backup');
const { createContext } = require('./context');
const { migrate } = require('./db/migrate');
const { seed, seedSuivi } = require('./db/seed');

const PUBLIC = path.join(__dirname, '..', 'public');

async function createApp() {
  cryptoSvc.init(config.masterKey);
  const db = new Pool({ ...config.db, max: 10 });
  const app = createContext(db);
  const router = new Router();

  // Limitation de débit en mémoire (par IP et par catégorie)
  const buckets = new Map();
  app.rateLimit = (ctx, name, max, minutes) => {
    const key = `${name}|${ctx.ip}`; const now = Date.now();
    const b = buckets.get(key) || { n: 0, reset: now + minutes * 60000 };
    if (now > b.reset) { b.n = 0; b.reset = now + minutes * 60000; }
    b.n++; buckets.set(key, b);
    if (b.n > max) throw new HttpError(429, 'Trop de tentatives depuis votre poste. Patientez quelques minutes.');
  };
  setInterval(() => { const now = Date.now(); for (const [k, b] of buckets) if (now > b.reset) buckets.delete(k); }, 60000).unref();

  async function techLog(niveau, module, message, details = {}) {
    const reference = cryptoSvc.randomToken(6).toUpperCase();
    try {
      await db.query('INSERT INTO journal_technique (niveau, module, message, reference, details) VALUES ($1,$2,$3,$4,$5)',
        [niveau, module, String(message).slice(0, 500), reference, details]);
    } catch { /* la base peut être indisponible */ }
    console.error(JSON.stringify({ t: new Date().toISOString(), niveau, module, message, reference }));
    return reference;
  }
  app.techLog = techLog;

  require('./routes/auth')(router, app);
  require('./routes/notes')(router, app);
  require('./routes/seances')(router, app);
  require('./routes/admin')(router, app);
  require('./routes/suivi')(router, app);
  require('./routes/absences')(router, app);
  require('./routes/edt')(router, app);

  async function handle(req, res) {
    securityHeaders(res, { https: config.https });
    const url = new URL(req.url, 'http://localhost');
    const cookiesOut = [];
    const fwd = String(req.headers['x-forwarded-for'] || '').split(',').map((s) => s.trim()).filter(Boolean);
    const ctx = {
      req, res, method: req.method, path: url.pathname, query: Object.fromEntries(url.searchParams),
      cookies: parseCookies(req.headers.cookie), params: {}, body: {},
      ip: (config.trustProxy && fwd.length ? fwd[fwd.length - 1] : req.socket.remoteAddress || '').replace(/^::ffff:/, ''),
      agent: String(req.headers['user-agent'] || '').slice(0, 300),
      setCookie: (c) => cookiesOut.push(c),
    };
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Méthode non autorisée.');
        if (!serveStatic(PUBLIC, req, res, url.pathname)) throw new HttpError(404, 'Ressource introuvable.');
        return;
      }
      const m = router.match(req.method, url.pathname);
      if (!m) throw new HttpError(404, 'Ressource introuvable.');
      if (m.methodNotAllowed) throw new HttpError(405, 'Méthode non autorisée.');
      ctx.params = m.params;
      ctx.body = await readJson(req);
      let result;
      for (const h of m.route.handlers) result = await h(ctx);
      if (cookiesOut.length) res.setHeader('Set-Cookie', cookiesOut);
      if (result && result.__raw) {
        res.writeHead(200, {
          'Content-Type': result.contentType, 'Cache-Control': 'no-store',
          'Content-Disposition': `attachment; filename="${result.filename}"`, ...result.headers,
        });
        return res.end(result.body);
      }
      sendJson(res, 200, result ?? { ok: true });
    } catch (err) {
      if (cookiesOut.length && !res.headersSent) res.setHeader('Set-Cookie', cookiesOut);
      if (err instanceof HttpError) return sendJson(res, err.status, { erreur: err.message, ...err.extra });
      // Erreur inattendue : message générique pour l'utilisateur, détail dans le journal technique
      const reference = await techLog('erreur', ctx.path, err.message, { methode: ctx.method, code: err.code, pile: String(err.stack || '').split('\n').slice(0, 4) });
      if (!res.headersSent) sendJson(res, 500, { erreur: `Une erreur est survenue, veuillez réessayer. (référence ${reference})` });
    }
  }

  return { db, app, router, handle, techLog };
}

async function start() {
  const m = await migrate();
  const { db, handle, techLog, app } = await createApp();
  if (config.demoData) {
    const s = await seed(db);
    if (s.ok) console.log('Jeu de données de démonstration initialisé.');
    const sv = await seedSuivi(db);
    if (sv.ok) console.log(`Comptes de démonstration Stagiaire / Parent créés : ${sv.comptes.join(', ')}`);
  } else {
    const n = (await db.query("SELECT count(*)::int n FROM utilisateurs WHERE role='administrateur'")).rows[0].n;
    if (!n) console.log('Aucun administrateur : créez le premier compte avec « node src/cli.js creer-admin <identifiant> \"<Nom complet>\" ».');
  }
  anomaly.start(db, (e) => techLog('erreur', 'detection', e.message));
  // Vérification périodique de l'intégrité du journal
  const check = async () => { try { app.setIntegrity(await anomaly.periodicIntegrityCheck()); } catch (e) { techLog('erreur', 'integrite', e.message); } };
  check();
  setInterval(check, 60 * 60 * 1000).unref();
  backup.schedule(db, (e) => techLog('erreur', 'sauvegarde', e.message));
  const server = http.createServer(handle);
  server.headersTimeout = 20000; server.requestTimeout = 30000;
  server.listen(config.port, () => {
    console.log(`SECURE-eNOTE à l'écoute sur le port ${config.port}${config.demoMode ? ' (MODE DÉMONSTRATION)' : ''}${m.skipped ? ' — migrations ignorées' : ''}`);
  });
  const stop = () => { server.close(); db.end(); process.exit(0); };
  process.on('SIGTERM', stop); process.on('SIGINT', stop);
}

if (require.main === module) {
  start().catch((e) => { console.error('Démarrage impossible :', e.message); process.exit(1); });
}

module.exports = { createApp };
