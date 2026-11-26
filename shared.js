// Small helpers shared by the kid app and the admin page.

export async function loadCatalog() {
  // GitHub Pages caches files for ~10 minutes; the query string skips that.
  const res = await fetch(`data/catalog.json?t=${Date.now()}`, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Couldn't load the video list (HTTP ${res.status})`);
  return res.json();
}

export const thumbUrl = (id, size = 'mqdefault') => `https://i.ytimg.com/vi/${encodeURIComponent(id)}/${size}.jpg`;

export function fmtDuration(sec) {
  if (sec == null || !isFinite(sec)) return '';
  sec = Math.max(0, Math.round(sec));
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
  const ss = String(s).padStart(2, '0');
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

// ---------------------------------------------------------------- blocked words
//
// Starter list offered on the admin page. Matching is whole-word and
// case/accent-insensitive, so "kill" does not block "skill". A * matches any
// word ending ("prank*" blocks "pranks" and "pranking"), and spaces in a phrase
// also match hyphens ("jump scare" blocks "jump-scare").
export const SUGGESTED_TERMS = [
  'scary', 'scariest', 'horror', 'creepy', 'creepiest', 'jumpscare*', 'jump scare*', 'creepypasta',
  'demon', 'demons', 'zombie*', 'gore', 'gory', 'blood', 'bloody',
  'kill', 'kills', 'killed', 'killing', 'murder*', 'gun', 'guns', 'weapon*',
  'prank*', 'sexy', 'sex', 'nsfw', '18+', 'drunk', 'beer', 'swear*',
  'fnaf', 'five nights at freddy*', 'huggy wuggy', 'poppy playtime', 'rainbow friends', 'siren head',
  'skibidi', 'momo challenge', 'backrooms', 'brainrot',
];

const normText = (s) => String(s ?? '').normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
const reEscape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function normalizeTerms(terms) {
  return [...new Set((terms || []).map((t) => normText(t).trim().replace(/\s+/g, ' ')).filter(Boolean))];
}

/** Returns (…texts) => the first blocked term found in the texts, or null. */
export function termMatcher(terms) {
  const compiled = normalizeTerms(terms).map((t) => {
    const body = t.split('*').map((part) => part.split(' ').map(reEscape).join('[\\s\\-_.]+')).join('[\\p{L}\\p{N}]*');
    return [t, new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'u')];
  });
  if (!compiled.length) return () => null;
  return (...texts) => {
    const s = normText(texts.flat().filter(Boolean).join(' \n '));
    for (const [t, re] of compiled) if (re.test(s)) return t;
    return null;
  };
}

export function timeAgo(iso) {
  if (!iso) return '';
  const s = (Date.now() - new Date(iso).getTime()) / 1000;
  const units = [[31536000, 'year'], [2592000, 'month'], [604800, 'week'], [86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [n, name] of units) if (s >= n) { const v = Math.floor(s / n); return `${v} ${name}${v > 1 ? 's' : ''} ago`; }
  return 'just now';
}
