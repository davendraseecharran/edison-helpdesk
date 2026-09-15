-- A saved view's path cannot be `/\evil.com` either.
--
-- 20260914150000 refused a path that did not start with `/` and a path that
-- started with `//`, which is a protocol-relative URL. It did not refuse
-- `/\evil.com`. Every browser normalises a leading `/\` into `//`, so that
-- single backslash is the same off-site link wearing a chip labelled
-- "Room 214" — and the chips render as anchors, which is the one field in this
-- whole table that becomes one.
--
-- 20260914150000 has been corrected in place, which is what a fresh database
-- runs. This file exists because `supabase migration up` will not run that file
-- again on a database that already has it, and a check that is only true of
-- new deployments is not a check. It replaces the function body with the same
-- text the corrected file now creates, so both kinds of database agree.
--
-- Additive: the signature, the security context, the grants and the stored data
-- are all unchanged. `src/lib/domain/saved-views.ts` applies the same rule when
-- the rows are read, because a value is not trusted for having been stored.

create or replace function public.app_set_saved_views(p_views jsonb)
returns public.account_preferences
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_row public.account_preferences;
  v_clean jsonb;
begin
  v_actor := public.app_require_actor();

  if p_views is null or pg_catalog.jsonb_typeof(p_views) <> 'array' then
    raise exception 'Send the saved views as a list.' using errcode = 'check_violation';
  end if;

  if pg_catalog.jsonb_array_length(p_views) > 24 then
    raise exception 'You can keep up to 24 saved views. Remove one and save again.'
      using errcode = 'check_violation';
  end if;

  select coalesce(pg_catalog.jsonb_agg(cleaned order by ordinality), '[]'::jsonb)
  into v_clean
  from pg_catalog.jsonb_array_elements(p_views) with ordinality as entry(value, ordinality)
  cross join lateral (
    select jsonb_build_object(
      'id', pg_catalog.left(coalesce(entry.value ->> 'id', ''), 64),
      'name', pg_catalog.left(pg_catalog.btrim(coalesce(entry.value ->> 'name', '')), 60),
      'path', pg_catalog.left(coalesce(entry.value ->> 'path', ''), 120),
      'query', pg_catalog.left(coalesce(entry.value ->> 'query', ''), 400)
    ) as cleaned
  ) as built
  where pg_catalog.jsonb_typeof(entry.value) = 'object'
    -- A view with no name is not a view; a path that is not in-app is not ours.
    -- One slash, and then neither a second slash nor a backslash.
    and pg_catalog.btrim(coalesce(entry.value ->> 'name', '')) <> ''
    and coalesce(entry.value ->> 'path', '') like '/%'
    and pg_catalog.left(coalesce(entry.value ->> 'path', ''), 2) not in ('//', '/\');

  insert into public.account_preferences (account_id)
  values (v_actor.id)
  on conflict (account_id) do nothing;

  update public.account_preferences p
  set saved_views = v_clean,
      updated_at = pg_catalog.now()
  where p.account_id = v_actor.id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.app_set_saved_views(jsonb) is
  'Replaces the caller''s saved views, rebuilding every element from the four fields this application understands. A path must start with one slash followed by neither a slash nor a backslash, because both spellings of a protocol-relative URL leave the application.';

revoke execute on function public.app_set_saved_views(jsonb) from public, anon;
grant execute on function public.app_set_saved_views(jsonb) to authenticated;
