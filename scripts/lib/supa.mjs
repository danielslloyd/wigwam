// Tiny Supabase client for the builder (no dependencies): database rows through the
// REST API and files through the Storage API, with the project's secret key.

export function supa(url, key) {
  // New-style secret keys go in the apikey header only; old JWT keys also as a bearer token.
  const auth = { apikey: key, ...(key.startsWith('eyJ') && { Authorization: `Bearer ${key}` }) };

  async function call(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
    const res = await fetch(url + path, {
      method,
      headers: { ...auth, ...(body !== undefined && !raw && { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) { const e = new Error(`${method} ${path.split('?')[0]} → ${res.status} ${text.slice(0, 300)}`); e.status = res.status; e.body = text; throw e; }
    return text && res.headers.get('content-type')?.includes('json') ? JSON.parse(text) : text;
  }

  return {
    /** Every row of a table (pages through the 1000-row limit). */
    async all(table, query = 'select=*') {
      const out = [];
      for (let from = 0; ; from += 1000) {
        const rows = await call(`/rest/v1/${table}?${query}`, { headers: { Range: `${from}-${from + 999}`, 'Range-Unit': 'items' } });
        out.push(...rows);
        if (rows.length < 1000) return out;
      }
    },
    update: (table, filter, patch) => call(`/rest/v1/${table}?${filter}`, { method: 'PATCH', body: patch, headers: { Prefer: 'return=minimal' } }),
    /** Insert rows, skipping ones whose primary key already exists. */
    insertNew: (table, rows) => rows.length && call(`/rest/v1/${table}`, { method: 'POST', body: rows, headers: { Prefer: 'resolution=ignore-duplicates,return=minimal' } }),

    /** A JSON file from storage, or null if it isn't there. */
    async getJson(bucket, path) {
      try { const t = await call(`/storage/v1/object/${bucket}/${path}`); return typeof t === 'string' ? JSON.parse(t) : t; }
      catch (e) { if (e.status === 400 || e.status === 404) return null; throw e; }
    },
    putJson: (bucket, path, data, cacheControl = 'no-cache') => call(`/storage/v1/object/${bucket}/${path}`, {
      method: 'POST', raw: true, body: typeof data === 'string' ? data : JSON.stringify(data),
      headers: { 'Content-Type': 'application/json', 'x-upsert': 'true', 'cache-control': cacheControl },
    }),
    async list(bucket, prefix) {
      return call(`/storage/v1/object/list/${bucket}`, { method: 'POST', body: { prefix, limit: 1000 } });
    },
    remove: (bucket, paths) => paths.length && call(`/storage/v1/object/${bucket}`, { method: 'DELETE', body: { prefixes: paths } }),
  };
}
