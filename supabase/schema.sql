-- Wigwam's database. Paste into Supabase → SQL editor and run (safe to run once on an empty project).
--
-- Who can see what is enforced here, by row-level security:
--   • Grown-ups who are members of a wigwam can read and change everything in it.
--   • Friends can read a wigwam's channels and playlists, and only if it shares with friends.
--   • A paired tablet (an anonymous sign-in) can read only its wigwam's kid files in storage.
--   • YouTube refresh tokens are readable by the server only.
-- Watch history and kids' hearts never come here: they stay on each device.

-- ------------------------------------------------------------------ tables

create table public.profiles (
  id uuid primary key references auth.users on delete cascade,
  name text,
  email text,
  avatar text,
  created_at timestamptz not null default now()
);

create table public.wigwams (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Our wigwam',
  settings jsonb not null default '{"allowShorts": false, "blockedTerms": [], "allowAnyway": []}',
  share_with_friends boolean not null default false,
  built_at timestamptz,           -- when the builder last wrote this wigwam's files
  build_requested_at timestamptz,
  created_at timestamptz not null default now()
);

create table public.members (
  wigwam_id uuid not null references public.wigwams on delete cascade,
  user_id uuid not null references public.profiles on delete cascade,
  role text not null default 'editor' check (role in ('owner', 'editor')),
  created_at timestamptz not null default now(),
  primary key (wigwam_id, user_id)
);
create index on public.members (user_id);

create table public.kids (
  wigwam_id uuid not null references public.wigwams on delete cascade,
  id text not null,
  name text not null,
  emoji text,
  color text,
  position int not null default 0,
  primary key (wigwam_id, id)
);

-- Approved channels, playlists and single videos.
create table public.sources (
  id uuid primary key default gen_random_uuid(),
  wigwam_id uuid not null references public.wigwams on delete cascade,
  kind text not null check (kind in ('channel', 'playlist', 'video')),
  yt_id text,          -- channel UC…, playlist PL…, video id (a channel can start with only a handle)
  handle text,
  username text,
  url text,
  title text,
  thumb text,
  kids text[] not null default '{}',
  shorts boolean,      -- channels only; null = the wigwam's default
  position int not null default 0,
  added_by uuid references public.profiles on delete set null,
  created_at timestamptz not null default now()
);
create index on public.sources (wigwam_id);

create table public.hidden (
  wigwam_id uuid not null references public.wigwams on delete cascade,
  video_id text not null,
  title text,
  primary key (wigwam_id, video_id)
);

-- Grown-ups' hearts, shared by everyone in the wigwam. (Kids' hearts stay on the device.)
create table public.hearts (
  wigwam_id uuid not null references public.wigwams on delete cascade,
  video_id text not null,
  primary key (wigwam_id, video_id)
);

create table public.activity (
  id bigint generated always as identity primary key,
  wigwam_id uuid not null references public.wigwams on delete cascade,
  user_id uuid references public.profiles on delete set null,
  message text not null,
  created_at timestamptz not null default now()
);
create index on public.activity (wigwam_id, created_at desc);

-- Links that add a grown-up to a wigwam ('member') or make two grown-ups friends ('friend').
create table public.invites (
  token text primary key default encode(extensions.gen_random_bytes(12), 'hex'),
  kind text not null check (kind in ('member', 'friend')),
  wigwam_id uuid references public.wigwams on delete cascade,
  role text not null default 'editor' check (role in ('owner', 'editor')),
  created_by uuid not null references public.profiles on delete cascade,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '14 days',
  check (kind = 'friend' or wigwam_id is not null)
);

create table public.friendships (
  a uuid not null references public.profiles on delete cascade,
  b uuid not null references public.profiles on delete cascade,
  created_at timestamptz not null default now(),
  primary key (a, b),
  check (a < b)
);

-- A kids' tablet: an anonymous sign-in, paired to one wigwam by a grown-up.
create table public.devices (
  user_id uuid primary key references auth.users on delete cascade,
  wigwam_id uuid not null references public.wigwams on delete cascade,
  name text not null default 'Tablet',
  paired_by uuid references public.profiles on delete set null,
  created_at timestamptz not null default now()
);

-- The code an unpaired tablet shows on screen until a grown-up types it in.
create table public.pair_codes (
  code text primary key,
  user_id uuid not null unique references auth.users on delete cascade,
  created_at timestamptz not null default now()
);

-- A grown-up's connected YouTube channel(s).
create table public.yt_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles on delete cascade,
  channel_id text not null,
  title text,
  thumb text,
  auto_sync boolean not null default true,
  synced_at timestamptz,
  sync_error text,
  created_at timestamptz not null default now(),
  unique (user_id, channel_id)
);

-- Server only (no policies): lets the nightly job read the grown-up's YouTube again.
create table public.yt_tokens (
  account_id uuid primary key references public.yt_accounts on delete cascade,
  refresh_token text not null,
  updated_at timestamptz not null default now()
);

-- Things found on a grown-up's YouTube, waiting to be approved or dismissed.
create table public.yt_inbox (
  account_id uuid not null references public.yt_accounts on delete cascade,
  kind text not null check (kind in ('channel', 'playlist', 'video')),
  yt_id text not null,
  title text,
  thumb text,
  channel_title text,
  reason text not null check (reason in ('subscription', 'playlist', 'liked')),
  dismissed boolean not null default false,
  found_at timestamptz not null default now(),
  primary key (account_id, kind, yt_id)
);

-- ------------------------------------------------------------------ helpers
-- security definer so policies can use them without recursing into each other.

create function public.is_member(w uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members where wigwam_id = w and user_id = auth.uid());
$$;

create function public.is_owner(w uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members where wigwam_id = w and user_id = auth.uid() and role = 'owner');
$$;

create function public.is_friend(other uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.friendships
    where (a = auth.uid() and b = other) or (b = auth.uid() and a = other));
$$;

-- A wigwam that shares with friends, run by one of my friends.
create function public.friend_can_see(w uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.wigwams ww join public.members m on m.wigwam_id = ww.id
    where ww.id = w and ww.share_with_friends and public.is_friend(m.user_id));
$$;

create function public.shares_wigwam(other uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.members m1 join public.members m2 on m1.wigwam_id = m2.wigwam_id
    where m1.user_id = auth.uid() and m2.user_id = other);
$$;

create function public.device_wigwam() returns uuid
language sql stable security definer set search_path = '' as $$
  select wigwam_id from public.devices where user_id = auth.uid();
$$;

-- ------------------------------------------------------------------ row-level security

alter table public.profiles enable row level security;
alter table public.wigwams enable row level security;
alter table public.members enable row level security;
alter table public.kids enable row level security;
alter table public.sources enable row level security;
alter table public.hidden enable row level security;
alter table public.hearts enable row level security;
alter table public.activity enable row level security;
alter table public.invites enable row level security;
alter table public.friendships enable row level security;
alter table public.devices enable row level security;
alter table public.pair_codes enable row level security;
alter table public.yt_accounts enable row level security;
alter table public.yt_tokens enable row level security;
alter table public.yt_inbox enable row level security;

create policy "see myself, co-parents and friends" on public.profiles for select
  using (id = auth.uid() or public.shares_wigwam(id) or public.is_friend(id));
create policy "edit myself" on public.profiles for update using (id = auth.uid());

create policy "members and friends see wigwams" on public.wigwams for select
  using (public.is_member(id) or public.friend_can_see(id));
create policy "members edit wigwams" on public.wigwams for update using (public.is_member(id));
create policy "owners delete wigwams" on public.wigwams for delete using (public.is_owner(id));

create policy "see members" on public.members for select
  using (public.is_member(wigwam_id) or public.friend_can_see(wigwam_id));
create policy "owners change roles" on public.members for update using (public.is_owner(wigwam_id));
create policy "owners remove anyone, anyone leaves" on public.members for delete
  using (public.is_owner(wigwam_id) or user_id = auth.uid());

create policy "members manage kids" on public.kids for all
  using (public.is_member(wigwam_id)) with check (public.is_member(wigwam_id));

create policy "members manage sources" on public.sources for all
  using (public.is_member(wigwam_id)) with check (public.is_member(wigwam_id));
create policy "friends see shared channels and playlists" on public.sources for select
  using (kind in ('channel', 'playlist') and public.friend_can_see(wigwam_id));

create policy "members manage hidden" on public.hidden for all
  using (public.is_member(wigwam_id)) with check (public.is_member(wigwam_id));
create policy "members manage hearts" on public.hearts for all
  using (public.is_member(wigwam_id)) with check (public.is_member(wigwam_id));

create policy "members read activity" on public.activity for select using (public.is_member(wigwam_id));
create policy "members write activity as themselves" on public.activity for insert
  with check (public.is_member(wigwam_id) and user_id = auth.uid());

create policy "see my invites" on public.invites for select
  using (created_by = auth.uid() or (wigwam_id is not null and public.is_owner(wigwam_id)));
create policy "make invites" on public.invites for insert
  with check (created_by = auth.uid() and (kind = 'friend' or public.is_owner(wigwam_id)));
create policy "cancel my invites" on public.invites for delete
  using (created_by = auth.uid() or (wigwam_id is not null and public.is_owner(wigwam_id)));

create policy "see my friendships" on public.friendships for select using (a = auth.uid() or b = auth.uid());
create policy "end my friendships" on public.friendships for delete using (a = auth.uid() or b = auth.uid());

create policy "members and the tablet itself see devices" on public.devices for select
  using (user_id = auth.uid() or public.is_member(wigwam_id));
create policy "members rename devices" on public.devices for update using (public.is_member(wigwam_id));
create policy "members remove devices" on public.devices for delete using (public.is_member(wigwam_id));

create policy "a tablet manages its own code" on public.pair_codes for all
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy "my YouTube accounts" on public.yt_accounts for select using (user_id = auth.uid());
create policy "change my YouTube accounts" on public.yt_accounts for update using (user_id = auth.uid());
create policy "disconnect my YouTube accounts" on public.yt_accounts for delete using (user_id = auth.uid());

create policy "my YouTube inbox" on public.yt_inbox for select
  using (exists (select 1 from public.yt_accounts a where a.id = account_id and a.user_id = auth.uid()));
create policy "dismiss from my inbox" on public.yt_inbox for update
  using (exists (select 1 from public.yt_accounts a where a.id = account_id and a.user_id = auth.uid()));

-- ------------------------------------------------------------------ actions

-- Every grown-up who signs in with Google gets a profile (tablets sign in anonymously and don't).
create function public.on_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  if not coalesce(new.is_anonymous, false) then
    insert into public.profiles (id, name, email, avatar)
    values (new.id,
      coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', split_part(new.email, '@', 1)),
      new.email, new.raw_user_meta_data ->> 'avatar_url')
    on conflict (id) do nothing;
  end if;
  return new;
end $$;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function public.on_new_user();

create function public.create_wigwam(wigwam_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare w uuid;
begin
  if auth.uid() is null or not exists (select 1 from public.profiles where id = auth.uid()) then
    raise exception 'Sign in first';
  end if;
  insert into public.wigwams (name) values (coalesce(nullif(trim(wigwam_name), ''), 'Our wigwam')) returning id into w;
  insert into public.members (wigwam_id, user_id, role) values (w, auth.uid(), 'owner');
  return w;
end $$;

-- What an invite link is for, shown before accepting it.
create function public.invite_info(invite_token text) returns json
language sql stable security definer set search_path = '' as $$
  select json_build_object('kind', i.kind, 'role', i.role, 'wigwam', w.name, 'from', p.name,
    'expired', i.expires_at < now(), 'mine', i.created_by = auth.uid())
  from public.invites i join public.profiles p on p.id = i.created_by
  left join public.wigwams w on w.id = i.wigwam_id
  where i.token = invite_token;
$$;

create function public.accept_invite(invite_token text) returns json
language plpgsql security definer set search_path = '' as $$
declare i public.invites;
begin
  if auth.uid() is null or not exists (select 1 from public.profiles where id = auth.uid()) then
    raise exception 'Sign in first';
  end if;
  select * into i from public.invites where token = invite_token;
  if i is null then raise exception 'That invite link has already been used or cancelled.'; end if;
  if i.expires_at < now() then raise exception 'That invite link has expired. Ask for a new one.'; end if;
  if i.created_by = auth.uid() then raise exception 'That''s your own invite link. Send it to someone else.'; end if;
  if i.kind = 'member' then
    insert into public.members (wigwam_id, user_id, role) values (i.wigwam_id, auth.uid(), i.role)
    on conflict (wigwam_id, user_id) do nothing;
    insert into public.activity (wigwam_id, user_id, message)
    values (i.wigwam_id, auth.uid(), 'joined this wigwam');
  else
    insert into public.friendships (a, b) values (least(auth.uid(), i.created_by), greatest(auth.uid(), i.created_by))
    on conflict do nothing;
  end if;
  delete from public.invites where token = invite_token;
  return json_build_object('kind', i.kind, 'wigwam_id', i.wigwam_id);
end $$;

-- A grown-up types the code a tablet is showing.
create function public.claim_device(pair_code text, wigwam uuid, device_name text) returns text
language plpgsql security definer set search_path = '' as $$
declare c public.pair_codes;
begin
  if not public.is_member(wigwam) then raise exception 'You can''t add devices to that wigwam.'; end if;
  select * into c from public.pair_codes
  where code = upper(replace(pair_code, ' ', '')) and created_at > now() - interval '1 day';
  if c is null then raise exception 'No tablet is showing that code. Check it and try again.'; end if;
  insert into public.devices (user_id, wigwam_id, name, paired_by)
  values (c.user_id, wigwam, coalesce(nullif(trim(device_name), ''), 'Tablet'), auth.uid())
  on conflict (user_id) do update set wigwam_id = excluded.wigwam_id, name = excluded.name, paired_by = excluded.paired_by;
  delete from public.pair_codes where code = c.code;
  insert into public.activity (wigwam_id, user_id, message)
  values (wigwam, auth.uid(), 'added the device ' || coalesce(nullif(trim(device_name), ''), 'Tablet'));
  return coalesce(nullif(trim(device_name), ''), 'Tablet');
end $$;

-- ------------------------------------------------------------------ storage
-- feeds/<wigwam>/index.json and feeds/<wigwam>/kids/<kid>.<version>.json: the kids' app.
-- feeds/<wigwam>/admin/catalog.json: every video, for the grown-ups' page.
-- cache/…: the builder's shared YouTube cache (server only).

insert into storage.buckets (id, name, public) values ('feeds', 'feeds', false), ('cache', 'cache', false);

create function public.can_read_feed(object_name text) returns boolean
language plpgsql stable security definer set search_path = '' as $$
declare parts text[] := storage.foldername(object_name); w uuid;
begin
  begin w := parts[1]::uuid; exception when others then return false; end;
  return public.is_member(w) or (w = public.device_wigwam() and coalesce(parts[2], '') <> 'admin');
end $$;

create policy "members and paired tablets read feeds" on storage.objects for select
  using (bucket_id = 'feeds' and public.can_read_feed(name));

-- ------------------------------------------------------------------ access for signed-in users
-- (Row-level security above still decides which rows. Tablets sign in anonymously but are
-- still "authenticated"; they aren't members of anything, so they only get their own rows.)
grant usage on schema public to authenticated;
grant select, insert, update, delete on all tables in schema public to authenticated;
grant execute on all functions in schema public to authenticated;
revoke all on public.yt_tokens from authenticated, anon;
