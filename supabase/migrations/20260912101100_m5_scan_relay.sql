-- M5: the phone scanner relay.
--
-- A technician on a desktop opens a pairing dialog, which renders a session id as
-- a QR code. They photograph it with their phone, the phone opens `/scan/<id>`,
-- and every barcode the phone reads is typed into the desktop field they were
-- filling in. These two tables are the channel between the two devices.
--
-- Additive only, and every earlier rule stays in force: identity is auth.uid()
-- only, clients get SELECT and nothing else, and every write goes through a
-- SECURITY DEFINER RPC that re-derives the actor inside the database.
--
-- Four decisions shape everything below.
--
-- 1. THE SESSION ID IS NOT A SECRET. It is drawn on a screen in an office, in a
--    classroom, in a corridor; anyone who can see the monitor can read it with
--    their own phone. So the id is never the thing that authorizes anything.
--    What authorizes is that BOTH ENDS ARE SIGNED IN AS THE SAME ACCOUNT: the
--    phone has to authenticate before `/scan/<id>` will do anything, and every
--    function here compares the session's `account_id` against the actor it
--    derived itself. A second technician holding a photographed id gets exactly
--    what a caller with an invented uuid gets, word for word, so the id cannot be
--    used to probe for whose session it is.
--
--    That also means administrators get nothing. This is one person's phone
--    talking to one person's browser, and there is no helpdesk question an
--    administrator answers by reading it.
--
-- 2. A SESSION IS SHORT-LIVED TWICE OVER. It expires half an hour after it is
--    opened whether or not anyone remembers it, and either end can stop it by
--    hand. Expiry and stopping are kept as separate facts — `expires_at` in the
--    past is not the same as `ended_at` being set — because the pairing dialog
--    says different things about them.
--
-- 3. OPENING A SIXTH SESSION ENDS THE OLDEST rather than refusing. Refusing would
--    be the wrong answer to the situation it actually describes: a dialog left
--    open on a forgotten tab, or a phone that was closed without pressing Stop.
--    Nobody should be unable to scan a laptop because of a tab they cannot find.
--
-- 4. SCANS ARE APPEND-ONLY FROM A SESSION'S POINT OF VIEW. There are no insert,
--    update or delete grants on either table; app_record_scan is the only way a
--    row appears, so a code can never be edited into something the desktop will
--    then look up.

-- ---------------------------------------------------------------------------
-- The channel
-- ---------------------------------------------------------------------------

create table public.scan_sessions (
  id uuid primary key default extensions.gen_random_uuid(),
  account_id uuid not null references public.app_accounts (id) on delete cascade,
  label text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null default now() + interval '30 minutes',
  ended_at timestamptz,
  -- Nullable, so this holds for a session with no label at all; what it refuses
  -- is a label that is present but blank, or longer than the dialog can render.
  constraint scan_sessions_label_length
    check (label is null or length(btrim(label)) between 1 and 80)
);

comment on table public.scan_sessions is
  'One pairing between a technician''s phone and their own desktop session. Private to the account that opened it, including from administrators. Never writable from a session: app_start_scan_session and app_end_scan_session are the only ways in.';
comment on column public.scan_sessions.label is
  'What the desktop was asking for — "Serial number", "Asset tag" — shown on the phone so the technician knows which field they are filling.';
comment on column public.scan_sessions.expires_at is
  'When the pairing stops accepting scans on its own. Separate from ended_at: expiring is not the same as somebody pressing Stop.';

create index scan_sessions_account_idx on public.scan_sessions (account_id, created_at desc);

create table public.scan_events (
  id uuid primary key default extensions.gen_random_uuid(),
  session_id uuid not null references public.scan_sessions (id) on delete cascade,
  code text not null check (length(code) between 1 and 200),
  format text,
  scanned_at timestamptz not null default now()
);

comment on table public.scan_events is
  'One barcode read by the phone, on its way to the desktop field that asked for it. Append-only from a session: app_record_scan is the only way a row appears.';
comment on column public.scan_events.format is
  'The barcode symbology the phone reported (code_128, qr_code, …). NULL when it was typed in by hand.';

create index scan_events_session_idx on public.scan_events (session_id, scanned_at);

-- ---------------------------------------------------------------------------
-- Realtime
--
-- The desktop subscribes to inserts on this table so a scan arrives without
-- polling. Guarded twice: `[realtime] enabled = false` in supabase/config.toml
-- means a local stack may have no `supabase_realtime` publication at all, and
-- adding a table that is already a member raises. ALTER PUBLICATION is a utility
-- command, so it goes through EXECUTE rather than being written inline.
--
-- Membership publishes the row, it does not authorize anybody to see it: Realtime
-- applies the same policies as any other read, and `scan_events_select_own`
-- below is what keeps one technician's scans off another's socket.
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (
    select 1 from pg_catalog.pg_publication where pubname = 'supabase_realtime'
  ) and not exists (
    select 1 from pg_catalog.pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'scan_events'
  ) then
    execute 'alter publication supabase_realtime add table public.scan_events';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Shared helper. Revoked from every role including service_role: it is called
-- only by the functions below, never over the API.
-- ---------------------------------------------------------------------------

-- The caller's own session, or an error that says nothing about whose it is.
--
-- This exists so "missing" and "somebody else's" cannot drift apart. They are one
-- branch, raised from one place, with one message, and every mutating function
-- here starts by calling it.
create function public.app_require_scan_session(p_session uuid, p_actor uuid)
returns public.scan_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_session public.scan_sessions;
begin
  select * into v_session
  from public.scan_sessions s
  where s.id = p_session
    and s.account_id = p_actor
  for update;

  if not found then
    raise exception 'That scan session is not available to this account.'
      using errcode = 'no_data_found';
  end if;

  return v_session;
end;
$$;

comment on function public.app_require_scan_session(uuid, uuid) is
  'Trusted internal helper: locks and returns one of the actor''s own scan sessions, raising the single "not available" message for an id that is missing and for one belonging to another account alike.';

-- ---------------------------------------------------------------------------
-- Writes. SECURITY DEFINER, actor re-derived inside the database.
-- ---------------------------------------------------------------------------

create function public.app_start_scan_session(p_label text default null)
returns public.scan_sessions
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_label text;
  v_session public.scan_sessions;
begin
  v_actor := public.app_require_actor();

  v_label := nullif(pg_catalog.btrim(coalesce(p_label, '')), '');
  if v_label is not null and pg_catalog.length(v_label) > 80 then
    raise exception 'Keep the label to 80 characters or fewer.' using errcode = 'check_violation';
  end if;

  -- Decision 3: make room rather than refuse. Everything past the four newest
  -- live sessions is closed, so the one about to be inserted makes five.
  --
  -- `offset 4` over a newest-first ordering rather than a count and a loop: one
  -- statement, and correct whatever number of sessions the account has drifted
  -- up to.
  update public.scan_sessions s
  set ended_at = pg_catalog.now()
  where s.id in (
    select x.id
    from public.scan_sessions x
    where x.account_id = v_actor.id
      and x.ended_at is null
      and x.expires_at > pg_catalog.now()
    order by x.created_at desc, x.id desc
    offset 4
  );

  -- created_at and expires_at both take their defaults, which both read the
  -- transaction timestamp, so a session is exactly thirty minutes long.
  insert into public.scan_sessions (account_id, label)
  values (v_actor.id, v_label)
  returning * into v_session;

  return v_session;
end;
$$;

comment on function public.app_start_scan_session(text) is
  'Opens a pairing session for the calling account, good for thirty minutes. Keeps at most five live at once by ending the oldest, so a forgotten tab never blocks a scan.';

create function public.app_end_scan_session(p_session uuid)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_session public.scan_sessions;
begin
  v_actor := public.app_require_actor();
  v_session := public.app_require_scan_session(p_session, v_actor.id);

  -- Both ends of the pairing offer a Stop button and both may be pressed. The
  -- second one is not an error, and it does not move the time it was stopped.
  if v_session.ended_at is not null then
    return;
  end if;

  update public.scan_sessions s
  set ended_at = pg_catalog.now()
  where s.id = v_session.id;
end;
$$;

comment on function public.app_end_scan_session(uuid) is
  'Stops one of the caller''s own pairing sessions. Idempotent: stopping an already stopped session succeeds and changes nothing.';

create function public.app_record_scan(
  p_session uuid,
  p_code text,
  p_format text default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_session public.scan_sessions;
  v_code text;
  v_format text;
  v_id uuid;
begin
  v_actor := public.app_require_actor();
  v_session := public.app_require_scan_session(p_session, v_actor.id);

  -- Stopped and expired are distinct facts and get distinct messages, because
  -- "you pressed Stop" and "this has been open since first period" are different
  -- things to have happened.
  if v_session.ended_at is not null then
    raise exception 'That scan session has been stopped. Start a new one from the desktop.'
      using errcode = 'check_violation';
  end if;
  if v_session.expires_at <= pg_catalog.now() then
    raise exception 'That scan session has expired. Start a new one from the desktop.'
      using errcode = 'check_violation';
  end if;

  -- A code is TRIMMED AND TRUNCATED rather than refused for length: it came off a
  -- camera, and a misread that produced 400 characters of noise should put
  -- something in the field the technician can look at and reject, not an error
  -- they cannot act on. Nothing at all, though, is a mistake worth reporting.
  v_code := pg_catalog.left(pg_catalog.btrim(coalesce(p_code, '')), 200);
  if v_code = '' then
    raise exception 'Scan a code or type one in.' using errcode = 'check_violation';
  end if;

  v_format := nullif(pg_catalog.btrim(coalesce(p_format, '')), '');
  v_format := pg_catalog.left(v_format, 40);

  insert into public.scan_events (session_id, code, format)
  values (v_session.id, v_code, v_format)
  returning id into v_id;

  return v_id;
end;
$$;

comment on function public.app_record_scan(uuid, text, text) is
  'Records one barcode against one of the caller''s own live sessions. Refuses a stopped or expired session and an empty code; trims the code and cuts it to 200 characters rather than refusing a long misread.';

-- ---------------------------------------------------------------------------
-- Reads. SECURITY INVOKER (the default) on purpose: they run with the caller's
-- privileges, so the policies below decide which rows they can return and
-- nothing here can hand out another technician's pairing or their scans.
-- ---------------------------------------------------------------------------

create function public.app_scan_session(p_session uuid)
returns table (
  id uuid,
  label text,
  expires_at timestamptz,
  ended_at timestamptz,
  active boolean
)
language sql
stable
set search_path = ''
as $$
  select s.id, s.label, s.expires_at, s.ended_at,
         -- What the pairing dialog and the phone both ask: may this still be
         -- scanned into?
         (s.ended_at is null and s.expires_at > pg_catalog.now()) as active
  from public.scan_sessions s
  where s.id = p_session;
$$;

comment on function public.app_scan_session(uuid) is
  'One of the caller''s own pairing sessions, with whether it is still live. Returns no rows for a session belonging to another account and for one that does not exist — deliberately the same answer. account_id is not in the result: the caller already is it.';

create function public.app_scan_events(
  p_session uuid,
  p_after timestamptz default null
)
returns setof public.scan_events
language sql
stable
set search_path = ''
as $$
  select e.*
  from public.scan_events e
  where e.session_id = p_session
    -- Strictly after, so a poll that passes back the newest timestamp it has
    -- does not receive that scan a second time.
    and (p_after is null or e.scanned_at > p_after)
  -- Oldest first: this is a feed being caught up with, and id breaks ties when
  -- two reads land in the same instant.
  order by e.scanned_at, e.id
  limit 500;
$$;

comment on function public.app_scan_events(uuid, timestamptz) is
  'The scans on one of the caller''s own sessions, oldest first, optionally only those after a given instant. Returns nothing for a session belonging to another account. Still readable after the session is stopped, so the last code is not lost.';

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

alter table public.scan_sessions enable row level security;
alter table public.scan_events enable row level security;

-- Own sessions only, with no administrator exception. app_active_account_id()
-- returns NULL for an anonymous, inactive, setup_pending, pending_approval,
-- denied, credential-pending or stale-token caller, and `account_id = NULL` is
-- NULL rather than true, so this fails closed.
create policy scan_sessions_select_own
  on public.scan_sessions for select to authenticated
  using (account_id = public.app_active_account_id());

-- A scan has no account of its own: it belongs to whoever owns the session, and
-- this is the only place that is decided. It is also the predicate Realtime
-- applies before delivering an insert, which is what keeps one technician's
-- scans off another's socket.
create policy scan_events_select_own
  on public.scan_events for select to authenticated
  using (
    exists (
      select 1
      from public.scan_sessions s
      where s.id = session_id
        and s.account_id = public.app_active_account_id()
    )
  );

-- Deliberately absent: INSERT, UPDATE and DELETE policies on both tables. Every
-- change goes through the RPCs above, so a session cannot be opened in somebody
-- else's name and a recorded code cannot be edited into a different one.

-- ---------------------------------------------------------------------------
-- Grants
--
-- Supabase's default privileges grant ALL on a new public table to anon and
-- authenticated, so both tables are revoked explicitly and then re-granted
-- read-only. anon gets nothing at all.
-- ---------------------------------------------------------------------------

revoke all on table public.scan_sessions, public.scan_events from anon, authenticated;
grant select on table public.scan_sessions, public.scan_events to authenticated;

-- The internal helper is callable only by the functions that own it.
-- service_role is named explicitly: Supabase's default privileges grant ALL ON
-- FUNCTIONS to it directly, so it does not lose EXECUTE when the grant to PUBLIC
-- is revoked.
revoke execute on function
  public.app_require_scan_session(uuid, uuid)
from public, anon, authenticated, service_role;

revoke execute on function
  public.app_start_scan_session(text),
  public.app_end_scan_session(uuid),
  public.app_scan_session(uuid),
  public.app_record_scan(uuid, text, text),
  public.app_scan_events(uuid, timestamptz)
from public, anon;

grant execute on function
  public.app_start_scan_session(text),
  public.app_end_scan_session(uuid),
  public.app_scan_session(uuid),
  public.app_record_scan(uuid, text, text),
  public.app_scan_events(uuid, timestamptz)
to authenticated;
