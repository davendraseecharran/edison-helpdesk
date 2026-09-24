-- The lookup's index of the directory and the inventory, read once per session.
--
-- The palette used to ask the database on every pause in typing. The two big
-- sets it searches — the people and the machines, about eight thousand rows —
-- change slowly and are read by every active account anyway, so the browser
-- now reads them once after sign-in, holds them in memory (never in storage),
-- and answers as the keys are pressed. Tickets, groups, events and forms are
-- still searched on the server, where their own visibility rules apply.
--
-- One row per record, already in the shape the palette draws (the same
-- title / subtitle / meta app_search renders), plus `keys`: the lower-cased
-- identifiers and names a query is matched against. Guardian phone numbers
-- and addresses are deliberately NOT in `keys`; a phone search still works,
-- through app_search, which the palette keeps asking.
--
-- SECURITY DEFINER for the same reason as app_search_inventory_rows: the
-- inventory has row-level security and no policies, and every read of it goes
-- through a definer function gated on an active account. The directory half is
-- gated the same way as requesters_select_active: an active account.

create function public.app_search_index()
returns table (
  kind text,
  id uuid,
  title text,
  subtitle text,
  meta text,
  keys text
)
language sql
stable
security definer
set search_path = ''
as $$
  select
    'person'::text,
    r.id,
    r.display_name,
    nullif(
      pg_catalog.concat_ws(
        ' — ',
        pg_catalog.initcap(r.kind),
        coalesce(
          nullif(pg_catalog.btrim(coalesce(r.department, '')), ''),
          nullif(pg_catalog.btrim(coalesce(r.official_class, '')), '')
        )
      ),
      ''
    ),
    coalesce(
      nullif(pg_catalog.btrim(coalesce(r.source_external_id, '')), ''),
      nullif(pg_catalog.btrim(coalesce(r.external_id, '')), '')
    ),
    pg_catalog.lower(
      pg_catalog.concat_ws(
        ' ',
        r.display_name,
        r.first_name,
        r.last_name,
        r.source_external_id,
        r.external_id,
        r.email,
        r.official_class,
        r.department
      )
    )
  from public.requesters r
  where public.app_active_account_id() is not null
    and r.archived_at is null

  union all

  select
    'device'::text,
    d.id,
    coalesce(
      nullif(pg_catalog.btrim(coalesce(d.asset_tag, '')), ''),
      nullif(pg_catalog.btrim(coalesce(d.serial_number, '')), ''),
      d.external_id
    ),
    nullif(pg_catalog.concat_ws(' ', d.manufacturer, d.model, d.device_type), ''),
    coalesce(nullif(pg_catalog.btrim(coalesce(d.status, '')), ''), 'No status')
      || case when h.display_name is not null then ' — ' || h.display_name else '' end,
    pg_catalog.lower(
      pg_catalog.concat_ws(
        ' ',
        d.asset_tag,
        d.serial_number,
        d.external_id,
        d.model,
        d.manufacturer,
        d.location,
        h.display_name
      )
    )
  from public.inventory_devices d
  left join public.requesters h on h.id = d.assigned_requester_id
  where public.app_active_account_id() is not null;
$$;

comment on function public.app_search_index() is
  'Every directory person (not archived) and inventory machine, in the palette''s row shape plus lower-cased match keys, for an active account; nothing for anybody else. Read once per session by the browser and held in memory. No guardian phone or address in the keys.';

revoke all on function public.app_search_index() from public, anon, authenticated;
grant execute on function public.app_search_index() to authenticated;
