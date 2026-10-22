'use strict';
/** Authentification multifacteur (H1) : mot de passe + TOTP, verrouillage progressif, enrôlement. */
const config = require('../config');
const password = require('../security/password');
const totp = require('../security/totp');
const cryptoSvc = require('../security/crypto');
const audit = require('../security/audit');
const qr = require('../lib/qr');
const { HttpError, cookie } = require('../lib/http');
const { PERMISSIONS } = require('../security/rbac');

const MAX_ECHECS = 5;
const MSG_ECHEC = 'Identifiant ou mot de passe incorrect.';

function deviceLabel(ua = '') {
  const b = /Edg\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navigateur';
  const o = /Windows/.test(ua) ? 'Windows' : /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : 'Système inconnu';
  return `${b} sur ${o}`;
}

module.exports = function authRoutes(router, app) {
  const { db } = app;

  /** Enregistre un échec et applique le verrouillage progressif (15 min, 30 min, 1 h… max 24 h). */
  async function registerFailure(user, ctx, action) {
    const r = await db.query(
      'UPDATE utilisateurs SET echecs_consecutifs = echecs_consecutifs + 1 WHERE id=$1 RETURNING echecs_consecutifs, nb_verrouillages', [user.id]);
    const { echecs_consecutifs: n, nb_verrouillages: nbv } = r.rows[0];
    await audit.log(db, { acteur: user, action, details: { echecs_consecutifs: n }, ip: ctx.ip });
    if (n >= MAX_ECHECS) {
      const minutes = Math.min(15 * 2 ** nbv, 24 * 60);
      await db.query(
        `UPDATE utilisateurs SET verrouille_jusqua = now() + ($2 || ' minutes')::interval, echecs_consecutifs = 0,
                nb_verrouillages = nb_verrouillages + 1 WHERE id=$1`, [user.id, String(minutes)]);
      await db.query('UPDATE sessions SET revoquee = true WHERE utilisateur_id=$1 AND type=\'pre_mfa\'', [user.id]);
      await audit.log(db, { acteur: user, action: 'auth.verrouillage', details: { duree_minutes: minutes, echecs: n }, ip: ctx.ip });
      throw new HttpError(423, `Compte temporairement verrouillé après ${MAX_ECHECS} échecs consécutifs. Réessayez dans ${minutes} minutes ou contactez l'administrateur.`);
    }
    return n;
  }

  function lockedMessage(u) {
    const min = Math.ceil((new Date(u.verrouille_jusqua) - Date.now()) / 60000);
    return `Compte temporairement verrouillé suite à plusieurs échecs. Réessayez dans ${min} minute${min > 1 ? 's' : ''}.`;
  }

  router.post('/api/auth/login', async (ctx) => {
    app.rateLimit(ctx, 'login', config.rateLimitLogin, 5);
    const login = String(ctx.body.login || '').trim().toLowerCase().slice(0, 60);
    const pwd = String(ctx.body.password || '');
    const r = await db.query('SELECT * FROM utilisateurs WHERE login=$1', [login]);
    const u = r.rows[0];
    if (!u) {
      password.verifyDummy(pwd); // temps de réponse constant
      await audit.log(db, { acteur: { login: login || '(vide)' }, action: 'auth.echec_mot_de_passe', details: { motif: 'compte inconnu' }, ip: ctx.ip });
      throw new HttpError(401, MSG_ECHEC);
    }
    if (u.verrouille_jusqua && new Date(u.verrouille_jusqua) > new Date()) {
      await audit.log(db, { acteur: u, action: 'auth.tentative_compte_verrouille', ip: ctx.ip });
      throw new HttpError(423, lockedMessage(u));
    }
    if (!password.verify(pwd, u.mot_de_passe)) {
      await registerFailure(u, ctx, 'auth.echec_mot_de_passe');
      throw new HttpError(401, MSG_ECHEC);
    }
    if (u.statut !== 'actif') {
      await audit.log(db, { acteur: u, action: 'auth.compte_suspendu', ip: ctx.ip });
      throw new HttpError(403, 'Ce compte est suspendu. Contactez l\'administrateur de l\'application.');
    }
    await db.query('UPDATE sessions SET revoquee = true WHERE utilisateur_id=$1 AND type=\'pre_mfa\'', [u.id]);
    await app.createSession(u.id, 'pre_mfa', ctx);
    await audit.log(db, { acteur: u, action: 'auth.mot_de_passe_valide', details: { etape: 1 }, ip: ctx.ip });
    return { etape: u.mfa_active ? 'mfa' : 'enrolement', nom: u.nom_complet, demo: config.demoMode };
  });

  async function pre(ctx) {
    const s = await app.loadSession(ctx.cookies[app.PRE], 'pre_mfa');
    if (!s) throw new HttpError(401, 'Étape de vérification expirée. Veuillez saisir à nouveau vos identifiants.');
    const u = (await db.query('SELECT * FROM utilisateurs WHERE id=$1', [s.utilisateur_id])).rows[0];
    return { s, u };
  }

  // Enrôlement : génération du secret TOTP et du QR code à scanner
  router.get('/api/auth/mfa/enrolement', async (ctx) => {
    const { u } = await pre(ctx);
    if (u.mfa_active) throw new HttpError(409, 'Le second facteur est déjà configuré pour ce compte.');
    let secret = u.mfa_secret_chiffre ? cryptoSvc.decrypt(u.mfa_secret_chiffre, 'mfa') : null;
    if (!secret) {
      secret = totp.generateSecret();
      await db.query('UPDATE utilisateurs SET mfa_secret_chiffre=$2 WHERE id=$1', [u.id, cryptoSvc.encrypt(secret, 'mfa')]);
    }
    const uri = totp.otpauthUri(secret, u.login);
    return { qr_svg: qr.toSvg(uri, { scale: 5 }), secret: secret.match(/.{1,4}/g).join(' '), login: u.login };
  });

  // Mode démonstration uniquement : affiche le code attendu (jamais en production)
  router.get('/api/auth/demo-code', async (ctx) => {
    if (!config.demoMode) throw new HttpError(404, 'Ressource introuvable.');
    const { u } = await pre(ctx);
    if (!u.mfa_secret_chiffre) return { code: null };
    return { code: totp.generate(cryptoSvc.decrypt(u.mfa_secret_chiffre, 'mfa')), secondes: totp.secondsRemaining() };
  });

  router.post('/api/auth/mfa', async (ctx) => {
    app.rateLimit(ctx, 'mfa', config.rateLimitLogin, 5);
    const { s, u } = await pre(ctx);
    if (u.verrouille_jusqua && new Date(u.verrouille_jusqua) > new Date()) throw new HttpError(423, lockedMessage(u));
    if (!u.mfa_secret_chiffre) throw new HttpError(400, 'Second facteur non configuré.');
    const secret = cryptoSvc.decrypt(u.mfa_secret_chiffre, 'mfa');
    const step = totp.verify(secret, String(ctx.body.code || '').replace(/\s/g, ''), Number(u.mfa_dernier_pas));
    if (step === null) {
      await db.query('UPDATE sessions SET tentatives_mfa = tentatives_mfa + 1 WHERE id=$1', [s.id]);
      await registerFailure(u, ctx, 'auth.echec_mfa');
      throw new HttpError(401, 'Code de vérification invalide ou expiré.');
    }
    const enrolement = !u.mfa_active;
    await db.query(
      `UPDATE utilisateurs SET mfa_active=true, mfa_dernier_pas=$2, echecs_consecutifs=0, nb_verrouillages=0,
              verrouille_jusqua=NULL, derniere_connexion=now() WHERE id=$1`, [u.id, step]);
    await db.query('UPDATE sessions SET revoquee=true WHERE id=$1', [s.id]);
    ctx.setCookie(cookie(app.PRE, '', { maxAge: 0, secure: config.https }));
    if (enrolement) await audit.log(db, { acteur: u, action: 'mfa.enrolement', details: { methode: 'totp' }, ip: ctx.ip });

    // Appareil connu ?
    const empreinte = cryptoSvc.sha256(`${ctx.ip}|${ctx.agent}`).slice(0, 24);
    const libelle = deviceLabel(ctx.agent);
    const known = await db.query('SELECT 1 FROM appareils_connus WHERE utilisateur_id=$1 AND empreinte=$2', [u.id, empreinte]);
    const nbAppareils = (await db.query('SELECT count(*)::int n FROM appareils_connus WHERE utilisateur_id=$1', [u.id])).rows[0].n;
    const nouvel = !known.rows.length && nbAppareils > 0;
    await db.query(
      `INSERT INTO appareils_connus (utilisateur_id, empreinte, libelle) VALUES ($1,$2,$3)
       ON CONFLICT (utilisateur_id, empreinte) DO UPDATE SET dernier_vu = now()`, [u.id, empreinte, `${libelle} — ${ctx.ip}`]);
    if (nouvel) {
      await app.notify(u.id, 'securite', `Nouvelle connexion à votre compte depuis un appareil inconnu (${libelle}, adresse ${ctx.ip}). Si ce n'est pas vous, changez immédiatement votre mot de passe et prévenez l'administrateur.`);
    }
    const { csrf } = await app.createSession(u.id, 'complete', ctx);
    await audit.log(db, { acteur: u, action: 'auth.connexion', details: { mfa: 'totp', nouvel_appareil: nouvel, appareil: libelle }, ip: ctx.ip });
    return { ok: true, csrf, doit_changer_mdp: u.doit_changer_mdp };
  });

  router.post('/api/auth/logout', async (ctx) => {
    const s = await app.loadSession(ctx.cookies[app.SID], 'complete');
    if (s) {
      await db.query('UPDATE sessions SET revoquee=true WHERE id=$1', [s.id]);
      await audit.log(db, { acteur: { id: s.utilisateur_id, login: s.login, role: s.role }, action: 'auth.deconnexion', ip: ctx.ip });
    }
    ctx.setCookie(cookie(app.SID, '', { maxAge: 0, secure: config.https }));
    return { ok: true };
  });

  // ------- Espace personnel
  router.get('/api/me', app.requireAuth, async (ctx) => {
    const n = await db.query('SELECT count(*)::int n FROM notifications WHERE utilisateur_id=$1 AND NOT lue', [ctx.user.id]);
    return {
      utilisateur: { ...ctx.user, etablissement: ctx.session.etablissement },
      permissions: PERMISSIONS[ctx.user.role], csrf: ctx.session.csrf,
      notifications_non_lues: n.rows[0].n, demo: config.demoMode,
      session: { expire_inactivite_min: config.session.idleMinutes },
    };
  });

  router.get('/api/me/notifications', app.requireAuth, async (ctx) => {
    const r = await db.query('SELECT * FROM notifications WHERE utilisateur_id=$1 ORDER BY id DESC LIMIT 30', [ctx.user.id]);
    return r.rows;
  });
  router.post('/api/me/notifications/lues', app.requireAuth, async (ctx) => {
    await db.query('UPDATE notifications SET lue=true WHERE utilisateur_id=$1', [ctx.user.id]);
    return { ok: true };
  });

  router.get('/api/me/securite', app.requireAuth, async (ctx) => {
    const sessions = await db.query(
      `SELECT id, ip, agent, cree_le, derniere_activite, (id = $2) AS courante FROM sessions
        WHERE utilisateur_id=$1 AND type='complete' AND NOT revoquee AND expire_le > now()
          AND derniere_activite > now() - ($3 || ' minutes')::interval ORDER BY id DESC`,
      [ctx.user.id, ctx.session.id, String(config.session.idleMinutes)]);
    const connexions = await db.query(
      `SELECT horodatage, action, ip, details FROM journal_audit WHERE acteur_id=$1 AND action LIKE 'auth.%'
        ORDER BY id DESC LIMIT 12`, [ctx.user.id]);
    const appareils = await db.query('SELECT libelle, premier_vu, dernier_vu FROM appareils_connus WHERE utilisateur_id=$1 ORDER BY dernier_vu DESC', [ctx.user.id]);
    const u = (await db.query('SELECT mdp_change_le, mfa_active FROM utilisateurs WHERE id=$1', [ctx.user.id])).rows[0];
    return { sessions: sessions.rows.map((s) => ({ ...s, agent: deviceLabel(s.agent) })), connexions: connexions.rows, appareils: appareils.rows, ...u };
  });

  router.delete('/api/me/sessions/:id', app.requireAuth, async (ctx) => {
    const r = await db.query('UPDATE sessions SET revoquee=true WHERE id=$1 AND utilisateur_id=$2 RETURNING id', [parseInt(ctx.params.id, 10) || 0, ctx.user.id]);
    if (!r.rows.length) throw new HttpError(404, 'Session introuvable.');
    await app.log(ctx, 'auth.revocation_session', `session:${ctx.params.id}`);
    return { ok: true };
  });

  router.post('/api/me/mot-de-passe', app.requireAuth, async (ctx) => {
    const { actuel = '', nouveau = '' } = ctx.body;
    const u = (await db.query('SELECT * FROM utilisateurs WHERE id=$1', [ctx.user.id])).rows[0];
    if (!password.verify(String(actuel), u.mot_de_passe)) {
      await app.log(ctx, 'compte.echec_changement_mdp', `utilisateur:${u.id}`);
      throw new HttpError(400, 'Le mot de passe actuel est incorrect.');
    }
    const errors = password.checkPolicy(nouveau, u.login);
    if (errors.length) throw new HttpError(400, 'Le nouveau mot de passe doit contenir : ' + errors.join(', ') + '.', { regles: errors });
    const history = [u.mot_de_passe, ...(u.historique_mdp || [])].slice(0, 3);
    if (history.some((h) => password.verify(nouveau, h))) throw new HttpError(400, 'Ce mot de passe a déjà été utilisé récemment. Choisissez-en un nouveau.');
    await db.query(
      'UPDATE utilisateurs SET mot_de_passe=$2, historique_mdp=$3, mdp_change_le=now(), doit_changer_mdp=false WHERE id=$1',
      [u.id, password.hash(nouveau), history]);
    await db.query('UPDATE sessions SET revoquee=true WHERE utilisateur_id=$1 AND id <> $2', [u.id, ctx.session.id]);
    await app.log(ctx, 'compte.changement_mdp', `utilisateur:${u.id}`, { autres_sessions_revoquees: true });
    return { ok: true };
  });
};
