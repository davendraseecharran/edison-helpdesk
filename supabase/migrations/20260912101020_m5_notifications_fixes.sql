-- M5 ticket notifications: review fixes.
--
-- 20260912101000_m5_audit_notifications.sql is already applied, so the two RPCs
-- that change are recreated here with their full bodies; app_audit_log,
-- app_claim_ticket, app_add_collaborator and app_reopen_ticket are untouched.
-- Bodies are copied from 101000, which copied them from
-- 20260910200300_ticket_rpcs.sql, so nothing a later migration fixed is reverted.
--
-- Two things were wrong.
--
-- 1. RETURNING A TICKET NOTIFIED THE PERSON WHO RETURNED IT. The rule 101000
--    stated for itself is that nobody is told about their own action, and the
--    four per-account notices honoured it. The queue notice did not:
--    app_notify_admins() addresses every active administrator, so an
--    administrator who put their own ticket back in the Open Queue was told
--    about it by the same click that did it. 101000 argued that the notice is
--    addressed to a role rather than to a person and so the rule did not apply;
--    review disagreed, and review is right — the recipient of that notice is a
--    person reading a list, and a line in it about something they just did is
--    noise whatever the intent behind the address was.
--
--    app_notify_admins() takes no exclusion, so the call is replaced by the
--    insert it would have made, minus one row. This is the only place in the
--    schema that writes public.notifications directly rather than through
--    app_notify(); it is a SECURITY DEFINER function owned by the same role, the
--    inserted columns are the same five, and the alternative — a second notifier
--    function differing from the first by one predicate — is a worse thing to
--    keep in step.
--
-- 2. THE ASSIGNMENT NOTICE DID NOT SAY WHAT THE TICKET WAS. 'You were assigned
--    EDT-1042' names a number nobody has memorised. The title now carries the
--    ticket's own title, as the brief asked. It is truncated to 80 characters
--    because tickets_title_length allows 120 and a notification title is read in
--    a narrow list; the body still carries the title in full, so nothing is lost,
--    only shortened where it is glanced at.

-- ---------------------------------------------------------------------------
-- app_return_ticket_to_queue
--
-- Body from 20260912101000_m5_audit_notifications.sql, itself from
-- 20260910200300_ticket_rpcs.sql. Only the notification block changes.
-- ---------------------------------------------------------------------------

create or replace function public.app_return_ticket_to_queue(p_ticket uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_ticket public.tickets;
  v_previous text;
begin
  v_actor := public.app_require_actor();
  v_ticket := public.app_lock_ticket(p_ticket, v_actor);

  if v_ticket.status in ('resolved', 'cancelled') then
    raise exception 'A closed ticket cannot be returned to the Open Queue.'
      using errcode = 'insufficient_privilege';
  end if;
  if v_ticket.owner_id is null then
    raise exception 'This ticket is already in the Open Queue.' using errcode = 'check_violation';
  end if;
  -- Collaborators cannot release someone else's ticket.
  if not (v_actor.role = 'admin' or v_ticket.owner_id = v_actor.id) then
    raise exception 'Only the primary owner or an administrator can return this ticket to the queue.'
      using errcode = 'insufficient_privilege';
  end if;

  select a.display_name into v_previous
  from public.app_accounts a where a.id = v_ticket.owner_id;

  update public.tickets
  set owner_id = null,
      assigned_at = null,
      status = 'open',
      waiting_reason = null
  where id = v_ticket.id;

  perform public.app_log_event(
    v_ticket.id, 'returned_to_queue', v_actor.id,
    case when v_ticket.owner_id = v_actor.id
      then v_actor.display_name || ' returned the ticket to the Open Queue'
      else v_actor.display_name || ' returned the ticket to the Open Queue from ' || v_previous
    end
  );

  -- Unfinished work is back on the desk and somebody has to pick it up, so
  -- every active administrator is told — except whoever pressed the button.
  -- This is app_notify_admins() with one row removed; that function takes no
  -- exclusion, and one predicate is a better thing to keep here than a second
  -- notifier to keep in step with the first.
  insert into public.notifications (account_id, kind, title, body, href)
  select a.id,
         'ticket_returned',
         v_ticket.number || ' is back in the Open Queue',
         v_ticket.title,
         '/tickets/' || v_ticket.id
  from public.app_accounts a
  where a.role = 'admin'
    and a.status = 'active'
    and a.id <> v_actor.id;

  return v_ticket.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- app_reassign_ticket
--
-- Body from 20260912101000_m5_audit_notifications.sql, itself from
-- 20260910200300_ticket_rpcs.sql. Only the notification title changes.
-- ---------------------------------------------------------------------------

create or replace function public.app_reassign_ticket(p_ticket uuid, p_new_owner uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_ticket public.tickets;
  v_new_owner public.app_accounts;
  v_previous text;
begin
  v_actor := public.app_require_actor();
  if v_actor.role <> 'admin' then
    raise exception 'Only an administrator can reassign a ticket.'
      using errcode = 'insufficient_privilege';
  end if;

  v_ticket := public.app_lock_ticket(p_ticket, v_actor);

  if p_new_owner is null then
    raise exception 'Choose an active technician, or return the ticket to the Open Queue.'
      using errcode = 'check_violation';
  end if;
  if v_ticket.status in ('resolved', 'cancelled') then
    raise exception 'Reopen the ticket before reassigning it.' using errcode = 'insufficient_privilege';
  end if;
  if v_ticket.owner_id is not distinct from p_new_owner then
    raise exception 'That technician already owns this ticket.' using errcode = 'check_violation';
  end if;

  select * into v_new_owner
  from public.app_accounts a
  where a.id = p_new_owner and a.status = 'active';
  if not found then
    raise exception 'Choose an active technician.' using errcode = 'check_violation';
  end if;

  select a.display_name into v_previous
  from public.app_accounts a where a.id = v_ticket.owner_id;

  update public.tickets
  set owner_id = v_new_owner.id,
      assigned_at = now(),
      status = case when status = 'open' then 'assigned' else status end
  where id = v_ticket.id;

  delete from public.ticket_collaborators
  where ticket_id = v_ticket.id and account_id = v_new_owner.id;

  perform public.app_log_event(
    v_ticket.id, 'assigned', v_actor.id,
    case when v_previous is null
      then v_actor.display_name || ' assigned the ticket to ' || v_new_owner.display_name
      else v_actor.display_name || ' reassigned the ticket from ' || v_previous
           || ' to ' || v_new_owner.display_name
    end
  );

  -- The point of the whole hook: a technician learns a ticket is theirs without
  -- watching the queue, and learns what it is without opening it. An
  -- administrator who takes one themselves already knows both.
  if v_new_owner.id <> v_actor.id then
    perform public.app_notify(
      v_new_owner.id,
      'ticket_assigned',
      -- 80 of the 120 characters a title may hold: the rest would be cut off by
      -- the notification list anyway, and the body below carries it in full.
      'You were assigned ' || v_ticket.number || ': ' || pg_catalog.left(v_ticket.title, 80),
      v_ticket.title,
      '/tickets/' || v_ticket.id
    );
  end if;

  return v_ticket.id;
end;
$$;
