import { h, card, toast, banner } from '../ui.js';
import { get, post } from '../api.js';

const CAT_ORDRE = ['Socle', 'Métier', 'Pilotage'];

export async function magasin(main, { setTitle, refresh }) {
  setTitle('Magasin de modules');

  const zone = h('div');

  const draw = async () => {
    let d;
    try { d = await get('/api/admin/modules'); }
    catch (e) { zone.replaceChildren(banner('warn', e.message)); return; }

    const actifs = d.modules.filter((m) => m.actif).length;
    const groupes = {};
    for (const m of d.modules) (groupes[m.categorie] = groupes[m.categorie] || []).push(m);
    const cats = Object.keys(groupes).sort((a, b) => (CAT_ORDRE.indexOf(a) + 1 || 99) - (CAT_ORDRE.indexOf(b) + 1 || 99));

    zone.replaceChildren(
      h('div', { class: 'mod-stats' },
        h('div', { class: 'mod-stat' }, h('b', {}, d.modules.length), h('span', {}, 'modules installés')),
        h('div', { class: 'mod-stat on' }, h('b', {}, actifs), h('span', {}, 'actifs')),
        h('div', { class: 'mod-stat off' }, h('b', {}, d.modules.length - actifs), h('span', {}, 'désactivés'))),
      ...cats.map((c) => h('div', { class: 'mod-cat' },
        h('h2', { class: 'mod-cat-titre' }, c),
        h('div', { class: 'mod-grid' }, ...groupes[c].map((m) => fiche(m))))));
  };

  const fiche = (m) => {
    const sw = h('button', {
      class: `mod-switch ${m.actif ? 'on' : 'off'}${m.verrou ? ' lock' : ''}`,
      role: 'switch', 'aria-checked': String(m.actif), disabled: m.verrou,
      title: m.verrou ? 'Le socle ne peut pas être désactivé' : (m.actif ? 'Désactiver' : 'Activer'),
      onclick: m.verrou ? null : async () => {
        try {
          await post(`/api/admin/modules/${m.id}`, { actif: !m.actif });
          toast(m.actif ? `Module « ${m.nom} » désactivé` : `Module « ${m.nom} » activé`);
          await draw();
          if (refresh) refresh(); // rafraîchit le menu (un module masqué/affiché)
        } catch (e) { toast(e.message, 'error'); }
      },
    }, h('span', { class: 'mod-knob' }));

    return h('div', { class: `mod-fiche ${m.actif ? '' : 'inactif'}` },
      h('div', { class: 'mod-top' },
        h('div', {},
          h('h3', { class: 'mod-nom' }, m.nom),
          h('span', { class: 'mod-ver' }, 'v' + m.version)),
        sw),
      h('p', { class: 'mod-desc' }, m.description || ''),
      h('div', { class: 'mod-foot' },
        m.verrou ? h('span', { class: 'mod-tag lock' }, 'Indispensable')
          : h('span', { class: `mod-tag ${m.actif ? 'on' : 'off'}` }, m.actif ? 'Actif' : 'Désactivé'),
        h('span', { class: 'mod-id' }, m.id)));
  };

  main.replaceChildren(
    banner('info', 'Activez ou désactivez les modules de l\'application. Seuls des modules déjà installés et vérifiés sont proposés — aucun code n\'est téléchargé ni exécuté. Un module désactivé disparaît du menu et ses accès sont bloqués côté serveur.'),
    zone);
  await draw();
}
