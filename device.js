// The kids' device: an anonymous sign-in that a grown-up pairs with their wigwam.
// It can read only that wigwam's kid files, and it never sends anything about what
// the kids watch: watch history and kids' hearts stay in this device's storage.

import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.2/+esm';
import { SUPABASE_URL, SUPABASE_KEY } from './config.js';

export const sb = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { storageKey: 'wigwam-device', persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

const LAST_INDEX = 'wigwam-device:index';
const FEED_CACHE = 'wigwam-feed';

/** Signs in anonymously the first time. Returns the user id. */
export async function ensureSignedIn() {
  const { data } = await sb.auth.getSession();
  if (data.session) return data.session.user.id;
  const { data: d, error } = await sb.auth.signInAnonymously();
  if (error) throw error;
  return d.user.id;
}

/** The wigwam this device is paired with, or null. */
export async function pairedWigwam() {
  const { data, error } = await sb.from('devices').select('wigwam_id, name').maybeSingle();
  if (error) throw error;
  return data?.wigwam_id || null;
}

const ALPHABET = 'ACDEFHJKMNPRTUVWXY3479'; // no look-alikes (0/O, 1/I, 5/S, 8/B…)
/** Puts a fresh code on record for this device and returns it. */
export async function newPairCode() {
  const { data: { session } } = await sb.auth.getSession();
  for (let tries = 0; tries < 5; tries++) {
    const bytes = crypto.getRandomValues(new Uint8Array(6));
    const code = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]).join('');
    await sb.from('pair_codes').delete().eq('user_id', session.user.id);
    const { error } = await sb.from('pair_codes').insert({ code, user_id: session.user.id });
    if (!error) return code;
  }
  throw new Error("Couldn't make a pairing code. Check the internet connection.");
}

async function fetchFeed(path, init = {}) {
  const { data: { session } } = await sb.auth.getSession();
  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/authenticated/feeds/${path}`, {
    ...init,
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${session?.access_token}` },
  });
  if (!res.ok) { const e = new Error(`Couldn't load the video list (HTTP ${res.status})`); e.status = res.status; throw e; }
  return res;
}

/** The kids and the current version of each kid's list. Tiny, so always fetched fresh;
 *  the last copy is kept for when the device is offline. */
export async function loadIndex(wigwam) {
  try {
    const index = await (await fetchFeed(`${wigwam}/index.json?t=${Date.now()}`, { cache: 'no-store' })).json();
    localStorage.setItem(LAST_INDEX, JSON.stringify({ wigwam, index }));
    return index;
  } catch (e) {
    const last = JSON.parse(localStorage.getItem(LAST_INDEX) || 'null');
    if (last?.wigwam === wigwam && !e.status) return last.index; // offline
    throw e;
  }
}

/** One kid's channels and videos. Each version is a separate file that never changes,
 *  so a downloaded copy is reused until the grown-ups change something. */
export async function loadKid(wigwam, kid, version) {
  const key = `https://wigwam.feed/${wigwam}/${kid}.${version}.json`;
  const cache = await caches.open(FEED_CACHE).catch(() => null);
  const hit = await cache?.match(key);
  if (hit) return hit.json();
  const res = await fetchFeed(`${wigwam}/kids/${encodeURIComponent(kid)}.${version}.json`);
  const json = await res.json();
  if (cache) {
    for (const old of await cache.keys()) if (old.url.startsWith(`https://wigwam.feed/${wigwam}/${kid}.`)) await cache.delete(old);
    await cache.put(key, new Response(JSON.stringify(json), { headers: { 'Content-Type': 'application/json' } }));
  }
  return json;
}

/** Forget this device's pairing and saved lists (when a grown-up removes it). */
export async function forgetFeeds() {
  localStorage.removeItem(LAST_INDEX);
  await caches.delete(FEED_CACHE).catch(() => {});
}
