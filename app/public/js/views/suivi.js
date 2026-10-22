// Espaces Stagiaire et Parent : consultation en lecture seule des notes validées et de l'assiduité.
import { h, icon, card, kpi, table, banner, fmtDate, fmtDateTime, fmtNote, pct } from '../ui.js';
import { get } from '../api.js';

const EVALS = ['CC1', 'CC2', 'CC3', 'EFM'];
const JUSTIF = { certificat_medical: 'Certificat médical', convocation_officielle: 'Convocation officielle', cas_familial: 'Cas familial grave', autre: 'Autre motif accepté' };
const initiales = (s) => `${s.prenom[0] || ''}${s.nom[0] || ''}`.toUpperCase();

function cellule(e) {
  if (e.etat === 'publiee') return h('span', { class: `nv ${e.valeur >= 10 ? 'nv-ok' : 'nv-ko'}`, title: `Publiée le ${fmtDate(e.publiee_le)}` }, fmtNote(e.valeur));
  if (e.etat === 'en_validation') return h('span', { class: 'chip chip-bleu', title: 'Note saisie, en attente de validation : elle sera visible après validation par la direction.' }, 'En validation');
  return h('span', { class: 'fine' }, '—');
}

function entete(s, extra) {
  return h('section', { class: 'card dossier-head' },
    h('span', { class: 'avatar avatar-lg' }, initiales(s)),
    h('div', { class: 'dossier-id' },
      h('div', { class: 'dossier-name' }, `${s.prenom} ${s.nom}`, extra || null),
      h('div', { class: 'dossier-meta' },
        h('span', {}, 'CEF ', h('b', { class: 'mono' }, s.cef)), h('span', {}, 'Groupe ', h('b', {}, s.groupe)),
        h('span', {}, s.filiere_libelle), h('span', {}, `Année ${s.annee}`))));
}

function kpis(d) {
  const y = d.synthese;
  return h('div', { class: 'kpis' },
    kpi('Moyenne indicative', y.moyenne_indicative === null ? '—' : fmtNote(y.moyenne_indicative), 'moyenne des notes publiées',
      y.moyenne_indicative === null ? '' : y.moyenne_indicative >= 10 ? 'tone-green' : 'tone-red'),
    kpi('Évaluations publiées', y.evaluations_publiees, y.evaluations_en_validation ? `${y.evaluations_en_validation} en cours de validation` : 'aucune en attente', 'tone-blue'),
    kpi('Absences', y.absences, `${y.absences_justifiees} justifiée(s) · ${y.seances_validees} séance(s) validée(s)`, y.absences - y.absences_justifiees ? 'tone-orange' : ''),
    kpi('Assiduité', pct(y.assiduite), 'séances validées par la direction', y.assiduite === null ? '' : y.assiduite >= 0.8 ? 'tone-green' : 'tone-orange'));
}

function tableauNotes(d) {
  return card(h('div', { class: 'card-head-row' }, h('h2', {}, 'Notes par module'), h('span', { class: 'fine' }, 'Barème sur 20 — seules les notes validées par la direction sont affichées')),
    table(['Module', 'Formateur', ...EVALS, 'Moyenne'], d.modules.map((m) => h('tr', {},
      h('td', {}, h('b', { class: 'mono' }, m.code), ' ', h('span', { class: 'muted' }, m.intitule), h('div', { class: 'fine' }, `${m.masse_horaire} h`)),
      h('td', { class: 'muted' }, m.formateurs),
      ...EVALS.map((e) => h('td', { class: 'center' }, cellule(m.evaluations[e]))),
      h('td', { class: 'center' }, m.moyenne === null ? h('span', { class: 'fine' }, '—') : h('b', { class: m.moyenne >= 10 ? 'ok' : 'ko' }, fmtNote(m.moyenne))))),
    { class: 'tbl-suivi', empty: 'Aucun module affecté à ce groupe pour le moment.' }));
}

function tableauAbsences(d, titre = 'Absences enregistrées') {
  return card(h('div', { class: 'card-head-row' }, h('h2', {}, titre), h('span', { class: 'fine' }, 'Séances validées par la direction')),
    table(['Date', 'Horaire', 'Module', 'Formateur', 'Justification'], d.absences.map((a) => h('tr', {},
      h('td', { class: 'nowrap' }, h('b', {}, fmtDate(a.date_seance))), h('td', { class: 'mono' }, `${a.heure_debut} – ${a.heure_fin}`),
      h('td', {}, h('span', { class: 'mono' }, a.module), ' ', h('span', { class: 'muted' }, a.intitule)), h('td', { class: 'muted' }, a.formateur),
      h('td', {}, a.justification ? h('span', { class: 'chip chip-vert' }, `Justifiée — ${JUSTIF[a.justification] || a.justification}`) : h('span', { class: 'chip chip-orange' }, 'Non justifiée')))),
    { empty: 'Aucune absence enregistrée.' }));
}

const AVIS = () => banner('info', 'Les notes sont publiées après le circuit complet : saisie et soumission par le formateur, puis validation par la direction. ',
  'Une évaluation en attente de validation apparaît « En validation », sans sa valeur.');

// ------------------------------------------------------------------ Espace Stagiaire
export async function mesNotes(main, { setTitle }) {
  setTitle('Mes notes');
  const [d, notifs] = await Promise.all([get('/api/stagiaire/dossier'), get('/api/me/notifications')]);
  main.replaceChildren(entete(d.stagiaire), kpis(d), AVIS(), tableauNotes(d),
    h('div', { class: 'grid-2' },
      tableauAbsences(d),
      card('Notifications récentes', notifs.length ? h('div', { class: 'notif-list' }, notifs.slice(0, 5).map((n) => h('div', { class: `notif notif-${n.type} ${n.lue ? '' : 'unread'}` },
        icon(n.type === 'securite' ? 'shield' : n.type === 'retour' ? 'alert' : 'bell', 16), h('div', {}, h('div', {}, n.message), h('div', { class: 'fine' }, fmtDateTime(n.cree_le))))))
        : h('p', { class: 'muted' }, 'Vous serez prévenu(e) ici dès qu\'une nouvelle note est publiée ou qu\'une absence est enregistrée.'))));
}

export async function mesAbsences(main, { setTitle }) {
  setTitle('Mes absences');
  const d = await get('/api/stagiaire/dossier');
  main.replaceChildren(entete(d.stagiaire), kpis(d), tableauAbsences(d),
    banner('info', 'En cas d\'erreur sur une absence, remettez votre justificatif au gestionnaire des stagiaires, qui l\'enregistre ; toute décision est tracée et vous en êtes informé(e).'));
}

// ------------------------------------------------------------------ Espace Parent
export async function enfants(main, { setTitle, me }) {
  setTitle('Suivi de mes enfants');
  const list = await get('/api/parent/enfants');
  main.replaceChildren(
    h('div', { class: 'hello' }, h('h2', {}, `Bonjour ${me.nom}`),
      h('p', { class: 'muted' }, 'Suivez les résultats et l\'assiduité des stagiaires rattachés à votre compte par l\'établissement.')),
    banner('info', 'Pour protéger les données personnelles (loi 09-08), seuls les stagiaires rattachés à votre compte par l\'administration sont accessibles. Chaque consultation est enregistrée dans le journal d\'audit.'),
    list.length ? h('div', { class: 'enfants' }, list.map((e) => h('a', { class: 'card enfant', href: `#/enfant?id=${e.id}` },
      h('div', { class: 'enfant-top' }, h('span', { class: 'avatar avatar-lg' }, initiales(e)),
        h('div', {}, h('div', { class: 'dossier-name' }, `${e.prenom} ${e.nom}`), h('div', { class: 'fine' }, `CEF ${e.cef} · ${e.groupe} · ${e.lien_libelle}`))),
      h('div', { class: 'enfant-stats' },
        h('div', {}, h('span', {}, 'Moyenne indicative'), h('b', { class: e.synthese.moyenne_indicative === null ? '' : e.synthese.moyenne_indicative >= 10 ? 'ok' : 'ko' },
          e.synthese.moyenne_indicative === null ? '—' : fmtNote(e.synthese.moyenne_indicative))),
        h('div', {}, h('span', {}, 'Notes publiées'), h('b', {}, e.synthese.evaluations_publiees)),
        h('div', {}, h('span', {}, 'Absences'), h('b', { class: e.synthese.absences ? 'warn-t' : '' }, e.synthese.absences)),
        h('div', {}, h('span', {}, 'Assiduité'), h('b', {}, pct(e.synthese.assiduite)))),
      h('div', { class: 'fine enfant-go' }, e.groupe_libelle, h('span', { class: 'link-like' }, 'Voir le suivi détaillé →')))))
      : card(null, h('p', { class: 'empty' }, 'Aucun stagiaire n\'est encore rattaché à votre compte. Contactez l\'administration de l\'établissement.')));
}

export async function enfant(main, { setTitle }) {
  const id = new URLSearchParams(location.hash.split('?')[1] || '').get('id');
  const d = await get(`/api/parent/enfants/${encodeURIComponent(id || '')}`);
  setTitle(`Suivi de ${d.stagiaire.prenom} ${d.stagiaire.nom}`);
  main.replaceChildren(
    h('a', { class: 'back', href: '#/' }, '← Tous mes enfants'),
    entete(d.stagiaire, h('span', { class: 'chip chip-gris chip-xs' }, d.lien_libelle)),
    kpis(d), AVIS(), tableauNotes(d), tableauAbsences(d));
}
