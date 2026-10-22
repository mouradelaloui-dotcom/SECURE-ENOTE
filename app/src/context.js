'use strict';
/** Services partagés par les routes : base, sessions, contrôle d'accès, journalisation. */
const config = require('./config');
const audit = require('./security/audit');
const { estAutorise, PERMISSIONS } = require('./security/rbac');
const cryptoSvc = require('./security/crypto');
const { HttpError, cookie } = require('./lib/http');

function createContext(db) {
  const SID = 'enote_sid'; const PRE = 'enote_pre';

  async function createSession(userId, type, ctx) {
    const token = cryptoSvc.randomToken(32);
    const csrf = cryptoSvc.randomToken(24);
    const minutes = type === 'pre_mfa' ? config.session.preMfaMinutes : config.session.absoluteHours * 60;
    await db.query(
      `INSERT INTO sessions (jeton_hash, utilisateur_id, type, csrf, ip, agent, expire_le)
       VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' minutes')::interval)`,
      [cryptoSvc.sha256(token), userId, type, csrf, ctx.ip, ctx.agent, String(minutes)]);
    ctx.setCookie(cookie(type === 'pre_mfa' ? PRE : SID, token, { secure: config.https, maxAge: minutes * 60 }));
    return { csrf };
  }

  async function loadSession(token, type) {
    if (!token || token.length > 100) return null;
    const r = await db.query(
      `SELECT s.*, u.login, u.nom_complet, u.role, u.statut, u.doit_changer_mdp, u.mfa_active, u.etablissement
         FROM sessions s JOIN utilisateurs u ON u.id = s.utilisateur_id
        WHERE s.jeton_hash = $1 AND s.type = $2 AND NOT s.revoquee AND s.expire_le > now()
          AND ($2 = 'pre_mfa' OR s.derniere_activite > now() - ($3 || ' minutes')::interval)`,
      [cryptoSvc.sha256(token), type, String(config.session.idleMinutes)]);
    const s = r.rows[0];
    if (!s || s.statut !== 'actif') return null;
    return s;
  }

  /** Authentifie la requête (session complète) et vérifie le jeton anti-CSRF. */
  async function authenticate(ctx) {
    const s = await loadSession(ctx.cookies[SID], 'complete');
    if (!s) throw new HttpError(401, 'Session expirée ou invalide. Veuillez vous reconnecter.');
    if (!['GET', 'HEAD'].includes(ctx.method)) {
      const header = ctx.req.headers['x-csrf-token'] || '';
      if (!cryptoSvc.safeEqual(header, s.csrf)) throw new HttpError(403, 'Requête refusée (jeton de sécurité invalide).');
    }
    await db.query('UPDATE sessions SET derniere_activite = now() WHERE id = $1', [s.id]);
    ctx.session = s;
    ctx.user = { id: s.utilisateur_id, login: s.login, role: s.role, nom: s.nom_complet, doit_changer_mdp: s.doit_changer_mdp };
    if (s.doit_changer_mdp && !ctx.path.startsWith('/api/me')) {
      throw new HttpError(403, 'Vous devez d\'abord changer votre mot de passe provisoire.', { code: 'CHANGER_MDP' });
    }
  }

  async function denied(ctx, ressource, raison) {
    await audit.log(db, { acteur: ctx.user, action: 'acces.refuse', ressource, details: { raison, methode: ctx.method, chemin: ctx.path }, ip: ctx.ip });
    throw new HttpError(403, 'Action non autorisée pour votre profil.');
  }

  /** Garde de route : authentification + permission RBAC (au moins une parmi la liste). */
  function requirePerm(...perms) {
    return async (ctx) => {
      await authenticate(ctx);
      if (!perms.some((p) => estAutorise(ctx.user.role, p))) await denied(ctx, ctx.path, `permission requise : ${perms.join(' | ')}`);
    };
  }
  const requireAuth = async (ctx) => authenticate(ctx);
  const can = (ctx, perm) => estAutorise(ctx.user.role, perm);

  /** Contrôle de périmètre côté serveur (protection contre la manipulation d'URL / IDOR). */
  async function checkScope(ctx, groupeId, moduleId) {
    if (can(ctx, 'note.lire_toutes') || can(ctx, 'seance.lire_toutes')) return true;
    const r = await db.query('SELECT 1 FROM affectations WHERE formateur_id=$1 AND groupe_id=$2 AND module_id=$3',
      [ctx.user.id, groupeId, moduleId]);
    if (!r.rows.length) await denied(ctx, `groupe:${groupeId}/module:${moduleId}`, 'hors périmètre d\'affectation');
    return true;
  }

  const log = (ctx, action, ressource, details = {}) => audit.log(db, { acteur: ctx.user, action, ressource, details, ip: ctx.ip });

  async function notify(userId, type, message) {
    await db.query('INSERT INTO notifications (utilisateur_id, type, message) VALUES ($1,$2,$3)', [userId, type, message]);
  }

  /**
   * Notifie les stagiaires concernés et leurs parents rattachés. Aucune note en clair dans le message :
   * la valeur n'est visible qu'après authentification, dans l'espace personnel.
   */
  async function notifyFamille(stagiaireIds, type, messageStagiaire, messageParent) {
    if (!stagiaireIds.length) return;
    const r = await db.query(
      `SELECT s.id, s.prenom, s.nom, s.utilisateur_id, ps.parent_id FROM stagiaires s
         LEFT JOIN parents_stagiaires ps ON ps.stagiaire_id = s.id
        WHERE s.id IN (SELECT jsonb_array_elements_text($1::jsonb)::int)`, [[...new Set(stagiaireIds)]]);
    const vus = new Set();
    for (const x of r.rows) {
      if (x.utilisateur_id && !vus.has(`s${x.id}`)) { vus.add(`s${x.id}`); await notify(x.utilisateur_id, type, messageStagiaire(x)); }
      if (x.parent_id && !vus.has(`p${x.parent_id}:${x.id}`)) { vus.add(`p${x.parent_id}:${x.id}`); await notify(x.parent_id, type, messageParent(x)); }
    }
  }

  return { db, createSession, loadSession, authenticate, requirePerm, requireAuth, can, checkScope, denied, log, notify, notifyFamille, SID, PRE, PERMISSIONS };
}

module.exports = { createContext };
