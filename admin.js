// Parent admin page. Edits data/whitelist.json in the GitHub repo through the
// GitHub API (with a personal access token kept only in this browser), or, on
// localhost without a token, edits a local copy you can download.

import { esc, thumbUrl, timeAgo, fmtDuration, SUGGESTED_TERMS, termMatcher, normalizeTerms } from './shared.js';

const LS = 'tb-admin:';
const EMOJIS = ['🦊', '🦉', '🐻', '🐼', '🐯', '🦁', '🐸', '🐵', '🐰', '🐨', '🦄', '🐙', '🦖', '🐳', '🐝', '🐞', '🚀', '⚽', '🌈', '⭐'];
const COLORS = ['#f97316', '#ef4444', '#ec4899', '#a855f7', '#6366f1', '#0ea5e9', '#14b8a6', '#22c55e', '#eab308', '#78716c'];

const $ = (sel, root = document) => root.querySelector(sel);
const el = (id) => document.getElementById(id);

const isLocalhost = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname) || location.hostname.endsWith('.localhost');

const cfg = {
  token: localStorage.getItem(LS + 'token') || '',
  owner: localStorage.getItem(LS + 'owner') || '',
  repo: localStorage.getItem(LS + 'repo') || '',
};
if (!cfg.owner && location.hostname.endsWith('.github.io')) {
  cfg.owner = location.hostname.split('.')[0];
  cfg.repo = location.pathname.split('/').filter(Boolean)[0] || `${cfg.owner}.github.io`;
  if (cfg.repo.endsWith('.html')) cfg.repo = `${cfg.owner}.github.io`;
}

const state = {
  mode: null,          // 'github' | 'local'
  wl: null,            // working copy of whitelist.json
  original: '',        // JSON of the last published version
  sha: null,           // GitHub blob sha of whitelist.json
  catalog: null,       // live catalog.json (titles, thumbnails, counts)
  log: [],             // human-readable list of unpublished changes
  filter: 'all',       // which kid's view the lists show
  editingKid: null,
  expanded: new Map(), // channel/playlist key → how many videos to show
  preview: null,       // current "add" preview
  addKids: null,       // kids ticked in the add card
  titles: new Map(),   // videoId → title (for hidden videos)
};

// ---------------------------------------------------------------- utilities

function b64enc(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}
const b64dec = (b64) => new TextDecoder().decode(Uint8Array.from(atob(b64.replace(/\s/g, '')), (c) => c.charCodeAt(0)));

function toast(msg, kind = '') {
  const t = el('toast');
  t.textContent = msg; t.className = `toast show ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = 'toast'; }, 3800);
}

function normalize(wl) {
  for (const k of ['profiles', 'channels', 'playlists', 'videos', 'blocked']) wl[k] ??= [];
  wl.settings ??= {};
  wl.settings.allowShorts ??= false;
  wl.settings.blockedTerms ??= [];
  wl.settings.allowAnyway ??= [];
  return wl;
}

// ---------------------------------------------------------------- hidden videos

/** videoId → blocked word, for every channel/playlist video the current word list hides. */
function termHits() {
  const s = state.wl.settings;
  const key = JSON.stringify([s.blockedTerms, s.allowAnyway, state.catalog?.generatedAt]);
  if (termHits.key === key) return termHits.map;
  const terms = new Set(normalizeTerms(s.blockedTerms));
  const match = termMatcher(s.blockedTerms);
  const allow = new Set(s.allowAnyway);
  const map = new Map();
  const cat = state.catalog;
  for (const id of new Set(Object.values(cat?.lists || {}).flat())) {
    if (allow.has(id)) continue;
    // Titles are checked here; tag matches (API mode) come from the last build.
    const server = cat.hidden?.[id]?.startsWith('term:') ? cat.hidden[id].slice(5) : null;
    const t = match(cat.videos[id]?.title) || (server && terms.has(server) ? server : null);
    if (t) map.set(id, t);
  }
  termHits.key = key; termHits.map = map;
  return map;
}
/** 'blocked' | 'term:<word>' | null */
function hiddenReason(id) {
  if (state.wl.blocked.includes(id)) return 'blocked';
  const t = termHits().get(id);
  return t ? 'term:' + t : null;
}
const shortsFor = (c) => (typeof c.shorts === 'boolean' ? c.shorts : state.wl.settings.allowShorts);
const serialize = (wl) => JSON.stringify(wl, null, 2) + '\n';
const dirty = () => state.wl && serialize(state.wl) !== state.original;
const kidById = (id) => state.wl.profiles.find((p) => p.id === id);
const kidNames = (ids) => ids.map((id) => kidById(id)?.name).filter(Boolean).join(', ') || 'nobody';
function change(msg) { state.log.push(msg); renderAll(); }

// ---------------------------------------------------------------- YouTube link parsing

const CH_ID = /^UC[\w-]{22}$/;
const VID = /^[\w-]{11}$/;
const PL = /^(PL|OL|FL|RD|UU)[\w-]{10,}$/;

/** → { video?, playlist?, channel?: { handle | id | username | url } } or null */
export function parseYouTube(input) {
  const s = input.trim();
  if (!s) return null;
  if (/^@[\p{L}\p{N}._-]+$/u.test(s)) return { channel: { handle: s } };
  if (CH_ID.test(s)) return { channel: { id: s } };
  if (PL.test(s)) return { playlist: s };
  if (VID.test(s)) return { video: s };
  let u;
  try { u = new URL(/^https?:\/\//i.test(s) ? s : 'https://' + s); } catch { return null; }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  const parts = u.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const list = u.searchParams.get('list');
  const out = {};
  if (list && PL.test(list) && !list.startsWith('RD')) out.playlist = list; // RD… = YouTube "mix", not a real playlist
  if (host === 'youtu.be') { if (VID.test(parts[0] || '')) out.video = parts[0]; return Object.keys(out).length ? out : null; }
  if (!/^(youtube\.com|youtube-nocookie\.com)$/.test(host)) return null;
  const [a, b] = parts;
  if (a === 'watch' && VID.test(u.searchParams.get('v') || '')) out.video = u.searchParams.get('v');
  else if (['shorts', 'embed', 'live', 'v'].includes(a) && VID.test(b || '')) out.video = b;
  else if (a?.startsWith('@')) out.channel = { handle: a };
  else if (a === 'channel' && CH_ID.test(b || '')) out.channel = { id: b };
  else if (a === 'user' && b) out.channel = { username: b };
  else if (a === 'c' && b) out.channel = { url: `https://www.youtube.com/c/${encodeURIComponent(b)}` };
  return Object.keys(out).length ? out : null;
}

async function oembed(url) {
  const res = await fetch(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent(url)}`);
  if (!res.ok) throw new Error(res.status === 401 || res.status === 403 ? 'embedding-disabled' : 'not-found');
  return res.json();
}

const sameChannel = (a, b) => (a.id && a.id === b.id) || (a.handle && b.handle && a.handle.toLowerCase() === b.handle.toLowerCase())
  || (a.username && a.username === b.username) || (a.url && a.url === b.url);
const channelLabel = (c) => c.title || c.handle || c.username || c.url?.split('/').pop() || c.id;

// ---------------------------------------------------------------- GitHub

async function gh(path, opts = {}) {
  const res = await fetch(`https://api.github.com/repos/${cfg.owner}/${cfg.repo}${path}`, {
    cache: 'no-store',
    ...opts,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      Authorization: `Bearer ${cfg.token}`,
      ...(opts.body && { 'Content-Type': 'application/json' }),
    },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) { const e = new Error(body?.message || res.statusText); e.status = res.status; throw e; }
  return body;
}
const FILE = '/contents/data/whitelist.json';

async function loadRemote() {
  const f = await gh(FILE);
  return { wl: normalize(JSON.parse(b64dec(f.content))), sha: f.sha };
}

// The build job writes resolved channel IDs / titles back into whitelist.json.
// If that happened while we were editing, copy those fields into our version.
function mergeResolved(local, remote) {
  for (const c of local.channels) {
    const r = remote.channels.find((x) => sameChannel(x, c));
    if (r) { c.id ??= r.id; c.title ??= r.title; }
  }
  for (const p of local.playlists) {
    const r = remote.playlists.find((x) => x.id === p.id);
    if (r && !p.title) p.title = r.title;
  }
}

async function loadCatalog() {
  try {
    const res = await fetch(`data/catalog.json?t=${Date.now()}`, { cache: 'no-store' });
    state.catalog = res.ok ? await res.json() : null;
  } catch { state.catalog = null; }
}

// ---------------------------------------------------------------- connect / load

async function connect() {
  el('setup').hidden = true;
  el('main').hidden = true;
  el('loading').hidden = false;
  try {
    await loadCatalog();
    if (cfg.token && cfg.owner && cfg.repo) {
      const { wl, sha } = await loadRemote();
      state.mode = 'github'; state.wl = wl; state.sha = sha;
    } else if (isLocalhost) {
      const res = await fetch(`data/whitelist.json?t=${Date.now()}`, { cache: 'no-store' });
      state.mode = 'local'; state.wl = normalize(await res.json());
    } else {
      throw Object.assign(new Error('not connected'), { setup: true });
    }
    state.original = serialize(state.wl);
    state.log = [];
    state.addKids ??= new Set(JSON.parse(localStorage.getItem(LS + 'addKids') || 'null') || state.wl.profiles.map((p) => p.id));
    el('loading').hidden = true;
    el('main').hidden = false;
    renderAll();
    const add = new URLSearchParams(location.hash.slice(1)).get('add'); // from the bookmarklet
    if (add) { el('add-input').value = add; history.replaceState(null, '', location.pathname); onAddInput(); }
  } catch (e) {
    el('loading').hidden = true;
    showSetup(e.setup ? '' : e.status === 401 ? 'GitHub didn\'t accept that token. Check it hasn\'t expired.'
      : e.status === 404 ? `Couldn't find data/whitelist.json in ${cfg.owner}/${cfg.repo}. Check the repository name and that the token can access it.`
        : `Couldn't connect: ${e.message}`);
  }
}

function showSetup(error = '') {
  el('setup').hidden = false;
  el('main').hidden = true;
  el('cfg-owner').value = cfg.owner;
  el('cfg-repo').value = cfg.repo;
  el('cfg-token').value = cfg.token;
  el('setup-error').textContent = error;
  el('setup-error').hidden = !error;
  el('local-btn').hidden = !isLocalhost;
}

el('setup-form').addEventListener('submit', (e) => {
  e.preventDefault();
  cfg.owner = el('cfg-owner').value.trim();
  cfg.repo = el('cfg-repo').value.trim();
  cfg.token = el('cfg-token').value.trim();
  for (const k of ['owner', 'repo', 'token']) localStorage.setItem(LS + k, cfg[k]);
  connect();
});
el('local-btn').addEventListener('click', () => { cfg.token = ''; localStorage.removeItem(LS + 'token'); connect(); });
el('disconnect').addEventListener('click', () => {
  if (dirty() && !confirm('You have unpublished changes. Disconnect anyway?')) return;
  localStorage.removeItem(LS + 'token'); cfg.token = '';
  showSetup();
});

// ---------------------------------------------------------------- rendering

function renderAll() {
  renderStatus();
  renderKids();
  renderFilters();
  renderAddKids();
  renderPreview();
  renderLists();
  renderPublishBar();
}

function renderStatus() {
  const c = state.catalog;
  const where = state.mode === 'github' ? `${esc(cfg.owner)}/${esc(cfg.repo)}` : 'local copy (not connected to GitHub)';
  let html = `<span class="muted">Editing ${where}</span>`;
  if (c) {
    const n = Object.keys(c.videos || {}).length;
    html += ` · <span>Kids' app updated <b>${esc(timeAgo(c.generatedAt))}</b> · ${n} videos</span>`;
  }
  el('status').innerHTML = html;
  el('disconnect').hidden = state.mode !== 'github';

  const notes = [];
  if (c?.mode === 'rss') notes.push(`<b>Free mode:</b> without a YouTube API key, Tellybox only sees each channel's newest ~15 videos, though the list grows over time. Add a key to get every video (see the README).`);
  if (c?.warnings?.length) notes.push(`<b>Last update had ${c.warnings.length} problem${c.warnings.length > 1 ? 's' : ''}:</b><ul>${c.warnings.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>`);
  el('notes').innerHTML = notes.map((n) => `<div class="note">${n}</div>`).join('');
}

function kidChip(p, on, attrs = '') {
  return `<button type="button" class="kid ${on ? 'on' : ''}" style="--c:${esc(p.color)}" ${attrs} aria-pressed="${on}" title="${esc(p.name)}"><span class="ke">${esc(p.emoji)}</span><span class="kn">${esc(p.name)}</span></button>`;
}

function renderKids() {
  const kids = state.wl.profiles;
  el('kids').innerHTML = `
    ${kids.map((p) => `<button type="button" class="kidcard ${state.editingKid === p.id ? 'editing' : ''}" data-edit-kid="${esc(p.id)}" style="--c:${esc(p.color)}">
        <span class="kidface">${esc(p.emoji)}</span><span>${esc(p.name)}</span></button>`).join('')}
    <button type="button" class="kidcard add" id="add-kid"><span class="kidface">＋</span><span>Add kid</span></button>`;

  const p = state.editingKid && kidById(state.editingKid);
  el('kid-editor').hidden = !p;
  if (p) {
    el('kid-editor').innerHTML = `
      <label>Name <input id="kid-name" value="${esc(p.name)}" maxlength="20" autocomplete="off"></label>
      <div class="pick">${EMOJIS.map((e) => `<button type="button" class="emo ${e === p.emoji ? 'on' : ''}" data-emoji="${e}">${e}</button>`).join('')}
        <input id="kid-emoji" class="emo-input" value="${EMOJIS.includes(p.emoji) ? '' : esc(p.emoji)}" placeholder="or type one" maxlength="4"></div>
      <div class="pick">${COLORS.map((c) => `<button type="button" class="swatch ${c === p.color ? 'on' : ''}" data-color="${c}" style="background:${c}" aria-label="Colour ${c}"></button>`).join('')}</div>
      <div class="row-actions"><button type="button" class="btn" id="kid-done">Done</button><button type="button" class="btn danger" id="kid-delete">Remove ${esc(p.name)}</button></div>`;
  }

  // filter tabs
  el('filter').innerHTML = `<button type="button" class="tab ${state.filter === 'all' ? 'on' : ''}" data-filter="all">Everything</button>`
    + kids.map((k) => `<button type="button" class="tab ${state.filter === k.id ? 'on' : ''}" data-filter="${esc(k.id)}">${esc(k.emoji)} What ${esc(k.name)} sees</button>`).join('');
}

el('kids').addEventListener('click', (e) => {
  if (e.target.closest('#add-kid')) {
    const name = 'New kid';
    let id = 'kid', i = 1;
    while (kidById(id)) id = `kid${++i}`;
    const used = new Set(state.wl.profiles.map((p) => p.emoji));
    state.wl.profiles.push({ id, name, emoji: EMOJIS.find((x) => !used.has(x)) || '🙂', color: COLORS[state.wl.profiles.length % COLORS.length] });
    state.editingKid = id;
    state.addKids.add(id);
    change(`add kid`);
    el('kid-name')?.select();
    return;
  }
  const id = e.target.closest('[data-edit-kid]')?.dataset.editKid;
  if (id) { state.editingKid = state.editingKid === id ? null : id; renderKids(); el('kid-name')?.focus(); }
});

el('kid-editor').addEventListener('click', (e) => {
  const p = kidById(state.editingKid);
  if (!p) return;
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.emoji) { p.emoji = t.dataset.emoji; change(`change ${p.name}'s picture`); }
  else if (t.dataset.color) { p.color = t.dataset.color; change(`change ${p.name}'s colour`); }
  else if (t.id === 'kid-done') { state.editingKid = null; renderKids(); }
  else if (t.id === 'kid-delete') {
    if (!confirm(`Remove ${p.name}? Their approved videos stay approved for the other kids.`)) return;
    state.wl.profiles = state.wl.profiles.filter((x) => x !== p);
    for (const k of ['channels', 'playlists', 'videos']) for (const it of state.wl[k]) it.profiles = (it.profiles || []).filter((x) => x !== p.id);
    state.addKids.delete(p.id);
    if (state.filter === p.id) state.filter = 'all';
    state.editingKid = null;
    change(`remove kid ${p.name}`);
  }
});
el('kid-editor').addEventListener('input', (e) => {
  const p = kidById(state.editingKid);
  if (!p) return;
  if (e.target.id === 'kid-name') {
    p.name = e.target.value.trim() || 'Kid';
    // update the card label without re-rendering the input we're typing in
    const card = $(`[data-edit-kid="${CSS.escape(p.id)}"] span:last-child`); if (card) card.textContent = p.name;
    renderAddKids(); renderPublishBar();
  }
  if (e.target.id === 'kid-emoji' && e.target.value.trim()) {
    p.emoji = [...new Intl.Segmenter().segment(e.target.value.trim())][0].segment;
    const face = $(`[data-edit-kid="${CSS.escape(p.id)}"] .kidface`); if (face) face.textContent = p.emoji;
    renderPublishBar();
  }
});
el('kid-editor').addEventListener('change', (e) => { if (e.target.id === 'kid-name') change(`rename kid to ${kidById(state.editingKid)?.name}`); });

el('filter').addEventListener('click', (e) => {
  const f = e.target.closest('[data-filter]')?.dataset.filter;
  if (f) { state.filter = f; renderKids(); renderLists(); }
});

// ---------------------------------------------------------------- filters (Shorts + blocked words)

function renderFilters() {
  const s = state.wl.settings;
  el('shorts-toggle').setAttribute('aria-checked', String(s.allowShorts));
  el('shorts-state').textContent = s.allowShorts ? 'Allowed' : 'Blocked';
  const overrides = state.wl.channels.filter((c) => typeof c.shorts === 'boolean' && c.shorts !== s.allowShorts).length;
  el('shorts-note').textContent = `${s.allowShorts ? 'Approved channels include their Shorts.' : 'Shorts from approved channels are left out.'} `
    + (overrides ? `${overrides} channel${overrides > 1 ? 's do' : ' does'} it differently (see the Shorts button on each channel).` : 'You can change this for a single channel with its Shorts button.');

  const terms = s.blockedTerms;
  el('terms').innerHTML = terms.length
    ? terms.map((t, i) => `<span class="term">${esc(t)}<button type="button" data-term-remove="${i}" aria-label="Remove ${esc(t)}">✕</button></span>`).join('')
    : '<span class="muted">No blocked words yet.</span>';
  const missing = SUGGESTED_TERMS.filter((t) => !normalizeTerms(terms).includes(t)).length;
  el('terms-suggest').hidden = !missing;
  el('terms-suggest').textContent = terms.length ? `Add ${missing} suggested words` : `Start with ${missing} suggested words`;
  el('terms-clear').hidden = !terms.length;

  const hits = termHits();
  const allowed = s.allowAnyway.filter((id) => state.catalog?.videos?.[id]);
  const open = state.expanded.get('terms');
  el('terms-effect').innerHTML = !state.catalog ? '' : `
    <span class="muted">${hits.size ? `<b>${hits.size}</b> video${hits.size > 1 ? 's' : ''} from your channels and playlists ${hits.size > 1 ? 'are' : 'is'} hidden by these words.` : 'No videos from your channels and playlists match these words.'}
    ${allowed.length ? ` ${allowed.length} allowed anyway.` : ''}</span>
    ${hits.size || allowed.length ? `<button type="button" class="link" data-expand-terms>${open ? 'Close' : 'Show them'}</button>` : ''}
    ${open ? `<div class="strip">${[...hits.keys(), ...allowed].slice(0, open).map(miniCard).join('')}</div>` : ''}`;
}

el('shorts-toggle').addEventListener('click', () => {
  const s = state.wl.settings;
  s.allowShorts = !s.allowShorts;
  // A channel override that now matches the default is no longer needed
  for (const c of state.wl.channels) if (c.shorts === s.allowShorts) delete c.shorts;
  change(`${s.allowShorts ? 'allow' : 'block'} Shorts`);
});

function addTerms(list) {
  const s = state.wl.settings;
  const before = normalizeTerms(s.blockedTerms);
  const added = normalizeTerms(list).filter((t) => !before.includes(t));
  if (!added.length) return toast('Already on the list.');
  s.blockedTerms = [...before, ...added];
  change(`block word${added.length > 1 ? 's' : ''} ${added.slice(0, 3).join(', ')}${added.length > 3 ? '…' : ''}`);
}
el('term-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = el('term-input').value;
  if (!v.trim()) return;
  addTerms(v.split(','));
  el('term-input').value = '';
  el('term-input').focus();
});
el('terms-suggest').addEventListener('click', () => addTerms(SUGGESTED_TERMS));
el('terms-clear').addEventListener('click', () => {
  if (!confirm('Remove every blocked word?')) return;
  state.wl.settings.blockedTerms = [];
  change('clear blocked words');
});
el('filters').addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.termRemove) {
    const [removed] = state.wl.settings.blockedTerms.splice(+t.dataset.termRemove, 1);
    change(`unblock word ${removed}`);
  } else if ('expandTerms' in t.dataset) {
    state.expanded.get('terms') ? state.expanded.delete('terms') : state.expanded.set('terms', 48);
    renderFilters();
  } else videoAction(t);
});

// ---------------------------------------------------------------- add card

function renderAddKids() {
  el('add-kids').innerHTML = state.wl.profiles.map((p) => kidChip(p, state.addKids.has(p.id), `data-add-kid="${esc(p.id)}"`)).join('');
}
el('add-kids').addEventListener('click', (e) => {
  const id = e.target.closest('[data-add-kid]')?.dataset.addKid;
  if (!id) return;
  state.addKids.has(id) ? state.addKids.delete(id) : state.addKids.add(id);
  localStorage.setItem(LS + 'addKids', JSON.stringify([...state.addKids]));
  renderAddKids(); renderPreview();
});

let previewSeq = 0;
async function onAddInput() {
  const raw = el('add-input').value;
  const parsed = parseYouTube(raw);
  const seq = ++previewSeq;
  if (!parsed) {
    state.preview = raw.trim() ? { error: "That doesn't look like a YouTube link. Try copying the address of a video, channel or playlist." } : null;
    return renderPreview();
  }
  const options = [];
  if (parsed.video) options.push({ type: 'video', id: parsed.video, title: 'Loading…', thumb: thumbUrl(parsed.video) });
  if (parsed.playlist) options.push({ type: 'playlist', id: parsed.playlist, title: `Playlist ${parsed.playlist}` });
  if (parsed.channel) options.push({ type: 'channel', ref: parsed.channel, title: channelLabel(parsed.channel) });
  if (parsed.video) options.push({ type: 'block', id: parsed.video, title: 'Hide this one video everywhere' });
  state.preview = { options, selected: 0 };
  renderPreview();

  // Fill in titles. oEmbed works from the browser for videos and playlists.
  if (parsed.video) {
    try {
      const o = await oembed(`https://www.youtube.com/watch?v=${parsed.video}`);
      if (seq !== previewSeq) return;
      const v = options.find((x) => x.type === 'video');
      v.title = o.title; v.sub = o.author_name;
      if (!parsed.channel) {
        const ch = parseYouTube(o.author_url || '')?.channel;
        if (ch) options.splice(options.length - 1, 0, { type: 'channel', ref: { ...ch, title: o.author_name }, title: `${o.author_name} (whole channel)` });
      }
      options.find((x) => x.type === 'block').sub = o.title;
    } catch (err) {
      if (seq !== previewSeq) return;
      options[0].title = err.message === 'embedding-disabled' ? "This video can't be played outside YouTube, so it won't work in Tellybox." : "Couldn't find that video. It may be private or deleted.";
      options[0].bad = true;
    }
    renderPreview();
  }
  if (parsed.playlist) {
    try {
      const o = await oembed(`https://www.youtube.com/playlist?list=${parsed.playlist}`);
      if (seq !== previewSeq) return;
      const p = options.find((x) => x.type === 'playlist');
      p.title = o.title; p.sub = o.author_name; p.thumb = o.thumbnail_url;
      renderPreview();
    } catch { /* keep the generic label */ }
  }
}

function existingFor(opt) {
  if (opt.type === 'video') return state.wl.videos.find((v) => v.id === opt.id);
  if (opt.type === 'playlist') return state.wl.playlists.find((p) => p.id === opt.id);
  if (opt.type === 'channel') return state.wl.channels.find((c) => sameChannel(c, opt.ref));
  return null;
}

function renderPreview() {
  const box = el('preview');
  const pv = state.preview;
  el('add-kids-row').hidden = !!(pv && !pv.error && pv.options[pv.selected]?.type !== 'block'); // preview shows its own "For:" chips
  if (!pv) { box.hidden = true; return; }
  box.hidden = false;
  if (pv.error) { box.innerHTML = `<p class="muted">${esc(pv.error)}</p>`; return; }
  const sel = pv.options[pv.selected];
  const existing = existingFor(sel);
  const blockedAlready = sel.type === 'block' && state.wl.blocked.includes(sel.id);
  const kindLabel = { video: 'Just this video', playlist: 'This playlist', channel: 'Whole channel', block: 'Hide' };
  box.innerHTML = `
    ${pv.options.length > 1 ? `<div class="choices">${pv.options.map((o, i) => `
      <button type="button" class="choice ${i === pv.selected ? 'on' : ''}" data-choice="${i}">${esc(kindLabel[o.type])}</button>`).join('')}</div>` : ''}
    <div class="pcard ${sel.bad ? 'bad' : ''}">
      ${sel.type === 'channel' ? `<div class="pthumb round">${esc((sel.ref.title || sel.title || '?').replace(/^@/, '')[0]?.toUpperCase() || '?')}</div>`
        : sel.thumb || sel.type === 'block' ? `<img class="pthumb" src="${esc(sel.thumb || thumbUrl(sel.id))}" alt="">` : '<div class="pthumb">▶</div>'}
      <div class="pinfo">
        <div class="ptitle">${esc(sel.title)}</div>
        <div class="muted">${sel.type === 'channel' ? 'Every video from this channel, including new ones. Shorts are left out.'
          : sel.type === 'playlist' ? `${sel.sub ? esc(sel.sub) + ' · ' : ''}Every video in this playlist.`
            : sel.type === 'block' ? `${esc(sel.sub || sel.id)}<br>Hidden from every kid, even if its channel is approved.`
              : esc(sel.sub || '')}</div>
        ${existing ? `<div class="already">Already approved for ${esc(kidNames(existing.profiles || []))}.</div>` : ''}
        ${(() => {
          const hit = sel.type === 'video' && !sel.bad && termMatcher(state.wl.settings.blockedTerms)(sel.title);
          return hit ? `<div class="headsup">Heads up: the title contains the blocked word “${esc(hit)}”. Videos you approve one at a time are shown anyway.</div>` : '';
        })()}
        ${blockedAlready ? '<div class="already">Already hidden.</div>' : ''}
      </div>
    </div>
    ${sel.type === 'block' ? '' : `<div class="who"><span class="muted">For:</span> ${state.wl.profiles.map((p) => kidChip(p, state.addKids.has(p.id), `data-add-kid="${esc(p.id)}"`)).join('')}</div>`}
    <div class="row-actions">
      <button type="button" class="btn primary" id="add-go" ${sel.bad || blockedAlready || (sel.type !== 'block' && !state.addKids.size) ? 'disabled' : ''}>
        ${sel.type === 'block' ? 'Hide video' : existing ? 'Update' : 'Approve'}</button>
      <button type="button" class="btn" id="add-cancel">Cancel</button>
    </div>`;
}

el('preview').addEventListener('click', (e) => {
  const pv = state.preview;
  const choice = e.target.closest('[data-choice]');
  if (choice) { pv.selected = +choice.dataset.choice; return renderPreview(); }
  const kid = e.target.closest('[data-add-kid]')?.dataset.addKid;
  if (kid) { state.addKids.has(kid) ? state.addKids.delete(kid) : state.addKids.add(kid); localStorage.setItem(LS + 'addKids', JSON.stringify([...state.addKids])); renderAddKids(); return renderPreview(); }
  if (e.target.closest('#add-cancel')) return clearAdd();
  if (e.target.closest('#add-go')) approve(pv.options[pv.selected]);
});

function approve(opt) {
  const kids = state.wl.profiles.map((p) => p.id).filter((id) => state.addKids.has(id));
  const existing = existingFor(opt);
  if (opt.type === 'block') {
    state.wl.blocked.push(opt.id);
    if (opt.sub) state.titles.set(opt.id, opt.sub);
    clearAdd();
    toast('Video hidden. Publish to update the kids\' app.');
    return change(`hide video ${opt.sub || opt.id}`);
  }
  if (existing) existing.profiles = kids;
  else if (opt.type === 'video') state.wl.videos.push({ id: opt.id, title: opt.title, profiles: kids });
  else if (opt.type === 'playlist') state.wl.playlists.push({ id: opt.id, ...(opt.sub !== undefined && { title: opt.title }), profiles: kids });
  else if (opt.type === 'channel') state.wl.channels.push({ ...opt.ref, profiles: kids });
  // Approving a video un-hides it
  if (opt.type === 'video') state.wl.blocked = state.wl.blocked.filter((id) => id !== opt.id);
  const name = opt.type === 'channel' ? channelLabel(opt.ref) : opt.title;
  clearAdd();
  toast(`${existing ? 'Updated' : 'Approved'} “${name}” for ${kidNames(kids)}. Publish when you're ready.`);
  change(`${existing ? 'update' : 'add'} ${opt.type} ${name}`);
}

function clearAdd() { el('add-input').value = ''; state.preview = null; renderPreview(); el('add-input').focus(); }

el('add-input').addEventListener('input', () => { clearTimeout(onAddInput.t); onAddInput.t = setTimeout(onAddInput, 250); });
el('add-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); clearTimeout(onAddInput.t); onAddInput(); } });
el('paste-btn').addEventListener('click', async () => {
  try { el('add-input').value = await navigator.clipboard.readText(); onAddInput(); }
  catch { el('add-input').focus(); toast('Long-press the box and choose Paste.'); }
});

// ---------------------------------------------------------------- lists

function visibleToFilter(entry) { return state.filter === 'all' || (entry.profiles || []).includes(state.filter); }

function entryKids(kind, idx, entry) {
  return state.wl.profiles.map((p) => kidChip(p, (entry.profiles || []).includes(p.id), `data-toggle="${kind}:${idx}:${esc(p.id)}"`)).join('');
}

// One video thumbnail with the right Hide / Unhide / Allow anyway button.
function miniCard(id) {
  const v = state.catalog?.videos?.[id];
  const reason = hiddenReason(id);
  const allowedAnyway = state.wl.settings.allowAnyway.includes(id);
  let note = esc(fmtDuration(v?.durationSec)), btns = `<button type="button" class="link" data-hide="${esc(id)}">Hide</button>`;
  if (reason === 'blocked') { note = 'Hidden by you'; btns = `<button type="button" class="link" data-hide="${esc(id)}">Unhide</button>`; }
  else if (reason) { note = `Blocked word: “${esc(reason.slice(5))}”`; btns = `<button type="button" class="link" data-allow="${esc(id)}">Allow anyway</button>`; }
  else if (allowedAnyway) { note = 'Allowed anyway'; btns = `<button type="button" class="link" data-allow="${esc(id)}">Undo</button>` + btns; }
  return `
    <div class="mini ${reason ? 'hidden-vid' : ''}">
      <a href="https://www.youtube.com/watch?v=${esc(id)}" target="_blank" rel="noopener" title="Preview on YouTube"><img src="${thumbUrl(id)}" alt="" loading="lazy"></a>
      <div class="mini-title" data-title-for="${esc(id)}">${esc(v?.title || state.titles.get(id) || id)}</div>
      <div class="mini-foot"><span class="muted">${note}</span><span>${btns}</span></div>
    </div>`;
}

function videoAction(t) {
  const id = t.dataset.hide || t.dataset.allow;
  if (!id) return;
  const title = state.catalog?.videos?.[id]?.title || state.titles.get(id) || id;
  if (t.dataset.allow) {
    const s = state.wl.settings;
    if (s.allowAnyway.includes(id)) { s.allowAnyway = s.allowAnyway.filter((x) => x !== id); change(`stop allowing ${title}`); }
    else { s.allowAnyway.push(id); change(`allow ${title} despite blocked words`); }
  } else if (state.wl.blocked.includes(id)) { state.wl.blocked = state.wl.blocked.filter((x) => x !== id); change(`unhide ${title}`); }
  else { state.wl.blocked.push(id); state.titles.set(id, title); change(`hide ${title}`); }
}

function videoStrip(key, ids) {
  const shown = state.expanded.get(key) || 0;
  if (!shown) return '';
  return `<div class="strip">
    ${ids.slice(0, shown).map(miniCard).join('')}
    ${ids.length > shown ? `<button type="button" class="btn more" data-more="${esc(key)}">Show more (${ids.length - shown} left)</button>` : ''}
  </div>`;
}

const countLabel = (ids) => {
  const hidden = ids.filter(hiddenReason).length;
  return `${ids.length - hidden} videos${hidden ? ` · ${hidden} hidden` : ''}`;
};

function renderLists() {
  const { wl, catalog } = state;
  const lists = catalog?.lists || {};

  const channels = wl.channels.map((c, i) => [c, i]).filter(([c]) => visibleToFilter(c));
  el('channels').innerHTML = channels.length ? channels.map(([c, i]) => {
    const info = c.id && catalog?.channels?.[c.id];
    const ids = (c.id && lists['ch:' + c.id]) || [];
    const key = 'ch:' + (c.id || i);
    return `<div class="item">
      <div class="item-main">
        ${info?.thumb ? `<img class="avatar" src="${esc(info.thumb)}" alt="" referrerpolicy="no-referrer">` : `<div class="avatar">${esc(channelLabel(c).replace(/^@/, '')[0]?.toUpperCase() || '?')}</div>`}
        <div class="item-text">
          <div class="item-title">${esc(info?.title || channelLabel(c))}</div>
          <div class="muted">${info ? countLabel(ids) : 'New: videos appear a minute after you publish'}${(c.profiles || []).length ? '' : ' · <b class="warn">no kids selected</b>'}</div>
        </div>
        <div class="item-kids">${entryKids('channels', i, c)}</div>
        <div class="item-btns">
          <button type="button" class="btn small shorts ${shortsFor(c) ? 'on' : ''}" data-shorts="${i}"
            title="${shortsFor(c) ? 'Shorts from this channel are included' : 'Shorts from this channel are left out'}${typeof c.shorts === 'boolean' ? ' (just for this channel)' : ' (your default)'}">Shorts ${shortsFor(c) ? '✓' : '✕'}</button>
          ${ids.length ? `<button type="button" class="btn small" data-expand="${esc(key)}">${state.expanded.get(key) ? 'Close' : 'Videos'}</button>` : ''}
          <button type="button" class="btn small danger" data-remove="channels:${i}" aria-label="Remove">✕</button>
        </div>
      </div>
      ${videoStrip(key, ids)}
    </div>`;
  }).join('') : `<p class="muted empty">No channels${state.filter === 'all' ? ' yet' : ' for this kid'}.</p>`;

  const pls = wl.playlists.map((p, i) => [p, i]).filter(([p]) => visibleToFilter(p));
  el('playlists-wrap').hidden = !wl.playlists.length;
  el('playlists').innerHTML = pls.map(([p, i]) => {
    const info = catalog?.playlists?.[p.id];
    const ids = lists['pl:' + p.id] || [];
    const key = 'pl:' + p.id;
    return `<div class="item">
      <div class="item-main">
        ${info?.thumb ? `<img class="avatar wide" src="${esc(info.thumb)}" alt="">` : '<div class="avatar wide">▤</div>'}
        <div class="item-text">
          <div class="item-title">${esc(info?.title || p.title || p.id)}</div>
          <div class="muted">${info ? `${countLabel(ids)}${info.channelTitle ? ' · ' + esc(info.channelTitle) : ''}` : 'New: videos appear a minute after you publish'}</div>
        </div>
        <div class="item-kids">${entryKids('playlists', i, p)}</div>
        <div class="item-btns">
          ${ids.length ? `<button type="button" class="btn small" data-expand="${esc(key)}">${state.expanded.get(key) ? 'Close' : 'Videos'}</button>` : ''}
          <button type="button" class="btn small danger" data-remove="playlists:${i}" aria-label="Remove">✕</button>
        </div>
      </div>
      ${videoStrip(key, ids)}
    </div>`;
  }).join('') || '<p class="muted empty">None for this kid.</p>';

  const vids = wl.videos.map((v, i) => [v, i]).filter(([v]) => visibleToFilter(v)).reverse();
  el('videos').innerHTML = vids.length ? vids.map(([v, i]) => `
    <div class="item"><div class="item-main">
      <a href="https://www.youtube.com/watch?v=${esc(v.id)}" target="_blank" rel="noopener" title="Preview on YouTube"><img class="avatar wide" src="${thumbUrl(v.id)}" alt=""></a>
      <div class="item-text">
        <div class="item-title">${esc(v.title || state.catalog?.videos?.[v.id]?.title || v.id)}</div>
        <div class="muted">${esc(state.catalog?.videos?.[v.id]?.channelTitle || '')}${(v.profiles || []).length ? '' : ' · <b class="warn">no kids selected</b>'}</div>
      </div>
      <div class="item-kids">${entryKids('videos', i, v)}</div>
      <div class="item-btns"><button type="button" class="btn small danger" data-remove="videos:${i}" aria-label="Remove">✕</button></div>
    </div></div>`).join('') : `<p class="muted empty">No single videos${state.filter === 'all' ? ' yet' : ' for this kid'}.</p>`;

  el('hidden-wrap').hidden = !wl.blocked.length;
  el('hidden').innerHTML = wl.blocked.map(miniCard).join('');
  for (const id of wl.blocked) if (!state.titles.has(id) && !catalog?.videos?.[id]) fetchTitle(id);

  const counts = { channels: wl.channels.length, playlists: wl.playlists.length, videos: wl.videos.length, hidden: wl.blocked.length };
  for (const [k, n] of Object.entries(counts)) { const c = el(`count-${k}`); if (c) c.textContent = n; }
}

async function fetchTitle(id) {
  state.titles.set(id, id);
  try {
    const o = await oembed(`https://www.youtube.com/watch?v=${id}`);
    state.titles.set(id, o.title);
    const n = $(`[data-title-for="${CSS.escape(id)}"]`); if (n) n.textContent = o.title;
  } catch { /* leave the id */ }
}

el('lists').addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.dataset.toggle) {
    const [kind, idx, kid] = t.dataset.toggle.split(':');
    const entry = state.wl[kind][+idx];
    const set = new Set(entry.profiles || []);
    set.has(kid) ? set.delete(kid) : set.add(kid);
    entry.profiles = state.wl.profiles.map((p) => p.id).filter((id) => set.has(id));
    return change(`${set.has(kid) ? 'allow' : 'disallow'} ${kidById(kid)?.name}: ${entry.title || entry.handle || entry.id}`);
  }
  if (t.dataset.remove) {
    const [kind, idx] = t.dataset.remove.split(':');
    const entry = state.wl[kind][+idx];
    const name = entry.title || entry.handle || entry.id;
    if (!confirm(`Remove “${name}” for every kid?`)) return;
    state.wl[kind].splice(+idx, 1);
    return change(`remove ${name}`);
  }
  if (t.dataset.expand) {
    const k = t.dataset.expand;
    state.expanded.get(k) ? state.expanded.delete(k) : state.expanded.set(k, 24);
    return renderLists();
  }
  if (t.dataset.more) { state.expanded.set(t.dataset.more, state.expanded.get(t.dataset.more) + 48); return renderLists(); }
  if (t.dataset.shorts) {
    const c = state.wl.channels[+t.dataset.shorts];
    const next = !shortsFor(c);
    if (next === state.wl.settings.allowShorts) delete c.shorts; else c.shorts = next;
    return change(`${next ? 'include' : 'leave out'} Shorts from ${channelLabel(c)}`);
  }
  videoAction(t);
});

// ---------------------------------------------------------------- publish

function renderPublishBar() {
  const bar = el('publish-bar');
  const isDirty = dirty();
  bar.classList.toggle('show', isDirty || bar.dataset.busy === '1');
  if (bar.dataset.busy === '1') return;
  const n = state.log.length || 1;
  el('publish-msg').textContent = `${n} unpublished change${n > 1 ? 's' : ''}`;
  el('publish').textContent = state.mode === 'github' ? 'Publish' : 'Download whitelist.json';
}

el('discard').addEventListener('click', () => {
  if (!confirm('Throw away your unpublished changes?')) return;
  state.wl = normalize(JSON.parse(state.original)); state.log = []; state.editingKid = null;
  renderAll();
});

window.addEventListener('beforeunload', (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });

el('publish').addEventListener('click', async () => {
  const json = serialize(state.wl);
  if (state.mode === 'local') {
    const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([json], { type: 'application/json' })), download: 'whitelist.json' });
    a.click(); URL.revokeObjectURL(a.href);
    toast('Downloaded. Put it in the data folder and run the build script.');
    return;
  }
  const bar = el('publish-bar');
  bar.dataset.busy = '1';
  el('publish').disabled = true; el('discard').disabled = true;
  el('publish-msg').textContent = 'Publishing…';
  const summary = state.log.length ? state.log.slice(0, 4).join('; ') + (state.log.length > 4 ? ` (+${state.log.length - 4} more)` : '') : 'update whitelist';
  const put = () => gh(FILE, { method: 'PUT', body: JSON.stringify({ message: `Admin: ${summary}`, content: b64enc(serialize(state.wl)), sha: state.sha }) });
  const startedAt = new Date();
  try {
    let res;
    try { res = await put(); }
    catch (e) {
      if (e.status !== 409 && e.status !== 422) throw e;
      const remote = await loadRemote(); // someone (usually the nightly build) changed it meanwhile
      mergeResolved(state.wl, remote.wl);
      state.sha = remote.sha;
      res = await put();
    }
    state.sha = res.content.sha;
    state.original = serialize(state.wl);
    state.log = [];
    watchBuild(startedAt);
  } catch (e) {
    bar.dataset.busy = '0';
    toast(`Couldn't publish: ${e.message}`, 'error');
  } finally {
    el('publish').disabled = false; el('discard').disabled = false;
    if (bar.dataset.busy !== '1') renderPublishBar();
  }
});

// After publishing, the GitHub Action rebuilds the catalog and redeploys the
// site. Follow it via the Actions API if the token allows, else by watching
// catalog.json on the live site.
async function watchBuild(since) {
  const bar = el('publish-bar');
  const msg = el('publish-msg');
  el('publish').hidden = true; el('discard').hidden = true;
  msg.innerHTML = '<span class="dot"></span> Saved. Updating the kids\' app (about a minute)…';
  const deadline = Date.now() + 6 * 60 * 1000;
  let useActions = true;
  const done = (text, kind = '') => {
    bar.dataset.busy = '0';
    el('publish').hidden = false; el('discard').hidden = false;
    toast(text, kind);
    renderPublishBar();
  };
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 8000));
    if (useActions) {
      try {
        const runs = await gh('/actions/runs?per_page=5&branch=main');
        const run = runs.workflow_runs.find((r) => new Date(r.created_at) >= new Date(since.getTime() - 5000));
        if (run?.status === 'completed') {
          await loadCatalog(); renderAll();
          return run.conclusion === 'success' ? done('✓ The kids\' app is up to date.') : done(`The update failed. Check GitHub → Actions (${run.html_url}).`, 'error');
        }
        continue;
      } catch { useActions = false; }
    }
    const before = state.catalog?.generatedAt;
    await loadCatalog();
    if (state.catalog?.generatedAt && state.catalog.generatedAt !== before && new Date(state.catalog.generatedAt) > since) {
      renderAll();
      return done('✓ The kids\' app is up to date.');
    }
  }
  done('Saved. The kids\' app hasn\'t updated yet. Check GitHub → Actions if it doesn\'t appear soon.');
}

// ---------------------------------------------------------------- bookmarklet

const adminUrl = location.origin + location.pathname;
el('bookmarklet').href = `javascript:void(window.open('${adminUrl}#add='+encodeURIComponent(location.href)))`;

connect();
