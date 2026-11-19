import { h, card, toast, banner, icon } from '../ui.js';
import { get, post, del } from '../api.js';

const JOURS = ['', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];

export async function edt(main, { setTitle, me }) {
  setTitle('Emploi du temps');
  const peutModifier = me.role === 'directeur' || me.role === 'administrateur';
  const ref = await get('/api/edt/ref');
  if (!ref.groupes.length) { main.replaceChildren(banner('info', 'Aucun groupe enregistré.')); return; }

  let groupeId = ref.groupes[0].id;
  const grid = h('div');

  const draw = async () => {
    const data = await get(`/api/edt?groupe_id=${groupeId}`);
    const parJour = {};
    for (let j = 1; j <= 6; j++) parJour[j] = [];
    data.seances.forEach((s) => parJour[s.jour].push(s));
    grid.replaceChildren(h('div', { class: 'edt-grid' }, ...[1, 2, 3, 4, 5, 6].map((j) =>
      h('div', { class: 'edt-col' },
        h('div', { class: 'edt-jour' }, JOURS[j]),
        ...(parJour[j].length ? parJour[j].map((s) => h('div', { class: 'edt-case' },
          h('div', { class: 'edt-h' }, `${s.heure_debut} – ${s.heure_fin}`),
          h('div', { class: 'edt-mod' }, s.module),
          h('div', { class: 'edt-f' }, icon('cap', 13), ' ', s.formateur),
          s.salle ? h('div', { class: 'edt-salle' }, 'Salle ', s.salle) : null,
          peutModifier ? h('button', { class: 'edt-del', title: 'Supprimer', onclick: async () => {
            try { await del(`/api/edt/${s.id}`); toast('Créneau supprimé'); draw(); }
            catch (e) { toast(e.message || 'Échec', 'error'); }
          } }, '×') : null))
          : [h('div', { class: 'edt-vide' }, '—')]))));
  };

  // Sélecteur de groupe.
  const selGroupe = h('select', { onchange: (e) => { groupeId = Number(e.target.value); draw(); } },
    ...ref.groupes.map((g) => h('option', { value: g.id }, `${g.code} — ${g.libelle}`)));

  const barre = h('div', { class: 'edt-bar' }, h('label', {}, 'Groupe : '), selGroupe);

  main.replaceChildren(
    banner('info', 'Emploi du temps hebdomadaire par groupe. ' + (peutModifier ? 'Vous pouvez ajouter ou retirer des créneaux.' : 'Consultation seule.')),
    card(null, barre, grid));

  // Formulaire d'ajout (direction seulement).
  if (peutModifier) {
    const fjour = h('select', {}, ...[1, 2, 3, 4, 5, 6].map((j) => h('option', { value: j }, JOURS[j])));
    const fhd = h('input', { type: 'time', value: '08:30' });
    const fhf = h('input', { type: 'time', value: '11:00' });
    const fmod = h('select', {}, ...ref.modules.map((m) => h('option', { value: m.id }, `${m.code} — ${m.intitule}`)));
    const fform = h('select', {}, ...ref.formateurs.map((f) => h('option', { value: f.id }, f.nom_complet)));
    const fsalle = h('input', { type: 'text', maxlength: 40, placeholder: 'Salle (optionnel)' });
    const ajouter = h('button', { class: 'btn btn-primary', onclick: async () => {
      try {
        await post('/api/edt', { groupe_id: groupeId, jour: Number(fjour.value), heure_debut: fhd.value, heure_fin: fhf.value, module_id: Number(fmod.value), formateur_id: Number(fform.value), salle: fsalle.value });
        toast('Créneau ajouté'); fsalle.value = ''; draw();
      } catch (e) { toast(e.message || 'Échec de l\'ajout', 'error'); }
    } }, 'Ajouter le créneau');
    main.appendChild(card('Ajouter un créneau',
      h('div', { class: 'edt-form' },
        champ('Jour', fjour), champ('Début', fhd), champ('Fin', fhf),
        champ('Module', fmod), champ('Formateur', fform), champ('Salle', fsalle)),
      h('div', { class: 'card-foot' }, h('span'), ajouter)));
  }

  await draw();
}

function champ(label, input) {
  return h('div', { class: 'edt-champ' }, h('label', {}, label), input);
}
