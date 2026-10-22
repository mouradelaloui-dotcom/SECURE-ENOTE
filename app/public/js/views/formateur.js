import { h, icon, card, kpi, table, chipStatut, toast, banner, field, modal, fmtDate, fmtDateTime, fmtNote } from '../ui.js';
import { get, post, put } from '../api.js';

const sum = (o, ...k) => k.reduce((a, x) => a + (o?.[x] || 0), 0);

export async function dashboard(main, { setTitle, me }) {
  setTitle('Tableau de bord');
  const [aff, notifs, sec] = await Promise.all([get('/api/formateur/affectations'), get('/api/me/notifications'), get('/api/me/securite')]);
  const t = aff.reduce((acc, a) => {
    acc.brouillon += sum(a.notes_par_statut, 'brouillon', 'a_corriger');
    acc.attente += sum(a.notes_par_statut, 'soumise');
    acc.validee += sum(a.notes_par_statut, 'validee');
    acc.seances += sum(a.seances_par_statut, 'brouillon', 'a_corriger');
    return acc;
  }, { brouillon: 0, attente: 0, validee: 0, seances: 0 });
  const cx = sec.connexions.filter((c) => c.action === 'auth.connexion');
  const derniere = cx[1] || cx[0];
  main.replaceChildren(
    h('div', { class: 'hello' }, h('h2', {}, `Bonjour ${me.nom.split(' ')[0]}`),
      h('p', { class: 'muted' }, 'Voici l\'état de vos saisies. Chaque note est chiffrée dès l\'enregistrement et chaque opération est tracée à votre nom.')),
    h('div', { class: 'kpis' },
      kpi('Notes à finaliser', t.brouillon, 'brouillons ou à corriger', t.brouillon ? 'tone-orange' : ''),
      kpi('En attente de validation', t.attente, 'soumises à la direction', 'tone-blue'),
      kpi('Notes validées', t.validee, 'verrouillées', 'tone-green'),
      kpi('Séances à soumettre', t.seances, 'brouillons ou à corriger', t.seances ? 'tone-orange' : '')),
    h('div', { class: 'grid-2' },
      card('Mes affectations', table(['Groupe', 'Module', 'Effectif', 'Notes', 'Séances', ''], aff.map((a) => h('tr', {},
        h('td', {}, h('b', {}, a.groupe)), h('td', {}, h('span', { class: 'mono' }, a.module), ' ', h('span', { class: 'muted' }, a.intitule)), h('td', {}, a.effectif),
        h('td', {}, Object.entries(a.notes_par_statut).map(([s, n]) => h('span', { class: 'mini' }, chipStatut(s), ` ${n}`))),
        h('td', {}, sum(a.seances_par_statut, 'brouillon', 'soumise', 'controlee', 'validee', 'a_corriger')),
        h('td', {}, h('a', { class: 'btn btn-sm', href: `#/notes?g=${a.groupe_id}&m=${a.module_id}` }, 'Saisir')))))),
      h('div', { class: 'stack' },
        card('Sécurité de mon compte', h('ul', { class: 'facts' },
          h('li', {}, icon('shieldcheck', 16), 'Vérification en deux étapes : ', h('b', { class: 'ok' }, 'active')),
          h('li', {}, icon('device', 16), 'Connexion précédente : ', h('b', {}, derniere ? fmtDateTime(derniere.horodatage) : '—'), derniere?.ip ? ` depuis ${derniere.ip}` : ''),
          h('li', {}, icon('key', 16), 'Mot de passe modifié le ', h('b', {}, fmtDate(sec.mdp_change_le))),
          h('li', {}, icon('users', 16), 'Sessions ouvertes : ', h('b', {}, sec.sessions.length))),
        h('a', { class: 'btn btn-sm', href: '#/compte' }, 'Gérer la sécurité du compte')),
        card('Notifications récentes', notifs.length ? h('div', { class: 'notif-list' }, notifs.slice(0, 4).map((n) => h('div', { class: `notif notif-${n.type} ${n.lue ? '' : 'unread'}` },
          icon(n.type === 'securite' ? 'shield' : n.type === 'retour' ? 'alert' : 'bell', 16), h('div', {}, h('div', {}, n.message), h('div', { class: 'fine' }, fmtDateTime(n.cree_le))))))
          : h('p', { class: 'muted' }, 'Aucune notification.')))));
}

export async function notes(main, { setTitle }) {
  setTitle('Saisie des notes');
  const aff = await get('/api/formateur/affectations');
  if (!aff.length) { main.replaceChildren(banner('info', 'Aucune affectation : contactez l\'administration de l\'établissement.')); return; }
  const params = new URLSearchParams((location.hash.split('?')[1]) || '');
  let sel = aff.find((a) => String(a.groupe_id) === params.get('g') && String(a.module_id) === params.get('m')) || aff[0];
  let type = params.get('t') || 'CC1';
  const select = h('select', { onchange: () => { sel = aff[select.selectedIndex]; load(); } },
    aff.map((a) => h('option', { selected: a === sel }, `${a.groupe} — ${a.module} ${a.intitule}`)));
  const tabs = h('div', { class: 'tabs' }, ['CC1', 'CC2', 'CC3', 'EFM'].map((t) => h('button', { class: t === type ? 'tab on' : 'tab', onclick: (e) => {
    type = t; tabs.querySelectorAll('.tab').forEach((b) => b.classList.toggle('on', b === e.currentTarget)); load();
  } }, t === 'EFM' ? 'EFM (fin de module)' : `Contrôle ${t.slice(2)}`)));
  const zone = h('div');
  main.replaceChildren(
    h('div', { class: 'toolbar' }, field('Groupe et module', select), tabs),
    zone);

  async function load() {
    const d = await get(`/api/notes?groupe_id=${sel.groupe_id}&module_id=${sel.module_id}&type_eval=${type}`);
    const editable = (l) => !l.statut || ['brouillon', 'a_corriger'].includes(l.statut);
    const inputs = [];
    const rows = d.lignes.map((l) => {
      const v = h('input', { class: 'note-input', inputmode: 'decimal', value: l.valeur === null ? '' : String(l.valeur).replace('.', ','), disabled: !editable(l), 'aria-label': `Note de ${l.prenom} ${l.nom}` });
      const o = h('input', { class: 'obs-input', value: l.observation || '', maxlength: 300, disabled: !editable(l), placeholder: editable(l) ? 'Observation (facultatif)' : '' });
      v.addEventListener('input', () => { v.classList.toggle('invalid', v.value !== '' && !(Number(v.value.replace(',', '.')) >= 0 && Number(v.value.replace(',', '.')) <= 20)); });
      inputs.push({ l, v, o });
      return h('tr', { class: editable(l) ? '' : 'locked' }, h('td', { class: 'mono' }, l.cef), h('td', {}, h('b', {}, l.nom), ' ', l.prenom), h('td', {}, v), h('td', {}, o),
        h('td', {}, l.statut ? chipStatut(l.statut) : h('span', { class: 'chip chip-vide' }, 'Non saisie')),
        h('td', { class: 'fine' }, l.version > 1 ? `v${l.version}` : ''));
    });
    const all = d.lignes; const locked = all.filter((l) => !editable(l)).length;
    const retour = all.find((l) => l.statut === 'a_corriger' && l.motif_retour);
    const vals = all.filter((l) => l.valeur !== null).map((l) => l.valeur);
    const save = async (quiet) => {
      const payload = inputs.filter((x) => editable(x.l)).map((x) => ({ stagiaire_id: x.l.stagiaire_id, valeur: x.v.value.trim(), observation: x.o.value.trim() }));
      const r = await put('/api/notes', { groupe_id: sel.groupe_id, module_id: sel.module_id, type_eval: type, notes: payload });
      if (!quiet) toast(`Brouillon enregistré et chiffré : ${r.creees} note(s) créée(s), ${r.modifiees} modifiée(s).`);
      return r;
    };
    zone.replaceChildren(
      retour ? banner('warn', h('b', {}, 'Renvoyé pour correction : '), retour.motif_retour) : null,
      locked === all.length && all.length ? banner('ok', 'Feuille soumise : les notes sont verrouillées. Toute modification ultérieure passe par une procédure exceptionnelle tracée.') : null,
      card(h('div', { class: 'card-head-row' }, h('h2', {}, `${d.groupe} · ${d.module} · ${type}`),
        h('div', { class: 'muted' }, `${vals.length}/${all.length} saisies`, vals.length ? ` · moyenne ${fmtNote(vals.reduce((a, b) => a + b, 0) / vals.length)}` : '')),
      table(['CEF', 'Stagiaire', 'Note /20', 'Observation', 'Statut', ''], rows, { class: 'tbl-notes' }),
      h('div', { class: 'card-foot' },
        h('span', { class: 'fine' }, icon('lock', 14), ' Valeurs chiffrées (AES-256-GCM) avant écriture en base · chaque saisie est inscrite au journal d\'audit.'),
        h('div', { class: 'actions' },
          h('button', { class: 'btn', disabled: locked === all.length, onclick: () => save().then(load).catch((e) => toast(e.message, 'err')) }, 'Enregistrer le brouillon'),
          h('button', { class: 'btn btn-primary', disabled: locked === all.length, onclick: async () => {
            const ok = await modal('Soumettre à la direction', h('p', {}, `Vous allez soumettre les notes ${type} du groupe ${d.groupe} (${d.module}) à la direction pour validation. Elles ne seront plus modifiables, sauf renvoi pour correction.`),
              [{ label: 'Annuler', value: false }, { label: 'Confirmer la soumission', class: 'btn-primary', value: true }]);
            if (!ok) return;
            try { await save(true); const r = await post('/api/notes/soumettre', { groupe_id: sel.groupe_id, module_id: sel.module_id, type_eval: type }); toast(`${r.soumises} note(s) soumise(s) à la direction.`); load(); } catch (e) { toast(e.message, 'err'); }
          } }, 'Soumettre à la direction')))));
  }
  await load();
}

export async function seances(main, { setTitle }) {
  setTitle('Mes séances');
  const [aff, list] = await Promise.all([get('/api/formateur/affectations'), get('/api/seances')]);
  const draw = (items) => main.replaceChildren(
    h('div', { class: 'toolbar' }, h('p', { class: 'muted' }, 'Déclarez chaque séance (contenu et absences) puis soumettez-la à la validation de la direction. Les absences deviennent officielles à la validation.'),
      h('button', { class: 'btn btn-primary', onclick: () => edit() }, '+ Déclarer une séance')),
    card(null, table(['Date', 'Horaire', 'Groupe', 'Module', 'Contenu', 'Absences', 'Statut', ''], items.map((s) => h('tr', {},
      h('td', {}, fmtDate(s.date_seance)), h('td', { class: 'mono' }, `${s.heure_debut}–${s.heure_fin}`), h('td', {}, h('b', {}, s.groupe)), h('td', { class: 'mono' }, s.module),
      h('td', { class: 'clip' }, s.contenu, s.motif_retour ? h('div', { class: 'retour' }, icon('alert', 13), ' ', s.motif_retour) : null),
      h('td', {}, `${s.absents.length}/${s.effectif}`), h('td', {}, chipStatut(s.statut)),
      h('td', { class: 'nowrap' }, ['brouillon', 'a_corriger'].includes(s.statut) ? [
        h('button', { class: 'btn btn-sm', onclick: () => edit(s.id) }, 'Modifier'), ' ',
        h('button', { class: 'btn btn-sm btn-primary', onclick: async () => { try { await post(`/api/seances/${s.id}/soumettre`); toast('Séance soumise à la direction.'); reload(); } catch (e) { toast(e.message, 'err'); } } }, 'Soumettre')] : ''))))));
  const reload = async () => draw(await get('/api/seances'));
  draw(list);

  async function edit(id) {
    const s = id ? await get(`/api/seances/${id}`) : null;
    let current = s ? aff.find((a) => a.groupe_id === s.groupe_id && a.module_id === s.module_id) : aff[0];
    const sel = h('select', {}, aff.map((a) => h('option', { selected: a === current }, `${a.groupe} — ${a.module} ${a.intitule}`)));
    const date = h('input', { type: 'date', value: s?.date_seance || new Date().toISOString().slice(0, 10), max: new Date().toISOString().slice(0, 10) });
    const deb = h('input', { type: 'time', value: s?.heure_debut || '08:30' }); const fin = h('input', { type: 'time', value: s?.heure_fin || '11:00' });
    const contenu = h('textarea', { rows: 3, maxlength: 1000, placeholder: 'Contenu dispensé, activités réalisées…' }, s?.contenu || '');
    const abs = h('div', { class: 'abs-grid' });
    const loadStag = async () => {
      const st = s && current.groupe_id === s.groupe_id ? s.stagiaires : await get(`/api/groupes/${current.groupe_id}/stagiaires?module_id=${current.module_id}`);
      abs.replaceChildren(...st.map((x) => h('label', { class: 'abs' }, h('input', { type: 'checkbox', value: x.id, checked: s?.absents?.includes(x.id) }), `${x.nom} ${x.prenom}`)));
    };
    sel.addEventListener('change', () => { current = aff[sel.selectedIndex]; loadStag(); });
    await loadStag();
    const err = h('div');
    await modal(id ? 'Modifier la séance' : 'Déclarer une séance', h('div', { class: 'stack' }, err,
      field('Groupe et module', sel), h('div', { class: 'row-3' }, field('Date', date), field('Début', deb), field('Fin', fin)),
      field('Contenu dispensé', contenu), h('div', { class: 'field-label' }, 'Stagiaires absents (cochez)'), abs), [
      { label: 'Annuler', value: null },
      { label: 'Enregistrer le brouillon', class: 'btn-primary', validate: async () => {
        try {
          await post('/api/seances', { id, groupe_id: current.groupe_id, module_id: current.module_id, date_seance: date.value, heure_debut: deb.value, heure_fin: fin.value,
            contenu: contenu.value, absents: [...abs.querySelectorAll('input:checked')].map((c) => Number(c.value)) });
          toast('Séance enregistrée (contenu chiffré).'); reload(); return true;
        } catch (e) { err.replaceChildren(banner('warn', e.message)); return false; }
      } }]);
  }
}
