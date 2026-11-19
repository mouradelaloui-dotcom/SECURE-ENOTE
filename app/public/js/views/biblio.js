import { h, card, toast, banner } from '../ui.js';
import { get, post, put, del } from '../api.js';

const TYPE_LIB = { support_cours: 'Support de cours', livre: 'Livre', article: 'Article', lien: 'Lien web', logiciel: 'Logiciel', autre: 'Autre' };
const TYPE_CLS = { support_cours: 'bi-support', livre: 'bi-livre', article: 'bi-article', lien: 'bi-lien', logiciel: 'bi-logiciel', autre: 'bi-autre' };

export async function bibliotheque(main, { setTitle, me }) {
  setTitle('Bibliothèque');

  const peutGerer = ['formateur', 'gestionnaire', 'directeur'].includes(me.role);
  const gereTout = ['gestionnaire', 'directeur'].includes(me.role);
  const ref = await get('/api/biblio/ref');

  let editing = null; // ressource en cours de modification, ou null (création)
  let remplir = () => {}; // réassigné dans le bloc « gestion » ci-dessous
  const filtres = { q: '', categorie: '', type: '' };
  const zone = h('div');
  const formCard = h('div');

  const draw = async () => {
    const qs = new URLSearchParams();
    if (filtres.q) qs.set('q', filtres.q);
    if (filtres.categorie) qs.set('categorie', filtres.categorie);
    if (filtres.type) qs.set('type', filtres.type);
    const d = await get('/api/biblio' + (qs.toString() ? `?${qs}` : ''));
    if (!d.ressources.length) { zone.replaceChildren(card(null, h('p', { class: 'muted' }, 'Aucune ressource ne correspond.'))); return; }
    zone.replaceChildren(h('div', { class: 'bi-grid' }, ...d.ressources.map((r) => fiche(r))));
  };

  const fiche = (r) => {
    const peutEditer = peutGerer && (gereTout || r.ajoute_par === me.id);
    return h('div', { class: 'bi-fiche' },
      h('div', { class: 'bi-top' },
        h('span', { class: `bi-badge ${TYPE_CLS[r.type]}` }, TYPE_LIB[r.type] || r.type),
        h('span', { class: 'bi-cat' }, r.categorie)),
      h('h3', { class: 'bi-titre' }, r.titre),
      r.auteur ? h('div', { class: 'bi-auteur' }, r.auteur) : null,
      r.filiere ? h('span', { class: 'bi-filiere' }, r.filiere) : null,
      r.description ? h('p', { class: 'bi-desc' }, r.description) : null,
      h('div', { class: 'bi-foot' },
        r.lien ? h('a', { class: 'bi-lien-btn', href: r.lien, target: '_blank', rel: 'noopener noreferrer' }, 'Ouvrir ↗') : h('span'),
        h('span', { class: 'bi-meta' }, (r.auteur_fiche ? `par ${r.auteur_fiche}` : '') )),
      peutEditer ? h('div', { class: 'bi-actions' },
        h('button', { class: 'bi-edit', onclick: () => remplir(r) }, 'Modifier'),
        h('button', { class: 'bi-del', onclick: async () => { try { await del(`/api/biblio/${r.id}`); toast('Ressource supprimée'); draw(); } catch (e) { toast(e.message, 'error'); } } }, 'Supprimer')) : null);
  };

  // Barre de filtres
  const fq = h('input', { type: 'search', placeholder: 'Rechercher (titre, auteur…)', oninput: (e) => { filtres.q = e.target.value.trim(); clearTimeout(fq._t); fq._t = setTimeout(draw, 250); } });
  const fcat = h('select', { onchange: (e) => { filtres.categorie = e.target.value; draw(); } },
    h('option', { value: '' }, 'Toutes les catégories'), ...ref.categories.map((c) => h('option', { value: c }, c)));
  const ftype = h('select', { onchange: (e) => { filtres.type = e.target.value; draw(); } },
    h('option', { value: '' }, 'Tous les types'), ...ref.types.map((t) => h('option', { value: t }, TYPE_LIB[t] || t)));

  main.replaceChildren(
    banner('info', 'Ressources pédagogiques du centre. ' + (peutGerer ? 'Vous pouvez publier des ressources' + (gereTout ? ' et gérer celles de tous.' : ' (vous ne modifiez que les vôtres).') : 'Consultation et téléchargement via les liens.')),
    card(null, h('div', { class: 'bi-bar' }, fq, fcat, ftype)),
    formCard,
    zone);

  // Formulaire de publication / modification (gestion uniquement)
  if (peutGerer) {
    const i = {};
    const champ = (key, el) => { i[key] = el; return h('div', { class: 'bi-champ' }, h('label', {}, el.dataset.lab), el); };
    const input = (lab, attrs = {}) => { const el = h('input', { type: 'text', ...attrs }); el.dataset.lab = lab; return el; };
    const sel = (lab, opts) => { const el = h('select', {}, ...opts); el.dataset.lab = lab; return el; };
    const titre = input('Titre', { maxlength: 160, placeholder: 'Titre de la ressource' });
    const auteur = input('Auteur', { maxlength: 120, placeholder: 'Auteur / éditeur' });
    const cat = sel('Catégorie', ref.categories.map((c) => h('option', { value: c }, c)));
    const type = sel('Type', ref.types.map((t) => h('option', { value: t }, TYPE_LIB[t] || t)));
    const filiere = input('Filière', { maxlength: 40, placeholder: 'Filière concernée (ex. DEV, TRI)' });
    const lien = input('Lien (optionnel)', { maxlength: 500, placeholder: 'https://…' });
    const desc = h('textarea', { maxlength: 800, rows: 3, placeholder: 'Description, contenu, à qui ça s\'adresse…' }); desc.dataset.lab = 'Description';
    const titreForm = h('h2', {}, 'Publier une ressource');
    const btn = h('button', { class: 'btn btn-primary' }, 'Publier');
    const annuler = h('button', { class: 'btn', style: 'display:none', onclick: () => reset() }, 'Annuler');

    const reset = () => { editing = null; titreForm.textContent = 'Publier une ressource'; btn.textContent = 'Publier'; annuler.style.display = 'none';
      titre.value = ''; auteur.value = ''; filiere.value = ''; lien.value = ''; desc.value = ''; cat.selectedIndex = 0; type.selectedIndex = 0; };

    remplir = (r) => { editing = r; titreForm.textContent = `Modifier : ${r.titre}`; btn.textContent = 'Enregistrer'; annuler.style.display = '';
      titre.value = r.titre || ''; auteur.value = r.auteur || ''; filiere.value = r.filiere || ''; lien.value = r.lien || ''; desc.value = r.description || '';
      cat.value = r.categorie; type.value = r.type; formCard.scrollIntoView({ behavior: 'smooth', block: 'start' }); };

    btn.onclick = async () => {
      const body = { titre: titre.value, auteur: auteur.value, categorie: cat.value, type: type.value, filiere: filiere.value, lien: lien.value, description: desc.value };
      try {
        if (editing) { await put(`/api/biblio/${editing.id}`, body); toast('Ressource mise à jour'); }
        else { await post('/api/biblio', body); toast('Ressource publiée'); }
        reset(); draw();
      } catch (e) { toast(e.message || 'Échec', 'error'); }
    };

    formCard.replaceChildren(card(titreForm,
      h('div', { class: 'bi-form' },
        champ('titre', titre), champ('auteur', auteur), champ('cat', cat),
        champ('type', type), champ('filiere', filiere), champ('lien', lien)),
      h('div', { class: 'bi-champ bi-full' }, h('label', {}, 'Description'), desc),
      h('div', { class: 'card-foot' }, annuler, btn)));
  }

  await draw();
}
