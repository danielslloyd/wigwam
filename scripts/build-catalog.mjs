#!/usr/bin/env node
// Builds every wigwam's video lists from what its grown-ups approved in Supabase.
//
//   node scripts/build-catalog.mjs           incremental update (nightly, and after each publish)
//   node scripts/build-catalog.mjs --full    re-fetch everything (weekly; drops deleted videos)
//   node scripts/build-catalog.mjs --local   try it offline: reads data/whitelist.json as one
//                                            wigwam and writes to .build/ instead of Supabase
//
// Environment: SUPABASE_SECRET_KEY (server key), YOUTUBE_API_KEY (optional: without it only
// each channel's newest ~15 videos are seen), GOOGLE_CLIENT_SECRET (to sync connected
// YouTube accounts).
//
// 1. YouTube is read once for everyone into a shared cache (storage: cache/catalog.json),
//    so a channel several families approve costs the same as one.
// 2. Each wigwam gets private files in storage (feeds/<wigwam>/…):
//      admin/catalog.json      every video in its channels and playlists, for the grown-ups' page
//      index.json              its kids and the current version of each kid's file (tiny)
//      kids/<kid>.<ver>.json   one kid's visible videos; a new file only when something changed
// 3. Connected YouTube accounts are read for new subscriptions, playlists and liked videos,
//    which land in that grown-up's inbox to approve or dismiss. Nothing is approved automatically.
//
// Shorts: unless allowed, a channel is read through its "UULF" playlist (long-form uploads
// only) instead of its full "UU" uploads playlist. Blocked words are checked per wigwam
// against titles (and tags, in API mode).

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { termMatcher } from '../shared.js';
import { SUPABASE_URL, GOOGLE_CLIENT_ID } from '../config.js';
import { supa } from './lib/supa.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEY = process.env.YOUTUBE_API_KEY?.trim();
const FULL = process.argv.includes('--full');
const LOCAL = process.argv.includes('--local');
const MODE = KEY ? 'api' : 'rss';
const UA = 'Mozilla/5.0 (compatible; Wigwam catalog builder)';
const db = LOCAL ? null : supa(SUPABASE_URL, process.env.SUPABASE_SECRET_KEY?.trim() || fail('SUPABASE_SECRET_KEY is not set'));

const warnings = new Map(); // source key ('ch:…', 'pl:…') or '' → messages
let apiCalls = 0;
function warn(msg, key = '') { console.warn('⚠ ' + msg); warnings.set(key, [...(warnings.get(key) || []), msg]); }
function fail(msg) { console.error(msg); process.exit(1); }

// ---------------------------------------------------------------- helpers

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); } catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}
const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));
const sha = (s) => createHash('sha1').update(s).digest('hex').slice(0, 12);

function isoDurationToSec(iso) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso || '');
  if (!m) return null;
  const [, d = 0, h = 0, min = 0, s = 0] = m.map((x) => (x === undefined ? 0 : Number(x)));
  return d * 86400 + h * 3600 + min * 60 + s;
}

function decodeEntities(s) {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** YouTube Data API. With `token`, as that grown-up (OAuth); otherwise with the API key. */
async function api(endpoint, params, token) {
  const url = new URL('https://www.googleapis.com/youtube/v3/' + endpoint);
  for (const [k, v] of Object.entries({ ...params, ...(!token && { key: KEY }) })) if (v != null) url.searchParams.set(k, v);
  apiCalls++;
  const res = await fetch(url, token ? { headers: { Authorization: `Bearer ${token}` } } : undefined);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const reason = body?.error?.errors?.[0]?.reason || res.status;
    const err = new Error(`${endpoint}: ${body?.error?.message || res.statusText} (${reason})`);
    err.status = res.status; err.reason = reason;
    throw err;
  }
  return body;
}

async function getText(url) {
  apiCalls++;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept-Language': 'en' } });
  if (!res.ok) { const e = new Error(`${url} → HTTP ${res.status}`); e.status = res.status; throw e; }
  return res.text();
}

// A channel's ID, title and avatar from its public page (works for any URL form).
async function scrapeChannel(url) {
  const html = await getText(url);
  const id = /"externalId":"(UC[\w-]{22})"/.exec(html)?.[1]
    || /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/.exec(html)?.[1];
  if (!id) throw new Error(`couldn't find a channel ID on ${url}`);
  const title = decodeEntities(/<meta property="og:title" content="([^"]*)"/.exec(html)?.[1] || '');
  const thumb = /<meta property="og:image" content="([^"]*)"/.exec(html)?.[1] || '';
  return { id, title, thumb: thumb.replace(/=s\d+-/, '=s240-') };
}

function channelPageUrl(c) {
  if (c.yt_id) return `https://www.youtube.com/channel/${c.yt_id}`;
  if (c.handle) return `https://www.youtube.com/${c.handle.startsWith('@') ? c.handle : '@' + c.handle}`;
  if (c.username) return `https://www.youtube.com/user/${c.username}`;
  if (c.url) return c.url;
  throw new Error('channel has no id, handle, username or url');
}

// RSS feed → newest ~15 entries
async function readFeed(query) {
  const xml = await getText(`https://www.youtube.com/feeds/videos.xml?${query}`);
  const title = decodeEntities(/<title>([^<]*)<\/title>/.exec(xml)?.[1] || '');
  const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
    id: /<yt:videoId>([^<]+)<\/yt:videoId>/.exec(e)?.[1],
    title: decodeEntities(/<title>([^<]*)<\/title>/.exec(e)?.[1] || ''),
    channelId: /<yt:channelId>([^<]+)<\/yt:channelId>/.exec(e)?.[1],
    channelTitle: decodeEntities(/<author>\s*<name>([^<]*)<\/name>/.exec(e)?.[1] || ''),
    publishedAt: /<published>([^<]+)<\/published>/.exec(e)?.[1],
  })).filter((v) => v.id);
  return { title, entries };
}

async function resolveChannel(c) {
  if (MODE !== 'api') return scrapeChannel(channelPageUrl(c));
  const params = { part: 'snippet' };
  if (c.yt_id) params.id = c.yt_id;
  else if (c.handle) params.forHandle = c.handle.startsWith('@') ? c.handle : '@' + c.handle;
  else if (c.username) params.forUsername = c.username;
  else return scrapeChannel(c.url); // /c/ custom URLs have no API lookup
  const item = (await api('channels', params)).items?.[0];
  if (!item) throw new Error(`channel not found (${c.handle || c.yt_id || c.username})`);
  const t = item.snippet.thumbnails;
  return { id: item.id, title: item.snippet.title, thumb: (t.medium || t.default)?.url || '' };
}

// Page through a playlist; with `known`, stop at the first page that has a known video.
async function playlistIds(playlistId, known, token) {
  const ids = [];
  let pageToken;
  do {
    const page = await api('playlistItems', { part: 'contentDetails', playlistId, maxResults: 50, pageToken }, token);
    const pageIds = page.items.map((i) => i.contentDetails.videoId);
    ids.push(...pageIds);
    if (known && pageIds.some((id) => known.has(id))) break;
    pageToken = page.nextPageToken;
  } while (pageToken);
  return ids;
}

// ---------------------------------------------------------------- load the wigwams

/** [{ id, name, settings, kids, sources, hidden: Set, hearts: [] }] */
async function loadWigwams() {
  if (LOCAL) { // one wigwam from the old whitelist.json format
    const wl = await readJson(path.join(ROOT, 'data', 'whitelist.json'));
    if (!wl) fail('--local needs data/whitelist.json');
    const src = (kind, e, i) => ({ id: `${kind}${i}`, kind, yt_id: e.id || null, handle: e.handle || null, username: e.username || null, url: e.url || null, title: e.title || null, kids: e.profiles || [], shorts: typeof e.shorts === 'boolean' ? e.shorts : null });
    return [{
      id: 'local', name: 'Local', settings: wl.settings || {}, kids: wl.profiles || [],
      sources: [...(wl.channels || []).map((e, i) => src('channel', e, i)), ...(wl.playlists || []).map((e, i) => src('playlist', e, i)), ...(wl.videos || []).map((e, i) => src('video', e, i))],
      hidden: new Set(wl.blocked || []), hearts: wl.hearts || [],
    }];
  }
  const [wigwams, kids, sources, hidden, hearts] = await Promise.all([
    db.all('wigwams', 'select=id,name,settings'),
    db.all('kids', 'select=*&order=position,id'),
    db.all('sources', 'select=*&order=position,created_at'),
    db.all('hidden', 'select=wigwam_id,video_id'),
    db.all('hearts', 'select=wigwam_id,video_id'),
  ]);
  return wigwams.map((w) => ({
    ...w,
    kids: kids.filter((k) => k.wigwam_id === w.id).map(({ id, name, emoji, color }) => ({ id, name, emoji, color })),
    sources: sources.filter((s) => s.wigwam_id === w.id),
    hidden: new Set(hidden.filter((h) => h.wigwam_id === w.id).map((h) => h.video_id)),
    hearts: hearts.filter((h) => h.wigwam_id === w.id).map((h) => h.video_id),
  }));
}

// ---------------------------------------------------------------- the shared YouTube cache

const emptyCache = () => ({ channels: {}, playlists: {}, videos: {}, lists: {}, shortFiltered: {}, skipped: [], tags: {} });

/** The catalog.json written by the old one-family builder, turned into the shared cache shape. */
function fromOldCatalog(old, tags) {
  const c = emptyCache();
  for (const [id, ch] of Object.entries(old.channels || {})) c.channels[id] = { title: ch.title, thumb: ch.thumb, handle: ch.handle || null };
  for (const [id, pl] of Object.entries(old.playlists || {})) c.playlists[id] = { title: pl.title, channelTitle: pl.channelTitle, thumb: pl.thumb };
  for (const [key, ids] of Object.entries(old.lists || {})) {
    const id = key.slice(3);
    c.lists[key.startsWith('ch:') ? (old.channels?.[id]?.shorts ? 'UU' : 'UULF') + id.slice(2) : id] = ids;
  }
  c.videos = old.videos || {};
  c.skipped = old.skipped || [];
  c.tags = tags || {};
  return c;
}

async function loadCache() {
  if (FULL) return emptyCache();
  if (!LOCAL) {
    const [c, tags] = await Promise.all([db.getJson('cache', 'catalog.json'), db.getJson('cache', 'tags.json')]);
    if (c) return { ...emptyCache(), ...c, tags: tags || {} };
  }
  // First run: start from the old builder's files if they're still in the repo.
  const old = await readJson(path.join(ROOT, 'data', 'catalog.json'), null);
  if (old) { console.log('  (starting the shared cache from data/catalog.json)'); return fromOldCatalog(old, await readJson(path.join(ROOT, 'data', 'tags.json'), {})); }
  return emptyCache();
}

// ---------------------------------------------------------------- main

console.log(`Building in ${MODE.toUpperCase()} mode${FULL ? ' (full rebuild)' : ''}${LOCAL ? ' (local)' : ''}…`);
if (MODE === 'rss') console.log("  (no YOUTUBE_API_KEY: only each channel's newest ~15 videos are visible per run)");

const wigwams = await loadWigwams();
const prev = await loadCache();
const cache = { ...emptyCache(), generatedAt: new Date().toISOString(), mode: MODE };
const skipped = new Set(prev.skipped);
const tags = { ...prev.tags };
const sourceUpdates = new Map(); // source row id → fields the builder learned (id, title, thumb)
const learn = (s, fields) => {
  const changed = Object.fromEntries(Object.entries(fields).filter(([k, v]) => v && s[k] !== v));
  if (Object.keys(changed).length) { Object.assign(s, changed); sourceUpdates.set(s.id, { ...sourceUpdates.get(s.id), ...changed }); }
};
const shortsOf = (w, s) => (typeof s.shorts === 'boolean' ? s.shorts : !!w.settings?.allowShorts);
const uploadsList = (channelId, shorts) => (shorts ? 'UU' : 'UULF') + channelId.slice(2);

// --- channels: find each one's ID, name and picture (once, however many wigwams have it)
const channelKey = (s) => s.yt_id || (s.handle && 'h:' + s.handle.toLowerCase()) || (s.username && 'u:' + s.username) || 'url:' + s.url;
const channelSources = wigwams.flatMap((w) => w.sources.filter((s) => s.kind === 'channel'));
const resolved = new Map(); // channelKey → { id, title, thumb } or null
for (const s of channelSources) {
  const k = channelKey(s);
  if (!resolved.has(k)) {
    const known = s.yt_id && prev.channels[s.yt_id];
    if (known && !FULL) resolved.set(k, { id: s.yt_id, ...known });
    else {
      try { resolved.set(k, await resolveChannel(s)); }
      catch (e) { resolved.set(k, null); warn(`channel ${s.handle || s.yt_id || s.url}: ${e.message}`, 'ch:' + (s.yt_id || s.handle)); }
    }
  }
  const ch = resolved.get(k);
  if (ch) {
    learn(s, { yt_id: ch.id, title: ch.title, thumb: ch.thumb });
    cache.channels[ch.id] = { title: ch.title, thumb: ch.thumb, handle: s.handle || prev.channels[ch.id]?.handle || null };
  } else if (s.yt_id && prev.channels[s.yt_id]) cache.channels[s.yt_id] = prev.channels[s.yt_id]; // keep last good data
}

// --- which lists are needed: a channel's or playlist's videos are only read once a kid has it
const wanted = new Map(); // list id → { kind: 'uploads' | 'playlist', channelId?, shorts? }
for (const w of wigwams) {
  for (const s of w.sources) {
    if (!s.kids?.length || !s.yt_id) continue;
    if (s.kind === 'channel') { const shorts = shortsOf(w, s); wanted.set(uploadsList(s.yt_id, shorts), { kind: 'uploads', channelId: s.yt_id, shorts }); }
    if (s.kind === 'playlist') wanted.set(s.yt_id, { kind: 'playlist' });
  }
}

const pendingDetails = new Map(); // videoId → partial info from feeds (rss) or null (api)
const want = (id, info = null) => { if (!skipped.has(id) && !prev.videos[id]) pendingDetails.set(id, info); };

for (const [listId, how] of wanted) {
  const label = how.kind === 'uploads' ? `channel ${cache.channels[how.channelId]?.title || how.channelId}` : `playlist ${listId}`;
  const warnKey = how.kind === 'uploads' ? 'ch:' + how.channelId : 'pl:' + listId;
  const before = prev.lists[listId] || [];
  try {
    let fresh;
    if (how.kind === 'uploads') {
      const known = new Set(before);
      if (MODE === 'api') {
        try { fresh = await playlistIds(listId, FULL || !before.length ? null : known); }
        catch (e) {
          if (e.status !== 404 || how.shorts) throw e;
          warn(`${label}: no long-form playlist, using all uploads (Shorts filtered by length)`, warnKey);
          fresh = await playlistIds('UU' + how.channelId.slice(2), FULL || !before.length ? null : known);
          cache.shortFiltered[listId] = true;
        }
        fresh.forEach((id) => want(id));
      } else {
        const feed = await readFeed(`playlist_id=${listId}`);
        fresh = feed.entries.map((v) => v.id);
        feed.entries.forEach((v) => want(v.id, v));
      }
      cache.lists[listId] = [...new Set([...fresh, ...before])]; // newest first
      console.log(`  ✓ ${label} (${fresh.filter((id) => !known.has(id) && !skipped.has(id)).length} new)`);
    } else { // playlists are always read in full: their order can change
      let title = '', thumb = '', channelTitle = '', ids;
      if (MODE === 'api') {
        const pl = (await api('playlists', { part: 'snippet', id: listId })).items?.[0];
        if (!pl) throw new Error('playlist not found or private');
        ({ title, channelTitle } = pl.snippet);
        thumb = (pl.snippet.thumbnails.medium || pl.snippet.thumbnails.default)?.url || '';
        ids = await playlistIds(listId, null);
        ids.forEach((id) => want(id));
      } else {
        const feed = await readFeed(`playlist_id=${listId}`);
        title = feed.title; channelTitle = feed.entries[0]?.channelTitle || '';
        ids = [...new Set([...feed.entries.map((v) => v.id), ...before])]; // RSS shows only ~15
        feed.entries.forEach((v) => want(v.id, v));
      }
      cache.playlists[listId] = { title, channelTitle, thumb: thumb || (ids[0] ? `https://i.ytimg.com/vi/${ids[0]}/mqdefault.jpg` : '') };
      cache.lists[listId] = ids;
      console.log(`  ✓ ${label}: ${title} (${ids.length} videos)`);
    }
  } catch (e) {
    warn(`${label}: ${e.message}`, warnKey);
    if (prev.lists[listId]) cache.lists[listId] = prev.lists[listId];
    if (prev.shortFiltered[listId]) cache.shortFiltered[listId] = true;
    if (prev.playlists[listId]) cache.playlists[listId] = prev.playlists[listId];
  }
}

// Playlists no kid has yet: just their name and picture.
for (const s of wigwams.flatMap((w) => w.sources.filter((x) => x.kind === 'playlist'))) {
  if (cache.playlists[s.yt_id]) continue;
  if (prev.playlists[s.yt_id] && !FULL) { cache.playlists[s.yt_id] = prev.playlists[s.yt_id]; continue; }
  try {
    if (MODE === 'api') {
      const pl = (await api('playlists', { part: 'snippet', id: s.yt_id })).items?.[0];
      if (pl) cache.playlists[s.yt_id] = { title: pl.snippet.title, channelTitle: pl.snippet.channelTitle, thumb: (pl.snippet.thumbnails.medium || pl.snippet.thumbnails.default)?.url || '' };
    } else {
      const feed = await readFeed(`playlist_id=${s.yt_id}`);
      cache.playlists[s.yt_id] = { title: feed.title, channelTitle: feed.entries[0]?.channelTitle || '', thumb: feed.entries[0] ? `https://i.ytimg.com/vi/${feed.entries[0].id}/mqdefault.jpg` : '' };
    }
  } catch (e) { warn(`playlist ${s.yt_id}: ${e.message}`, 'pl:' + s.yt_id); }
}

// --- single videos
const singles = new Set();
for (const w of wigwams) for (const s of w.sources) if (s.kind === 'video' && s.yt_id) { singles.add(s.yt_id); want(s.yt_id, s.title ? { title: s.title } : null); }

// --- details for everything not seen before
const ids = [...pendingDetails.keys()];
if (ids.length) console.log(`  fetching details for ${ids.length} new videos…`);
if (MODE === 'api') {
  for (const batch of chunk(ids, 50)) {
    const res = await api('videos', { part: 'snippet,contentDetails,status', id: batch.join(','), maxResults: 50 });
    const got = new Map(res.items.map((v) => [v.id, v]));
    for (const id of batch) {
      const v = got.get(id);
      const ok = v && v.status.embeddable && v.status.privacyStatus !== 'private' && v.status.uploadStatus === 'processed' && v.snippet.liveBroadcastContent === 'none';
      if (!ok) { skipped.add(id); continue; }
      const sn = v.snippet;
      cache.videos[id] = { title: sn.title, channelId: sn.channelId, channelTitle: sn.channelTitle, publishedAt: sn.publishedAt, durationSec: isoDurationToSec(v.contentDetails.duration) };
      if (sn.tags?.length) tags[id] = sn.tags;
    }
  }
} else {
  for (const id of ids) {
    let info = pendingDetails.get(id);
    if (!info?.channelTitle) {
      try { // oEmbed also tells us the video exists and can be embedded
        const o = JSON.parse(await getText(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`));
        info = { ...info, title: info?.title || o.title, channelTitle: o.author_name };
      } catch (e) {
        if ([401, 403, 404].includes(e.status)) { skipped.add(id); continue; }
        warn(`video ${id}: ${e.message}`);
      }
    }
    cache.videos[id] = { title: info?.title || id, channelId: info?.channelId || null, channelTitle: info?.channelTitle || '', publishedAt: info?.publishedAt || null, durationSec: null };
  }
}

// Carry over details of known videos that are still used; forget the rest.
const referenced = new Set([...Object.values(cache.lists).flat(), ...singles]);
for (const id of referenced) if (!cache.videos[id] && prev.videos[id]) cache.videos[id] = prev.videos[id];
for (const key of Object.keys(cache.lists)) cache.lists[key] = cache.lists[key].filter((id) => cache.videos[id]);
for (const id of Object.keys(cache.videos)) if (!referenced.has(id)) delete cache.videos[id];
for (const id of Object.keys(tags)) if (!cache.videos[id]) delete tags[id];
cache.skipped = [...skipped];

if (!Object.keys(cache.videos).length && referenced.size) fail('No videos could be fetched. Check the API key and network. Nothing was changed.');

// ---------------------------------------------------------------- each wigwam's files

/** The video ids in a channel's or playlist's list, for this wigwam's Shorts setting. */
function listFor(w, s) {
  if (s.kind === 'playlist') return cache.lists[s.yt_id] || [];
  const listId = uploadsList(s.yt_id, shortsOf(w, s));
  const ids = cache.lists[listId] || [];
  return cache.shortFiltered[listId] ? ids.filter((id) => !(cache.videos[id]?.durationSec <= 180)) : ids;
}

function buildWigwam(w) {
  const settings = w.settings || {};
  const matchTerm = termMatcher(settings.blockedTerms || []);
  const allowAnyway = new Set(settings.allowAnyway || []);
  const catalog = {
    generatedAt: cache.generatedAt, mode: MODE, profiles: w.kids,
    channels: {}, playlists: {}, videos: {}, lists: {}, hidden: {}, byProfile: {}, hearts: w.hearts, warnings: [],
  };
  const channels = w.sources.filter((s) => s.kind === 'channel' && s.yt_id);
  const playlists = w.sources.filter((s) => s.kind === 'playlist' && s.yt_id);
  const videos = w.sources.filter((s) => s.kind === 'video' && s.yt_id);
  for (const s of channels) {
    const info = cache.channels[s.yt_id];
    if (!info) continue;
    catalog.channels[s.yt_id] = { id: s.yt_id, title: info.title, thumb: info.thumb, handle: info.handle, shorts: shortsOf(w, s) };
    if (s.kids.length) catalog.lists['ch:' + s.yt_id] = listFor(w, s);
  }
  for (const s of playlists) {
    const info = cache.playlists[s.yt_id];
    if (!info) continue;
    catalog.playlists[s.yt_id] = { id: s.yt_id, ...info };
    if (s.kids.length) catalog.lists['pl:' + s.yt_id] = listFor(w, s);
  }
  for (const id of new Set([...Object.values(catalog.lists).flat(), ...videos.map((s) => s.yt_id)])) if (cache.videos[id]) catalog.videos[id] = cache.videos[id];
  for (const s of w.sources) for (const msg of warnings.get((s.kind === 'channel' ? 'ch:' : 'pl:') + (s.yt_id || s.handle)) || []) catalog.warnings.push(msg);

  // Hidden videos stay in the lists (so un-hiding is instant) but are marked. Blocked words
  // apply to channels and playlists; single videos approved by hand are always shown.
  for (const id of new Set(Object.values(catalog.lists).flat())) {
    if (w.hidden.has(id)) { catalog.hidden[id] = 'blocked'; continue; }
    if (allowAnyway.has(id)) continue;
    const term = matchTerm(catalog.videos[id].title, tags[id]);
    if (term) catalog.hidden[id] = 'term:' + term;
  }
  const playable = (id) => catalog.videos[id] && !w.hidden.has(id);
  for (const k of w.kids) {
    const has = (s) => s.kids.includes(k.id);
    catalog.byProfile[k.id] = {
      channels: channels.filter((s) => has(s) && catalog.lists['ch:' + s.yt_id]).map((s) => s.yt_id),
      playlists: playlists.filter((s) => has(s) && catalog.lists['pl:' + s.yt_id]).map((s) => s.yt_id),
      videos: videos.filter((s) => has(s) && playable(s.yt_id)).map((s) => s.yt_id),
    };
  }

  // One small file per kid, with only what that kid can see.
  const kidFiles = {};
  const hearts = new Set(w.hearts);
  for (const k of w.kids) {
    const bp = catalog.byProfile[k.id];
    const visible = (ids) => ids.filter((id) => !catalog.hidden[id]);
    const kid = { profiles: [k], byProfile: { [k.id]: bp }, channels: {}, playlists: {}, lists: {}, hidden: {}, videos: {}, hearts: [] };
    const add = (id) => { const v = catalog.videos[id]; kid.videos[id] = { title: v.title, ...(v.durationSec && { durationSec: v.durationSec }) }; };
    for (const id of bp.channels) { const { title, thumb } = catalog.channels[id]; kid.channels[id] = { title, thumb }; kid.lists['ch:' + id] = visible(catalog.lists['ch:' + id]); kid.lists['ch:' + id].forEach(add); }
    for (const id of bp.playlists) { const { title, thumb } = catalog.playlists[id]; kid.playlists[id] = { title, thumb }; kid.lists['pl:' + id] = visible(catalog.lists['pl:' + id]); kid.lists['pl:' + id].forEach(add); }
    bp.videos.forEach(add);
    kid.hearts = Object.keys(kid.videos).filter((id) => hearts.has(id));
    const json = JSON.stringify(kid);
    const version = sha(json);
    kidFiles[k.id] = { version, json: JSON.stringify({ version, ...kid }) };
  }
  return { catalog, kidFiles };
}

async function publish(w, { catalog, kidFiles }) {
  const adminJson = JSON.stringify(catalog);
  const index = {
    generatedAt: cache.generatedAt, wigwam: w.name, profiles: w.kids,
    versions: Object.fromEntries(Object.entries(kidFiles).map(([k, f]) => [k, f.version])),
    adminVersion: sha(adminJson.replace(/"generatedAt":"[^"]*"/, '')),
  };
  if (LOCAL) {
    const dir = path.join(ROOT, '.build', w.id);
    await mkdir(path.join(dir, 'kids'), { recursive: true });
    await mkdir(path.join(dir, 'admin'), { recursive: true });
    await writeFile(path.join(dir, 'admin', 'catalog.json'), adminJson);
    for (const [k, f] of Object.entries(kidFiles)) await writeFile(path.join(dir, 'kids', `${k}.${f.version}.json`), f.json);
    await writeFile(path.join(dir, 'index.json'), JSON.stringify(index));
    return;
  }
  const before = await db.getJson('feeds', `${w.id}/index.json`);
  let changed = 0;
  for (const [k, f] of Object.entries(kidFiles)) {
    if (before?.versions?.[k] === f.version) continue;
    await db.putJson('feeds', `${w.id}/kids/${k}.${f.version}.json`, f.json, 'max-age=31536000, immutable');
    changed++;
  }
  // The grown-ups' page always gets the latest (it shows when the build ran and any problems).
  await db.putJson('feeds', `${w.id}/admin/catalog.json`, adminJson);
  if (JSON.stringify({ ...before, generatedAt: 0 }) !== JSON.stringify({ ...index, generatedAt: 0 })) await db.putJson('feeds', `${w.id}/index.json`, index);
  const current = new Set(Object.entries(kidFiles).map(([k, f]) => `${k}.${f.version}.json`));
  const stale = (await db.list('feeds', `${w.id}/kids/`)).map((o) => o.name).filter((n) => !current.has(n));
  await db.remove('feeds', stale.map((n) => `${w.id}/kids/${n}`));
  await db.update('wigwams', `id=eq.${w.id}`, { built_at: new Date().toISOString() });
  console.log(`  ✓ wigwam ${w.name}: ${w.kids.length} kids, ${Object.keys(catalog.videos).length} videos${changed ? `, ${changed} kid file(s) updated` : ''}`);
}

for (const w of wigwams) await publish(w, buildWigwam(w));

// Remember what the builder learned about each approved thing (for the grown-ups' page and friends).
if (!LOCAL) {
  for (const s of wigwams.flatMap((w) => w.sources)) {
    const info = s.kind === 'playlist' ? cache.playlists[s.yt_id] : s.kind === 'video' ? cache.videos[s.yt_id] && { title: cache.videos[s.yt_id].title } : null;
    if (info) learn(s, { title: info.title, thumb: info.thumb || (s.kind === 'video' ? `https://i.ytimg.com/vi/${s.yt_id}/mqdefault.jpg` : null) });
  }
  for (const [id, patch] of sourceUpdates) await db.update('sources', `id=eq.${id}`, patch);
  if (sourceUpdates.size) console.log(`  updated ${sourceUpdates.size} channel/playlist names`);
}

// Save the shared cache last, so a run that failed halfway starts from the last good one.
if (LOCAL) {
  await mkdir(path.join(ROOT, '.build'), { recursive: true });
  await writeFile(path.join(ROOT, '.build', 'cache.json'), JSON.stringify({ ...cache, tags: undefined }));
} else {
  await db.putJson('cache', 'catalog.json', { ...cache, tags: undefined });
  await db.putJson('cache', 'tags.json', tags);
}

// ---------------------------------------------------------------- connected YouTube accounts

async function syncYouTube() {
  const secret = process.env.GOOGLE_CLIENT_SECRET?.trim();
  if (!secret || !GOOGLE_CLIENT_ID) { console.log('  (YouTube accounts not synced: GOOGLE_CLIENT_SECRET or GOOGLE_CLIENT_ID missing)'); return; }
  const accounts = await db.all('yt_accounts', 'select=id,title,auto_sync,synced_at');
  const tokens = new Map((await db.all('yt_tokens', 'select=account_id,refresh_token')).map((t) => [t.account_id, t.refresh_token]));
  for (const a of accounts) {
    if (!a.auto_sync && a.synced_at) continue; // auto-sync off: only the first import
    const refresh = tokens.get(a.id);
    if (!refresh) continue;
    try {
      const res = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        body: new URLSearchParams({ client_id: GOOGLE_CLIENT_ID, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' }),
      });
      const tok = await res.json();
      if (!res.ok) {
        const gone = tok.error === 'invalid_grant';
        await db.update('yt_accounts', `id=eq.${a.id}`, { sync_error: gone ? 'YouTube access was removed or expired. Connect it again.' : `Google: ${tok.error_description || tok.error}` });
        continue;
      }
      const token = tok.access_token;
      const rows = [];
      const pages = async (endpoint, params, max, each) => {
        let pageToken;
        for (let n = 0; n < max; n++) {
          const page = await api(endpoint, { ...params, maxResults: 50, pageToken }, token);
          page.items.forEach(each);
          pageToken = page.nextPageToken;
          if (!pageToken) break;
        }
      };
      const thumb = (t) => (t?.medium || t?.default)?.url || null;
      await pages('subscriptions', { part: 'snippet', mine: 'true', order: 'alphabetical' }, 20, (i) => rows.push({
        account_id: a.id, kind: 'channel', yt_id: i.snippet.resourceId.channelId, title: i.snippet.title, thumb: thumb(i.snippet.thumbnails), reason: 'subscription' }));
      await pages('playlists', { part: 'snippet', mine: 'true' }, 10, (i) => rows.push({
        account_id: a.id, kind: 'playlist', yt_id: i.id, title: i.snippet.title, thumb: thumb(i.snippet.thumbnails), channel_title: i.snippet.channelTitle, reason: 'playlist' }));
      try {
        await pages('playlistItems', { part: 'snippet', playlistId: 'LL' }, 4, (i) => i.snippet.resourceId?.videoId && rows.push({
          account_id: a.id, kind: 'video', yt_id: i.snippet.resourceId.videoId, title: i.snippet.title, thumb: thumb(i.snippet.thumbnails), channel_title: i.snippet.videoOwnerChannelTitle || null, reason: 'liked' }));
      } catch (e) { if (e.status !== 404 && e.status !== 403) throw e; } // likes can be private or missing
      const unique = [...new Map(rows.map((r) => [`${r.kind}:${r.yt_id}`, r])).values()];
      for (const batch of chunk(unique, 500)) await db.insertNew('yt_inbox', batch);
      await db.update('yt_accounts', `id=eq.${a.id}`, { synced_at: new Date().toISOString(), sync_error: null });
      console.log(`  ✓ YouTube ${a.title}: ${unique.length} subscriptions, playlists and likes checked`);
    } catch (e) {
      console.warn(`⚠ YouTube ${a.title}: ${e.message}`);
      await db.update('yt_accounts', `id=eq.${a.id}`, { sync_error: e.message.slice(0, 300) });
    }
  }
}
if (!LOCAL) await syncYouTube();

console.log(`Done: ${wigwams.length} wigwam(s), ${Object.keys(cache.videos).length} videos in the shared cache, ${apiCalls} requests, ${[...warnings.values()].flat().length} warnings.`);
