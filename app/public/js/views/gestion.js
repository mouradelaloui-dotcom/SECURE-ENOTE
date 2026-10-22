// Vues de la Directrice : pilotage, validation des notes et des séances, exports tracés.
import { h, icon, card, kpi, table, chipStatut, toast, banner, field, modal, fmtDate, fmtDateTime, fmtNote, pct, short } from '../ui.js';
import { get, post, api } from '../api.js';

const isDir = (me) => me.role === 'directeur';

export async function dashboard(main, { setTitle, me }) {
  setTitle('Tableau de bord');
  const [stats, vn, vs] = await Promise.all([get('/api/stats'), get('/api/validation/notes'), get('/api/validation/seances')]);
  const synth = isDir(me) ? await get('/api/securite/synthese') : null;
  const n = stats.notes; const s = stats.seances;
  main.replaceChildren(
    h('div', { class: 'hello' }, h('h2', {}, isDir(me) ? 'Pilotage pédagogique — Direction' : 'Suivi de l\'assiduité'),
      h('p', { class: 'muted' }, isDir(me)
        ? 'Vous validez les notes et les séances soumises par les formateurs. Le gestionnaire des stagiaires suit les absences et enregistre les justificatifs.'
        : 'Vous contrôlez les séances et les absences déclarées par les formateurs avant leur validation par la direction. Les notes ne relèvent pas de votre périmètre.')),
    h('div', { class: 'kpis' },
      isDir(me) ? kpi('Lots de notes à valider', vn.lots.length, `${vn.lots.reduce((a, l) => a + l.nb, 0)} notes`, vn.lots.length ? 'tone-orange' : '') : null,
      kpi(isDir(me) ? 'Séances à valider' : 'Séances à contrôler', vs.seances.length, 'en attente à votre étape', vs.seances.length ? 'tone-orange' : ''),
      isDir(me) ? kpi('Notes validées', n.validee || 0, `${n.soumise || 0} en attente de validation`, 'tone-green') : null,
      kpi('Séances validées', s.validee || 0, `${s.soumise || 0} en attente de validation`, 'tone-blue'),
      isDir(me) ? null : kpi('Absences déclarées', stats.absences.reduce((a, x) => a + x.absences, 0), `sur ${stats.absences.reduce((a, x) => a + x.seances, 0)} séances`, 'tone-orange')),
    h('div', { class: 'grid-2' },
      !isDir(me) ? null : card('Résultats des évaluations validées', table(['Groupe', 'Module', 'Éval.', 'Notes', 'Moyenne', 'Réussite ≥ 10'], stats.moyennes.map((m) => h('tr', {},
        h('td', {}, h('b', {}, m.groupe)), h('td', { class: 'mono' }, m.module), h('td', {}, m.type_eval), h('td', {}, m.nb), h('td', {}, h('b', {}, fmtNote(m.moyenne))),
        h('td', {}, h('div', { class: 'meter' }, h('span', { class: 'meter-fill', dataset: { w: Math.round(m.reussite * 100) } })), ' ', pct(m.reussite)))))),
      h('div', { class: 'stack' },
        card('Assiduité (séances déclarées)', table(['Groupe', 'Séances', 'Absences', 'Taux d\'absence'], stats.absences.map((a) => h('tr', {},
          h('td', {}, h('b', {}, a.groupe)), h('td', {}, a.seances), h('td', {}, a.absences), h('td', {}, pct(a.presences_attendues ? a.absences / a.presences_attendues : 0)))))),
        synth ? card('Sécurité de l\'application (synthèse)', h('ul', { class: 'facts' },
          h('li', {}, icon('shieldcheck', 16), 'Comptes protégés par MFA : ', h('b', {}, pct(synth.taux_mfa))),
          h('li', {}, icon('alert', 16), 'Alertes de sécurité ouvertes : ', h('b', { class: synth.alertes.critiques ? 'ko' : '' }, synth.alertes.ouvertes), synth.alertes.critiques ? ` dont ${synth.alertes.critiques} critique(s)` : ''),
          h('li', {}, icon('log', 16), 'Intégrité du journal d\'audit : ', synth.integrite ? h('b', { class: synth.integrite.integre ? 'ok' : 'ko' }, synth.integrite.integre ? 'vérifiée' : 'ROMPUE') : '—'),
          h('li', {}, icon('database', 16), 'Dernière sauvegarde : ', h('b', {}, synth.derniere_sauvegarde ? fmtDateTime(synth.derniere_sauvegarde.cree_le) : 'aucune')))) : null)));
  main.querySelectorAll('.meter-fill').forEach((m) => { m.style.width = `${m.dataset.w}%`; });
}

export async function lotsNotes(main, { setTitle, me }) {
  setTitle('Validation des notes');
  const d = await get('/api/validation/notes');
  const verb = 'Valider définitivement';
  main.replaceChildren(
    banner('info', 'Étape 2/2 — Les lots ci-dessous ont été soumis par les formateurs. Vérifiez la complétude et la cohérence de chaque lot : votre validation verrouille et publie les notes ; sinon renvoyez le lot au formateur avec un motif.'),
    d.lots.length ? h('div', { class: 'lots' }, d.lots.map((l) => h('div', { class: 'lot card' },
      h('div', { class: 'lot-head' }, h('div', {}, h('div', { class: 'lot-title' }, `${l.groupe} · ${l.module} · ${l.type_eval}`), h('div', { class: 'muted' }, l.intitule)), chipStatut(d.etape)),
      h('div', { class: 'lot-stats' }, h('div', {}, h('span', {}, 'Notes'), h('b', {}, l.nb)), h('div', {}, h('span', {}, 'Moyenne'), h('b', {}, fmtNote(l.moyenne))),
        h('div', {}, h('span', {}, 'Min'), h('b', {}, fmtNote(l.min))), h('div', {}, h('span', {}, 'Max'), h('b', {}, fmtNote(l.max)))),
      h('div', { class: 'fine' }, `Formateur : ${l.formateurs} · soumis le ${fmtDateTime(l.soumis_le)}`),
      h('div', { class: 'lot-actions' },
        h('button', { class: 'btn btn-sm', onclick: () => detail(l) }, 'Consulter le détail'),
        h('button', { class: 'btn btn-sm btn-warn', onclick: () => decide(l, 'renvoyer') }, 'Renvoyer'),
        h('button', { class: 'btn btn-sm btn-primary', onclick: () => decide(l, 'approuver') }, verb))))) : card(null, h('p', { class: 'empty' }, 'Aucun lot en attente à votre étape.')));

  async function detail(l) {
    const f = await get(`/api/notes?groupe_id=${l.groupe_id}&module_id=${l.module_id}&type_eval=${l.type_eval}`);
    await modal(`${l.groupe} · ${l.module} · ${l.type_eval}`, table(['CEF', 'Stagiaire', 'Note', 'Observation', 'Statut'], f.lignes.map((x) => h('tr', {},
      h('td', { class: 'mono' }, x.cef), h('td', {}, h('b', {}, x.nom), ' ', x.prenom), h('td', {}, h('b', {}, fmtNote(x.valeur))), h('td', { class: 'muted' }, x.observation || ''), h('td', {}, chipStatut(x.statut))))),
    [{ label: 'Fermer', class: 'btn-primary' }]);
  }
  async function decide(l, decision) {
    const motif = h('textarea', { rows: 3, maxlength: 300, placeholder: 'Motif du renvoi (obligatoire, transmis au formateur et tracé)' });
    const err = h('div');
    const ok = await modal(decision === 'approuver' ? verb : 'Renvoyer pour correction', h('div', { class: 'stack' }, err,
      h('p', {}, decision === 'approuver'
        ? `Confirmez-vous la validation définitive des ${l.nb} notes ${l.type_eval} du groupe ${l.groupe} (${l.module}) ?`
        : `Les ${l.nb} notes seront renvoyées au formateur pour correction.`),
      decision === 'renvoyer' ? field('Motif', motif) : null,
      h('p', { class: 'fine' }, icon('log', 13), ' Votre décision sera inscrite au journal d\'audit chaîné, à votre nom et horodatée.')), [
      { label: 'Annuler', value: false },
      { label: 'Confirmer', class: decision === 'approuver' ? 'btn-primary' : 'btn-warn', validate: async () => {
        try { await post('/api/validation/notes', { groupe_id: l.groupe_id, module_id: l.module_id, type_eval: l.type_eval, decision, motif: motif.value }); return true; } catch (e) { err.replaceChildren(banner('warn', e.message)); return false; }
      } }]);
    if (ok) { toast(decision === 'approuver' ? 'Notes validées et publiées — décision tracée.' : 'Lot renvoyé au formateur.'); lotsNotes(main, { setTitle, me }); }
  }
}

export async function seances(main, { setTitle, me }) {
  setTitle('Validation des séances');
  const d = await get('/api/validation/seances');
  main.replaceChildren(
    banner('info', 'Étape 2/2 — Séances soumises par les formateurs : vérifiez le contenu déclaré et la liste des absents. Votre validation rend les absences officielles (le gestionnaire des stagiaires peut alors enregistrer les justificatifs).'),
    card(null, table(['Date', 'Horaire', 'Formateur', 'Groupe · Module', 'Contenu', 'Absences', ''], d.seances.map((s) => h('tr', {},
      h('td', {}, fmtDate(s.date_seance)), h('td', { class: 'mono' }, `${s.heure_debut}–${s.heure_fin}`), h('td', {}, s.formateur),
      h('td', {}, h('b', {}, s.groupe), ' · ', h('span', { class: 'mono' }, s.module)), h('td', { class: 'clip' }, s.contenu), h('td', {}, `${s.absents.length}/${s.effectif}`),
      h('td', { class: 'nowrap' }, h('button', { class: 'btn btn-sm btn-warn', onclick: () => decide(s, 'renvoyer') }, 'Renvoyer'), ' ',
        h('button', { class: 'btn btn-sm btn-primary', onclick: () => decide(s, 'approuver') }, 'Valider')))), { empty: 'Aucune séance en attente à votre étape.' })));
  async function decide(s, decision) {
    let motif = '';
    if (decision === 'renvoyer') {
      const t = h('textarea', { rows: 3, maxlength: 300, placeholder: 'Motif du renvoi (obligatoire)' });
      motif = await modal('Renvoyer la séance', field('Motif', t), [{ label: 'Annuler', value: null }, { label: 'Renvoyer', class: 'btn-warn', validate: () => t.value }]);
      if (motif === null) return;
    }
    try { await post(`/api/validation/seances/${s.id}`, { decision, motif }); toast('Décision enregistrée et tracée.'); seances(main, { setTitle, me }); } catch (e) { toast(e.message, 'err'); }
  }
}

export async function exports(main, { setTitle }) {
  setTitle('Exports traçés');
  const lots = await get('/api/export/lots');
  const out = h('div');
  main.replaceChildren(
    banner('info', 'Chaque export vers les systèmes de délibération est inscrit au journal d\'audit avec l\'empreinte SHA-256 du fichier : toute modification ultérieure du fichier exporté est détectable.'),
    out,
    card('Lots de notes validées disponibles', table(['Groupe', 'Module', 'Évaluation', 'Notes', 'Validé le', ''], lots.map((l) => h('tr', {},
      h('td', {}, h('b', {}, l.groupe)), h('td', {}, h('span', { class: 'mono' }, l.module), ' ', h('span', { class: 'muted' }, l.intitule)), h('td', {}, l.type_eval), h('td', {}, l.nb),
      h('td', {}, fmtDateTime(l.valide_le)),
      h('td', {}, h('button', { class: 'btn btn-sm', onclick: async () => {
        const r = await api('GET', `/api/export/notes?groupe_id=${l.groupe_id}&module_id=${l.module_id}&type_eval=${l.type_eval}`);
        const a = h('a', { href: URL.createObjectURL(r.blob), download: r.nom }); document.body.append(a); a.click(); a.remove();
        out.replaceChildren(banner('ok', h('b', {}, `Export ${r.nom} généré. `), 'Empreinte SHA-256 : ', h('code', { class: 'hash' }, r.empreinte), ` — inscrite au journal (entrée n° ${r.entree}).`));
      } }, icon('download', 14), ' CSV')))), { empty: 'Aucun lot validé.' })));
}

export { short };
