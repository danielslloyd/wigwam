// Connects a grown-up's YouTube channel. The grown-ups' page sends the one-time code
// Google gave it; this swaps it for a refresh token (which needs the client secret, so it
// can't happen in the browser), stores that token where only the server can read it,
// and starts a build, which imports the channel's subscriptions, playlists and liked
// videos into the grown-up's inbox. Nothing is approved for the kids automatically.
//
// Secrets (Supabase → Edge Functions → Secrets):
//   GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET   the Google OAuth client
//   WIGWAM_GITHUB_TOKEN                      as for request-build

import { createClient } from 'npm:@supabase/supabase-js@2';

const REPO = 'danielslloyd/wigwam';
const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json' } });

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const asUser = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, {
      global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } },
    });
    const { data: { user } } = await asUser.auth.getUser();
    if (!user || user.is_anonymous) return json({ error: 'Sign in first.' }, 401);

    const { code, redirect_uri } = await req.json();
    if (!code || !/^https?:\/\/[^ ]+$/.test(redirect_uri ?? '')) return json({ error: 'Missing code.' }, 400);

    // 1. The code → tokens
    const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST',
      body: new URLSearchParams({
        code, redirect_uri, grant_type: 'authorization_code',
        client_id: Deno.env.get('GOOGLE_CLIENT_ID')!, client_secret: Deno.env.get('GOOGLE_CLIENT_SECRET')!,
      }),
    });
    const tok = await tokenRes.json();
    if (!tokenRes.ok) return json({ error: `Google: ${tok.error_description || tok.error}` }, 400);

    // 2. Which channel did they pick?
    const chRes = await fetch('https://www.googleapis.com/youtube/v3/channels?part=snippet&mine=true', {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    });
    const ch = (await chRes.json()).items?.[0];
    if (!ch) return json({ error: "That Google account doesn't have a YouTube channel." }, 400);

    // 3. Remember it (the token only where the server can read it)
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
    const thumbs = ch.snippet.thumbnails ?? {};
    const { data: account, error } = await admin.from('yt_accounts').upsert({
      user_id: user.id, channel_id: ch.id, title: ch.snippet.title,
      thumb: (thumbs.medium ?? thumbs.default)?.url ?? null, sync_error: null,
    }, { onConflict: 'user_id,channel_id' }).select('id, title').single();
    if (error) throw error;
    if (tok.refresh_token) {
      const { error: e2 } = await admin.from('yt_tokens').upsert({
        account_id: account.id, refresh_token: tok.refresh_token, updated_at: new Date().toISOString(),
      });
      if (e2) throw e2;
    } else {
      const { data: has } = await admin.from('yt_tokens').select('account_id').eq('account_id', account.id).maybeSingle();
      if (!has) return json({ error: "Google didn't allow ongoing access. Try connecting again." }, 400);
    }

    // 4. Import now (the build reads the new account's subscriptions, playlists and likes)
    const gh = await fetch(`https://api.github.com/repos/${REPO}/actions/workflows/build.yml/dispatches`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${Deno.env.get('WIGWAM_GITHUB_TOKEN')}`, Accept: 'application/vnd.github+json', 'User-Agent': 'wigwam' },
      body: JSON.stringify({ ref: 'master' }),
    });
    return json({ account, importing: gh.ok });
  } catch (e) {
    return json({ error: String((e as Error).message ?? e) }, 500);
  }
});
