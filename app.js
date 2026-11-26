// Kid-facing app: pick a profile → pick a channel / collection → pick a video.
// Everything shown comes from data/catalog.json, so only approved videos exist here.

import { loadCatalog, thumbUrl, fmtDuration, esc } from './shared.js';
import { initSpatialNav } from './nav.js';
import { mountPlayer } from './player.js';

const PAGE_SIZE = 24;
const app = document.getElementById('app');
let catalog = null;
let teardown = null;

// ---------------------------------------------------------------- storage

const store = {
  get(k, d) { try { return JSON.parse(localStorage.getItem('tb:' + k)) ?? d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('tb:' + k, JSON.stringify(v)); } catch {} },
  del(k) { try { localStorage.removeItem('tb:' + k); } catch {} },
};
const watched = (pid) => new Set(store.get(`watched:${pid}`, []));
function markWatched(pid, vid) { const w = watched(pid); w.add(vid); store.set(`watched:${pid}`, [...w]); }

// ---------------------------------------------------------------- data access

const profile = (pid) => catalog.profiles.find((p) => p.id === pid);

/** Everything a profile is allowed to see, as browseable "sources". */
function sources(pid) {
  const bp = catalog.byProfile[pid];
  if (!bp) return [];
  const out = [];
  const hidden = catalog.hidden || {}; // hidden by a grown-up or by a blocked word
  const visible = (key) => (catalog.lists[key] || []).filter((id) => !hidden[id]);
  for (const id of bp.channels) {
    const ch = catalog.channels[id], ids = visible('ch:' + id);
    if (ch && ids.length) out.push({ key: 'ch:' + id, kind: 'channel', title: ch.title, thumb: ch.thumb, ids });
  }
  for (const id of bp.playlists) {
    const pl = catalog.playlists[id], ids = visible('pl:' + id);
    if (pl && ids.length) out.push({ key: 'pl:' + id, kind: 'playlist', title: pl.title, thumb: pl.thumb, ids });
  }
  if (bp.videos.length) {
    out.push({ key: 'mine', kind: 'mine', title: 'Special picks', thumb: thumbUrl(bp.videos.at(-1)), ids: [...bp.videos].reverse() });
  }
  return out;
}
const source = (pid, key) => sources(pid).find((s) => s.key === key);
const allowed = (pid, vid) => sources(pid).some((s) => s.ids.includes(vid));

// ---------------------------------------------------------------- routing

function parseHash() {
  const [p = '', q = ''] = location.hash.replace(/^#\/?/, '').split('?');
  return { parts: p.split('/').filter(Boolean).map(decodeURIComponent), query: new URLSearchParams(q) };
}
const go = (hash) => { location.hash = hash; };
const replace = (hash) => { location.replace(hash); };
const enc = encodeURIComponent;

function goBack() {
  const { parts } = parseHash();
  if (parts[0] !== 'p') return;
  const pid = parts[1];
  if (parts[2] === 'v') go(sessionStorage.getItem('tb:lastGrid') || `#/p/${enc(pid)}`);
  else if (parts[2] === 's') go(`#/p/${enc(pid)}`);
  else go('#/');
}

function render() {
  teardown?.(); teardown = null;
  document.body.classList.remove('playing');
  const { parts, query } = parseHash();
  try {
    if (parts[0] !== 'p') return renderProfiles();
    const pid = parts[1];
    const p = profile(pid);
    if (!p) return replace('#/');
    store.set('lastProfile', pid);
    document.documentElement.style.setProperty('--accent', p.color || '#f97316');
    if (!parts[2]) return renderHome(p);
    if (parts[2] === 's') return renderGrid(p, parts[3], query);
    if (parts[2] === 'v') return renderPlayer(p, parts[3]);
    replace(`#/p/${enc(pid)}`);
  } finally {
    window.scrollTo(0, 0);
  }
}

function focusFirst() {
  (app.querySelector('[data-autofocus]') || app.querySelector('a[href], button'))?.focus({ preventScroll: true });
}

// ---------------------------------------------------------------- screens

function renderProfiles() {
  document.documentElement.style.removeProperty('--accent');
  const last = store.get('lastProfile');
  app.innerHTML = `
    <section class="screen center">
      <h1 class="hello">Who's watching?</h1>
      <div class="profiles">
        ${catalog.profiles.map((p) => `
          <a class="profile" href="#/p/${enc(p.id)}" style="--c:${esc(p.color || '#f97316')}" ${p.id === last ? 'data-autofocus' : ''}>
            <span class="emoji">${esc(p.emoji || '🙂')}</span>
            <span class="pname">${esc(p.name)}</span>
          </a>`).join('')}
      </div>
    </section>`;
  focusFirst();
}

function header(p, { back, title }) {
  return `
    <header class="bar">
      ${back ? `<a class="iconbtn" href="${back}" aria-label="Back">←</a>` : ''}
      <h1 class="bar-title">${esc(title)}</h1>
      <a class="me" href="#/" style="--c:${esc(p.color)}" aria-label="Switch profile">${esc(p.emoji || '🙂')}</a>
    </header>`;
}

function renderHome(p) {
  const list = sources(p.id);
  app.innerHTML = `
    ${header(p, { title: `Hi ${p.name}!` })}
    <section class="screen">
      ${list.length ? `<div class="sources">
        ${list.map((s, i) => `
          <a class="source ${s.kind}" href="#/p/${enc(p.id)}/s/${enc(s.key)}" ${i === 0 ? 'data-autofocus' : ''}>
            <span class="source-art">${s.thumb ? `<img src="${esc(s.thumb)}" alt="" loading="lazy" referrerpolicy="no-referrer">` : '⭐'}</span>
            <span class="source-title">${esc(s.title)}</span>
            <span class="source-count">${s.ids.length} video${s.ids.length === 1 ? '' : 's'}</span>
          </a>`).join('')}
      </div>` : `<p class="empty">Nothing here yet. Ask a grown-up to add some videos!</p>`}
    </section>`;
  focusFirst();
}

function renderGrid(p, key, query) {
  const s = source(p.id, key);
  if (!s) return replace(`#/p/${enc(p.id)}`);
  const sort = query.get('sort') || 'default';
  const q = (query.get('q') || '').trim().toLowerCase();
  let ids = s.ids.filter((id) => catalog.videos[id]);
  if (q) ids = ids.filter((id) => catalog.videos[id].title.toLowerCase().includes(q));
  if (sort === 'az') ids = [...ids].sort((a, b) => catalog.videos[a].title.localeCompare(catalog.videos[b].title));
  if (sort === 'old') ids = [...ids].reverse();

  const pages = Math.max(1, Math.ceil(ids.length / PAGE_SIZE));
  const page = Math.min(pages, Math.max(1, parseInt(query.get('page') || '1', 10) || 1));
  const shown = ids.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE);
  const seen = watched(p.id);
  const lastVid = sessionStorage.getItem('tb:lastVideo');
  const focusId = shown.includes(lastVid) ? lastVid : shown[0]; // TV: land back on the video just watched
  const base = `#/p/${enc(p.id)}/s/${enc(key)}`;
  const link = (o) => {
    const u = new URLSearchParams({ ...(sort !== 'default' && { sort }), ...(q && { q }), ...o });
    for (const [k, v] of [...u]) if (v === '' || (k === 'page' && v === '1') || (k === 'sort' && v === 'default')) u.delete(k);
    return base + (u.toString() ? '?' + u : '');
  };
  const here = link({ page: String(page) });
  sessionStorage.setItem('tb:lastGrid', here);

  const sortLabel = s.kind === 'playlist' ? 'In order' : s.kind === 'mine' ? 'Newest picks' : 'Newest';
  const sorts = [['default', sortLabel], ['old', s.kind === 'playlist' ? 'Reverse' : 'Oldest'], ['az', 'A–Z']];

  app.innerHTML = `
    ${header(p, { back: `#/p/${enc(p.id)}`, title: s.title })}
    <section class="screen">
      <div class="tools">
        <div class="chips" role="group" aria-label="Sort">
          ${sorts.map(([v, label]) => `<a class="chip ${sort === v ? 'on' : ''}" href="${link({ sort: v, page: '1' })}">${label}</a>`).join('')}
        </div>
        ${s.ids.length > PAGE_SIZE ? `<input class="search" id="search" type="search" placeholder="Find a video…" value="${esc(query.get('q') || '')}" autocomplete="off">` : ''}
      </div>
      ${shown.length ? `<div class="grid">
        ${shown.map((id) => {
          const v = catalog.videos[id];
          return `
          <a class="card" href="#/p/${enc(p.id)}/v/${enc(id)}" ${id === focusId ? 'data-autofocus' : ''}>
            <span class="thumb">
              <img src="${thumbUrl(id)}" alt="" loading="lazy">
              ${v.durationSec ? `<span class="dur">${fmtDuration(v.durationSec)}</span>` : ''}
              ${seen.has(id) ? '<span class="seen" aria-label="Watched">✓</span>' : ''}
            </span>
            <span class="ctitle">${esc(v.title)}</span>
          </a>`;
        }).join('')}
      </div>` : `<p class="empty">No videos match “${esc(query.get('q'))}”.</p>`}
      ${pages > 1 ? `
      <nav class="pager" aria-label="Pages">
        ${page > 1 ? `<a class="pbig" href="${link({ page: String(page - 1) })}">◀ Back</a>` : '<span class="pbig off">◀ Back</span>'}
        <span class="pnum">Page ${page} of ${pages}</span>
        ${page < pages ? `<a class="pbig" href="${link({ page: String(page + 1) })}">More ▶</a>` : '<span class="pbig off">More ▶</span>'}
      </nav>` : ''}
    </section>`;

  // Page/sort/search changes replace the history entry instead of stacking up.
  app.querySelectorAll('.chip, .pager a').forEach((a) => a.addEventListener('click', (e) => { e.preventDefault(); replace(a.getAttribute('href')); }));
  const search = app.querySelector('#search');
  if (search) {
    let t;
    search.addEventListener('input', () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const u = new URLSearchParams({ ...(sort !== 'default' && { sort }), ...(search.value.trim() && { q: search.value.trim() }) });
        history.replaceState(null, '', base + (u.toString() ? '?' + u : ''));
        render();
        const again = app.querySelector('#search');
        again.focus(); again.setSelectionRange(again.value.length, again.value.length);
      }, 300);
    });
  }
  if (!search || !q) focusFirst();
}

function renderPlayer(p, vid) {
  if (!vid || !allowed(p.id, vid)) return replace(`#/p/${enc(p.id)}`); // only approved videos can play
  document.body.classList.add('playing');
  sessionStorage.setItem('tb:lastVideo', vid);
  const posKey = `pos:${p.id}:${vid}`;
  const saved = store.get(posKey, 0);
  teardown = mountPlayer(app, {
    videoId: vid,
    title: catalog.videos[vid]?.title || '',
    startAt: saved > 10 ? saved : 0,
    onBack: goBack,
    onProgress(t, d) {
      if (!d) return;
      if (t / d > 0.9) { markWatched(p.id, vid); store.del(posKey); }
      else if (t > 10) store.set(posKey, Math.floor(t));
    },
    onEnded() { markWatched(p.id, vid); store.del(posKey); },
  });
}

// ---------------------------------------------------------------- staying up to date

// A tablet app can stay open for days, so re-check the catalog whenever the app
// comes back on screen (at most once a minute). A video that's playing is left alone;
// the new list shows up as soon as the kid goes back.
let lastLoad = Date.now();
async function refreshCatalog() {
  if (!catalog || Date.now() - lastLoad < 60_000) return;
  lastLoad = Date.now();
  try {
    const fresh = await loadCatalog();
    if (fresh.generatedAt === catalog.generatedAt) return;
    catalog = fresh;
    if (parseHash().parts[2] !== 'v') render();
  } catch { /* offline: keep what we have */ }
}

// ---------------------------------------------------------------- boot

(async function boot() {
  try {
    catalog = await loadCatalog();
  } catch (e) {
    app.innerHTML = `<section class="screen center"><p class="empty">😕 ${esc(e.message)}</p><button class="cbtn primary" onclick="location.reload()">Try again</button></section>`;
    return;
  }
  initSpatialNav(app, { onBack: goBack });
  window.tellyboxBack = goBack; // the Android app's Back button calls this
  window.tellyboxResume = refreshCatalog; // the Android app calls this when it comes back on screen
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshCatalog(); });
  window.addEventListener('hashchange', render);
  if (!location.hash && catalog.profiles.length === 1) replace(`#/p/${enc(catalog.profiles[0].id)}`);
  render();
})();

if ('serviceWorker' in navigator && location.protocol === 'https:') {
  navigator.serviceWorker.register('sw.js').catch(() => {});
}
