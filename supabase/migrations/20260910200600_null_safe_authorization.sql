-- Reject unknown ownership as permission. SQL NOT(NULL) does not enter an IF
-- branch, so all nullable owner comparisons in denial predicates must return
-- a concrete false. Preserve the original RPC grants via CREATE OR REPLACE.
-- Reference: https://www.postgresql.org/docs/17/functions-comparison.html

create or replace function public.app_lock_ticket(p_ticket uuid, p_actor public.app_accounts)
returns public.tickets
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ticket public.tickets;
begin
  if p_ticket is null then
    raise exception 'That ticket is not available to this account.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_ticket
  from public.tickets t
  where t.id = p_ticket
  for update;

  if not found
    or not (
      p_actor.role = 'admin'
      or (v_ticket.status = 'open' and v_ticket.owner_id is null)
      or coalesce(v_ticket.owner_id = p_actor.id, false)
      or exists (
        select 1
        from public.ticket_collaborators tc
        where tc.ticket_id = v_ticket.id
          and tc.account_id = p_actor.id
      )
    )
  then
    raise exception 'That ticket is not available to this account.'
      using errcode = 'insufficient_privilege';
  end if;

  return v_ticket;
end;
$$;

create or replace function public.app_is_participant(p_ticket public.tickets, p_actor_id uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(p_ticket.owner_id = p_actor_id, false)
    or exists (
      select 1
      from public.ticket_collaborators tc
      where tc.ticket_id = p_ticket.id
        and tc.account_id = p_actor_id
    );
$$;

create or replace function public.app_add_collaborator(p_ticket uuid, p_account uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_ticket public.tickets;
  v_target public.app_accounts;
begin
  v_actor := public.app_require_actor();
  v_ticket := public.app_lock_ticket(p_ticket, v_actor);

  if v_ticket.status in ('resolved', 'cancelled') then
    raise exception 'This ticket is closed. An administrator must reopen it first.'
      using errcode = 'insufficient_privilege';
  end if;
  -- Owner or admin only; a collaborator cannot recruit further collaborators.
  if not (v_actor.role = 'admin' or coalesce(v_ticket.owner_id = v_actor.id, false)) then
    raise exception 'Only the primary owner or an administrator can change collaborators.'
      using errcode = 'insufficient_privilege';
  end if;

  select * into v_target
  from public.app_accounts a
  where a.id = p_account and a.status = 'active';
  if not found then
    raise exception 'Choose an active account to collaborate.' using errcode = 'check_violation';
  end if;
  if v_ticket.owner_id = v_target.id then
    raise exception 'That account is already the primary owner.' using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from public.ticket_collaborators tc
    where tc.ticket_id = v_ticket.id and tc.account_id = v_target.id
  ) then
    raise exception 'That account is already collaborating.' using errcode = 'check_violation';
  end if;

  insert into public.ticket_collaborators (ticket_id, account_id, added_by)
  values (v_ticket.id, v_target.id, v_actor.id);

  perform public.app_log_event(
    v_ticket.id, 'collaborator_added', v_actor.id,
    v_actor.display_name || ' added ' || v_target.display_name || ' as a collaborator'
  );

  return v_ticket.id;
end;
$$;

create or replace function public.app_remove_collaborator(p_ticket uuid, p_account uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_ticket public.tickets;
  v_name text;
begin
  v_actor := public.app_require_actor();
  v_ticket := public.app_lock_ticket(p_ticket, v_actor);

  if v_ticket.status in ('resolved', 'cancelled') then
    raise exception 'This ticket is closed. An administrator must reopen it first.'
      using errcode = 'insufficient_privilege';
  end if;
  if not (v_actor.role = 'admin' or coalesce(v_ticket.owner_id = v_actor.id, false)) then
    raise exception 'Only the primary owner or an administrator can change collaborators.'
      using errcode = 'insufficient_privilege';
  end if;

  select a.display_name into v_name from public.app_accounts a where a.id = p_account;

  delete from public.ticket_collaborators
  where ticket_id = v_ticket.id and account_id = p_account;
  if not found then
    raise exception 'That account is not collaborating on this ticket.' using errcode = 'check_violation';
  end if;

  -- Access ends now; everything they already authored keeps their name.
  perform public.app_log_event(
    v_ticket.id, 'collaborator_removed', v_actor.id,
    v_actor.display_name || ' removed ' || coalesce(v_name, 'a collaborator') || ' from the ticket'
  );

  return v_ticket.id;
end;
$$;
