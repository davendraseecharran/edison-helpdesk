-- Devices due back, the whole list.
--
-- Today shows the six oldest machines due back and, since this batch, says
-- how many more there are. Until now that line had nowhere honest to go: the
-- inventory list can filter by holder, status, type and location, and "due
-- back" is none of those — it is a machine whose holder has left, or a repair
-- nobody has touched in a fortnight. `app_today_devices_due()` already knows
-- the rule and already counts every row, but caps what it returns at twenty
-- because a briefing is a briefing.
--
-- So the rule moves into one function that takes a limit, and the briefing's
-- function becomes a call to it with the same twenty it always returned. The
-- page at /devices/due-back asks for the lot. Same gate (administrators and
-- NetRiders; anybody else gets zero and an empty list, never an error), same
-- ordering (oldest first, then id, so a page is stable between two reads),
-- same row shape, so `deviceFrom` in src/lib/data/today.ts reads both.
--
-- Nothing here changes a row. Every function is SECURITY DEFINER because
-- `inventory_devices` is not readable by `authenticated` directly, and each
-- is gated in its own body, as 20260914150200 explains.

create or replace function public.app_devices_due(p_limit integer default 200)
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
          -- moves on every edit. See the note at the head of 20260914150200.
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
        -- A page, never the whole inventory: one to a thousand rows.
        limit least(greatest(coalesce(p_limit, 200), 1), 1000)
      ) as picked
    ), '[]'::jsonb)
  );
$$;

comment on function public.app_devices_due(integer) is
  'Every machine due back — holder has left, or a repair untouched for fourteen days — as {count, rows}, oldest first, rows capped at p_limit (1 to 1000, default 200). Administrators and NetRiders only; anybody else gets a zero count and no rows. Read by /devices/due-back and, through app_today_devices_due, by the briefing.';

revoke execute on function public.app_devices_due(integer) from public, anon;
grant execute on function public.app_devices_due(integer) to authenticated;

-- The briefing's function keeps its name, its signature and its twenty rows;
-- only its body changes, to the one rule above.
create or replace function public.app_today_devices_due()
returns jsonb
language sql
stable
security definer
set search_path = ''
as $$
  select public.app_devices_due(20);
$$;

comment on function public.app_today_devices_due() is
  'The briefing''s slice of app_devices_due: the same count, the twenty oldest rows. Administrators and NetRiders only.';

revoke execute on function public.app_today_devices_due() from public, anon;
grant execute on function public.app_today_devices_due() to authenticated;
