import { h, icon, toast, banner, ROLES, fmtDateTime, modal } from './ui.js';
import { state, get, post, ApiError } from './api.js';
import * as formateur from './views/formateur.js';
import * as gestion from './views/gestion.js';
import * as admin from './views/admin.js';
import * as compte from './views/compte.js';
import * as suivi from './views/suivi.js';
import * as absences from './views/absences.js';

const root = document.getElementById('app');

const NAV = {
  formateur: [['#/', 'home', 'Tableau de bord'], ['#/notes', 'notes', 'Saisie des notes'], ['#/seances', 'calendar', 'Mes séances'], ['#/compte', 'lock', 'Sécurité du compte']],
  gestionnaire: [['#/', 'home', 'Tableau de bord'], ['#/absences', 'calendar', 'Absences et justificatifs'],
    ['#/journal', 'log', 'Journal des opérations'], ['#/compte', 'lock', 'Sécurité du compte']],
  directeur: [['#/', 'home', 'Tableau de bord'], ['#/validation-notes', 'check', 'Validation des notes'], ['#/validation-seances', 'calendar', 'Validation des séances'],
    ['#/performance', 'chart', 'Performance formateurs'], ['#/exports', 'download', 'Exports traçés'], ['#/journal', 'log', 'Journal des opérations'], ['#/compte', 'lock', 'Sécurité du compte']],
  administrateur: [['#/', 'shield', 'Centre de sécurité'], ['#/alertes', 'alert', 'Alertes'], ['#/journal', 'log', 'Journal d\'audit'],
    ['#/utilisateurs', 'users', 'Comptes et rôles'], ['#/regles', 'sliders', 'Règles de détection'], ['#/sauvegardes', 'database', 'Sauvegardes et reprise'],
    ['#/notes-validees', 'edit', 'Notes validées'], ['#/performance', 'chart', 'Performance formateurs'], ['#/technique', 'wrench', 'Journal technique'], ['#/compte', 'lock', 'Sécurité du compte']],
  stagiaire: [['#/', 'cap', 'Mes notes'], ['#/absences', 'calendar', 'Mes absences'], ['#/compte', 'lock', 'Sécurité du compte']],
  parent: [['#/', 'family', 'Suivi de mes enfants'], ['#/compte', 'lock', 'Sécurité du compte']],
};

const ROUTES = {
  formateur: { '/': formateur.dashboard, '/notes': formateur.notes, '/seances': formateur.seances },
  gestionnaire: { '/': absences.dashboard, '/absences': absences.liste, '/journal': admin.journal },
  directeur: { '/': gestion.dashboard, '/validation-notes': gestion.lotsNotes, '/validation-seances': gestion.seances, '/performance': admin.performance, '/exports': gestion.exports, '/journal': admin.journal },
  administrateur: { '/': admin.dashboard, '/alertes': admin.alertes, '/journal': admin.journal, '/utilisateurs': admin.utilisateurs, '/regles': admin.regles,
    '/sauvegardes': admin.sauvegardes, '/notes-validees': admin.notesValidees, '/performance': admin.performance, '/technique': admin.technique },
  stagiaire: { '/': suivi.mesNotes, '/absences': suivi.mesAbsences },
  parent: { '/': suivi.enfants, '/enfant': suivi.enfant },
};

const ofppt = (cls = '') => h('img', { class: `ofppt-logo ${cls}`, src: '/img/ofppt.png', alt: 'OFPPT' });

function logo(light = false) {
  return h('div', { class: `logo ${light ? 'logo-light' : ''}` }, h('span', { class: 'logo-mark' }, icon('shieldcheck', 22)),
    h('span', { class: 'logo-text' }, h('b', {}, 'SECURE'), '-eNOTE'));
}

// ------------------------------------------------------------------ Connexion
function loginShell(...content) {
  root.replaceChildren(h('div', { class: 'login' },
    h('aside', { class: 'login-brand' },
      h('div', { class: 'brand-top' }, h('span', { class: 'ofppt-badge' }, ofppt()), h('div', { class: 'brand-org' }, h('b', {}, 'OFPPT'), h('span', {}, 'ISTA NTIC Safi'))),
      logo(true),
      h('div', { class: 'brand-copy' },
        h('h1', {}, 'Gestion sécurisée des notes et des séances'),
        h('p', {}, 'Personnel, stagiaires et parents — OFPPT, ISTA NTIC Safi'),
        h('ul', { class: 'brand-list' },
          [['lock', 'Authentification à deux facteurs (TOTP, RFC 6238)'], ['users', 'Droits par rôle et séparation des tâches'],
            ['key', 'Notes chiffrées AES-256-GCM au repos'], ['log', 'Journal d\'audit chaîné et infalsifiable'],
            ['alert', 'Détection des comportements suspects'], ['database', 'Sauvegardes chiffrées et vérifiées']]
            .map(([i, t]) => h('li', {}, icon(i, 18), t)))),
      h('div', { class: 'brand-foot' }, 'Projet SECURE-eNOTE — Concours de promotion interne 2026')),
    h('main', { class: 'login-main' }, h('div', { class: 'login-card' }, h('div', { class: 'card-brand' }, ofppt('sm'), h('span', {}, 'Office de la Formation Professionnelle', h('br'), 'et de la Promotion du Travail')), ...content))));
}

let demoTimer = null;
export function showLogin(message) {
  clearInterval(demoTimer);
  const err = h('div');
  if (message) err.append(banner('warn', message));
  const login = h('input', { name: 'login', autocomplete: 'username', required: true, maxlength: 60, placeholder: 'prenom.nom ou CEF' });
  const pwd = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true, maxlength: 128 });
  const btn = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Continuer');
  const form = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault(); btn.disabled = true; err.replaceChildren();
    try {
      const r = await post('/api/auth/login', { login: login.value, password: pwd.value });
      if (r.etape === 'enrolement') showEnrolment(r); else showMfa(r);
    } catch (ex) { err.replaceChildren(banner(ex.status === 423 ? 'danger' : 'warn', ex.message)); btn.disabled = false; pwd.value = ''; pwd.focus(); }
  } },
  h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Identifiant'), login),
  h('label', { class: 'field' }, h('span', { class: 'field-label' }, 'Mot de passe'), pwd),
  btn);
  loginShell(h('div', { class: 'steps' }, h('span', { class: 'step on' }, '1'), h('i'), h('span', { class: 'step' }, '2')),
    h('h2', {}, 'Connexion'), h('p', { class: 'muted' }, 'Étape 1 sur 2 — identifiant et mot de passe.'), err, form,
    h('p', { class: 'fine' }, icon('shield', 14), ' Ne communiquez jamais votre mot de passe ni vos codes de vérification. L\'OFPPT ne vous les demandera jamais par courriel.'));
  login.focus();
}

function codeInput() {
  return h('input', { class: 'code-input', inputmode: 'numeric', autocomplete: 'one-time-code', maxlength: 7, pattern: '[0-9 ]*', placeholder: '••••••', required: true, 'aria-label': 'Code à 6 chiffres' });
}

function demoBox(onCode) {
  const val = h('b', {}, '— — —'); const sec = h('span', {}, '');
  const box = h('div', { class: 'demo-box' }, h('div', { class: 'demo-title' }, 'MODE DÉMONSTRATION'),
    h('div', {}, 'Code attendu par le serveur : ', val, ' ', sec),
    h('div', { class: 'fine' }, 'Affiché uniquement pour la démonstration au jury. En production, ce code n\'est visible que dans l\'application d\'authentification du téléphone.'));
  const tick = async () => {
    try {
      const r = await get('/api/auth/demo-code');
      if (r.code) { val.textContent = r.code.slice(0, 3) + ' ' + r.code.slice(3); sec.textContent = `(expire dans ${r.secondes} s)`; if (onCode) onCode(r.code); }
    } catch { clearInterval(demoTimer); }
  };
  clearInterval(demoTimer); tick(); demoTimer = setInterval(tick, 1000);
  return box;
}

async function finishMfa(code, err, btn) {
  btn.disabled = true; err.replaceChildren();
  try {
    const r = await post('/api/auth/mfa', { code });
    clearInterval(demoTimer);
    state.csrf = r.csrf;
    await boot(r.doit_changer_mdp ? '#/compte' : '#/');
  } catch (ex) {
    if (ex.status === 401 && /expirée/.test(ex.message)) return showLogin(ex.message);
    err.replaceChildren(banner(ex.status === 423 ? 'danger' : 'warn', ex.message)); btn.disabled = false;
    if (ex.status === 423) { clearInterval(demoTimer); setTimeout(() => showLogin(ex.message), 2500); }
  }
}

function showMfa(info) {
  const err = h('div'); const code = codeInput();
  const btn = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Vérifier et se connecter');
  loginShell(h('div', { class: 'steps' }, h('span', { class: 'step done' }, icon('check', 14)), h('i'), h('span', { class: 'step on' }, '2')),
    h('h2', {}, 'Vérification en deux étapes'),
    h('p', { class: 'muted' }, `Bonjour ${info.nom}. Saisissez le code à 6 chiffres affiché dans votre application d'authentification (Google Authenticator, Microsoft Authenticator…).`),
    err,
    h('form', { class: 'stack', onsubmit: (e) => { e.preventDefault(); finishMfa(code.value.replace(/\s/g, ''), err, btn); } }, code, btn),
    info.demo ? demoBox() : null,
    h('button', { class: 'link', onclick: () => showLogin() }, '← Revenir à l\'étape 1'));
  code.focus();
}

async function showEnrolment(info) {
  const err = h('div'); const code = codeInput();
  const btn = h('button', { class: 'btn btn-primary btn-block', type: 'submit' }, 'Activer et se connecter');
  let e;
  try { e = await get('/api/auth/mfa/enrolement'); } catch (ex) { return showLogin(ex.message); }
  const qr = h('div', { class: 'qr' }); qr.innerHTML = e.qr_svg; // SVG produit par le serveur (générateur interne)
  loginShell(h('div', { class: 'steps' }, h('span', { class: 'step done' }, icon('check', 14)), h('i'), h('span', { class: 'step on' }, '2')),
    h('h2', {}, 'Activez la vérification en deux étapes'),
    h('p', { class: 'muted' }, `Bienvenue ${info.nom}. Pour protéger les notes et les données personnelles, la vérification en deux étapes est obligatoire pour tous les comptes.`),
    h('ol', { class: 'enrol' },
      h('li', {}, 'Installez une application d\'authentification sur votre téléphone (Google Authenticator, Microsoft Authenticator, FreeOTP).'),
      h('li', {}, 'Scannez ce QR code, ou saisissez la clé manuellement :'),
      h('div', { class: 'enrol-qr' }, qr, h('div', {}, h('div', { class: 'fine' }, 'Compte : ', h('b', {}, e.login)), h('code', { class: 'secret' }, e.secret))),
      h('li', {}, 'Saisissez le code à 6 chiffres affiché par l\'application :')),
    err,
    h('form', { class: 'stack', onsubmit: (ev) => { ev.preventDefault(); finishMfa(code.value.replace(/\s/g, ''), err, btn); } }, code, btn),
    info.demo ? demoBox() : null);
}

// ------------------------------------------------------------------ Application
async function showNotifications(bell) {
  const list = await get('/api/me/notifications');
  await post('/api/me/notifications/lues');
  bell.querySelector('.badge')?.remove();
  modal('Notifications', h('div', { class: 'notif-list' }, list.length ? list.map((n) => h('div', { class: `notif notif-${n.type} ${n.lue ? '' : 'unread'}` },
    icon(n.type === 'securite' ? 'shield' : n.type === 'retour' ? 'alert' : 'bell', 16),
    h('div', {}, h('div', {}, n.message), h('div', { class: 'fine' }, fmtDateTime(n.cree_le))))) : h('p', { class: 'muted' }, 'Aucune notification.')), [{ label: 'Fermer', class: 'btn-primary' }]);
}

function shell() {
  const me = state.me.utilisateur;
  const nav = h('nav', { class: 'nav' }, NAV[me.role].map(([href, ic, label]) => h('a', { href, dataset: { href } }, icon(ic), h('span', {}, label))));
  const title = h('h1', { class: 'page-title' });
  const bell = h('button', { class: 'icon-btn bell', 'aria-label': 'Notifications', onclick: () => showNotifications(bell) }, icon('bell', 20),
    state.me.notifications_non_lues ? h('span', { class: 'badge' }, String(state.me.notifications_non_lues)) : null);
  const main = h('div', { class: 'content' });
  // Sur téléphone, le menu est replié derrière un bouton ; il se referme après le choix d'une page.
  const menuBtn = h('button', { class: 'icon-btn menu-btn', 'aria-label': 'Menu', 'aria-expanded': 'false',
    onclick: () => { const open = sidebar.classList.toggle('open'); menuBtn.setAttribute('aria-expanded', String(open)); } }, icon('menu', 22));
  nav.addEventListener('click', (ev) => { if (ev.target.closest('a')) { sidebar.classList.remove('open'); menuBtn.setAttribute('aria-expanded', 'false'); } });
  const sidebar = h('aside', { class: 'sidebar' }, h('div', { class: 'side-head' }, logo(true), menuBtn), h('div', { class: 'org' }, h('span', { class: 'ofppt-badge sm' }, ofppt()), h('div', {}, h('b', {}, 'OFPPT'), h('span', {}, me.etablissement || 'ISTA NTIC Safi'))), nav,
      h('div', { class: 'side-foot' },
        h('div', { class: 'who' }, h('span', { class: 'avatar' }, me.nom.split(' ').map((x) => x[0]).join('').slice(0, 2)),
          h('div', {}, h('div', { class: 'who-name' }, me.nom), h('div', { class: 'who-role' }, ROLES[me.role]))),
        h('button', { class: 'btn btn-ghost-light btn-block', onclick: logout }, icon('logout', 16), 'Se déconnecter')));
  root.replaceChildren(h('div', { class: 'layout' }, sidebar,
    h('div', { class: 'main' },
      h('header', { class: 'topbar' }, title,
        h('div', { class: 'top-right' },
          h('span', { class: 'pill-secure' }, icon('shieldcheck', 15), 'Session protégée — MFA'),
          state.me.demo ? h('span', { class: 'pill-demo' }, 'Démo') : null,
          bell, h('span', { class: `role-chip role-${me.role}` }, ROLES[me.role]))),
      main)));
  return { main, title, nav };
}

let ui = null;
async function render() {
  if (!state.me) return;
  const path = ((location.hash || '#/').slice(1) || '/').split('?')[0];
  const me = state.me.utilisateur;
  document.querySelectorAll('.overlay').forEach((o) => o.remove());   // une fenêtre ouverte ne survit pas à un changement de page
  if (!ui) ui = shell();
  ui.nav.querySelectorAll('a').forEach((a) => a.classList.toggle('active', a.dataset.href === '#' + path || (path === '/enfant' && a.dataset.href === '#/')));
  const view = path === '/compte' ? compte.page : ROUTES[me.role][path];
  ui.main.replaceChildren(h('div', { class: 'loading' }, 'Chargement…'));
  if (!view) { ui.title.textContent = 'Page introuvable'; ui.main.replaceChildren(banner('warn', 'Cette page n\'existe pas ou n\'est pas accessible à votre profil.')); return; }
  try {
    await view(ui.main, { setTitle: (t) => { ui.title.textContent = t; document.title = `${t} — SECURE-eNOTE`; }, me, refresh: render });
  } catch (ex) {
    if (ex instanceof ApiError && ex.status === 401) return;
    ui.main.replaceChildren(banner('danger', ex.message));
  }
}

async function logout() {
  try { await post('/api/auth/logout'); } catch { /* ignore */ }
  state.me = null; state.csrf = null; ui = null;
  history.replaceState(null, '', '#/');
  showLogin('Vous êtes déconnecté(e). À bientôt.');
}

async function boot(hash) {
  try {
    state.me = await get('/api/me');
    state.csrf = state.me.csrf;
    ui = null;
    if (hash) history.replaceState(null, '', hash);
    if (state.me.utilisateur.doit_changer_mdp) history.replaceState(null, '', '#/compte');
    await render();
  } catch { showLogin(); }
}

window.addEventListener('hashchange', render);
window.addEventListener('session-expiree', (e) => { ui = null; showLogin(e.detail || 'Votre session a expiré.'); });
window.addEventListener('unhandledrejection', (e) => { if (e.reason instanceof ApiError && e.reason.status !== 401) toast(e.reason.message, 'err'); });
boot();
