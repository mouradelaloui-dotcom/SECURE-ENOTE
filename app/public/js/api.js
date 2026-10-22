// Accès à l'API : cookies de session HttpOnly + jeton anti-CSRF en en-tête.
export const state = { me: null, csrf: null, ref: null };

export class ApiError extends Error { constructor(status, message, data) { super(message); this.status = status; this.data = data; } }

export async function api(method, path, body) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (state.csrf) headers['X-CSRF-Token'] = state.csrf;
  const r = await fetch(path, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
  const ct = r.headers.get('content-type') || '';
  if (ct.includes('text/csv')) {
    if (!r.ok) throw new ApiError(r.status, 'Export impossible');
    return { blob: await r.blob(), empreinte: r.headers.get('X-Empreinte-SHA256'), entree: r.headers.get('X-Journal-Entree'),
      nom: (r.headers.get('Content-Disposition') || '').split('filename="')[1]?.replace('"', '') || 'export.csv' };
  }
  const data = ct.includes('json') ? await r.json() : {};
  if (!r.ok) {
    if (r.status === 401 && state.me) { state.me = null; window.dispatchEvent(new CustomEvent('session-expiree', { detail: data.erreur })); }
    if (r.status === 403 && data.code === 'CHANGER_MDP') { location.hash = '#/compte'; }
    throw new ApiError(r.status, data.erreur || 'Erreur', data);
  }
  return data;
}
export const get = (p) => api('GET', p);
export const post = (p, b = {}) => api('POST', p, b);
export const put = (p, b = {}) => api('PUT', p, b);
export const del = (p) => api('DELETE', p);
