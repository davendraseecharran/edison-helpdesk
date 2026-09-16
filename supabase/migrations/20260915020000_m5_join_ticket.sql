-- ---------------------------------------------------------------------------
-- Join a colleague's ticket.
--
-- A NetRider sees the queue, their own tickets and the ones they collaborate
-- on, and nothing else. So when a colleague says "give me a hand with 1042",
-- the helper cannot open it, and the owner has to stop and add them. This is
-- the other direction: the helper types the number and puts themselves on the
-- ticket as a collaborator. The owner is told, and the activity log records
-- it as the helper's own doing ("added themselves"), so a ticket somebody
-- joined and a ticket somebody was invited to never read the same.
--
-- Additive: one function. Rules, in order: only a ticket worker; the number
-- has to exist; the ticket has to be live; unowned work is claimed, not
-- joined; the owner is already on it; joining twice is the same answer.
-- ---------------------------------------------------------------------------
create or replace function public.app_join_ticket(p_number text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_ticket public.tickets;
  v_number text;
begin
  v_actor := public.app_require_actor();

  if not (v_actor.roles && array['admin', 'netrider']::text[]) then
    raise exception 'Only a NetRider or an administrator can join a ticket.'
      using errcode = 'insufficient_privilege';
  end if;

  -- "1042", "edt-1042" and "EDT-1042" are the same ticket.
  v_number := pg_catalog.upper(pg_catalog.regexp_replace(coalesce(p_number, ''), '\s', '', 'g'));
  if v_number ~ '^[0-9]+$' then
    v_number := 'EDT-' || v_number;
  elsif v_number ~ '^EDT[0-9]+$' then
    v_number := 'EDT-' || pg_catalog.substr(v_number, 4);
  end if;

  select * into v_ticket
  from public.tickets t
  where t.number = v_number
  for update;

  if not found then
    raise exception 'No ticket with that number.' using errcode = 'check_violation';
  end if;
  if v_ticket.status in ('resolved', 'cancelled') then
    raise exception 'This ticket is closed. An administrator must reopen it first.'
      using errcode = 'insufficient_privilege';
  end if;
  if v_ticket.owner_id is null then
    raise exception 'Nobody owns this ticket yet. Claim it from the queue instead.'
      using errcode = 'check_violation';
  end if;
  if v_ticket.owner_id = v_actor.id then
    raise exception 'You already own this ticket.' using errcode = 'check_violation';
  end if;
  if exists (
    select 1 from public.ticket_collaborators tc
    where tc.ticket_id = v_ticket.id and tc.account_id = v_actor.id
  ) then
    -- Already on it. The answer to "join" is the ticket, not a complaint.
    return v_ticket.id;
  end if;

  insert into public.ticket_collaborators (ticket_id, account_id, added_by)
  values (v_ticket.id, v_actor.id, v_actor.id);

  -- The same kind as an invitation, so every list of collaborator events
  -- still finds it; the summary is what tells the two apart.
  perform public.app_log_event(
    v_ticket.id, 'collaborator_added', v_actor.id,
    v_actor.display_name || ' joined ' || v_ticket.number || ' (added themselves)'
  );

  perform public.app_notify(
    v_ticket.owner_id,
    'collaborator_joined',
    v_actor.display_name || ' joined ' || v_ticket.number,
    v_ticket.title,
    '/tickets/' || v_ticket.id
  );

  return v_ticket.id;
end;
$$;

comment on function public.app_join_ticket(text) is
  'Puts the caller on a colleague''s live ticket as a collaborator, by ticket number. Logged as the caller''s own doing; the owner is notified.';

revoke execute on function public.app_join_ticket(text) from public, anon;
grant execute on function public.app_join_ticket(text) to authenticated;
