// Vues Administrateur : centre de sécurité, alertes, journal, comptes, règles, sauvegardes.
import { h, icon, card, kpi, table, chipSeverite, chipStatut, toast, banner, field, modal, fmtDate, fmtDateTime, fmtNote, pct, short, ROLES, barChart } from '../ui.js';
import { get, post, put } from '../api.js';

const ACTIONS = {
  'auth.connexion': 'Connexion réussie (MFA)', 'auth.deconnexion': 'Déconnexion', 'auth.mot_de_passe_valide': 'Mot de passe vérifié (étape 1)',
  'auth.echec_mot_de_passe': 'Échec — mot de passe', 'auth.echec_mfa': 'Échec — code MFA', 'auth.verrouillage': 'Verrouillage du compte',
  'auth.tentative_compte_verrouille': 'Tentative sur compte verrouillé', 'auth.compte_suspendu': 'Tentative sur compte suspendu', 'auth.revocation_session': 'Révocation d\'une session',
  'mfa.enrolement': 'Activation du MFA', 'acces.refuse': 'ACCÈS REFUSÉ', 'note.saisie': 'Saisie d\'une note', 'note.modification': 'Modification d\'une note',
  'note.soumission': 'Soumission à la direction', 'note.controle': 'Contrôle — conforme', 'note.validation': 'Validation direction', 'note.retour_correction': 'Renvoi pour correction',
  'note.modification_post_validation': 'MODIFICATION APRÈS VALIDATION', 'seance.declaration': 'Déclaration de séance', 'seance.modification': 'Modification de séance',
  'seance.soumission': 'Soumission de séance', 'seance.controle': 'Contrôle de séance', 'seance.validation': 'Validation de séance', 'seance.retour_correction': 'Renvoi de séance',
  'export.notes': 'Export de notes', 'journal.consultation': 'Consultation du journal', 'journal.verification': 'Vérification d\'intégrité',
  'alerte.qualification': 'Qualification d\'alerte', 'regle.modification': 'Modification de règle', 'sauvegarde.creation': 'Sauvegarde', 'sauvegarde.verification': 'Vérification de sauvegarde',
  'compte.creation': 'Création de compte', 'compte.suspendre': 'Suspension de compte', 'compte.reactiver': 'Réactivation de compte', 'compte.deverrouiller': 'Déverrouillage',
  'compte.reinitialiser_mfa': 'Réinitialisation MFA', 'compte.changer_role': 'Changement de rôle', 'compte.changement_mdp': 'Changement de mot de passe',
  'compte.suspension': 'Suspension (alerte confirmée)', 'systeme.initialisation': 'Initialisation du système',
  'dossier.consultation': 'Consultation d\'un dossier stagiaire', 'absence.justification': 'Justification d\'absence', 'absence.modification_justification': 'Modification d\'un justificatif', 'absence.retrait_justification': 'Retrait d\'une justification', 'compte.rattacher_enfant': 'Rattachement parent ↔ stagiaire', 'compte.detacher_enfant': 'Retrait d\'un rattachement',
};
const actionLabel = (a) => ACTIONS[a] || a;
const actionTone = (a) => (/echec|refuse|verrouill|post_validation|suspen/.test(a) ? 'danger' : /connexion|validation|controle|enrolement/.test(a) ? 'ok' : '');

function detailsText(d) {
  return Object.entries(d || {}).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k.replace(/_/g, ' ')} : ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ');
}

export async function dashboard(main, { setTitle }) {
  setTitle('Centre de sécurité');
  const [s, alertes] = await Promise.all([get('/api/securite/synthese'), get('/api/alertes?statut=nouvelle')]);
  const a = s.alertes; const integ = s.integrite;
  main.replaceChildren(
    h('div', { class: 'kpis kpis-6' },
      kpi('Taux d\'adoption MFA', pct(s.taux_mfa), `${s.comptes.mfa}/${s.comptes.total} comptes · privilégiés ${s.comptes.privilegies_mfa}/${s.comptes.privilegies}`, s.taux_mfa >= 0.95 ? 'tone-green' : 'tone-orange'),
      kpi('Alertes ouvertes', a.ouvertes, `${a.critiques} critique(s) · ${a.avertissements} avert. · ${a.informations} info`, a.critiques ? 'tone-red' : a.ouvertes ? 'tone-orange' : 'tone-green'),
      kpi('Intégrité du journal', integ ? (integ.integre ? 'Intègre' : 'ROMPUE') : '—', integ ? `${integ.entrees} entrées · vérifiée ${fmtDateTime(integ.verifie_le)}` : 'non vérifiée', integ && !integ.integre ? 'tone-red' : 'tone-green'),
      kpi('Comptes verrouillés', s.comptes.verrouilles, `${s.comptes.suspendus} suspendu(s)`, s.comptes.verrouilles ? 'tone-orange' : ''),
      kpi('Dernière sauvegarde', s.derniere_sauvegarde ? `il y a ${s.derniere_sauvegarde.age_h < 1 ? Math.round(s.derniere_sauvegarde.age_h * 60) + ' min' : s.derniere_sauvegarde.age_h.toFixed(1) + ' h'}` : 'aucune',
        'RPO cible ≤ 4 h', s.derniere_sauvegarde && s.derniere_sauvegarde.age_h <= 4 ? 'tone-green' : 'tone-orange'),
      kpi('Faux positifs', s.taux_faux_positifs === null ? '—' : pct(s.taux_faux_positifs), `délai moyen de traitement ${a.delai_moyen_h ? a.delai_moyen_h.toFixed(1) + ' h' : '—'}`, '')),
    h('div', { class: 'grid-2' },
      card(h('div', { class: 'card-head-row' }, h('h2', {}, 'Connexions et échecs d\'authentification — 14 jours'),
        h('span', { class: 'muted' }, `24 h : ${s.auth_24h.connexions} connexions · ${s.auth_24h.echecs} échecs · ${s.auth_24h.refus} accès refusés`)),
      barChart(s.tendance, [{ key: 'connexions', label: 'Connexions réussies', class: 's1' }, { key: 'echecs', label: 'Échecs (mot de passe / MFA)', class: 's2' }])),
      card(h('div', { class: 'card-head-row' }, h('h2', {}, 'Dernières alertes à traiter'), h('a', { class: 'btn btn-sm', href: '#/alertes' }, 'Toutes les alertes')),
        alertes.length ? h('div', { class: 'alert-list' }, alertes.slice(0, 6).map((x) => h('div', { class: `alert-item sev-${x.severite}` },
          chipSeverite(x.severite), h('div', {}, h('div', { class: 'alert-title' }, x.titre), h('div', { class: 'fine' }, fmtDateTime(x.cree_le)))))) : h('p', { class: 'empty' }, 'Aucune alerte ouverte.'))),
    h('div', { class: 'grid-3' },
      card('Sessions et activité', h('ul', { class: 'facts' }, h('li', {}, icon('users', 16), 'Sessions actives : ', h('b', {}, s.sessions_actives)),
        h('li', {}, icon('log', 16), 'Entrées au journal d\'audit : ', h('b', {}, s.entrees_journal)),
        h('li', {}, icon('alert', 16), 'Alertes des 7 derniers jours : ', h('b', {}, a.semaine)))),
      card('Protection des données', h('ul', { class: 'facts' }, h('li', {}, icon('key', 16), 'Notes, contenus de séance, CIN, téléphones : AES-256-GCM'),
        h('li', {}, icon('lock', 16), 'Mots de passe : scrypt salé (N=32768)'), h('li', {}, icon('shield', 16), 'Secrets MFA chiffrés par une clé dédiée (HKDF)'))),
      card('Continuité de service', h('ul', { class: 'facts' }, h('li', {}, icon('database', 16), 'Sauvegarde chiffrée automatique toutes les 4 h'),
        h('li', {}, icon('refresh', 16), 'Redémarrage automatique des conteneurs'), h('li', {}, icon('check', 16), 'Sonde de santé : /api/sante')))));
}

export async function alertes(main, { setTitle }) {
  setTitle('Alertes de sécurité');
  const f = { severite: '', statut: 'nouvelle' };
  const bar = h('div', { class: 'filters' });
  const zone = h('div');
  const chips = (key, opts) => h('div', { class: 'chips' }, opts.map(([v, l]) => h('button', { class: `fchip ${f[key] === v ? 'on' : ''}`, onclick: () => { f[key] = v; draw(); } }, l)));
  async function draw() {
    bar.replaceChildren(h('span', { class: 'muted' }, 'Sévérité'), chips('severite', [['', 'Toutes'], ['critique', 'Critique'], ['avertissement', 'Avertissement'], ['information', 'Information']]),
      h('span', { class: 'muted' }, 'Statut'), chips('statut', [['nouvelle', 'À traiter'], ['confirmee', 'Confirmées'], ['infirmee', 'Infirmées'], ['', 'Toutes']]));
    const list = await get(`/api/alertes?severite=${f.severite}&statut=${f.statut}`);
    zone.replaceChildren(card(null, table(['Sévérité', 'Alerte', 'Compte concerné', 'Détectée le', 'Statut', ''], list.map((x) => h('tr', {},
      h('td', {}, chipSeverite(x.severite)), h('td', {}, h('div', { class: 'alert-title' }, x.titre), h('div', { class: 'fine mono' }, `règle : ${x.regle}`)),
      h('td', {}, x.login ? [h('b', {}, x.login), h('div', { class: 'fine' }, ROLES[x.role] || '')] : '—'), h('td', {}, fmtDateTime(x.cree_le)),
      h('td', {}, x.statut === 'nouvelle' ? h('span', { class: 'chip chip-orange' }, 'À traiter') : h('span', { class: `chip ${x.statut === 'confirmee' ? 'chip-rouge' : 'chip-gris'}` }, x.statut === 'confirmee' ? 'Confirmée' : 'Infirmée'),
        x.traitee_par_nom ? h('div', { class: 'fine' }, `${x.traitee_par_nom}, ${fmtDateTime(x.traitee_le)}`) : null),
      h('td', { class: 'nowrap' }, x.statut === 'nouvelle' ? h('button', { class: 'btn btn-sm btn-primary', onclick: () => qualify(x) }, 'Qualifier') : x.commentaire ? h('span', { class: 'fine' }, x.commentaire) : ''))),
    { empty: 'Aucune alerte pour ces critères.' })));
  }
  async function qualify(x) {
    const com = h('textarea', { rows: 2, maxlength: 300, placeholder: 'Analyse / commentaire (facultatif)' });
    const susp = h('input', { type: 'checkbox' });
    const body = h('div', { class: 'stack' }, h('p', {}, h('b', {}, x.titre)), h('pre', { class: 'json' }, JSON.stringify(x.details, null, 2)),
      field('Commentaire', com), x.utilisateur_id ? h('label', { class: 'check' }, susp, ' Suspendre le compte concerné si l\'alerte est confirmée (révoque ses sessions)') : null);
    const r = await modal('Qualifier l\'alerte', body, [{ label: 'Annuler', value: null }, { label: 'Faux positif (infirmer)', value: 'infirmee' }, { label: 'Confirmer l\'incident', class: 'btn-danger', value: 'confirmee' }]);
    if (!r) return;
    await post(`/api/alertes/${x.id}`, { statut: r, commentaire: com.value, suspendre: susp.checked });
    toast(r === 'confirmee' ? 'Incident confirmé et tracé.' : 'Alerte infirmée (faux positif).'); draw();
  }
  main.replaceChildren(bar, zone);
  await draw();
}

export async function journal(main, { setTitle, me }) {
  const complet = me.role === 'administrateur';
  setTitle(complet ? 'Journal d\'audit' : 'Journal des opérations');
  let page = 0; const act = h('select', {}, [['', 'Toutes les actions'], ['auth.', 'Authentification'], ['acces.', 'Accès refusés'], ['note.', 'Notes'], ['seance.', 'Séances'], ['absence.', 'Absences et justificatifs'],
    ['export.', 'Exports'], ['dossier.', 'Consultations stagiaires / parents'], ['compte.', 'Comptes'], ['alerte.', 'Alertes'], ['sauvegarde.', 'Sauvegardes'], ['journal.', 'Journal']]
    .filter(([v]) => complet || (me.role === 'gestionnaire' ? ['', 'absence.'] : ['', 'note.', 'seance.', 'export.', 'absence.']).includes(v)).map(([v, l]) => h('option', { value: v }, l)));
  const who = h('input', { placeholder: 'Utilisateur…', maxlength: 40 });
  const result = h('div'); const zone = h('div');
  act.addEventListener('change', () => { page = 0; draw(); }); who.addEventListener('change', () => { page = 0; draw(); });
  async function draw() {
    const d = await get(`/api/journal?page=${page}&action=${encodeURIComponent(act.value)}&acteur=${encodeURIComponent(who.value)}`);
    zone.replaceChildren(card(h('div', { class: 'card-head-row' }, h('h2', {}, `${d.total} entrées`), h('span', { class: 'muted' }, complet ? 'Périmètre complet' : me.role === 'gestionnaire' ? 'Périmètre partiel : absences et justificatifs uniquement' : 'Périmètre partiel : opérations pédagogiques uniquement')),
      table(['N°', 'Horodatage (UTC+1)', 'Acteur', 'Action', 'Ressource / détails', 'IP', 'Empreinte (chaînée)'], d.entrees.map((e) => h('tr', { class: `tone-${actionTone(e.action)}` },
        h('td', { class: 'mono' }, e.id), h('td', { class: 'nowrap' }, fmtDateTime(e.horodatage)),
        h('td', {}, h('b', {}, e.acteur_login), e.acteur_role ? h('div', { class: 'fine' }, ROLES[e.acteur_role]) : null),
        h('td', {}, h('span', { class: `act act-${actionTone(e.action)}` }, actionLabel(e.action))),
        h('td', { class: 'clip-wide' }, e.ressource ? h('span', { class: 'mono' }, e.ressource) : null, h('div', { class: 'fine' }, detailsText(e.details))),
        h('td', { class: 'mono fine' }, e.ip || ''),
        h('td', { class: 'mono fine hashcell' }, h('div', { title: e.hash }, '#', short(e.hash, 12)), h('div', { class: 'prev', title: e.hash_precedent }, '↳ ', short(e.hash_precedent, 12)))))),
      h('div', { class: 'card-foot' }, h('span', { class: 'fine' }, `Page ${page + 1} / ${Math.max(1, Math.ceil(d.total / 50))}`),
        h('div', { class: 'actions' }, h('button', { class: 'btn btn-sm', disabled: page === 0, onclick: () => { page--; draw(); } }, '← Précédent'),
          h('button', { class: 'btn btn-sm', disabled: (page + 1) * 50 >= d.total, onclick: () => { page++; draw(); } }, 'Suivant →')))));
  }
  const verify = complet ? h('button', { class: 'btn btn-primary', onclick: async () => {
    const r = await post('/api/journal/verifier');
    result.replaceChildren(r.integre
      ? banner('ok', h('b', {}, 'Chaîne intègre. '), `${r.entrees} entrées vérifiées en ${r.duree_ms} ms — aucune altération détectée. Dernière empreinte : `, h('code', { class: 'hash' }, short(r.derniere_empreinte, 24)))
      : banner('danger', h('b', {}, `ALTÉRATION DÉTECTÉE à l'entrée n° ${r.rupture}. `), `${r.raison}. Une alerte critique a été générée.`));
    draw();
  } }, icon('shieldcheck', 16), ' Vérifier l\'intégrité de la chaîne') : null;
  main.replaceChildren(h('div', { class: 'toolbar' }, h('div', { class: 'row-2' }, field('Type d\'action', act), field('Acteur', who)), verify), result, zone);
  await draw();
}

export async function utilisateurs(main, { setTitle, me }) {
  setTitle('Comptes et rôles');
  const draw = async () => {
    const list = await get('/api/admin/utilisateurs');
    main.replaceChildren(
      h('div', { class: 'toolbar' }, h('p', { class: 'muted' }, 'Cycle de vie des identités : création avec mot de passe provisoire, changement de rôle, suspension, déverrouillage et réinitialisation du second facteur.'),
        h('button', { class: 'btn btn-primary', onclick: create }, '+ Créer un compte')),
      card(null, table(['Compte', 'Rôle', 'Statut', 'MFA', 'Dernière connexion', 'Mot de passe', ''], list.map((u) => h('tr', {},
        h('td', {}, h('b', {}, u.nom_complet), h('div', { class: 'fine mono' }, u.login),
          u.rattachement ? h('div', { class: 'fine rattache' }, icon(u.role === 'parent' ? 'family' : 'cap', 13), ' ', u.rattachement) : null),
        h('td', {}, h('span', { class: `role-chip role-${u.role}` }, ROLES[u.role])),
        h('td', {}, u.verrouille ? h('span', { class: 'chip chip-orange' }, 'Verrouillé') : u.statut === 'actif' ? h('span', { class: 'chip chip-vert' }, 'Actif') : h('span', { class: 'chip chip-rouge' }, 'Suspendu'),
          u.echecs_consecutifs ? h('div', { class: 'fine' }, `${u.echecs_consecutifs} échec(s) récent(s)`) : null),
        h('td', {}, u.mfa_active ? h('span', { class: 'chip chip-vert' }, 'Activé') : h('span', { class: 'chip chip-orange' }, 'À enrôler')),
        h('td', {}, fmtDateTime(u.derniere_connexion)), h('td', { class: 'fine' }, u.doit_changer_mdp ? 'Provisoire' : `changé le ${fmtDate(u.mdp_change_le)}`),
        h('td', { class: 'nowrap' }, u.id === me.id ? h('span', { class: 'fine' }, 'Vous') : actions(u)))))));
  };
  const act = async (u, action, extra = {}) => { await post(`/api/admin/utilisateurs/${u.id}/action`, { action, ...extra }); toast('Action effectuée et tracée.'); draw(); };
  const actions = (u) => {
    const sel = h('select', { class: 'sel-sm', onchange: async () => {
      const v = sel.value; sel.value = '';
      if (v === 'rattacher_enfant') { rattacher(u); return; }
      if (v === 'changer_role') {
        const r = h('select', {}, Object.entries(ROLES).map(([k, l]) => h('option', { value: k, selected: k === u.role }, l)));
        const role = await modal(`Changer le rôle de ${u.nom_complet}`, field('Nouveau rôle', r), [{ label: 'Annuler', value: null }, { label: 'Appliquer', class: 'btn-primary', validate: () => r.value }]);
        if (role) act(u, 'changer_role', { role });
      } else if (v) {
        const ok = await modal('Confirmation', h('p', {}, `Confirmer l'action « ${sel.querySelector(`option[value="${v}"]`).textContent} » sur le compte ${u.login} ?`), [{ label: 'Annuler', value: false }, { label: 'Confirmer', class: 'btn-primary', value: true }]);
        if (ok) act(u, v);
      }
    } }, h('option', { value: '' }, 'Actions…'),
    u.verrouille ? h('option', { value: 'deverrouiller' }, 'Déverrouiller') : null,
    u.statut === 'actif' ? h('option', { value: 'suspendre' }, 'Suspendre') : h('option', { value: 'reactiver' }, 'Réactiver'),
    h('option', { value: 'reinitialiser_mfa' }, 'Réinitialiser le MFA'),
    ['stagiaire', 'parent'].includes(u.role) ? null : h('option', { value: 'changer_role' }, 'Changer de rôle'),
    u.role === 'parent' ? h('option', { value: 'rattacher_enfant' }, 'Rattacher un stagiaire') : null);
    return sel;
  };
  const LIENS = { pere: 'Père', mere: 'Mère', tuteur: 'Tuteur / tutrice' };
  /** Sélecteur de dossier stagiaire : recherche par CEF, nom ou groupe. */
  function picker(pourRole) {
    let choisi = null;
    const q = h('input', { placeholder: 'CEF, nom ou groupe (ex. 2026001, Hilali, IDOSR201)', maxlength: 40 });
    const list = h('div', { class: 'pick-list' }, h('p', { class: 'fine' }, 'Saisissez au moins 2 caractères.'));
    let t = null;
    q.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(async () => {
        const r = await get(`/api/admin/stagiaires?q=${encodeURIComponent(q.value)}`);
        choisi = null;
        list.replaceChildren(r.length ? r.map((x) => {
          const pris = pourRole === 'stagiaire' && x.compte;
          const b = h('button', { type: 'button', disabled: pris, onclick: () => { choisi = x; list.querySelectorAll('button').forEach((y) => y.classList.remove('on')); b.classList.add('on'); } },
            h('b', {}, `${x.prenom} ${x.nom}`), ` — CEF ${x.cef} — ${x.groupe}`, pris ? h('span', { class: 'fine' }, ` (compte existant : ${x.compte})`) : null,
            pourRole === 'parent' && x.parents ? h('span', { class: 'fine' }, ` (${x.parents} parent(s) déjà rattaché(s))`) : null);
          return b;
        }) : h('p', { class: 'fine' }, 'Aucun stagiaire trouvé.'));
      }, 250);
    });
    return { el: h('div', { class: 'stack' }, q, list), get: () => choisi };
  }
  const lienSelect = () => h('select', {}, Object.entries(LIENS).map(([k, l]) => h('option', { value: k }, l)));
  async function rattacher(u) {
    const p = picker('parent'); const lien = lienSelect(); const err = h('div');
    await modal(`Rattacher un stagiaire à ${u.nom_complet}`, h('div', { class: 'stack' }, err, field('Dossier stagiaire', p.el), field('Lien', lien)), [
      { label: 'Annuler', value: null },
      { label: 'Rattacher', class: 'btn-primary', validate: async () => {
        if (!p.get()) { err.replaceChildren(banner('warn', 'Sélectionnez un stagiaire dans la liste.')); return false; }
        try { await act(u, 'rattacher_enfant', { stagiaire_id: p.get().id, lien: lien.value }); return true; } catch (e) { err.replaceChildren(banner('warn', e.message)); return false; }
      } }]);
  }
  async function create() {
    const login = h('input', { placeholder: 'prenom.nom', maxlength: 40 }); const nom = h('input', { maxlength: 80 }); const email = h('input', { type: 'email', maxlength: 120 });
    const role = h('select', {}, Object.entries(ROLES).map(([k, l]) => h('option', { value: k }, l)));
    const mdp = h('input', { type: 'text', maxlength: 128, autocomplete: 'off' }); const err = h('div');
    const zone = h('div'); let p = null; let lien = null;
    const majZone = () => {
      p = null; lien = null;
      if (role.value === 'stagiaire') {
        p = picker('stagiaire');
        zone.replaceChildren(h('div', { class: 'stack' }, banner('info', 'Le compte est rattaché à un seul dossier stagiaire. Conseil : utilisez le CEF comme identifiant.'), field('Dossier stagiaire', p.el)));
      } else if (role.value === 'parent') {
        p = picker('parent'); lien = lienSelect();
        zone.replaceChildren(h('div', { class: 'stack' }, banner('info', 'Le parent ne verra que les stagiaires rattachés à son compte. D\'autres enfants peuvent être rattachés ensuite (menu Actions).'),
          field('Premier stagiaire rattaché', p.el), field('Lien', lien)));
      } else zone.replaceChildren();
    };
    role.addEventListener('change', majZone);
    await modal('Créer un compte', h('div', { class: 'stack' }, err, h('div', { class: 'row-2' }, field('Identifiant', login), field('Nom complet', nom)),
      h('div', { class: 'row-2' }, field('Courriel', email), field('Rôle', role)), zone,
      field('Mot de passe provisoire', mdp, '10 caractères min., majuscule, minuscule, chiffre, caractère spécial. Changement imposé à la première connexion, puis enrôlement MFA.')), [
      { label: 'Annuler', value: null },
      { label: 'Créer', class: 'btn-primary', validate: async () => {
        if (p && !p.get()) { err.replaceChildren(banner('warn', 'Sélectionnez le dossier stagiaire dans la liste.')); return false; }
        try {
          await post('/api/admin/utilisateurs', { login: login.value, nom_complet: nom.value, email: email.value, role: role.value, mot_de_passe: mdp.value,
            stagiaire_id: p ? p.get().id : undefined, lien: lien ? lien.value : undefined });
          toast('Compte créé.'); draw(); return true;
        } catch (e) { err.replaceChildren(banner('warn', e.message)); return false; }
      } }]);
  }
  await draw();
}

export async function regles(main, { setTitle }) {
  setTitle('Règles de détection');
  const list = await get('/api/admin/regles');
  const LIB = { seuil: 'Seuil', fenetre_minutes: 'Fenêtre (min)', debut: 'Début', fin: 'Fin', z: 'Z-score', historique_min_heures: 'Historique min. (h)', minimum_actions: 'Actions min.', verification_minutes: 'Vérification (min)' };
  main.replaceChildren(banner('info', 'Le moteur analyse chaque entrée du journal d\'audit en temps réel. Ajustez les seuils pour limiter les faux positifs (cible < 20 %). Chaque modification de règle est elle-même tracée.'),
    h('div', { class: 'rules' }, list.map((r) => {
      const inputs = {};
      const on = h('input', { type: 'checkbox', checked: r.active });
      const sev = h('select', {}, ['information', 'avertissement', 'critique'].map((s) => h('option', { value: s, selected: s === r.severite }, s)));
      const params = Object.entries(r.parametres).filter(([, v]) => typeof v !== 'object').map(([k, v]) => {
        inputs[k] = h('input', { value: v, class: 'in-sm', type: typeof v === 'number' ? 'number' : 'text' });
        return field(LIB[k] || k, inputs[k]);
      });
      return h('div', { class: 'card rule' }, h('div', { class: 'rule-head' }, h('label', { class: 'switch' }, on, h('span')), h('div', {}, h('b', {}, r.libelle), h('div', { class: 'fine mono' }, r.code)), chipSeverite(r.severite)),
        h('p', { class: 'muted' }, r.description), h('div', { class: 'rule-params' }, ...params, field('Sévérité', sev)),
        h('div', { class: 'card-foot' }, h('span'), h('button', { class: 'btn btn-sm btn-primary', onclick: async () => {
          const p = {}; for (const [k, i] of Object.entries(inputs)) p[k] = i.type === 'number' ? Number(i.value) : i.value;
          try { await put(`/api/admin/regles/${r.code}`, { active: on.checked, severite: sev.value, parametres: p }); toast('Règle mise à jour.'); regles(main, { setTitle }); } catch (e) { toast(e.message, 'err'); }
        } }, 'Enregistrer')));
    })));
}

export async function sauvegardes(main, { setTitle }) {
  setTitle('Sauvegardes et reprise d\'activité');
  const out = h('div');
  const draw = async () => {
    const list = await get('/api/admin/sauvegardes');
    main.replaceChildren(
      h('div', { class: 'kpis' }, kpi('RPO cible', '≤ 4 h', 'sauvegarde automatique toutes les 4 h'), kpi('RTO cible', '≤ 4 h', 'restauration documentée et testée'),
        kpi('Sauvegardes conservées', list.length, 'rétention : 30 dernières'), kpi('Chiffrement', 'AES-256-GCM', 'clé dédiée, hors base')),
      h('div', { class: 'toolbar' }, h('p', { class: 'muted' }, 'Chaque sauvegarde est un export complet de la base, chiffré, accompagné de son empreinte SHA-256 et de l\'ancrage de la dernière empreinte du journal d\'audit.'),
        h('button', { class: 'btn btn-primary', onclick: async (e) => { e.currentTarget.disabled = true; const b = await post('/api/admin/sauvegardes'); out.replaceChildren(banner('ok', `Sauvegarde ${b.fichier} créée en ${b.duree_ms} ms (${Math.round(b.taille / 1024)} Ko).`)); draw(); } }, icon('database', 16), ' Lancer une sauvegarde')),
      out,
      card(null, table(['Date', 'Fichier chiffré', 'Taille', 'Empreinte SHA-256', 'Ancrage journal', 'Origine', 'Vérification', ''], list.map((b) => h('tr', {},
        h('td', { class: 'nowrap' }, fmtDateTime(b.cree_le)), h('td', { class: 'mono fine' }, b.fichier), h('td', {}, `${Math.round(b.taille / 1024)} Ko`),
        h('td', { class: 'mono fine' }, short(b.sha256, 16)), h('td', { class: 'mono fine' }, short(b.hash_journal, 12)), h('td', {}, b.declencheur),
        h('td', {}, b.verification_ok === null ? h('span', { class: 'chip chip-gris' }, 'Non vérifiée') : b.verification_ok ? h('span', { class: 'chip chip-vert' }, 'Restaurable') : h('span', { class: 'chip chip-rouge' }, 'Échec')),
        h('td', {}, h('button', { class: 'btn btn-sm', onclick: async () => {
          const r = await post(`/api/admin/sauvegardes/${b.id}/verifier`);
          out.replaceChildren(card(`Vérification de ${r.fichier}`, h('ul', { class: 'checks' }, r.etapes.map((x) => h('li', { class: x.ok ? 'ok' : 'ko' }, icon(x.ok ? 'check' : 'x', 15), x.etape))),
            r.ok ? banner('ok', `Sauvegarde intègre et restaurable (vérifiée en ${r.duree_ms} ms).`) : banner('danger', r.erreur || 'Sauvegarde non conforme.')));
          draw();
        } }, 'Vérifier')))), { empty: 'Aucune sauvegarde.' })));
  };
  await draw();
}

export async function notesValidees(main, { setTitle }) {
  setTitle('Notes validées — modification exceptionnelle');
  const q = h('input', { placeholder: 'Nom, CEF ou groupe…', maxlength: 40 });
  const zone = h('div');
  const draw = async () => {
    const list = await get(`/api/admin/notes-validees?q=${encodeURIComponent(q.value)}`);
    zone.replaceChildren(card(null, table(['Stagiaire', 'Groupe', 'Module', 'Éval.', 'Note', 'Version', 'Validée le', ''], list.map((n) => h('tr', {},
      h('td', {}, h('b', {}, n.nom), ' ', n.prenom, h('div', { class: 'fine mono' }, n.cef)), h('td', {}, n.groupe), h('td', { class: 'mono' }, n.module), h('td', {}, n.type_eval),
      h('td', {}, h('b', {}, fmtNote(n.valeur))), h('td', {}, `v${n.version}`), h('td', {}, fmtDateTime(n.valide_le)),
      h('td', {}, h('button', { class: 'btn btn-sm btn-warn', onclick: () => edit(n) }, 'Modifier')))), { empty: 'Aucune note validée.' })));
  };
  async function edit(n) {
    const v = h('input', { value: String(n.valeur).replace('.', ','), inputmode: 'decimal' }); const m = h('textarea', { rows: 3, maxlength: 300, placeholder: 'Ex. : erreur de report constatée sur la copie, PV de la commission du …' });
    const err = h('div');
    await modal('Modification exceptionnelle d\'une note validée', h('div', { class: 'stack' },
      banner('warn', 'Action exceptionnelle : elle génère une alerte de sécurité, notifie la direction et le formateur, et reste inscrite de façon indélébile au journal d\'audit.'),
      err, h('p', {}, h('b', {}, `${n.nom} ${n.prenom}`), ` — ${n.groupe} · ${n.module} · ${n.type_eval} — note actuelle ${fmtNote(n.valeur)}`),
      field('Nouvelle note', v), field('Motif (obligatoire, 15 caractères min.)', m)), [
      { label: 'Annuler', value: null },
      { label: 'Appliquer la modification', class: 'btn-danger', validate: async () => {
        try { await post(`/api/admin/notes/${n.id}/modifier`, { valeur: v.value.replace(',', '.'), motif: m.value }); toast('Note modifiée — action tracée et signalée.'); draw(); return true; } catch (e) { err.replaceChildren(banner('warn', e.message)); return false; }
      } }]);
  }
  q.addEventListener('change', draw);
  main.replaceChildren(banner('info', 'Séparation des tâches : l\'administrateur ne saisit ni ne valide les notes. Il peut uniquement corriger une note déjà validée, avec motif obligatoire.'),
    h('div', { class: 'toolbar' }, field('Rechercher', q)), zone);
  await draw();
}

export async function technique(main, { setTitle }) {
  setTitle('Journal technique');
  const list = await get('/api/admin/journal-technique');
  main.replaceChildren(banner('info', 'Erreurs applicatives détaillées, réservées aux administrateurs. L\'utilisateur ne voit qu\'un message générique accompagné d\'une référence permettant de retrouver l\'erreur ici.'),
    card(null, table(['Horodatage', 'Niveau', 'Module', 'Message', 'Référence'], list.map((e) => h('tr', {},
      h('td', { class: 'nowrap' }, fmtDateTime(e.horodatage)), h('td', {}, h('span', { class: 'chip chip-rouge' }, e.niveau)), h('td', { class: 'mono' }, e.module),
      h('td', {}, e.message), h('td', { class: 'mono' }, e.reference))), { empty: 'Aucune erreur enregistrée.' })));
}

// --- Performance administrative des formateurs (perspective) ---
const PERF_CRIT = [
  ['cc', 'CC à temps'], ['efm', 'EFM à temps'], ['valide1', 'Validé 1ʳᵉ fois'],
  ['pointage', 'Pointage j. même'], ['absences', 'Absences à temps'], ['complet', 'Complétude'],
];
const POIDS_DEFAUT = { cc: 18, efm: 22, valide1: 12, pointage: 16, absences: 14, complet: 18 };
function chipRythme(r) {
  const cls = r === 'rapide' ? 'chip-vert' : r === 'moyen' ? 'chip-orange' : r === 'long' ? 'chip-rouge' : 'chip-gris';
  return h('span', { class: `chip ${cls}` }, r);
}
const pcell = (v) => (v === null || v === undefined ? h('td', { class: 'fine' }, '—')
  : h('td', {}, h('div', { class: 'perf-bar' },
      h('div', { class: 'perf-track' }, h('i', { style: `width:${v}%;background:${v >= 85 ? 'var(--green)' : v >= 65 ? 'var(--orange)' : 'var(--red)'}` })),
      h('span', { class: 'mono' }, `${v}%`))));

export async function performance(main, { setTitle }) {
  setTitle('Performance administrative des formateurs');
  const poids = { ...POIDS_DEFAUT };
  const zone = h('div');
  const draw = async () => {
    const q = encodeURIComponent(JSON.stringify(poids));
    const res = await get(`/api/admin/performance?poids=${q}`);
    const evalues = res.formateurs.filter((f) => f.note !== null);
    const moy = evalues.length ? Math.round(evalues.reduce((a, b) => a + b.note, 0) / evalues.length) : 0;
    const rapide = evalues.filter((f) => f.rythme === 'rapide').length;
    zone.replaceChildren(
      h('div', { class: 'kpis' },
        kpi('Formateurs évalués', evalues.length, `sur ${res.formateurs.length} actifs`),
        kpi('Note moyenne', `${moy}/100`, 'tous critères confondus'),
        kpi('Classés « rapide »', rapide, '> 70 / 100'),
        kpi('Règle des délais', `+${res.delaiSaisie} j`, `séance à temps sous ${res.delaiSeance} j`)),
      card(null, table(
        ['Formateur', ...PERF_CRIT.map(([, l]) => l), 'Retard', 'Note /100', 'Rythme'],
        res.formateurs.map((f) => h('tr', {},
          h('td', {}, h('b', {}, f.nom), h('div', { class: 'fine mono' }, f.login)),
          ...PERF_CRIT.map(([k]) => pcell(f.criteres[k])),
          h('td', { class: f.retard_moyen_jours > 2 ? 'perf-late' : '' }, `${f.retard_moyen_jours} j`),
          h('td', {}, f.note === null ? h('span', { class: 'fine' }, '—') : h('b', { class: 'perf-score' }, f.note)),
          h('td', {}, chipRythme(f.rythme)))),
        { empty: 'Aucune donnée à mesurer pour le moment.' })));
  };

  let t = null;
  const sliders = PERF_CRIT.map(([k, label]) => {
    const val = h('span', { class: 'mono' }, `${poids[k]} %`);
    const input = h('input', { type: 'range', min: 0, max: 40, value: poids[k],
      oninput: (e) => { poids[k] = Number(e.target.value); val.textContent = `${poids[k]} %`; clearTimeout(t); t = setTimeout(draw, 250); } });
    return h('div', { class: 'perf-w' }, h('div', { class: 'perf-w-top' }, h('span', {}, label), val), input);
  });

  main.replaceChildren(
    banner('info', 'Perspective — note de ponctualité calculée à partir des données déjà horodatées dans eNote (lecture seule). Garde-fous : calcul visible, note proposée (non automatique), décision humaine avec droit de contestation, respect de la loi 09-08. On ne mesure que le respect des délais administratifs, jamais la qualité pédagogique.'),
    card('Pondération des critères', h('p', { class: 'muted' }, 'Ajustez le poids de chaque critère : les notes se recalculent. Seuils : > 70 rapide · 50-70 moyen · < 50 long.'),
      h('div', { class: 'perf-weights' }, ...sliders),
      h('div', { class: 'card-foot' }, h('span'), h('button', { class: 'btn btn-sm', onclick: () => { Object.assign(poids, POIDS_DEFAUT); performance(main, { setTitle }); } }, 'Réinitialiser'))),
    zone);
  await draw();
}

export { chipStatut };
