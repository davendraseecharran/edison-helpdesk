-- ---------------------------------------------------------------------------
-- P2-3 follow-up: the three ticket RPCs that do not go through app_lock_ticket.
--
-- 20260914140000 put the ticket-worker rule in app_lock_ticket, which every
-- ticket mutation takes before it changes anything — except three:
--
--   * app_claim_ticket takes its OWN `for update`, deliberately, so that the
--     loser of a claim race is told nothing about who won. A skills officer
--     could therefore still claim an unowned open ticket, and then not be able
--     to see the ticket they had just taken.
--   * app_reassign_ticket and app_add_collaborator lock the ticket as the
--     ACTOR, which is correct, but neither checked what the TARGET may do. An
--     administrator could hand work to a skills officer, or add one as a
--     collaborator, and the ticket would vanish from everyone's point of view
--     but the owner's: assigned to somebody the policy hides it from.
--
-- Each function is restated from the migration that last defined it, with the
-- guard added and nothing else changed:
--   app_claim_ticket      — 20260914101300_m5_row_attribution.sql
--   app_reassign_ticket   — 20260914101020_m5_notifications_fixes.sql
--   app_add_collaborator  — 20260914101000_m5_audit_notifications.sql
--
-- The owner-facing wording moves to NetRider with them, since these are
-- sentences a person reads.
--
-- Additive: no table changes, no data changes. CREATE OR REPLACE preserves the
-- existing EXECUTE ACLs on all three.
-- ---------------------------------------------------------------------------

create or replace function public.app_claim_ticket(p_ticket uuid)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_ticket public.tickets;
  v_previous uuid;
begin
  v_actor := public.app_require_actor();

  -- Claiming is ticket work. Answered with the same sentence as every other
  -- unavailable ticket, so this endpoint still says nothing about what exists.
  if not (v_actor.roles && array['admin', 'netrider']::text[]) then
    raise exception 'That ticket is not available to claim.'
      using errcode = 'insufficient_privilege';
  end if;

  -- Deliberate M2 change from the M1 demo: the loser of a claim race is NOT told
  -- who won. Missing, invisible, already-owned and non-open tickets all produce
  -- this one message, so the claim endpoint cannot be used to probe ownership by
  -- ticket id. Documented in docs/M2-DATABASE.md.
  select * into v_ticket
  from public.tickets t
  where t.id = p_ticket
  for update;

  if not found or v_ticket.status <> 'open' or v_ticket.owner_id is not null then
    raise exception 'That ticket is not available to claim.'
      using errcode = 'insufficient_privilege';
  end if;

  v_previous := v_ticket.owner_id;

  update public.tickets
  set owner_id = v_actor.id,
      assigned_at = now(),
      status = 'assigned'
  where id = v_ticket.id;

  -- Someone cannot be both primary owner and collaborator.
  delete from public.ticket_collaborators
  where ticket_id = v_ticket.id and account_id = v_actor.id;

  perform public.app_log_event(
    v_ticket.id, 'claimed', v_actor.id, v_actor.display_name || ' claimed the ticket'
  );

  -- Unreachable while claiming requires an unowned ticket, so `v_previous` is
  -- always NULL here; kept for the day a previous-owner column exists.
  if v_previous is not null and v_previous <> v_actor.id then
    perform public.app_notify(
      v_previous,
      'ticket_claimed',
      v_ticket.number || ' was claimed by ' ||
        case when public.app_request_via() = 'ai'
          then v_actor.display_name || '''s AI'
          else v_actor.display_name
        end,
      v_ticket.title,
      '/tickets/' || v_ticket.id
    );
  end if;

  return v_ticket.id;
end;
$$;

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
    raise exception 'Choose an active NetRider, or return the ticket to the Open Queue.'
      using errcode = 'check_violation';
  end if;
  if v_ticket.status in ('resolved', 'cancelled') then
    raise exception 'Reopen the ticket before reassigning it.' using errcode = 'insufficient_privilege';
  end if;
  if v_ticket.owner_id is not distinct from p_new_owner then
    raise exception 'That NetRider already owns this ticket.' using errcode = 'check_violation';
  end if;

  select * into v_new_owner
  from public.app_accounts a
  where a.id = p_new_owner and a.status = 'active';
  if not found then
    raise exception 'Choose an active NetRider.' using errcode = 'check_violation';
  end if;
  -- A ticket handed to somebody the policy hides it from is a ticket nobody is
  -- working, so the target has to be able to see it.
  if not (v_new_owner.roles && array['admin', 'netrider']::text[]) then
    raise exception 'That account does not work tickets. Choose a NetRider or an administrator.'
      using errcode = 'check_violation';
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

  -- The point of the whole hook: a NetRider learns a ticket is theirs without
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
  -- Same reason as reassignment: a collaborator who cannot see the ticket is
  -- not help, and the invitation would read as one.
  if not (v_target.roles && array['admin', 'netrider']::text[]) then
    raise exception 'That account does not work tickets. Choose a NetRider or an administrator.'
      using errcode = 'check_violation';
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

  -- An administrator may add themselves to a ticket they do not own, which is
  -- the one case where actor and recipient are the same account.
  if v_target.id <> v_actor.id then
    perform public.app_notify(
      v_target.id,
      'collaborator_added',
      'You were added to ' || v_ticket.number,
      v_ticket.title,
      '/tickets/' || v_ticket.id
    );
  end if;

  return v_ticket.id;
end;
$$;
