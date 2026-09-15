-- ---------------------------------------------------------------------------
-- Today: the machines that should be back on the shelf, and a briefing that
-- returns enough rows for the screen to do its own folding.
--
-- TWO THINGS, one function.
--
-- 1. DEVICES DUE BACK. A help desk loses machines the same two ways every year.
--    A student graduates and the Chromebook goes with them, because the row
--    that says who holds it is never revisited; and a laptop goes to the bench
--    in October and is still "In repair" in February, because a status nobody
--    looks at is a status nobody changes. Neither is a ticket, so neither has
--    ever appeared on a screen anybody opens. They belong on Today, which is
--    the screen that answers "what needs me", with the action — Return — on the
--    row itself.
--
--    `app_today_devices_due()` is SECURITY DEFINER and gated in its own body,
--    which is the pattern the whole inventory surface already uses: the owner's
--    `inventory_devices` is revoked from `authenticated` outright and every read
--    of it goes through a bounded function. It returns an EMPTY list rather than
--    raising for anybody who is not a NetRider or an administrator, because
--    Today is the landing page and a landing page must not fail for the person
--    who simply does not do inventory.
--
-- 2. THE SECTION CAPS WERE BELOW WHAT THE SCREEN NEEDS. `app_today_briefing()`
--    returned five unclaimed tickets; `needsYou()` ranks across every section,
--    folds repeats of one problem into a single row, and then shows seven. Five
--    reports of one dead projector arrived as five rows, folded to one, and
--    Today said "26 things need you" over a single line. The database's job
--    here is to hand over enough to choose from; choosing is the screen's. Every
--    section is 20 now, which is comfortably above `NEEDS_LIMIT` even when a
--    whole section folds into one row.
--
-- The briefing keeps its signature, stays SECURITY INVOKER, and is dropped and
-- recreated rather than replaced so the grants are restated in one place.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- app_today_devices_due: machines that are somewhere they should not still be.
--
-- Two reasons, and they are different failures:
--
--   holder_left  the person holding it has graduated or left. `student_status`
--                is the owner's own column for a student who has gone, and
--                `archived_at` (20260914130000) is the same fact for staff.
--   in_repair    it is marked in repair and NOBODY HAS TOUCHED THE RECORD FOR A
--                FORTNIGHT. The test is `updated_at`, which every edit moves, so
--                this is "untouched for fourteen days" rather than "on the bench
--                for fourteen days" — a machine somebody is actively working on
--                keeps dropping off the list, which is the behaviour wanted: the
--                row is for the job nobody has come back to. Reading the bench
--                time itself would mean the last status change in
--                `inventory_events`, which is a different and more expensive
--                question than this screen is asking.
--
-- Oldest first, capped at 20. The count is over the whole set, not the capped
-- list, so the heading stays true when only some of them fit.
-- ---------------------------------------------------------------------------
create or replace function public.app_today_devices_due()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  with allowed as (
    select (public.app_has_role('admin') or public.app_has_role('netrider')) as ok
  ),
  due as (
    select
      d.id,
      d.external_id,
      d.asset_tag,
      d.serial_number,
      d.device_type,
      d.manufacturer,
      d.model,
      d.status,
      d.version,
      coalesce(d.updated_at, d.imported_at) as since,
      r.display_name as holder_name,
      case
        when d.assigned_requester_id is not null
          and (r.student_status in ('graduated', 'other') or r.archived_at is not null)
        then 'holder_left'
        else 'in_repair'
      end as reason
    from public.inventory_devices d
    left join public.requesters r on r.id = d.assigned_requester_id
    cross join allowed
    where allowed.ok
      and (
        (
          d.assigned_requester_id is not null
          and (r.student_status in ('graduated', 'other') or r.archived_at is not null)
        )
        or (
          -- Untouched for a fortnight, not on the bench for one: `updated_at`
          -- moves on every edit. See the note at the head of this file.
          pg_catalog.lower(pg_catalog.btrim(coalesce(d.status, ''))) in ('in repair', 'in_repair')
          and coalesce(d.updated_at, d.imported_at)
                < pg_catalog.now() - '14 days'::interval
        )
      )
  )
  select jsonb_build_object(
    'count', (select pg_catalog.count(*) from due),
    'rows', coalesce((
      select pg_catalog.jsonb_agg(row)
      from (
        select jsonb_build_object(
          'id', x.id,
          'external_id', x.external_id,
          'asset_tag', x.asset_tag,
          'serial_number', x.serial_number,
          'device_type', x.device_type,
          'manufacturer', x.manufacturer,
          'model', x.model,
          'status', x.status,
          'version', x.version,
          'since', x.since,
          'holder_name', x.holder_name,
          'reason', x.reason
        ) as row
        from due x
        order by x.since asc, x.id asc
        limit 20
      ) as picked
    ), '[]'::jsonb)
  );
$$;

comment on function public.app_today_devices_due() is
  'Machines whose holder has left the school, or which have been in repair for over a fortnight. Empty for anybody who is not a NetRider or an administrator.';

revoke execute on function public.app_today_devices_due() from public, anon;
grant execute on function public.app_today_devices_due() to authenticated;

-- ---------------------------------------------------------------------------
-- app_today_briefing, widened.
--
-- Same signature, same SECURITY INVOKER, same four ticket sections; a fifth
-- section for the machines, read through the definer function above because
-- `inventory_devices` is revoked from `authenticated` and an invoker function
-- cannot see a row its caller cannot.
-- ---------------------------------------------------------------------------
drop function if exists public.app_today_briefing();

create function public.app_today_briefing()
returns jsonb
language sql
stable
set search_path = ''
as $$
  with me as (
    select public.app_active_account_id() as account_id,
           public.app_is_admin() as is_admin
  ),
  devices as (
    select public.app_today_devices_due() as payload
  ),
  live as (
    select t.*
    from public.tickets t
    where t.status in ('open', 'assigned', 'in_progress', 'waiting')
  ),
  waiting as (
    select t.*
    from live t, me
    where t.owner_id = me.account_id and t.status = 'waiting'
  ),
  unassigned as (
    select t.*
    from live t
    where t.owner_id is null and t.status = 'open'
  ),
  mine as (
    select t.*
    from live t, me
    where t.owner_id = me.account_id and t.status <> 'waiting'
  ),
  access as (
    select a.id, a.display_name, a.email, a.created_at
    from public.app_accounts a, me
    where me.is_admin and a.status = 'pending_approval'
  )
  select jsonb_build_object(
    'at', pg_catalog.now(),
    'counts', jsonb_build_object(
      'waiting', (select pg_catalog.count(*) from waiting),
      'unassigned', (select pg_catalog.count(*) from unassigned),
      'mine', (select pg_catalog.count(*) from mine),
      'access_requests', (select pg_catalog.count(*) from access),
      'devices_due', (select (d.payload ->> 'count')::bigint from devices d)
    ),
    'waiting', coalesce((
      select pg_catalog.jsonb_agg(row)
      from (
        select jsonb_build_object(
          'id', t.id, 'number', t.number, 'title', t.title,
          'priority', t.priority, 'status', t.status,
          'waiting_reason', t.waiting_reason,
          'created_at', t.created_at,
          'since', coalesce(t.assigned_at, t.created_at),
          'requester_name', r.display_name
        ) as row
        from waiting t
        left join public.requesters r on r.id = t.requester_id
        order by coalesce(t.assigned_at, t.created_at) asc, t.id asc
        limit 20
      ) as picked
    ), '[]'::jsonb),
    'unassigned', coalesce((
      select pg_catalog.jsonb_agg(row)
      from (
        select jsonb_build_object(
          'id', t.id, 'number', t.number, 'title', t.title,
          'priority', t.priority, 'status', t.status,
          'created_at', t.created_at,
          'since', t.created_at,
          'requester_name', r.display_name
        ) as row
        from unassigned t
        left join public.requesters r on r.id = t.requester_id
        order by
          case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
          t.created_at asc,
          t.id asc
        limit 20
      ) as picked
    ), '[]'::jsonb),
    'mine', coalesce((
      select pg_catalog.jsonb_agg(row)
      from (
        select jsonb_build_object(
          'id', t.id, 'number', t.number, 'title', t.title,
          'priority', t.priority, 'status', t.status,
          'created_at', t.created_at,
          'since', coalesce(t.assigned_at, t.created_at),
          'requester_name', r.display_name
        ) as row
        from mine t
        left join public.requesters r on r.id = t.requester_id
        order by
          case t.priority when 'urgent' then 0 when 'high' then 1 when 'normal' then 2 else 3 end,
          t.created_at asc,
          t.id asc
        limit 20
      ) as picked
    ), '[]'::jsonb),
    'access_requests', coalesce((
      select pg_catalog.jsonb_agg(row)
      from (
        select jsonb_build_object(
          'id', a.id, 'name', a.display_name, 'email', a.email, 'created_at', a.created_at
        ) as row
        from access a
        order by a.created_at asc, a.id asc
        limit 20
      ) as picked
    ), '[]'::jsonb),
    'devices_due', (select d.payload -> 'rows' from devices d)
  );
$$;

comment on function public.app_today_briefing() is
  'SECURITY INVOKER briefing for the Today screen: counts plus the top rows of what is waiting on you, what is unclaimed, what you own, who is waiting for access, and which machines are due back.';

revoke execute on function public.app_today_briefing() from public, anon;
grant execute on function public.app_today_briefing() to authenticated;
