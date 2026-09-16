-- ---------------------------------------------------------------------------
-- The Today line remembers an ask that came back with nothing.
--
-- `app_set_today_line` refused an empty line, so a model that kept answering
-- badly was asked again on every visit to Today, for as long as it kept
-- failing, and nothing bounded the cost. Now an empty line with a fingerprint
-- is a value in its own right: "this queue was asked about, and nothing usable
-- came back". The application keeps such a mark for two minutes and shows the
-- library line meanwhile. The fingerprint is still required; a mark that says
-- nothing about which queue it belongs to is still refused.
--
-- Same signature, same grants, same rule about `updated_at`.
-- ---------------------------------------------------------------------------
create or replace function public.app_set_today_line(p_line text, p_hash text)
returns public.account_preferences
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_row public.account_preferences;
  v_line text;
  v_hash text;
begin
  v_actor := public.app_require_actor();

  v_line := pg_catalog.left(pg_catalog.btrim(coalesce(p_line, '')), 90);
  v_hash := pg_catalog.left(pg_catalog.btrim(coalesce(p_hash, '')), 64);

  if v_hash = '' then
    raise exception 'Send the hash of the briefing the line was written from.'
      using errcode = 'check_violation';
  end if;

  -- An account may cache a line before it has ever opened settings, so the row
  -- is ensured here rather than assumed.
  insert into public.account_preferences (account_id)
  values (v_actor.id)
  on conflict (account_id) do nothing;

  -- `updated_at` is untouched on purpose: this is a cache, not a setting.
  update public.account_preferences p
  set today_line = pg_catalog.jsonb_build_object(
        'line', v_line,
        'hash', v_hash,
        'generated_at', pg_catalog.to_char(
          pg_catalog.now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'
        )
      )
  where p.account_id = v_actor.id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.app_set_today_line(text, text) is
  'Stores the caller''s cached Today line with the fingerprint of the briefing it was written from and the moment it was written. An empty line with a fingerprint records an ask that produced nothing. Never moves updated_at: this is a cache, not a setting.';

revoke execute on function public.app_set_today_line(text, text) from public, anon;
grant execute on function public.app_set_today_line(text, text) to authenticated;
