-- Facets for the inventory list: status, type and location.
--
-- `app_list_inventory` took a search term, a page and one optional holder. On
-- 4,278 machines that is a search box and nothing else: "every Chromebook in
-- repair" is a question the list could not answer, because the term is a
-- substring match over concatenated fields and "repair" also matches a note,
-- a location and a model name.
--
-- So three equality filters go in beside the term. They are exact, they are
-- optional, and an empty string means "any" so a caller never has to
-- distinguish a missing parameter from a cleared one.
--
-- The parameter list changes, so the old signature is dropped first: Postgres
-- would otherwise keep both and every call would be ambiguous. Every existing
-- caller passes its arguments by name and the new parameters default to null,
-- so nothing else has to change.
--
-- `app_inventory_facets` is the other half: the values actually present in the
-- inventory, so the controls offer what exists rather than a guess. Statuses
-- already have `app_inventory_statuses()`, which adds the five seeded ones to
-- whatever is in use; types and locations have no seed list and are exactly
-- what the district has.

drop function if exists public.app_list_inventory(text, integer, uuid);

create function public.app_list_inventory(
  p_query text default '',
  p_page integer default 1,
  p_requester uuid default null,
  p_status text default null,
  p_type text default null,
  p_location text default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_query text := lower(btrim(coalesce(p_query, '')));
  v_status text := nullif(btrim(coalesce(p_status, '')), '');
  v_type text := nullif(btrim(coalesce(p_type, '')), '');
  v_location text := nullif(btrim(coalesce(p_location, '')), '');
  v_result jsonb;
begin
  perform public.app_require_actor();
  if p_page is null or p_page < 1 or p_page > 100000 or length(v_query) > 120 then
    raise exception 'Invalid search or page.';
  end if;
  if length(coalesce(v_status, '')) > 120
    or length(coalesce(v_type, '')) > 120
    or length(coalesce(v_location, '')) > 120 then
    raise exception 'Invalid filter.';
  end if;

  with matches as materialized (
    select d.*
    from public.inventory_devices d
    left join public.requesters r on r.id = d.assigned_requester_id
    where (p_requester is null or d.assigned_requester_id = p_requester)
      and (v_status is null or d.status = v_status)
      and (v_type is null or d.device_type = v_type)
      and (v_location is null or d.location = v_location)
      and (
        v_query = ''
        or strpos(
          lower(concat_ws(' ', d.external_id, d.device_type, d.manufacturer, d.model, d.os_version,
            d.serial_number, d.asset_tag, d.status, d.location, d.notes,
            r.display_name, r.external_id, r.email)),
          v_query
        ) > 0
      )
  ), page as (
    select * from matches order by device_type, manufacturer, model, id
    limit 50 offset ((p_page - 1) * 50)
  )
  select jsonb_build_object(
    'rows', coalesce((
      select jsonb_agg(public.app_inventory_device_json(p::public.inventory_devices)
        order by p.device_type, p.manufacturer, p.model, p.id)
      from page p
    ), '[]'::jsonb),
    'total', (select count(*) from matches),
    'page', p_page,
    'pageSize', 50
  ) into v_result;

  return v_result;
end;
$$;

revoke execute on function
  public.app_list_inventory(text, integer, uuid, text, text, text)
  from public, anon;
grant execute on function
  public.app_list_inventory(text, integer, uuid, text, text, text)
  to authenticated;

comment on function public.app_list_inventory(text, integer, uuid, text, text, text) is
  'The inventory list: one search term over a machine and its holder, plus exact '
  'filters for status, type and location. Fifty to a page.';

create function public.app_inventory_facets()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.app_require_actor();
  return jsonb_build_object(
    'types', coalesce((
      select jsonb_agg(t order by t)
      from (select distinct device_type as t from public.inventory_devices
            where nullif(btrim(device_type), '') is not null) q
    ), '[]'::jsonb),
    'locations', coalesce((
      select jsonb_agg(l order by l)
      from (select distinct location as l from public.inventory_devices
            where nullif(btrim(location), '') is not null) q
    ), '[]'::jsonb)
  );
end;
$$;

revoke execute on function public.app_inventory_facets() from public, anon;
grant execute on function public.app_inventory_facets() to authenticated;

comment on function public.app_inventory_facets() is
  'The device types and locations actually present in the inventory, so the '
  'list offers what exists rather than a guess.';
