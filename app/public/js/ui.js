// Utilitaires d'interface : création d'éléments sans innerHTML (protection XSS), composants communs.

// replaceChildren ignore les valeurs vides (null / false) au lieu de les afficher en texte
const nativeReplace = Element.prototype.replaceChildren;
Element.prototype.replaceChildren = function replaceChildren(...c) {
  return nativeReplace.apply(this, c.flat(Infinity).filter((x) => x !== null && x !== undefined && x !== false));
};
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  append(el, children);
  return el;
}
function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

const ICONS = {
  home: 'M3 10.5 12 3l9 7.5V21h-6v-6H9v6H3z',
  notes: 'M5 3h10l4 4v14H5zM14 3v5h5M8 12h8M8 16h6',
  calendar: 'M4 5h16v16H4zM4 9h16M8 3v4M16 3v4',
  check: 'M4 12.5 9 17.5 20 6.5',
  shield: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6z',
  shieldcheck: 'M12 3 4 6v6c0 5 3.5 8 8 9 4.5-1 8-4 8-9V6zM8.5 12l2.5 2.5 4.5-5',
  bell: 'M6 16V11a6 6 0 1 1 12 0v5l2 2H4zM10 20h4',
  log: 'M4 4h16v16H4zM8 8h8M8 12h8M8 16h5',
  users: 'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM2 21v-1a7 7 0 0 1 14 0v1M17 11a3 3 0 1 0 0-6M22 21v-1a5 5 0 0 0-4-4.9',
  sliders: 'M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0M14 4v4M8 10v4M16 16v4',
  database: 'M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3',
  alert: 'M12 3 2 20h20zM12 10v4M12 17v.5',
  download: 'M12 3v12M7 10l5 5 5-5M4 20h16',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21a8 8 0 0 1 16 0',
  logout: 'M15 4h4v16h-4M10 8l-4 4 4 4M6 12h10',
  lock: 'M6 11h12v10H6zM8 11V7a4 4 0 0 1 8 0v4',
  chart: 'M4 20V4M4 20h16M8 16v-5M12 16V8M16 16v-8',
  edit: 'M4 20h4L19 9l-4-4L4 16zM14 6l4 4',
  key: 'M14 10a4 4 0 1 0-3.5 4L4 20.5V22h3v-2h2v-2h2l1.5-1.5',
  wrench: 'M14.7 6.3a4 4 0 0 0-5.4 5.4L3 18l3 3 6.3-6.3a4 4 0 0 0 5.4-5.4l-2.6 2.6-2.4-.6-.6-2.4z',
  refresh: 'M20 11a8 8 0 1 0-2.3 5.7M20 4v7h-7',
  x: 'M6 6l12 12M18 6 6 18',
  menu: 'M4 6h16M4 12h16M4 18h16',
  device: 'M3 5h18v11H3zM8 20h8M12 16v4',
  cap: 'M2 9.5 12 5l10 4.5L12 14zM6 11.5V16c0 1.5 2.7 3 6 3s6-1.5 6-3v-4.5M22 9.5V15',
  family: 'M8 8a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM3 21v-4a5 5 0 0 1 10 0v4M17 11a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5zM14.5 21v-3a3.5 3.5 0 0 1 7 0v3',
};
export function icon(name, size = 18) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('width', size); svg.setAttribute('height', size);
  svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round'); svg.setAttribute('stroke-linejoin', 'round'); svg.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path'); p.setAttribute('d', ICONS[name] || ICONS.notes);
  svg.append(p);
  return svg;
}

export const STATUTS = {
  brouillon: ['Brouillon', 'gris'], soumise: ['Soumise — attente direction', 'bleu'], controlee: ['Contrôlée — attente direction', 'violet'],
  validee: ['Validée', 'vert'], a_corriger: ['À corriger', 'orange'],
};
// Notes et séances : circuit en deux étapes (formateur -> direction)
export function chipStatut(s) { const [lib, c] = STATUTS[s] || [s || 'Non saisie', 'vide']; return h('span', { class: `chip chip-${c}` }, lib); }
export function chipSeverite(s) {
  const m = { information: ['Information', 'bleu'], avertissement: ['Avertissement', 'orange'], critique: ['Critique', 'rouge'] };
  const [lib, c] = m[s] || [s, 'gris'];
  return h('span', { class: `chip chip-${c} chip-sev` }, lib);
}
export const ROLES = { formateur: 'Formateur', gestionnaire: 'Gestionnaire des stagiaires', directeur: 'Directrice', administrateur: 'Administrateur',
  stagiaire: 'Stagiaire', parent: 'Parent / tuteur' };

const dtf = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'short', timeStyle: 'short', timeZone: 'Africa/Casablanca' });
const df = new Intl.DateTimeFormat('fr-FR', { dateStyle: 'medium', timeZone: 'Africa/Casablanca' });
export const fmtDateTime = (v) => (v ? dtf.format(new Date(v)) : '—');
export const fmtDate = (v) => (v ? df.format(new Date(v.length === 10 ? v + 'T12:00:00Z' : v)) : '—');
export const fmtNote = (v) => (v === null || v === undefined ? '—' : Number(v).toFixed(2).replace('.', ','));
export const pct = (v) => (v === null || v === undefined ? '—' : `${Math.round(v * 100)} %`);

export function toast(message, type = 'ok') {
  let zone = document.getElementById('toasts');
  if (!zone) { zone = h('div', { id: 'toasts', role: 'status', 'aria-live': 'polite' }); document.body.append(zone); }
  const t = h('div', { class: `toast toast-${type}` }, icon(type === 'ok' ? 'check' : 'alert', 16), h('span', {}, message));
  zone.append(t);
  setTimeout(() => t.classList.add('out'), 4200);
  setTimeout(() => t.remove(), 4700);
}

export function modal(title, body, actions = []) {
  return new Promise((resolve) => {
    const close = (v) => { overlay.remove(); resolve(v); };
    const overlay = h('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) close(null); } },
      h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
        h('div', { class: 'modal-head' }, h('h3', {}, title), h('button', { class: 'icon-btn', 'aria-label': 'Fermer', onclick: () => close(null) }, icon('x'))),
        h('div', { class: 'modal-body' }, body),
        h('div', { class: 'modal-foot' }, actions.map((a) => h('button', { class: `btn ${a.class || ''}`, onclick: async () => {
          if (a.validate) { const r = await a.validate(); if (r === false) return; close(r); } else close(a.value);
        } }, a.label)))));
    document.body.append(overlay);
    const first = overlay.querySelector('input, textarea, select'); if (first) first.focus();
  });
}

export function card(title, ...children) {
  return h('section', { class: 'card' }, title ? h('div', { class: 'card-head' }, typeof title === 'string' ? h('h2', {}, title) : title) : null, ...children);
}
export function kpi(label, value, sub, tone = '') {
  return h('div', { class: `kpi ${tone}` }, h('div', { class: 'kpi-label' }, label), h('div', { class: 'kpi-value' }, value), sub ? h('div', { class: 'kpi-sub' }, sub) : null);
}
export function table(headers, rows, opts = {}) {
  return h('div', { class: 'table-wrap' }, h('table', { class: `tbl ${opts.class || ''}` },
    h('thead', {}, h('tr', {}, headers.map((x) => h('th', {}, x)))),
    h('tbody', {}, rows.length ? rows : h('tr', {}, h('td', { colspan: headers.length, class: 'empty' }, opts.empty || 'Aucun élément.')))));
}
export function field(label, input, hint) {
  return h('label', { class: 'field' }, h('span', { class: 'field-label' }, label), input, hint ? h('span', { class: 'field-hint' }, hint) : null);
}
export function banner(type, ...content) { return h('div', { class: `banner banner-${type}` }, icon(type === 'ok' ? 'shieldcheck' : type === 'info' ? 'shield' : 'alert', 18), h('div', {}, ...content)); }
export function short(hash, n = 10) { return hash ? hash.slice(0, n) + '…' : '—'; }

/** Mini-graphe en barres groupées (SVG). */
export function barChart(data, series, { height = 180 } = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const w = 640; const pad = 28; const max = Math.max(1, ...data.flatMap((d) => series.map((s) => d[s.key])));
  const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', `0 0 ${w} ${height}`); svg.setAttribute('class', 'chart');
  const bw = (w - pad * 2) / data.length;
  const mk = (tag, a) => { const e = document.createElementNS(NS, tag); Object.entries(a).forEach(([k, v]) => e.setAttribute(k, v)); svg.append(e); return e; };
  for (let i = 0; i <= 2; i++) {
    const y = height - 22 - ((height - 40) * i) / 2;
    mk('line', { x1: pad, x2: w - 8, y1: y, y2: y, class: 'grid' });
    mk('text', { x: pad - 6, y: y + 4, class: 'axis', 'text-anchor': 'end' }).textContent = Math.round((max * i) / 2);
  }
  data.forEach((d, i) => {
    series.forEach((s, j) => {
      const v = d[s.key]; const bh = ((height - 40) * v) / max; const sw = (bw - 8) / series.length;
      const r = mk('rect', { x: pad + i * bw + 4 + j * sw, y: height - 22 - bh, width: Math.max(sw - 2, 2), height: Math.max(bh, v ? 2 : 0), rx: 2, class: `bar ${s.class}` });
      const t = document.createElementNS(NS, 'title'); t.textContent = `${d.jour} — ${s.label} : ${v}`; r.append(t);
    });
    if (i % 2 === 0 || data.length < 10) mk('text', { x: pad + i * bw + bw / 2, y: height - 6, class: 'axis', 'text-anchor': 'middle' }).textContent = d.jour;
  });
  return h('div', { class: 'chart-wrap' }, svg, h('div', { class: 'legend' }, series.map((s) => h('span', {}, h('i', { class: `dot ${s.class}` }), s.label))));
}
