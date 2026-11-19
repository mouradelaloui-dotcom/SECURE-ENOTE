import { h, card, toast, banner, icon } from '../ui.js';
import { get, post, put, del } from '../api.js';

const LIB = { en_recherche: 'En recherche', en_cours: 'En cours', termine: 'Terminé', valide: 'Validé' };
const CLS = { en_recherche: 'st-rech', en_cours: 'st-cours', termine: 'st-fini', valide: 'st-valide' };
const STATUTS = ['en_recherche', 'en_cours', 'termine', 'valide'];

export async function stages(main, { setTitle, me }) {
  setTitle('Stages');

  // Vue stagiaire : son propre stage.
  if (me.role === 'stagiaire') {
    const d = await get('/api/stages/moi');
    if (!d.stage) { main.replaceChildren(banner('info', 'Aucun stage ne vous est encore attribué. Contactez l\'administration.')); return; }
    const s = d.stage;
    main.replaceChildren(card('Mon stage',
      ligne('Entreprise', s.entreprise + (s.ville ? ` — ${s.ville}` : '')),
      ligne('Statut', h('span', { class: `st-chip ${CLS[s.statut]}` }, LIB[s.statut])),
      ligne('Encadrant', s.encadrant || '—'),
      ligne('Tuteur en entreprise', s.tuteur || '—'),
      ligne('Période', (s.date_debut || '?') + ' → ' + (s.date_fin || '?')),
      ligne('Sujet', s.sujet || '—')));
    return;
  }

  const peutGerer = me.role === 'directeur' || me.role === 'gestionnaire';
  const ref = await get('/api/stages/ref');
  const zone = h('div');

  const draw = async (filtre = '') => {
    const d = await get('/api/stages' + (filtre ? `?statut=${filtre}` : ''));
    const compte = STATUTS.map((st) => d.stages.filter((x) => x.statut === st).length);
    zone.replaceChildren(
      h('div', { class: 'st-kpis' }, ...STATUTS.map((st, i) =>
        h('div', { class: `st-kpi ${CLS[st]}` }, h('b', {}, compte[i]), h('span', {}, LIB[st])))),
      card(null, d.stages.length ? h('table', { class: 'tbl' },
        h('thead', {}, h('tr', {}, ...['Stagiaire', 'Groupe', 'Entreprise', 'Encadrant', 'Période', 'Statut', peutGerer ? '' : null].filter((x) => x !== null).map((t) => h('th', {}, t)))),
        h('tbody', {}, ...d.stages.map((s) => h('tr', {},
          h('td', {}, h('b', {}, `${s.stagiaire_nom} ${s.stagiaire_prenom}`), h('div', { class: 'fine mono' }, s.cef)),
          h('td', {}, s.groupe),
          h('td', {}, s.entreprise, s.ville ? h('div', { class: 'fine' }, s.ville) : null),
          h('td', {}, s.encadrant || '—'),
          h('td', { class: 'fine' }, (s.date_debut || '?') + ' → ' + (s.date_fin || '?')),
          h('td', {}, peutGerer
            ? h('select', { class: 'st-sel', onchange: async (e) => { try { await put(`/api/stages/${s.id}`, { statut: e.target.value }); toast('Statut mis à jour'); draw(filtre); } catch (err) { toast(err.message, 'error'); } } },
                ...STATUTS.map((st) => h('option', { value: st, selected: st === s.statut }, LIB[st])))
            : h('span', { class: `st-chip ${CLS[s.statut]}` }, LIB[s.statut])),
          peutGerer ? h('td', {}, h('button', { class: 'st-del', title: 'Supprimer', onclick: async () => { try { await del(`/api/stages/${s.id}`); toast('Stage supprimé'); draw(filtre); } catch (err) { toast(err.message, 'error'); } } }, '×')) : null))))
        : h('p', { class: 'muted' }, 'Aucun stage.')));
  };

  const filtre = h('select', { onchange: (e) => draw(e.target.value) },
    h('option', { value: '' }, 'Tous les statuts'), ...STATUTS.map((st) => h('option', { value: st }, LIB[st])));

  main.replaceChildren(
    banner('info', 'Suivi des stages des stagiaires. ' + (peutGerer ? 'Vous pouvez créer et suivre les stages.' : 'Consultation seule.')),
    card(null, h('div', { class: 'st-bar' }, h('label', {}, 'Filtrer : '), filtre)),
    zone);

  if (peutGerer) {
    const fst = h('select', {}, ...ref.stagiaires.map((s) => h('option', { value: s.id }, `${s.nom} ${s.prenom} (${s.groupe})`)));
    const fent = h('input', { type: 'text', maxlength: 120, placeholder: 'Entreprise' });
    const fville = h('input', { type: 'text', maxlength: 60, placeholder: 'Ville' });
    const ftut = h('input', { type: 'text', maxlength: 80, placeholder: 'Tuteur en entreprise' });
    const fenc = h('select', {}, h('option', { value: '' }, '— Encadrant —'), ...ref.formateurs.map((f) => h('option', { value: f.id }, f.nom_complet)));
    const fdd = h('input', { type: 'date' });
    const fdf = h('input', { type: 'date' });
    const fsuj = h('input', { type: 'text', maxlength: 200, placeholder: 'Sujet du stage' });
    const add = h('button', { class: 'btn btn-primary', onclick: async () => {
      try {
        await post('/api/stages', { stagiaire_id: Number(fst.value), entreprise: fent.value, ville: fville.value, tuteur: ftut.value, encadrant_id: fenc.value || null, date_debut: fdd.value, date_fin: fdf.value, sujet: fsuj.value, statut: 'en_recherche' });
        toast('Stage créé'); fent.value = ''; fville.value = ''; ftut.value = ''; fsuj.value = ''; draw(filtre.value);
      } catch (e) { toast(e.message || 'Échec', 'error'); }
    } }, 'Créer le stage');
    main.appendChild(card('Nouveau stage',
      h('div', { class: 'st-form' },
        champ('Stagiaire', fst), champ('Entreprise', fent), champ('Ville', fville),
        champ('Tuteur', ftut), champ('Encadrant', fenc), champ('Sujet', fsuj),
        champ('Début', fdd), champ('Fin', fdf)),
      h('div', { class: 'card-foot' }, h('span'), add)));
  }
  await draw();
}

function champ(label, input) { return h('div', { class: 'st-champ' }, h('label', {}, label), input); }
function ligne(label, val) { return h('div', { class: 'st-ligne' }, h('span', { class: 'st-lab' }, label), h('span', {}, val)); }
