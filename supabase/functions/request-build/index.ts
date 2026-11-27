// Starts the "Build video lists" GitHub workflow, so the kids' app picks up a grown-up's
// changes about a minute after they publish. Only grown-ups who belong to a wigwam can call it.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   WIGWAM_GITHUB_TOKEN   fine-grained GitHub token for the wigwam repo with Actions: Read and write

import { createClient } from 'npm:@supabase/supabase-js@2';

const REPO = 'danielslloyd/wigwam';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

async function startBuild() {
  const res = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/build.yml/dispatches`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${Deno.env.get('WIGWAM_GITHUB_TOKEN')}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'wigwam',
    },
    body: JSON.stringify({ ref: 'master' }),
  });
  if (!res.ok) throw new Error(`GitHub said ${res.status}: ${(await res.text()).slice(0, 200)}`);
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const sb = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: { user } } = await sb.auth.getUser();
    if (!user || user.is_anonymous) return json({ error: 'Sign in first.' }, 401);
    const { count } = await sb.from('members').select('wigwam_id', { count: 'exact', head: true }).eq('user_id', user.id);
    if (!count) return json({ error: "You aren't in a wigwam yet." }, 403);
    await startBuild();
    return json({ ok: true });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
