// Vues du gestionnaire des stagiaires : suivi de l'assiduité et justificatifs d'absence.
// Aucun accès aux notes ni à la validation des séances (contrôlé côté serveur).
import { h, icon, card, kpi, table, toast, banner, field, modal, fmtDate, fmtDateTime, pct } from '../ui.js';
import { get, post } from '../api.js';

const MOTIFS = [['certificat_medical', 'Certificat médical'], ['convocation_officielle', 'Convocation officielle'],
  ['cas_familial', 'Cas familial grave'], ['autre', 'Autre motif accepté']];

const chipJustif = (a) => (a.motif
  ? h('span', { class: 'chip chip-vert', title: a.commentaire || '' }, `Justifiée — ${a.motif_libelle}`)
  : h('span', { class: 'chip chip-orange' }, 'Non justifiée'));

export async function dashboard(main, { setTitle, me }) {
  setTitle('Tableau de bord');
  const d = await get('/api/absences/synthese');
  const t = d.totaux;
  main.replaceChildren(
    h('div', { class: 'hello' }, h('h2', {}, `Bonjour ${me.nom}`),
      h('p', { class: 'muted' }, 'Suivi de l\'assiduité des stagiaires : les absences proviennent des séances validées par la direction, et vous enregistrez les justificatifs présentés.')),
    h('div', { class: 'kpis' },
      kpi('Absences enregistrées', t.absences, `sur ${t.seances} séance(s) validée(s)`, 'tone-blue'),
      kpi('Non justifiées', t.non_justifiees, 'à traiter', t.non_justifiees ? 'tone-orange' : 'tone-green'),
      kpi('Justifiées', t.justifiees, 'justificatif enregistré', 'tone-green'),
      kpi('Taux de justification', t.absences ? pct(t.justifiees / t.absences) : '—', 'toutes absences confondues', '')),
    h('div', { class: 'grid-2' },
      card('Assiduité par groupe', table(['Groupe', 'Effectif', 'Séances', 'Absences', 'Justifiées', 'Taux d\'absence'], d.groupes.map((g) => h('tr', {},
        h('td', {}, h('b', {}, g.groupe)), h('td', {}, g.effectif), h('td', {}, g.seances), h('td', {}, g.absences),
        h('td', {}, g.absences ? `${g.justifiees}/${g.absences}` : '—'), h('td', {}, pct(g.taux_absence)))))),
      card('Stagiaires à suivre (absences non justifiées)', d.a_suivre.length
        ? table(['Stagiaire', 'Absences', 'Non justifiées', ''], d.a_suivre.map((s) => h('tr', {},
          h('td', {}, h('b', {}, s.nom), ' ', s.prenom, h('div', { class: 'fine' }, `CEF ${s.cef} · ${s.groupe}`)), h('td', {}, s.absences),
          h('td', {}, h('b', { class: 'warn-t' }, s.non_justifiees)),
          h('td', {}, h('a', { class: 'btn btn-sm', href: `#/absences?q=${encodeURIComponent(s.cef)}` }, 'Traiter')))))
        : h('p', { class: 'muted' }, 'Aucune absence non justifiée.'))));
}

export async function liste(main, { setTitle }) {
  setTitle('Absences et justificatifs');
  const params = new URLSearchParams(location.hash.split('?')[1] || '');
  const synth = await get('/api/absences/synthese');
  const grp = h('select', {}, [h('option', { value: '' }, 'Tous les groupes'), ...synth.groupes.map((g) => h('option', { value: g.id }, g.groupe))]);
  const st = h('select', {}, [['', 'Toutes les absences'], ['non_justifiees', 'Non justifiées'], ['justifiees', 'Justifiées']].map(([v, l]) => h('option', { value: v }, l)));
  const q = h('input', { placeholder: 'CEF ou nom…', maxlength: 40, value: params.get('q') || '' });
  const zone = h('div');
  [grp, st].forEach((x) => x.addEventListener('change', draw)); q.addEventListener('change', draw);
  main.replaceChildren(
    banner('info', 'Une absence est enregistrée par le formateur et devient officielle quand la direction valide la séance. Vous la qualifiez : justifiée (avec le motif) ou non justifiée. Chaque décision est inscrite au journal d\'audit, et le stagiaire et ses parents en sont informés.'),
    h('div', { class: 'toolbar' }, field('Groupe', grp), field('Statut', st), field('Stagiaire', q)),
    zone);
  draw();

  async function draw() {
    const list = await get(`/api/absences?groupe_id=${grp.value}&statut=${st.value}&q=${encodeURIComponent(q.value)}`);
    zone.replaceChildren(card(null, table(['Date', 'Horaire', 'Groupe · Module', 'Stagiaire', 'Justification', ''], list.map((a) => h('tr', {},
      h('td', { class: 'nowrap' }, h('b', {}, fmtDate(a.date_seance))), h('td', { class: 'mono' }, `${a.heure_debut}–${a.heure_fin}`),
      h('td', {}, h('b', {}, a.groupe), ' · ', h('span', { class: 'mono' }, a.module), h('div', { class: 'fine' }, a.formateur)),
      h('td', {}, h('span', { class: 'mono' }, a.cef), ' ', h('b', {}, a.nom), ' ', a.prenom),
      h('td', {}, chipJustif(a), a.motif ? h('div', { class: 'fine' }, `${a.saisi_par} · ${fmtDateTime(a.saisi_le)}`) : null),
      h('td', { class: 'nowrap' }, a.motif
        ? [h('button', { class: 'btn btn-sm', onclick: () => justifier(a) }, 'Modifier'), ' ', h('button', { class: 'btn btn-sm btn-warn', onclick: () => retirer(a) }, 'Retirer')]
        : h('button', { class: 'btn btn-sm btn-primary', onclick: () => justifier(a) }, 'Justifier')))),
    { empty: 'Aucune absence pour ces critères.' })));
  }

  async function justifier(a) {
    const motif = h('select', {}, MOTIFS.map(([v, l]) => h('option', { value: v, selected: a.motif === v }, l)));
    const com = h('textarea', { rows: 3, maxlength: 300, placeholder: 'Précisions (facultatif) — conservées chiffrées' }, a.commentaire || '');
    const err = h('div');
    const ok = await modal('Justifier une absence', h('div', { class: 'stack' }, err,
      h('p', {}, h('b', {}, `${a.prenom} ${a.nom}`), ` (CEF ${a.cef}) — absent(e) le ${fmtDate(a.date_seance)}, ${a.heure_debut}–${a.heure_fin}, ${a.module} ${a.intitule}.`),
      field('Motif du justificatif', motif), field('Commentaire', com),
      h('p', { class: 'fine' }, icon('log', 13), ' Enregistré au journal d\'audit à votre nom ; le stagiaire et ses parents sont informés (sans le commentaire).')), [
      { label: 'Annuler', value: false },
      { label: 'Enregistrer', class: 'btn-primary', validate: async () => {
        try { await post('/api/absences/justification', { seance_id: a.seance_id, stagiaire_id: a.stagiaire_id, motif: motif.value, commentaire: com.value }); return true; } catch (e) { err.replaceChildren(banner('warn', e.message)); return false; }
      } }]);
    if (ok) { toast('Justificatif enregistré et tracé.'); draw(); }
  }

  async function retirer(a) {
    const raison = h('textarea', { rows: 3, maxlength: 300, placeholder: 'Raison du retrait (obligatoire, tracée)' });
    const err = h('div');
    const ok = await modal('Retirer la justification', h('div', { class: 'stack' }, err,
      h('p', {}, `L'absence de ${a.prenom} ${a.nom} du ${fmtDate(a.date_seance)} redeviendra « non justifiée ».`), field('Raison', raison)), [
      { label: 'Annuler', value: false },
      { label: 'Retirer', class: 'btn-warn', validate: async () => {
        try { await post('/api/absences/justification/retirer', { seance_id: a.seance_id, stagiaire_id: a.stagiaire_id, raison: raison.value }); return true; } catch (e) { err.replaceChildren(banner('warn', e.message)); return false; }
      } }]);
    if (ok) { toast('Justification retirée — action tracée.'); draw(); }
  }
}
