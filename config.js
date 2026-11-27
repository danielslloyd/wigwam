// Where Wigwam keeps its data. These values are public by design: the publishable key
// only lets people do what the database's row-level security allows (see supabase/schema.sql).

export const SUPABASE_URL = 'https://csfjbounvpezvmsppcvy.supabase.co';
export const SUPABASE_KEY = 'sb_publishable_FfMPfnXIDgewTcySTWDNJA_PqNc2WoV';

// Google OAuth client (Google Cloud → Google Auth Platform → Clients), used to connect
// a grown-up's YouTube account. Its secret lives only in Supabase and GitHub secrets.
export const GOOGLE_CLIENT_ID = '';

export const SUPABASE_JS = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.2/+esm';
