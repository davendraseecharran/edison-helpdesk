-- Consolidate the review's two deactivation triggers into one.
drop trigger if exists app_accounts_deactivation_cutoff on public.app_accounts;
drop function if exists public.app_stamp_deactivation_cutoff();

-- Revocation must use the time of the actual status change, not transaction
-- start: a status RPC can wait behind another operation's authorization lock.
create function public.app_deactivation_clock() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'inactive' and old.status is distinct from new.status then
    new.sessions_valid_from := clock_timestamp();
  end if;
  return new;
end;
$$;
revoke all on function public.app_deactivation_clock() from public, anon, authenticated;
create trigger app_accounts_deactivation_clock before update on public.app_accounts
for each row execute function public.app_deactivation_clock();
