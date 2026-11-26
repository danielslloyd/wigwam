#!/usr/bin/env node
// Builds data/catalog.json from data/whitelist.json.
//
//   node scripts/build-catalog.mjs          incremental update
//   node scripts/build-catalog.mjs --full   re-fetch everything from scratch
//
// With YOUTUBE_API_KEY set it uses the YouTube Data API v3 (complete channel
// history, durations, embeddability). Without a key it falls back to YouTube's
// public RSS feeds, which only list each channel's ~15 newest videos; the
// catalog still grows over time because each run merges with the previous one.
//
// Shorts: unless allowed (settings.allowShorts, or "shorts": true on a channel),
// a channel is read through its "UULF" playlist (long-form uploads only)
// instead of its full "UU" uploads playlist.
//
// Blocked words (settings.blockedTerms) are checked against each video's title
// (and tags, in API mode). Matching videos are marked in catalog.hidden.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { termMatcher } from '../shared.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const WHITELIST = path.join(ROOT, 'data', 'whitelist.json');
const CATALOG = path.join(ROOT, 'data', 'catalog.json');
const TAGS = path.join(ROOT, 'data', 'tags.json');

const KEY = process.env.YOUTUBE_API_KEY?.trim();
const FULL = process.argv.includes('--full');
const MODE = KEY ? 'api' : 'rss';
const UA = 'Mozilla/5.0 (compatible; Tellybox catalog builder)';

const warnings = [];
let apiCalls = 0;
const warn = (msg) => { warnings.push(msg); console.warn('⚠ ' + msg); };

// ---------------------------------------------------------------- helpers

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (e) { if (e.code === 'ENOENT') return fallback; throw e; }
}

const chunk = (arr, n) => Array.from({ length: Math.ceil(arr.length / n) }, (_, i) => arr.slice(i * n, i * n + n));

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

async function api(endpoint, params) {
  const url = new URL('https://www.googleapis.com/youtube/v3/' + endpoint);
  for (const [k, v] of Object.entries({ ...params, key: KEY })) if (v != null) url.searchParams.set(k, v);
  apiCalls++;
  const res = await fetch(url);
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

// Find a channel's ID, title and avatar from its public page (works for any URL form).
async function scrapeChannel(url) {
  const html = await getText(url);
  const id = /"externalId":"(UC[\w-]{22})"/.exec(html)?.[1]
    || /<link rel="canonical" href="https:\/\/www\.youtube\.com\/channel\/(UC[\w-]{22})"/.exec(html)?.[1];
  if (!id) throw new Error(`couldn't find a channel ID on ${url}`);
  const title = decodeEntities(/<meta property="og:title" content="([^"]*)"/.exec(html)?.[1] || '');
  const thumb = /<meta property="og:image" content="([^"]*)"/.exec(html)?.[1] || '';
  return { id, title, thumb: thumb.replace(/=s\d+-/, '=s240-') };
}

function channelPageUrl(entry) {
  if (entry.id) return `https://www.youtube.com/channel/${entry.id}`;
  if (entry.handle) return `https://www.youtube.com/${entry.handle.startsWith('@') ? entry.handle : '@' + entry.handle}`;
  if (entry.username) return `https://www.youtube.com/user/${entry.username}`;
  if (entry.url) return entry.url;
  throw new Error('channel entry has no id, handle, username or url');
}

// RSS feed → [{ id, title, publishedAt }] (newest first, max ~15)
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

// ---------------------------------------------------------------- API mode

async function apiResolveChannel(entry) {
  const params = { part: 'snippet,contentDetails' };
  if (entry.id) params.id = entry.id;
  else if (entry.handle) params.forHandle = entry.handle.startsWith('@') ? entry.handle : '@' + entry.handle;
  else if (entry.username) params.forUsername = entry.username;
  else return { ...(await scrapeChannel(entry.url)) }; // /c/ custom URLs have no API lookup
  const item = (await api('channels', params)).items?.[0];
  if (!item) throw new Error(`channel not found (${entry.handle || entry.id || entry.username})`);
  const t = item.snippet.thumbnails;
  return { id: item.id, title: item.snippet.title, thumb: (t.medium || t.default)?.url || '' };
}

// Page through a playlist. If `known` is given, stop at the first page that
// contains an already-known video (incremental mode).
async function apiPlaylistIds(playlistId, known) {
  const ids = [];
  let pageToken;
  do {
    const page = await api('playlistItems', { part: 'contentDetails', playlistId, maxResults: 50, pageToken });
    const pageIds = page.items.map((i) => i.contentDetails.videoId);
    ids.push(...pageIds);
    if (known && pageIds.some((id) => known.has(id))) break;
    pageToken = page.nextPageToken;
  } while (pageToken);
  return ids;
}

async function apiVideoDetails(ids) {
  const out = new Map();
  for (const batch of chunk(ids, 50)) {
    const res = await api('videos', { part: 'snippet,contentDetails,status', id: batch.join(','), maxResults: 50 });
    for (const v of res.items) out.set(v.id, v);
  }
  return out; // ids missing from the map are deleted/private
}

// ---------------------------------------------------------------- main

const whitelist = await readJson(WHITELIST);
if (!whitelist) throw new Error('data/whitelist.json is missing');
for (const k of ['profiles', 'channels', 'playlists', 'videos', 'blocked']) whitelist[k] ??= [];
const settings = whitelist.settings ?? {};
const allowShortsDefault = !!settings.allowShorts;
const matchTerm = termMatcher(settings.blockedTerms || []);
const allowAnyway = new Set(settings.allowAnyway || []);

const prev = FULL ? {} : await readJson(CATALOG, {});
const prevVideos = prev.videos || {};
const prevLists = prev.lists || {};
const skipped = new Set(FULL ? [] : prev.skipped || []); // non-embeddable / private / live — don't re-check
const blocked = new Set(whitelist.blocked);
const tags = await readJson(TAGS, {}); // videoId → tags (API mode only), used for blocked-word matching

const catalog = {
  generatedAt: new Date().toISOString(),
  mode: MODE,
  profiles: whitelist.profiles,
  channels: {},
  playlists: {},
  videos: {},
  lists: {},     // every playable video per channel/playlist, newest first
  hidden: {},    // videoId → why the kids can't see it: "blocked" or "term:<word>"
  byProfile: {},
  skipped: [],
  warnings,
};

console.log(`Building catalog in ${MODE.toUpperCase()} mode${FULL ? ' (full rebuild)' : ''}…`);
if (MODE === 'rss') console.log('  (no YOUTUBE_API_KEY: only each channel\'s newest ~15 videos are visible per run)');

const pendingDetails = new Map(); // videoId → partial info from feeds (rss) or null (api)
// Blocked videos still get fetched, so un-hiding one later brings it straight back.
const want = (id, info = null) => { if (!skipped.has(id) && !prevVideos[id]) pendingDetails.set(id, info); };

// --- channels
for (const entry of whitelist.channels) {
  const label = entry.handle || entry.id || entry.username || entry.url;
  // A channel no kid has been given yet: look up its name and picture once (for the
  // grown-ups page), but don't fetch its videos, so the kids' catalog stays small.
  const unassigned = !(entry.profiles || []).length;
  if (unassigned && entry.id && prev.channels?.[entry.id]) {
    catalog.channels[entry.id] = prev.channels[entry.id];
    continue;
  }
  try {
    const ch = MODE === 'api' ? await apiResolveChannel(entry) : await scrapeChannel(channelPageUrl(entry));
    entry.id = ch.id;
    if (ch.title) entry.title = ch.title;
    // Shorts: per-channel "shorts": true/false overrides settings.allowShorts
    const shorts = typeof entry.shorts === 'boolean' ? entry.shorts : allowShortsDefault;
    catalog.channels[ch.id] = { id: ch.id, title: ch.title, thumb: ch.thumb, handle: entry.handle || null, shorts };
    if (unassigned) { console.log(`  · channel ${ch.title} (no kids yet: videos not fetched)`); continue; }

    const key = 'ch:' + ch.id;
    // If the Shorts setting changed since last time, start this channel's list afresh.
    const sameShorts = (prev.channels?.[ch.id]?.shorts ?? false) === shorts;
    const before = sameShorts ? prevLists[key] || [] : [];
    const known = new Set(before);
    // UULF… = long-form uploads only (no Shorts, no live); UU… = every upload.
    const uploads = (shorts ? 'UU' : 'UULF') + ch.id.slice(2);
    let fresh;
    if (MODE === 'api') {
      try {
        fresh = await apiPlaylistIds(uploads, FULL || !before.length ? null : known);
      } catch (e) {
        if (e.status !== 404 || shorts) throw e;
        warn(`${label}: no long-form playlist, using all uploads (Shorts filtered by length)`);
        fresh = await apiPlaylistIds('UU' + ch.id.slice(2), FULL || !before.length ? null : known);
        entry._filterShort = true;
      }
      fresh.forEach((id) => want(id));
    } else {
      const feed = await readFeed(`playlist_id=${uploads}`);
      fresh = feed.entries.map((v) => v.id);
      feed.entries.forEach((v) => want(v.id, v));
    }
    // newest first: fresh items, then anything we knew about before
    catalog.lists[key] = [...new Set([...fresh, ...before])];
    console.log(`  ✓ channel ${ch.title} (${fresh.filter((id) => !known.has(id) && !skipped.has(id) && !blocked.has(id)).length} new)`);
  } catch (e) {
    warn(`channel ${label}: ${e.message}`);
    if (entry.id && prevLists['ch:' + entry.id]) { // keep last good data
      catalog.lists['ch:' + entry.id] = prevLists['ch:' + entry.id];
      catalog.channels[entry.id] = prev.channels?.[entry.id];
    }
  }
}

// --- playlists (always fetched in full: order can change)
for (const entry of whitelist.playlists) {
  try {
    let title = '', thumb = '', channelTitle = '', ids;
    if (MODE === 'api') {
      const pl = (await api('playlists', { part: 'snippet', id: entry.id })).items?.[0];
      if (!pl) throw new Error('playlist not found or private');
      title = pl.snippet.title; channelTitle = pl.snippet.channelTitle;
      thumb = (pl.snippet.thumbnails.medium || pl.snippet.thumbnails.default)?.url || '';
      ids = await apiPlaylistIds(entry.id, null);
      ids.forEach((id) => want(id));
    } else {
      const feed = await readFeed(`playlist_id=${entry.id}`);
      title = feed.title; ids = feed.entries.map((v) => v.id);
      feed.entries.forEach((v) => want(v.id, v));
      channelTitle = feed.entries[0]?.channelTitle || '';
      // RSS shows only the first ~15 items; keep any we saw on earlier runs
      ids = [...new Set([...ids, ...(prevLists['pl:' + entry.id] || [])])];
    }
    if (title) entry.title = title;
    catalog.playlists[entry.id] = { id: entry.id, title, channelTitle, thumb: thumb || (ids[0] ? `https://i.ytimg.com/vi/${ids[0]}/mqdefault.jpg` : '') };
    catalog.lists['pl:' + entry.id] = ids;
    console.log(`  ✓ playlist ${title} (${ids.length} videos)`);
  } catch (e) {
    warn(`playlist ${entry.id}: ${e.message}`);
    if (prevLists['pl:' + entry.id]) {
      catalog.lists['pl:' + entry.id] = prevLists['pl:' + entry.id];
      catalog.playlists[entry.id] = prev.playlists?.[entry.id];
    }
  }
}

// --- individually approved videos
for (const entry of whitelist.videos) want(entry.id, entry.title ? { title: entry.title } : null);

// --- details for everything we haven't seen before
const ids = [...pendingDetails.keys()];
if (ids.length) console.log(`  fetching details for ${ids.length} new videos…`);
const filterShortChannels = new Set(whitelist.channels.filter((c) => c._filterShort).map((c) => c.id));

if (MODE === 'api') {
  const details = await apiVideoDetails(ids);
  for (const id of ids) {
    const v = details.get(id);
    if (!v) { skipped.add(id); continue; }
    const s = v.status, sn = v.snippet;
    const durationSec = isoDurationToSec(v.contentDetails.duration);
    const ok = s.embeddable && s.privacyStatus !== 'private' && s.uploadStatus === 'processed'
      && sn.liveBroadcastContent === 'none'
      && !(filterShortChannels.has(sn.channelId) && durationSec != null && durationSec <= 180);
    if (!ok) { skipped.add(id); continue; }
    catalog.videos[id] = { title: sn.title, channelId: sn.channelId, channelTitle: sn.channelTitle, publishedAt: sn.publishedAt, durationSec };
    if (sn.tags?.length) tags[id] = sn.tags;
  }
} else {
  for (const id of ids) {
    let info = pendingDetails.get(id);
    if (!info?.channelTitle) {
      try { // oEmbed also tells us the video exists and is embeddable
        const o = JSON.parse(await getText(`https://www.youtube.com/oembed?format=json&url=${encodeURIComponent('https://www.youtube.com/watch?v=' + id)}`));
        info = { ...info, title: info?.title || o.title, channelTitle: o.author_name };
      } catch (e) {
        if (e.status === 401 || e.status === 403 || e.status === 404) { skipped.add(id); continue; }
        warn(`video ${id}: ${e.message}`);
      }
    }
    catalog.videos[id] = { title: info?.title || id, channelId: info?.channelId || null, channelTitle: info?.channelTitle || '', publishedAt: info?.publishedAt || null, durationSec: null };
  }
}

// carry over details of previously known videos that are still referenced
const referenced = new Set([...Object.values(catalog.lists).flat(), ...whitelist.videos.map((v) => v.id)]);
for (const id of referenced) if (!catalog.videos[id] && prevVideos[id]) catalog.videos[id] = prevVideos[id];

// drop skipped videos / ones without details; forget videos nothing refers to
for (const key of Object.keys(catalog.lists)) catalog.lists[key] = catalog.lists[key].filter((id) => catalog.videos[id]);
for (const id of Object.keys(catalog.videos)) if (!referenced.has(id)) delete catalog.videos[id];
for (const id of Object.keys(tags)) if (!catalog.videos[id]) delete tags[id];

// Hidden videos stay in the lists (so un-hiding is instant) but are marked, and
// the kids' app leaves them out. Blocked words apply to channels and playlists;
// single videos you approved by hand are always shown.
const inChannelsOrPlaylists = new Set(Object.values(catalog.lists).flat());
let termHits = 0;
for (const id of inChannelsOrPlaylists) {
  if (blocked.has(id)) { catalog.hidden[id] = 'blocked'; continue; }
  if (allowAnyway.has(id)) continue;
  const term = matchTerm(catalog.videos[id].title, tags[id]);
  if (term) { catalog.hidden[id] = 'term:' + term; termHits++; }
}
if (termHits) console.log(`  ${termHits} videos hidden by blocked words`);
const playable = (id) => catalog.videos[id] && !blocked.has(id);

// --- per-profile view
for (const p of whitelist.profiles) {
  const has = (e) => (e.profiles || []).includes(p.id);
  catalog.byProfile[p.id] = {
    channels: whitelist.channels.filter((c) => has(c) && catalog.lists['ch:' + c.id]).map((c) => c.id),
    playlists: whitelist.playlists.filter((pl) => has(pl) && catalog.lists['pl:' + pl.id]).map((pl) => pl.id),
    videos: whitelist.videos.filter((v) => has(v) && playable(v.id)).map((v) => v.id),
  };
}

catalog.skipped = [...skipped];

// Bail out before writing if nothing usable came back (e.g. bad API key, no
// network), so the previous catalog stays live.
const total = Object.keys(catalog.videos).length;
if (!total && (whitelist.channels.length || whitelist.videos.length || whitelist.playlists.length)) {
  console.error('No videos could be fetched. Check the API key / network. Catalog left unchanged.');
  process.exit(1);
}

// --- write files (whitelist only if something was resolved/changed)
for (const c of whitelist.channels) delete c._filterShort;
const wlOut = JSON.stringify(whitelist, null, 2) + '\n';
if (wlOut !== (await readFile(WHITELIST, 'utf8'))) await writeFile(WHITELIST, wlOut);
await writeFile(CATALOG, JSON.stringify(catalog) + '\n');
await writeFile(TAGS, JSON.stringify(tags) + '\n');

console.log(`Done: ${total} videos, ${Object.keys(catalog.channels).length} channels, ${apiCalls} requests, ${warnings.length} warnings.`);
