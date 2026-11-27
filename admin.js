// Grown-ups' page. Signs in with Google and edits a wigwam in Supabase: its kids, the
// channels, playlists and videos they may watch, hidden videos, hearts and filters.
// Changes collect in the bar at the bottom until Publish; then the builder updates the
// kids' files. Devices, co-parents, friends and YouTube are in admin-social.js.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';
import { esc, thumbUrl, timeAgo, fmtDuration, SUGGESTED_TERMS, termMatcher, normalizeTerms } from './shared.js';
import { refreshSocial, renderSocial, finishYouTubeConnect, loadActivity } from './admin-social.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { storageKey: 'wigwam-admin', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false, flowType: 'pkce' },
});

const LS = 'tb-admin:';
const EMOJIS = ['🦊', '🦉', '🐻', '🐼', '🐯', '🦁', '🐸', '🐵', '🐰', '🐨', '🦄', '🐙', '🦖', '🐳', '🐝', '🐞', '🚀', '⚽', '🌈', '⭐'];
const COLORS = ['#f97316', '#ef4444', '#ec4899', '#a855f7', '#6366f1', '#0ea5e9', '#14b8a6', '#22c55e', '#eab308', '#78716c'];

const $ = (sel, root = document) => root.querySelector(sel);
const el = (id) => document.getElementById(id);

export const state = {
  user: null,          // the signed-in grown-up
  wigwams: [],         // the wigwams they belong to: [{ id, name, role, share_with_friends, built_at }]
  wigwam: null,        // id of the one being edited
  wl: null,            // working copy: { profiles, channels, playlists, videos, blocked, hearts, settings }
  original: '',        // JSON of the last published version
  catalog: null,       // the wigwam's admin/catalog.json (titles, thumbnails, counts)
  log: [],             // human-readable list of unpublished changes
  filter: 'all',       // which kid's view the lists show
  editingKid: null,
  expanded: new Map(), // open "show more" sections → how many to show
  browse: null,        // the channel/playlist open in the video browser
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

export function toast(msg, kind = '') {
  const t = el('toast');
  t.textContent = msg; t.className = `toast show ${kind}`;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.className = 'toast'; }, 3800);
}

function normalize(wl) {
  for (const k of ['profiles', 'channels', 'playlists', 'videos', 'blocked', 'hearts']) wl[k] ??= [];
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
export const dirty = () => state.wl && serialize(state.wl) !== state.original;
const kidById = (id) => state.wl.profiles.find((p) => p.id === id);
const kidNames = (ids) => ids.map((id) => kidById(id)?.name).filter(Boolean).join(', ') || 'nobody';
/** Records an unpublished change (or just redraws, with no message). */
export function change(msg) { if (msg) state.log.push(msg); renderAll(); }

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

// ---------------------------------------------------------------- Supabase

export async function must(query) { const { data, error } = await query; if (error) throw error; return data; }
/** Every row of a query (Supabase returns at most 1000 at a time). */
export async function allRows(make) {
  const out = [];
  for (let from = 0; ; from += 1000) {
    const rows = await must(make().range(from, from + 999));
    out.push(...rows);
    if (rows.length < 1000) return out;
  }
}
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const uid = () => state.user.id;
const current = () => state.wigwams.find((w) => w.id === state.wigwam);

/** The wigwam's rows → the working copy this page edits. */
async function loadDoc(w) {
  const [row, kids, sources, hidden, hearts] = await Promise.all([
    must(sb.from('wigwams').select('*').eq('id', w).single()),
    must(sb.from('kids').select('*').eq('wigwam_id', w).order('position')),
    allRows(() => sb.from('sources').select('*').eq('wigwam_id', w).order('position').order('created_at')),
    allRows(() => sb.from('hidden').select('video_id, title').eq('wigwam_id', w)),
    allRows(() => sb.from('hearts').select('video_id').eq('wigwam_id', w)),
  ]);
  const entry = (s) => {
    const e = { _id: s.id };
    if (s.yt_id) e.id = s.yt_id;
    for (const k of ['handle', 'username', 'url', 'title']) if (s[k]) e[k] = s[k];
    e.profiles = s.kids || [];
    if (typeof s.shorts === 'boolean') e.shorts = s.shorts;
    return e;
  };
  for (const h of hidden) if (h.title) state.titles.set(h.video_id, h.title);
  return {
    row,
    wl: normalize({
      profiles: kids.map(({ id, name, emoji, color }) => ({ id, name, emoji, color })),
      channels: sources.filter((s) => s.kind === 'channel').map(entry),
      playlists: sources.filter((s) => s.kind === 'playlist').map(entry),
      videos: sources.filter((s) => s.kind === 'video').map(entry),
      blocked: hidden.map((h) => h.video_id),
      hearts: hearts.map((h) => h.video_id),
      settings: row.settings || {},
    }),
  };
}

async function loadCatalog() {
  try {
    const { data: { session } } = await sb.auth.getSession();
    const res = await fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/feeds/${state.wigwam}/admin/catalog.json`, {
      cache: 'no-store', headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${session.access_token}` },
    });
    state.catalog = res.ok ? await res.json() : null;
  } catch { state.catalog = null; }
}

export async function loadWigwam(id) {
  const { row, wl } = await loadDoc(id);
  state.wigwam = id;
  localStorage.setItem(LS + 'wigwam', id);
  Object.assign(current(), row);
  state.wl = wl;
  state.original = serialize(wl);
  state.log = []; state.filter = 'all'; state.editingKid = null; state.browse = null;
  state.addKids = new Set(JSON.parse(localStorage.getItem(LS + 'addKids:' + id) || 'null') || wl.profiles.map((p) => p.id));
  await loadCatalog();
}

async function loadWigwams() {
  state.wigwams = (await must(sb.from('members').select('role, wigwams(id, name, share_with_friends, built_at)').eq('user_id', uid())))
    .filter((m) => m.wigwams).map((m) => ({ ...m.wigwams, role: m.role }));
}

// ---------------------------------------------------------------- sign in / choose a wigwam

function show(which, html = '') {
  for (const id of ['loading', 'gate', 'main']) el(id).hidden = id !== which;
  if (which === 'gate') el('gate').innerHTML = html;
  renderAccount();
}

function renderAccount() {
  const signedIn = !!state.user;
  el('account').hidden = !signedIn;
  if (!signedIn) return;
  const w = current();
  el('account').innerHTML = `
    ${state.wigwams.length ? `<label class="switcher" title="Which wigwam you're editing">🛖
      <select id="wigwam-pick">${state.wigwams.map((x) => `<option value="${esc(x.id)}" ${x.id === state.wigwam ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}
        <option value="+">＋ New wigwam…</option></select></label>` : ''}
    ${w ? '<button type="button" class="btn small" id="wigwam-rename">Rename</button>' : ''}
    <button type="button" class="btn small" id="sign-out" title="${esc(state.user.email || '')}">Sign out</button>`;
}

el('account').addEventListener('change', async (e) => {
  if (e.target.id !== 'wigwam-pick') return;
  const v = e.target.value;
  if (dirty() && !confirm('You have unpublished changes. Switch anyway and lose them?')) { e.target.value = state.wigwam; return; }
  if (v === '+') return showCreate(true);
  show('loading');
  try { await loadWigwam(v); show('main'); renderAll(); refreshSocial(); } catch (err) { showProblem(err); }
});
el('account').addEventListener('click', async (e) => {
  const t = e.target.closest('button');
  if (!t) return;
  if (t.id === 'sign-out') {
    if (dirty() && !confirm('You have unpublished changes. Sign out anyway?')) return;
    await sb.auth.signOut(); location.reload();
  }
  if (t.id === 'wigwam-rename') {
    const name = prompt('Name this wigwam (friends see this name if you share with them)', current().name)?.trim();
    if (!name) return;
    try {
      await must(sb.from('wigwams').update({ name }).eq('id', state.wigwam));
      current().name = name; renderAccount(); renderStatus();
    } catch (err) { toast(err.message, 'error'); }
  }
});

function showSignIn() {
  show('gate', `
    <h2>Sign in</h2>
    <p class="muted">Wigwam keeps each family's lists private. Sign in with Google to see and change yours. Do this on <b>your</b> phone or computer, not the kids' device.</p>
    <div class="row-actions"><button type="button" class="btn primary" id="google-btn">Sign in with Google</button></div>`);
  el('google-btn').onclick = async () => {
    const { error } = await sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: location.origin + location.pathname, queryParams: { prompt: 'select_account' } } });
    if (error) toast(error.message, 'error');
  };
}

async function showInvite(token) {
  sessionStorage.removeItem('wigwam-invite');
  history.replaceState(null, '', location.pathname);
  const info = await must(sb.rpc('invite_info', { invite_token: token }));
  const go = () => location.reload();
  if (!info) { toast('That invite link has already been used or cancelled.', 'error'); return connect(); }
  show('gate', `
    <h2>${info.kind === 'member' ? `Join “${esc(info.wigwam)}”` : 'Be friends'}</h2>
    <p>${info.kind === 'member'
      ? `<b>${esc(info.from)}</b> invited you to help run their wigwam. You'll be able to see and change what the kids can watch, and add devices.`
      : `<b>${esc(info.from)}</b> wants to be friends on Wigwam. Friends can look at each other's approved channels and playlists, but only for wigwams that choose to share. Nothing about your kids is shared.`}</p>
    ${info.expired ? '<p class="warn">This link has expired. Ask for a new one.</p>' : ''}
    <div class="row-actions">
      ${info.expired || info.mine ? '' : `<button type="button" class="btn primary" id="accept">${info.kind === 'member' ? 'Join' : 'Accept'}</button>`}
      <button type="button" class="btn" id="decline">${info.mine ? 'OK' : 'Not now'}</button>
    </div>${info.mine ? '<p class="muted">This is your own invite link. Send it to the other grown-up.</p>' : ''}`);
  el('decline').onclick = go;
  el('accept')?.addEventListener('click', async () => {
    try {
      const r = await must(sb.rpc('accept_invite', { invite_token: token }));
      if (r.wigwam_id) localStorage.setItem(LS + 'wigwam', r.wigwam_id);
      toast(r.kind === 'member' ? 'Welcome in!' : 'You\'re friends now.');
      setTimeout(go, 800);
    } catch (err) { toast(err.message, 'error'); }
  });
}

async function oldList() {
  try { const r = await fetch('data/whitelist.json', { cache: 'no-store' }); return r.ok ? normalize(await r.json()) : null; } catch { return null; }
}

async function showCreate(another = false) {
  const old = another ? null : await oldList();
  show('gate', `
    <h2>${another ? 'A new wigwam' : 'Make your wigwam'}</h2>
    <p class="muted">A wigwam holds your kids and what they can watch. You can invite another grown-up to share it later.</p>
    <label>Name <input id="new-name" value="${another ? '' : 'Our wigwam'}" maxlength="40" autocomplete="off"></label>
    ${old ? `<label class="check"><input type="checkbox" id="bring-old" checked> Bring in the list from the old Wigwam:
      ${old.profiles.length} kids, ${old.channels.length} channels, ${old.playlists.length} playlists, ${old.videos.length} videos, ${old.blocked.length} hidden</label>` : ''}
    <div class="row-actions"><button type="button" class="btn primary" id="create-go">Create</button>
      ${another ? '<button type="button" class="btn" id="create-cancel">Cancel</button>' : ''}</div>`);
  el('create-cancel')?.addEventListener('click', () => { show('main'); renderAll(); });
  el('create-go').onclick = async (e) => {
    e.target.disabled = true;
    try {
      const id = await must(sb.rpc('create_wigwam', { wigwam_name: el('new-name').value }));
      if (old && el('bring-old')?.checked) await importOld(id, old);
      localStorage.setItem(LS + 'wigwam', id);
      requestBuild().catch(() => {});
      location.reload();
    } catch (err) { e.target.disabled = false; toast(err.message, 'error'); }
  };
}

/** Copies the old one-family whitelist.json into a new wigwam. */
async function importOld(w, old) {
  await must(sb.from('kids').insert(old.profiles.map((k, i) => ({ wigwam_id: w, id: k.id, name: k.name, emoji: k.emoji, color: k.color, position: i }))));
  const rows = [];
  const add = (kind, list) => list.forEach((e, i) => rows.push({
    wigwam_id: w, kind, yt_id: e.id || null, handle: e.handle || null, username: e.username || null, url: e.url || null, title: e.title || null,
    kids: e.profiles || [], shorts: kind === 'channel' && typeof e.shorts === 'boolean' ? e.shorts : null, position: i, added_by: uid(),
  }));
  add('channel', old.channels); add('playlist', old.playlists); add('video', old.videos);
  for (const batch of chunk(rows, 500)) await must(sb.from('sources').insert(batch));
  for (const batch of chunk([...new Set(old.blocked)], 500)) await must(sb.from('hidden').insert(batch.map((video_id) => ({ wigwam_id: w, video_id }))));
  await must(sb.from('wigwams').update({ settings: old.settings }).eq('id', w));
  await must(sb.from('activity').insert({ wigwam_id: w, user_id: uid(), message: 'brought in the list from the old Wigwam' }));
}

function showProblem(err) {
  show('gate', `<h2>Something went wrong</h2><p class="warn">${esc(err.message || err)}</p>
    <div class="row-actions"><button type="button" class="btn primary" onclick="location.reload()">Try again</button></div>`);
}

async function connect() {
  show('loading');
  let youtubeCode = null;
  try {
    // Back from Google: either signing in (Supabase) or connecting YouTube (ours).
    const q = new URLSearchParams(location.search);
    if (q.get('code') || q.get('error')) {
      history.replaceState(null, '', location.pathname + location.hash);
      if (q.get('error')) toast(`Google said: ${q.get('error_description') || q.get('error')}`, 'error');
      else if (q.get('state') && q.get('state') === sessionStorage.getItem('wigwam-yt-state')) youtubeCode = q.get('code');
      else { const { error } = await sb.auth.exchangeCodeForSession(q.get('code')); if (error) toast(`Couldn't sign in: ${error.message}`, 'error'); }
      sessionStorage.removeItem('wigwam-yt-state');
    }
    const invite = new URLSearchParams(location.hash.slice(1)).get('invite');
    if (invite) sessionStorage.setItem('wigwam-invite', invite);

    const { data: { session } } = await sb.auth.getSession();
    if (!session || session.user.is_anonymous) return showSignIn();
    state.user = session.user;
    if (sessionStorage.getItem('wigwam-invite')) return await showInvite(sessionStorage.getItem('wigwam-invite'));

    await loadWigwams();
    if (!state.wigwams.length) return await showCreate();
    const saved = localStorage.getItem(LS + 'wigwam');
    await loadWigwam(state.wigwams.some((w) => w.id === saved) ? saved : state.wigwams[0].id);
    show('main');
    renderAll();
    await refreshSocial();
    if (youtubeCode) finishYouTubeConnect(youtubeCode);
    const add = new URLSearchParams(location.hash.slice(1)).get('add'); // from the bookmarklet
    if (add) { el('add-input').value = add; history.replaceState(null, '', location.pathname); onAddInput(); }
  } catch (e) {
    showProblem(e);
  }
}

// ---------------------------------------------------------------- rendering

function renderAll() {
  renderStatus();
  renderKids();
  renderFilters();
  renderAddKids();
  renderPreview();
  renderLists();
  renderBrowser();
  renderSocial();
  renderPublishBar();
}

function renderStatus() {
  const c = state.catalog, w = current();
  let html = `<span class="muted">Editing <b>${esc(w?.name || '')}</b></span>`;
  if (w?.built_at) html += ` · <span>Kids' app updated <b>${esc(timeAgo(w.built_at))}</b>${c ? ` · ${Object.keys(c.videos || {}).length} videos` : ''}</span>`;
  else html += ' · <span>Kids\' app: <b>not built yet</b> (publish something, or wait a minute)</span>';
  el('status').innerHTML = html;

  const notes = [];
  if (c?.mode === 'rss') notes.push(`<b>Free mode:</b> without a YouTube API key, Wigwam only sees each channel's newest ~15 videos, though the list grows over time.`);
  if (c?.warnings?.length) notes.push(`<b>Last update had ${c.warnings.length} problem${c.warnings.length > 1 ? 's' : ''}:</b><ul>${c.warnings.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>`);
  el('notes').innerHTML = notes.map((n) => `<div class="note">${n}</div>`).join('');
}

export function kidChip(p, on, attrs = '') {
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
  localStorage.setItem(LS + 'addKids:' + state.wigwam, JSON.stringify([...state.addKids]));
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
      options[0].title = err.message === 'embedding-disabled' ? "This video can't be played outside YouTube, so it won't work in Wigwam." : "Couldn't find that video. It may be private or deleted.";
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
  if (kid) { state.addKids.has(kid) ? state.addKids.delete(kid) : state.addKids.add(kid); localStorage.setItem(LS + 'addKids:' + state.wigwam, JSON.stringify([...state.addKids])); renderAddKids(); return renderPreview(); }
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
  const id = t.dataset.hide || t.dataset.allow || t.dataset.heart;
  if (!id) return;
  const title = state.catalog?.videos?.[id]?.title || state.titles.get(id) || state.wl.videos.find((v) => v.id === id)?.title || id;
  if (t.dataset.heart) {
    const h = state.wl.hearts;
    if (h.includes(id)) { state.wl.hearts = h.filter((x) => x !== id); return change(`unheart ${title}`); }
    h.push(id);
    return change(`heart ${title}`);
  }
  if (t.dataset.allow) {
    const s = state.wl.settings;
    if (s.allowAnyway.includes(id)) { s.allowAnyway = s.allowAnyway.filter((x) => x !== id); change(`stop allowing ${title}`); }
    else { s.allowAnyway.push(id); change(`allow ${title} despite blocked words`); }
  } else if (state.wl.blocked.includes(id)) { state.wl.blocked = state.wl.blocked.filter((x) => x !== id); change(`unhide ${title}`); }
  else { state.wl.blocked.push(id); state.titles.set(id, title); change(`hide ${title}`); }
}

const countLabel = (ids, entry) => {
  if (!ids.length && !(entry.profiles || []).length) return 'Videos load once a kid has it';
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
    return `<div class="item" data-idx="${i}">
      <div class="item-main">
        ${grip('channels', i)}
        <button type="button" class="item-open" data-open="${esc(key)}" title="See this channel's videos">
          ${info?.thumb ? `<img class="avatar" src="${esc(info.thumb)}" alt="" referrerpolicy="no-referrer">` : `<div class="avatar">${esc(channelLabel(c).replace(/^@/, '')[0]?.toUpperCase() || '?')}</div>`}
        </button>
        <div class="item-text">
          <button type="button" class="item-title item-open" data-open="${esc(key)}">${esc(info?.title || channelLabel(c))}</button>
          <div class="muted">${info ? countLabel(ids, c) :'New: videos appear a minute after you publish'}${(c.profiles || []).length ? '' : ' · <b class="warn">no kids selected</b>'}</div>
        </div>
        <div class="item-kids">${entryKids('channels', i, c)}</div>
        <div class="item-btns">
          <button type="button" class="btn small shorts ${shortsFor(c) ? 'on' : ''}" data-shorts="${i}"
            title="${shortsFor(c) ? 'Shorts from this channel are included' : 'Shorts from this channel are left out'}${typeof c.shorts === 'boolean' ? ' (just for this channel)' : ' (your default)'}">Shorts ${shortsFor(c) ? '✓' : '✕'}</button>
          <button type="button" class="btn small" data-open="${esc(key)}">Videos</button>
          <button type="button" class="btn small danger" data-remove="channels:${i}" aria-label="Remove">✕</button>
        </div>
      </div>
    </div>`;
  }).join('') : `<p class="muted empty">No channels${state.filter === 'all' ? ' yet' : ' for this kid'}.</p>`;

  const pls = wl.playlists.map((p, i) => [p, i]).filter(([p]) => visibleToFilter(p));
  el('playlists-wrap').hidden = !wl.playlists.length;
  el('playlists').innerHTML = pls.map(([p, i]) => {
    const info = catalog?.playlists?.[p.id];
    const ids = lists['pl:' + p.id] || [];
    const key = 'pl:' + p.id;
    return `<div class="item" data-idx="${i}">
      <div class="item-main">
        ${grip('playlists', i)}
        <button type="button" class="item-open" data-open="${esc(key)}" title="See this playlist's videos">
          ${info?.thumb ? `<img class="avatar wide" src="${esc(info.thumb)}" alt="">` : '<div class="avatar wide">▤</div>'}
        </button>
        <div class="item-text">
          <button type="button" class="item-title item-open" data-open="${esc(key)}">${esc(info?.title || p.title || p.id)}</button>
          <div class="muted">${info ? `${countLabel(ids, p)}${info.channelTitle ? ' · ' + esc(info.channelTitle) : ''}` : 'New: videos appear a minute after you publish'}</div>
        </div>
        <div class="item-kids">${entryKids('playlists', i, p)}</div>
        <div class="item-btns">
          <button type="button" class="btn small" data-open="${esc(key)}">Videos</button>
          <button type="button" class="btn small danger" data-remove="playlists:${i}" aria-label="Remove">✕</button>
        </div>
      </div>
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
      <div class="item-btns">${heartBtn(v.id)}<button type="button" class="btn small danger" data-remove="videos:${i}" aria-label="Remove">✕</button></div>
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
  if (t.dataset.open) return openBrowser(t.dataset.open);
  if (t.dataset.shorts) {
    const c = state.wl.channels[+t.dataset.shorts];
    const next = !shortsFor(c);
    if (next === state.wl.settings.allowShorts) delete c.shorts; else c.shorts = next;
    return change(`${next ? 'include' : 'leave out'} Shorts from ${channelLabel(c)}`);
  }
  videoAction(t);
});

// ---------------------------------------------------------------- video browser
//
// Opens one channel or playlist and lists every video in it, so you can hide or
// unhide them one at a time (tap the picture) or all at once after a search.

const PAGE = 60;
const fold = (s) => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();

function openBrowser(key) {
  state.browse = { key, q: '', tab: 'all', page: 0 };
  el('br-search').value = '';
  el('browser').show();
  document.body.classList.add('browsing');
  renderBrowser();
  el('br-body').scrollTop = 0;
}

function closeBrowser() {
  if (!state.browse) return;
  state.browse = null;
  el('browser').close();
  document.body.classList.remove('browsing');
}

/** What's open: { entry, title, thumb, round, ids, what, sub } */
function browsed() {
  const { key } = state.browse;
  const { wl, catalog } = state;
  const ids = catalog?.lists?.[key] || [];
  const kind = key.slice(0, 2), id = key.slice(3);
  if (kind === 'ch') {
    const c = wl.channels.find((x) => x.id === id) || (/^\d+$/.test(id) ? wl.channels[+id] : null);
    const info = catalog?.channels?.[id];
    return { entry: c, title: info?.title || (c ? channelLabel(c) : id), thumb: info?.thumb, round: true, ids, what: 'channel' };
  }
  const p = wl.playlists.find((x) => x.id === id);
  const info = catalog?.playlists?.[id];
  return { entry: p, title: info?.title || p?.title || id, thumb: info?.thumb, round: false, ids, what: 'playlist', sub: info?.channelTitle };
}

const matching = (ids, q) => (q ? ids.filter((id) => fold(state.catalog.videos[id]?.title).includes(q)) : ids);

const heartBtn = (id) => {
  const on = state.wl.hearts.includes(id);
  return `<button type="button" class="heartbtn ${on ? 'on' : ''}" data-heart="${esc(id)}" aria-pressed="${on}" title="${on ? 'Loved by the grown-ups: shows near the top of “♥ Top”' : 'Love this (it shows near the top of “♥ Top” in the kids\' app)'}">${on ? '♥' : '♡'}</button>`;
};

function browserCard(id) {
  const v = state.catalog?.videos?.[id];
  const reason = hiddenReason(id);
  const byWord = reason && reason !== 'blocked';
  const action = byWord ? `data-allow="${esc(id)}"` : `data-hide="${esc(id)}"`;
  const note = reason === 'blocked' ? 'Hidden by you' : byWord ? `Blocked word “${esc(reason.slice(5))}”` : esc([fmtDuration(v?.durationSec), timeAgo(v?.publishedAt)].filter(Boolean).join(' · '));
  const tip = reason === 'blocked' ? 'Tap to show it again' : byWord ? 'Tap to allow it anyway' : 'Tap to hide it';
  return `
    <div class="bcard ${reason ? 'off' : ''}">
      <button type="button" class="bthumb" ${action} aria-pressed="${!!reason}" title="${tip}">
        <img src="${thumbUrl(id)}" alt="" loading="lazy">
        <span class="bbadge">${reason ? '🚫 Hidden' : ''}</span>
      </button>
      <div class="mini-title">${esc(v?.title || id)}</div>
      <div class="mini-foot">
        <span class="muted">${note}</span>
        <span class="foot-btns">${heartBtn(id)}<a class="link" href="https://www.youtube.com/watch?v=${esc(id)}" target="_blank" rel="noopener" title="Watch on YouTube">Watch ↗</a></span>
      </div>
    </div>`;
}

function renderBrowser() {
  const b = state.browse;
  if (!b) return;
  const info = browsed();
  if (!info.entry) return closeBrowser(); // removed meanwhile
  const hiddenCount = info.ids.filter(hiddenReason).length;
  el('br-avatar').innerHTML = info.thumb ? `<img class="avatar ${info.round ? '' : 'wide'}" src="${esc(info.thumb)}" alt="" referrerpolicy="no-referrer">` : '';
  el('br-title').textContent = info.title;
  el('br-count').textContent = info.ids.length ? `${info.ids.length - hiddenCount} showing · ${hiddenCount} hidden${info.sub ? ' · ' + info.sub : ''}` : '';

  if (!info.ids.length) {
    el('br-tools').hidden = true; el('br-pager').innerHTML = ''; el('br-bulk').innerHTML = '';
    el('br-grid').innerHTML = `<p class="muted empty">${(info.entry.profiles || []).length
      ? 'No videos yet. They appear about a minute after you publish.'
      : `Wigwam only fetches the videos of a ${info.what} once a kid can watch it. Tick a kid for it and publish, then come back here to hide videos.`}</p>`;
    return;
  }
  el('br-tools').hidden = false;

  const q = fold(b.q.trim());
  const matches = matching(info.ids, q);
  const hearts = new Set(state.wl.hearts);
  const byTab = { all: matches, shown: matches.filter((id) => !hiddenReason(id)), hidden: matches.filter(hiddenReason), loved: matches.filter((id) => hearts.has(id)) };
  const list = byTab[b.tab];
  el('br-tabs').innerHTML = [['all', 'All'], ['shown', 'Showing'], ['hidden', 'Hidden'], ['loved', '♥ Loved']]
    .map(([k, name]) => `<button type="button" class="tab ${b.tab === k ? 'on' : ''}" data-tab="${k}">${name} <span class="n">${byTab[k].length}</span></button>`).join('');

  // After a search, hide or unhide everything that matched in one go.
  const canHide = byTab.shown.length, canShow = matches.filter((id) => state.wl.blocked.includes(id)).length;
  el('br-bulk').innerHTML = q && (canHide || canShow) ? `<div class="br-bulk">
      <span class="muted">${matches.length} match “${esc(b.q.trim())}”</span>
      ${canHide ? `<button type="button" class="btn small" data-bulk="hide">Hide ${canHide === 1 ? 'it' : `all ${canHide}`}</button>` : ''}
      ${canShow ? `<button type="button" class="btn small" data-bulk="show">Unhide ${canShow === 1 ? 'it' : `all ${canShow}`}</button>` : ''}
    </div>` : '';

  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  b.page = Math.min(b.page, pages - 1);
  el('br-grid').innerHTML = list.length
    ? list.slice(b.page * PAGE, (b.page + 1) * PAGE).map(browserCard).join('')
    : `<p class="muted empty">${b.tab === 'hidden' ? 'Nothing hidden here.' : b.tab === 'loved' ? 'Tap ♡ under a video to love it. Loved videos come first in the kids\' “♥ Top” sort.' : 'No videos match.'}</p>`;
  el('br-pager').innerHTML = pages > 1 ? `
    <button type="button" class="btn small" data-page="${b.page - 1}" ${b.page ? '' : 'disabled'}>◀ Newer</button>
    <span class="muted">Page ${b.page + 1} of ${pages}</span>
    <button type="button" class="btn small" data-page="${b.page + 1}" ${b.page < pages - 1 ? '' : 'disabled'}>Older ▶</button>` : '';
}

el('br-search').addEventListener('input', (e) => { state.browse.q = e.target.value; state.browse.page = 0; renderBrowser(); });
el('br-close').addEventListener('click', closeBrowser);
el('br-shade').addEventListener('click', closeBrowser);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && state.browse) { e.preventDefault(); closeBrowser(); } });
el('browser').addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (!t || !state.browse) return;
  const b = state.browse;
  const top = () => { el('br-body').scrollTop = 0; };
  if (t.dataset.tab) { b.tab = t.dataset.tab; b.page = 0; renderBrowser(); return top(); }
  if (t.dataset.page) { b.page = +t.dataset.page; renderBrowser(); return top(); }
  if (t.dataset.bulk) {
    const info = browsed(), words = b.q.trim();
    const matches = matching(info.ids, fold(words));
    if (t.dataset.bulk === 'hide') {
      const ids = matches.filter((id) => !hiddenReason(id));
      for (const id of ids) state.titles.set(id, state.catalog.videos[id]?.title || id);
      state.wl.blocked.push(...ids);
      return change(`hide ${ids.length} video${ids.length > 1 ? 's' : ''} matching “${words}” in ${info.title}`);
    }
    const ids = new Set(matches.filter((id) => state.wl.blocked.includes(id)));
    state.wl.blocked = state.wl.blocked.filter((id) => !ids.has(id));
    return change(`unhide ${ids.size} video${ids.size > 1 ? 's' : ''} matching “${words}” in ${info.title}`);
  }
  videoAction(t);
});

// ---------------------------------------------------------------- drag to reorder
//
// Grab a channel's or playlist's ⠿ handle and drag it up or down; the kids' app
// shows them in the same order. Works with a mouse or a finger. With a keyboard,
// focus the handle and press ↑ or ↓.

const grip = (kind, i) =>
  `<button type="button" class="grip" data-grip="${kind}" data-idx="${i}" aria-label="Move (drag, or press the up and down arrows)" title="Drag to move">⠿</button>`;

const entryName = (e) => e.title || state.catalog?.channels?.[e.id]?.title || state.catalog?.playlists?.[e.id]?.title || e.handle || e.id;

/** Puts the shown entries (indices in `order`, in their new order) back into the
 *  slots they came from, so entries hidden by the kid filter stay where they were. */
function reorder(kind, order) {
  const list = state.wl[kind];
  const slots = [...order].sort((a, b) => a - b);
  const next = [...list];
  slots.forEach((slot, n) => { next[slot] = list[order[n]]; });
  if (next.every((e, n) => e === list[n])) return false;
  state.wl[kind] = next;
  return true;
}

function moved(kind, entry) {
  const pos = state.wl[kind].indexOf(entry);
  change(`move ${entryName(entry)} to number ${pos + 1}`);
  return pos;
}

let drag = null;
const rows = (box) => [...box.querySelectorAll(':scope > .item')];

el('lists').addEventListener('pointerdown', (e) => {
  const g = e.target.closest('[data-grip]');
  if (!g || e.button > 0) return;
  e.preventDefault();
  const item = g.closest('.item');
  drag = { kind: g.dataset.grip, item, box: item.parentElement, y: e.clientY };
  g.setPointerCapture(e.pointerId);
  item.classList.add('dragging');
  document.body.classList.add('reordering');
  requestAnimationFrame(autoScroll);
});

/** Moves the lifted row to where the pointer is. */
function place() {
  const { item, box, y } = drag;
  const before = rows(box).find((n) => n !== item && (() => { const r = n.getBoundingClientRect(); return y < r.top + r.height / 2; })());
  if (before) { if (item.nextElementSibling !== before) box.insertBefore(item, before); }
  else if (box.lastElementChild !== item) box.appendChild(item);
}

// Scrolls the page while a row is held near the top or bottom edge.
function autoScroll() {
  if (!drag) return;
  const bottom = innerHeight - (el('publish-bar').classList.contains('show') ? el('publish-bar').offsetHeight : 0);
  const edge = 80;
  const speed = drag.y < edge ? -(edge - drag.y) / 3 : drag.y > bottom - edge ? (drag.y - (bottom - edge)) / 3 : 0;
  if (speed) { scrollBy(0, speed); place(); }
  requestAnimationFrame(autoScroll);
}

document.addEventListener('pointermove', (e) => { if (drag) { drag.y = e.clientY; place(); } });

function endDrag() {
  if (!drag) return;
  const { kind, item, box } = drag;
  drag = null;
  item.classList.remove('dragging');
  document.body.classList.remove('reordering');
  const entry = state.wl[kind][+item.dataset.idx];
  if (reorder(kind, rows(box).map((n) => +n.dataset.idx))) moved(kind, entry);
  else renderLists();
}
document.addEventListener('pointerup', endDrag);
document.addEventListener('pointercancel', endDrag);

el('lists').addEventListener('keydown', (e) => {
  const g = e.target.closest('[data-grip]');
  if (!g || (e.key !== 'ArrowUp' && e.key !== 'ArrowDown')) return;
  e.preventDefault();
  const kind = g.dataset.grip;
  const order = rows(g.closest('.item').parentElement).map((n) => +n.dataset.idx);
  const at = order.indexOf(+g.dataset.idx), to = at + (e.key === 'ArrowUp' ? -1 : 1);
  if (to < 0 || to >= order.length) return;
  const entry = state.wl[kind][order[at]];
  [order[at], order[to]] = [order[to], order[at]];
  reorder(kind, order);
  const pos = moved(kind, entry);
  $(`[data-grip="${kind}"][data-idx="${pos}"]`)?.focus();
});

// ---------------------------------------------------------------- publish

function renderPublishBar() {
  const bar = el('publish-bar');
  const isDirty = dirty();
  bar.classList.toggle('show', isDirty || bar.dataset.busy === '1');
  if (bar.dataset.busy === '1') return;
  const n = state.log.length || 1;
  el('publish-msg').textContent = `${n} unpublished change${n > 1 ? 's' : ''}`;
}

el('discard').addEventListener('click', () => {
  if (!confirm('Throw away your unpublished changes?')) return;
  state.wl = normalize(JSON.parse(state.original)); state.log = []; state.editingKid = null;
  renderAll();
});

window.addEventListener('beforeunload', (e) => { if (dirty()) { e.preventDefault(); e.returnValue = ''; } });

/** Writes the difference between the last published version and the working copy. Only
 *  what changed is sent, so a co-parent's changes made meanwhile are kept. */
async function saveChanges() {
  const w = state.wigwam, before = normalize(JSON.parse(state.original)), after = state.wl;

  const kidRow = (k, i) => ({ wigwam_id: w, id: k.id, name: k.name, emoji: k.emoji, color: k.color, position: i });
  const oldKids = new Map(before.profiles.map((k, i) => [k.id, JSON.stringify(kidRow(k, i))]));
  const kidUpserts = after.profiles.map(kidRow).filter((r) => oldKids.get(r.id) !== JSON.stringify(r));
  if (kidUpserts.length) await must(sb.from('kids').upsert(kidUpserts));

  for (const [list, kind] of [['channels', 'channel'], ['playlists', 'playlist'], ['videos', 'video']]) {
    const old = new Map(before[list].map((e, i) => [e._id, { e, i }]));
    const fields = (e, i) => ({ kids: e.profiles || [], shorts: kind === 'channel' && typeof e.shorts === 'boolean' ? e.shorts : null, position: i });
    const inserts = [], updates = [];
    after[list].forEach((e, i) => {
      if (!e._id) {
        inserts.push({ wigwam_id: w, kind, yt_id: e.id || null, handle: e.handle || null, username: e.username || null, url: e.url || null, title: e.title || null, added_by: uid(), ...fields(e, i) });
      } else {
        const o = old.get(e._id);
        if (o && JSON.stringify(fields(o.e, o.i)) !== JSON.stringify(fields(e, i))) updates.push([e._id, fields(e, i)]);
      }
    });
    const gone = [...old.keys()].filter((id) => !after[list].some((e) => e._id === id));
    for (const batch of chunk(inserts, 500)) await must(sb.from('sources').insert(batch));
    for (const batch of chunk(updates, 10)) await Promise.all(batch.map(([id, f]) => must(sb.from('sources').update(f).eq('id', id))));
    for (const batch of chunk(gone, 100)) await must(sb.from('sources').delete().in('id', batch));
  }

  const goneKids = [...oldKids.keys()].filter((id) => !after.profiles.some((k) => k.id === id));
  if (goneKids.length) await must(sb.from('kids').delete().eq('wigwam_id', w).in('id', goneKids));

  for (const [table, key] of [['hidden', 'blocked'], ['hearts', 'hearts']]) {
    const b = new Set(before[key]), a = new Set(after[key]);
    const added = [...a].filter((id) => !b.has(id)), removed = [...b].filter((id) => !a.has(id));
    for (const batch of chunk(added, 500)) {
      await must(sb.from(table).upsert(batch.map((video_id) => ({ wigwam_id: w, video_id, ...(table === 'hidden' && { title: state.titles.get(video_id) || state.catalog?.videos?.[video_id]?.title || null }) })), { ignoreDuplicates: true }));
    }
    for (const batch of chunk(removed, 100)) await must(sb.from(table).delete().eq('wigwam_id', w).in('video_id', batch));
  }

  if (JSON.stringify(before.settings) !== JSON.stringify(after.settings)) {
    const remote = (await must(sb.from('wigwams').select('settings').eq('id', w).single())).settings || {};
    const merge = (key) => {
      const b = new Set(before.settings[key]), a = new Set(after.settings[key]), r = new Set(remote[key] || []);
      for (const x of a) if (!b.has(x)) r.add(x);
      for (const x of b) if (!a.has(x)) r.delete(x);
      return [...r];
    };
    const allowShorts = after.settings.allowShorts !== before.settings.allowShorts ? after.settings.allowShorts : remote.allowShorts ?? after.settings.allowShorts;
    await must(sb.from('wigwams').update({ settings: { ...remote, allowShorts, blockedTerms: merge('blockedTerms'), allowAnyway: merge('allowAnyway') } }).eq('id', w));
  }

  const msgs = state.log.length ? state.log : ['changed the lists'];
  const rows = (msgs.length > 40 ? [...msgs.slice(0, 39), `…and ${msgs.length - 39} more changes`] : msgs).map((message) => ({ wigwam_id: w, user_id: uid(), message }));
  await must(sb.from('activity').insert(rows));
}

async function requestBuild() {
  const { error } = await sb.functions.invoke('request-build');
  if (error) {
    let msg = error.message;
    try { msg = (await error.context.json()).error || msg; } catch {}
    throw new Error(msg);
  }
}

el('publish').addEventListener('click', async () => {
  const bar = el('publish-bar');
  bar.dataset.busy = '1';
  el('publish').disabled = true; el('discard').disabled = true;
  el('publish-msg').textContent = 'Publishing…';
  const startedAt = new Date();
  try {
    await saveChanges();
    let building = true;
    try { await requestBuild(); } catch (e) { building = false; toast(`Saved. The kids' app updates tonight (couldn't start an update now: ${e.message})`); }
    await loadWigwam(state.wigwam);
    renderAll(); loadActivity().then(renderSocial).catch(() => {});
    if (building) watchBuild(startedAt);
    else { bar.dataset.busy = '0'; renderPublishBar(); }
  } catch (e) {
    bar.dataset.busy = '0';
    toast(`Couldn't publish: ${e.message}`, 'error');
  } finally {
    el('publish').disabled = false; el('discard').disabled = false;
    if (bar.dataset.busy !== '1') renderPublishBar();
  }
});

// After publishing, the builder (a GitHub Action) updates the kids' files. Watch the
// wigwam's built_at until it moves past the moment we published.
async function watchBuild(since) {
  const bar = el('publish-bar');
  el('publish').hidden = true; el('discard').hidden = true;
  el('publish-msg').innerHTML = '<span class="dot"></span> Saved. Updating the kids\' app (about a minute)…';
  const done = (text, kind = '') => {
    bar.dataset.busy = '0';
    el('publish').hidden = false; el('discard').hidden = false;
    toast(text, kind);
    renderPublishBar();
  };
  const deadline = Date.now() + 6 * 60 * 1000;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 8000));
    try {
      const { built_at } = await must(sb.from('wigwams').select('built_at').eq('id', state.wigwam).single());
      if (built_at && new Date(built_at) > since) {
        current().built_at = built_at;
        await loadCatalog(); renderAll();
        return done('✓ The kids\' app is up to date.');
      }
    } catch { /* keep waiting */ }
  }
  done('Saved. The kids\' app hasn\'t updated yet; it will by tonight at the latest.');
}

// ---------------------------------------------------------------- bookmarklet

const adminUrl = location.origin + location.pathname;
el('bookmarklet').href = `javascript:void(window.open('${adminUrl}#add='+encodeURIComponent(location.href)))`;

connect();
