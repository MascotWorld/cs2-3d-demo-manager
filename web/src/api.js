async function requestJSON(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    throw new Error(data?.error || `HTTP ${res.status}`);
  }
  return data;
}

export const api = {
  health() {
    return requestJSON('/api/health');
  },

  listDemos(q = '', map = '') {
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (map.trim()) params.set('map', map.trim());
    const qs = params.toString();
    return requestJSON(`/api/demos${qs ? `?${qs}` : ''}`);
  },

  uploadDemo(file) {
    const fd = new FormData();
    fd.append('file', file);
    return requestJSON('/api/demos/upload', { method: 'POST', body: fd });
  },

  registerDemo(path, reparse = false) {
    return requestJSON('/api/demos/register', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path, reparse }),
    });
  },

  getDemo(id) {
    return requestJSON(`/api/demos/${encodeURIComponent(id)}`);
  },

  deleteDemo(id) {
    return requestJSON(`/api/demos/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },

  reparseDemo(id) {
    return requestJSON(`/api/demos/${encodeURIComponent(id)}/reparse`, { method: 'POST' });
  },

  getRound(id, roundNumber) {
    return requestJSON(`/api/demos/${encodeURIComponent(id)}/rounds/${roundNumber}`);
  },

  listBookmarks(id) {
    return requestJSON(`/api/demos/${encodeURIComponent(id)}/bookmarks`);
  },

  createBookmark(id, payload) {
    return requestJSON(`/api/demos/${encodeURIComponent(id)}/bookmarks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
  },

  deleteBookmark(id, bookmarkId) {
    return requestJSON(`/api/demos/${encodeURIComponent(id)}/bookmarks/${encodeURIComponent(bookmarkId)}`, {
      method: 'DELETE',
    });
  },

  async fetchMapMesh(mapName) {
    const res = await fetch(`/api/maps/${encodeURIComponent(mapName)}/mesh`);
    if (res.status === 404) return null;
    if (!res.ok) {
      throw new Error(`Map mesh load failed (${res.status})`);
    }
    return res.arrayBuffer();
  },

  async fetchMapRadar(mapName) {
    const res = await fetch(`/api/maps/${encodeURIComponent(mapName)}/radar`);
    if (res.status === 404) return null;
    if (!res.ok) return null;
    return res.json();
  },

  listAssetDirs() {
    return requestJSON('/api/assets/dirs');
  },

  addAssetDir(path) {
    return requestJSON('/api/assets/dirs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path }),
    });
  },

  deleteAssetDir(path) {
    return requestJSON(`/api/assets/dirs?path=${encodeURIComponent(path)}`, { method: 'DELETE' });
  },

  uploadMapAsset(mapName, file) {
    const fd = new FormData();
    fd.append('file', file);
    return requestJSON(`/api/assets/maps/${encodeURIComponent(mapName)}`, { method: 'POST', body: fd });
  },

  deleteMapAsset(mapName) {
    return requestJSON(`/api/assets/maps/${encodeURIComponent(mapName)}`, { method: 'DELETE' });
  },

  uploadPlayerAsset(file) {
    const fd = new FormData();
    fd.append('file', file);
    return requestJSON('/api/assets/player', { method: 'POST', body: fd });
  },

  deletePlayerAsset() {
    return requestJSON('/api/assets/player', { method: 'DELETE' });
  },
};
