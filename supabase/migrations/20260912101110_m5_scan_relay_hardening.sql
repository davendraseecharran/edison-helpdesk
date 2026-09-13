-- M5: bounds, housekeeping and a warning label for the phone scanner relay.
--
-- 20260912101100 established the channel. Review of it raised four things that
-- are not defects in what it does but in what it leaves unbounded or unsaid, and
-- this file is additive-only answers to them.
--
-- ---------------------------------------------------------------------------
-- A warning about Realtime, because this is the one table in the schema that is
-- published to it.
--
-- Realtime's `postgres_changes` checks row-level security PER SUBSCRIBER, and it
-- does that only for INSERT and UPDATE changes, where it has a new record to
-- test the policy against. A DELETE change carries the OLD record, and Realtime
-- does NOT filter those: every subscriber on the channel receives every delete.
--
-- With the default replica identity — the primary key — a delete carries nothing
-- but `id`, so an unfiltered delete tells a listener a uuid they cannot use. That
-- is the whole reason it is safe here.
--
--   NEVER SET `REPLICA IDENTITY FULL` ON public.scan_events.
--
-- Doing so would put `code` into the old record of every delete, and every delete
-- would then be broadcast, unfiltered, to every subscriber on the channel —
-- including the deletes app_sweep_scan_sessions() below does by the thousand.
-- One technician's scanned serial numbers would arrive on another technician's
-- socket. Nothing in this schema needs the old record, so nothing in this schema
-- should ever ask for it.
--
-- The per-subscriber cost is worth knowing too: Realtime evaluates
-- `scan_events_select_own` once per change PER OPEN SUBSCRIPTION, and that policy
-- is an EXISTS over scan_sessions. Ten technicians with a pairing dialog open is
-- ten policy evaluations per scan, which is nothing; ten thousand idle
-- subscriptions would not be. The five-live-sessions cap in
-- app_start_scan_session and the sweeper below are what keep the number of open
-- subscriptions proportional to the number of people actually scanning.
-- ---------------------------------------------------------------------------

comment on table public.scan_events is
  'One barcode read by the phone, on its way to the desktop field that asked for it. Append-only from a session: app_record_scan is the only way a row appears, and at most 500 rows per session. Published to supabase_realtime. NEVER set REPLICA IDENTITY FULL on this table: Realtime applies RLS to INSERT changes only and broadcasts DELETE changes unfiltered, so a full replica identity would put every swept code on every subscriber''s socket.';

comment on column public.scan_events.code is
  'The scanned string, trimmed and cut to 200 characters. Only ever readable by the account that owns the session, and only ever leaves the database through that account''s own subscription or read.';

-- ---------------------------------------------------------------------------
-- The read path, stated in one index
--
-- app_scan_events filters on session_id, compares scanned_at, and orders by
-- (scanned_at, id). The two-column index made the comparison indexable but left
-- the id to a sort; carrying it makes the whole of that query an index scan.
-- ---------------------------------------------------------------------------

drop index public.scan_events_session_idx;
create index scan_events_session_idx on public.scan_events (session_id, scanned_at, id);

-- ---------------------------------------------------------------------------
-- A session holds at most 500 scans
--
-- A phone left face-up on a bench with the camera running will read the same
-- barcode until its battery dies. The debounce in the client is the first answer
-- to that; this is the answer that does not depend on the client.
--
-- 500 is deliberately THE SAME NUMBER as the `limit 500` in app_scan_events, so
-- the reader can always reach every scan a session holds and the limit can never
-- silently drop one. If either number is ever changed, the other has to change
-- with it.
--
-- Enforced here rather than as a trigger because there is no other way in: there
-- are no insert grants on scan_events, so this function is the only thing that
-- ever writes a row. app_require_scan_session has already taken a FOR UPDATE lock
-- on the session, so two phones scanning into one pairing serialise here and the
-- count cannot be raced.
--
-- Same signature, so `create or replace` keeps every existing caller and the
-- function's ACL; the grants are restated at the foot of this file so it says in
-- full who may call what it recreated.
-- ---------------------------------------------------------------------------

create or replace function public.app_record_scan(
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

  -- Full is a third distinct state, and the way out of it is the same as the way
  -- out of the other two: a fresh pairing.
  if (
    select pg_catalog.count(*)
    from public.scan_events e
    where e.session_id = v_session.id
  ) >= 500 then
    raise exception 'This scanner session is full. Stop it and start a new one.'
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
  'Records one barcode against one of the caller''s own live sessions. Refuses a stopped session, an expired one, a full one (500 scans) and an empty code; trims the code and cuts it to 200 characters rather than refusing a long misread.';

-- The read limit and the write cap are one decision, so the comment says both.
comment on function public.app_scan_events(uuid, timestamptz) is
  'The scans on one of the caller''s own sessions, oldest first, optionally only those after a given instant. Returns nothing for a session belonging to another account. Still readable after the session is stopped, so the last code is not lost. Returns the OLDEST 500, which is every scan a session can hold because app_record_scan caps it at the same number — change one and you must change the other. A polling client should still pass p_after, so each poll carries only what is new rather than the whole session again.';

-- ---------------------------------------------------------------------------
-- Housekeeping
--
-- Nothing deleted a finished pairing, so the tables grew forever. A session is
-- finished when it has been stopped or when it has run out — both are checked,
-- because a session that was stopped a minute ago may have expired two days
-- earlier and is just as dead either way.
--
-- A day of grace rather than an hour: a technician who scanned a shelf of
-- laptops this morning may reasonably want to look at what their phone sent this
-- afternoon, and the rows are tiny.
--
-- The delete cascades to scan_events, which is a great many DELETE changes on a
-- published table. That is exactly why the replica identity warning at the top of
-- this file matters, and why it must stay the default.
-- ---------------------------------------------------------------------------

create function public.app_sweep_scan_sessions()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_cutoff timestamptz := pg_catalog.now() - interval '1 day';
  v_claims jsonb;
  v_count integer;
begin
  -- Two callers, not one. A scheduled job runs this with the service key and has
  -- no account at all, so app_require_actor() alone would refuse the very caller
  -- this is written for; an administrator running it by hand is an ordinary
  -- signed-in session and must still be an ACTIVE administrator.
  --
  -- The role comes from the JWT PostgREST validated, read the same NULL-safe way
  -- app_request_headers() reads its setting: absent outside a PostgREST request,
  -- and never allowed to raise inside the function it gates.
  v_claims := case
    when pg_catalog.pg_input_is_valid(
      nullif(pg_catalog.current_setting('request.jwt.claims', true), ''), 'jsonb'
    )
    then nullif(pg_catalog.current_setting('request.jwt.claims', true), '')::jsonb
  end;

  if coalesce(v_claims ->> 'role', '') <> 'service_role' then
    v_actor := public.app_require_actor();
    if v_actor.role <> 'admin' then
      raise exception 'Only an administrator can clear out finished scanner sessions.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  delete from public.scan_sessions s
  where s.expires_at < v_cutoff
     or (s.ended_at is not null and s.ended_at < v_cutoff);

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

comment on function public.app_sweep_scan_sessions() is
  'Deletes pairing sessions that were stopped or ran out more than a day ago, and their scans with them. Callable by the service role (for a scheduled job) and by an active administrator, and by nobody else. Returns how many sessions were removed.';

-- ---------------------------------------------------------------------------
-- Grants
--
-- `create or replace` preserved app_record_scan's ACL; it is restated so this
-- file says in full who may call the function it recreated. The sweeper is
-- granted to authenticated because an administrator reaches it through an
-- ordinary signed-in session — the role check inside is the gate, not the grant —
-- and service_role keeps the EXECUTE Supabase grants it by default.
-- ---------------------------------------------------------------------------

revoke execute on function
  public.app_record_scan(uuid, text, text),
  public.app_sweep_scan_sessions()
from public, anon;

grant execute on function
  public.app_record_scan(uuid, text, text),
  public.app_sweep_scan_sessions()
to authenticated;
