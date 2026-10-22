// Sécurité du compte : mot de passe, sessions actives, historique de connexions, appareils.
import { h, icon, card, table, toast, banner, field, fmtDateTime, fmtDate } from '../ui.js';
import { get, post, del, state } from '../api.js';

const RULES = [
  ['au moins 10 caractères', (p) => p.length >= 10], ['une lettre minuscule', (p) => /[a-z]/.test(p)], ['une lettre majuscule', (p) => /[A-Z]/.test(p)],
  ['un chiffre', (p) => /\d/.test(p)], ['un caractère spécial', (p) => /[^A-Za-z0-9]/.test(p)],
];
const LABELS = {
  'auth.connexion': 'Connexion réussie', 'auth.echec_mot_de_passe': 'Échec — mot de passe', 'auth.echec_mfa': 'Échec — code MFA', 'auth.verrouillage': 'Verrouillage',
  'auth.deconnexion': 'Déconnexion', 'auth.mot_de_passe_valide': 'Mot de passe vérifié', 'auth.revocation_session': 'Session révoquée', 'auth.tentative_compte_verrouille': 'Tentative (compte verrouillé)',
};

export async function page(main, { setTitle, me, refresh }) {
  setTitle('Sécurité du compte');
  const forced = me.doit_changer_mdp;
  const s = forced ? null : await get('/api/me/securite');

  const actuel = h('input', { type: 'password', autocomplete: 'current-password' });
  const nouveau = h('input', { type: 'password', autocomplete: 'new-password' });
  const confirm = h('input', { type: 'password', autocomplete: 'new-password' });
  const checklist = h('ul', { class: 'checks' });
  const paint = () => checklist.replaceChildren(...RULES.map(([l, f]) => h('li', { class: f(nouveau.value) ? 'ok' : '' }, icon(f(nouveau.value) ? 'check' : 'x', 14), l)),
    h('li', { class: nouveau.value && nouveau.value === confirm.value ? 'ok' : '' }, icon(nouveau.value && nouveau.value === confirm.value ? 'check' : 'x', 14), 'confirmation identique'));
  nouveau.addEventListener('input', paint); confirm.addEventListener('input', paint); paint();
  const err = h('div');
  const form = h('form', { class: 'stack', onsubmit: async (e) => {
    e.preventDefault(); err.replaceChildren();
    if (nouveau.value !== confirm.value) { err.append(banner('warn', 'La confirmation ne correspond pas.')); return; }
    try {
      await post('/api/me/mot-de-passe', { actuel: actuel.value, nouveau: nouveau.value });
      toast('Mot de passe modifié. Vos autres sessions ont été fermées.');
      if (forced) { state.me.utilisateur.doit_changer_mdp = false; location.hash = '#/'; location.reload(); } else refresh();
    } catch (ex) { err.append(banner('warn', ex.message)); }
  } }, err, field(forced ? 'Mot de passe provisoire' : 'Mot de passe actuel', actuel), field('Nouveau mot de passe', nouveau), field('Confirmation', confirm), checklist,
  h('p', { class: 'fine' }, 'Les mots de passe trop courants ou figurant dans des listes de mots de passe compromis sont refusés, ainsi que la réutilisation des 3 derniers.'),
  h('button', { class: 'btn btn-primary', type: 'submit' }, 'Changer le mot de passe'));

  if (forced) {
    main.replaceChildren(banner('warn', h('b', {}, 'Première connexion : '), 'vous devez remplacer le mot de passe provisoire communiqué par l\'administrateur avant d\'accéder à l\'application.'),
      h('div', { class: 'narrow' }, card('Définir votre mot de passe personnel', form)));
    return;
  }

  main.replaceChildren(
    h('div', { class: 'grid-2' },
      h('div', { class: 'stack' },
        card('Vérification en deux étapes', h('div', { class: 'mfa-state' }, h('span', { class: 'big-ok' }, icon('shieldcheck', 30)),
          h('div', {}, h('b', {}, 'Activée — application d\'authentification (TOTP)'),
            h('p', { class: 'muted' }, 'En cas de perte ou de changement de téléphone, demandez à l\'administrateur une réinitialisation : une vérification d\'identité vous sera demandée.')))),
        card('Changer le mot de passe', h('p', { class: 'fine' }, `Dernière modification : ${fmtDate(s.mdp_change_le)}`), form)),
      h('div', { class: 'stack' },
        card('Sessions ouvertes', table(['Appareil', 'Adresse IP', 'Ouverte le', 'Dernière activité', ''], s.sessions.map((x) => h('tr', {},
          h('td', {}, x.agent, x.courante ? h('span', { class: 'chip chip-vert chip-xs' }, 'cette session') : null), h('td', { class: 'mono' }, x.ip), h('td', {}, fmtDateTime(x.cree_le)), h('td', {}, fmtDateTime(x.derniere_activite)),
          h('td', {}, x.courante ? '' : h('button', { class: 'btn btn-sm btn-warn', onclick: async () => { await del(`/api/me/sessions/${x.id}`); toast('Session fermée.'); refresh(); } }, 'Fermer')))))),
        card('Activité récente de connexion', table(['Date', 'Événement', 'Adresse IP'], s.connexions.map((c) => h('tr', { class: /echec|verrou/.test(c.action) ? 'tone-danger' : '' },
          h('td', {}, fmtDateTime(c.horodatage)), h('td', {}, LABELS[c.action] || c.action, c.details?.nouvel_appareil ? h('span', { class: 'chip chip-orange chip-xs' }, 'nouvel appareil') : null),
          h('td', { class: 'mono' }, c.ip || '—'))))),
        card('Appareils reconnus', table(['Appareil', 'Première utilisation', 'Dernière utilisation'], s.appareils.map((a) => h('tr', {},
          h('td', {}, icon('device', 14), ' ', a.libelle), h('td', {}, fmtDateTime(a.premier_vu)), h('td', {}, fmtDateTime(a.dernier_vu)))))))));
}
