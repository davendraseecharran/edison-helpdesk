-- M5 audit log and ticket notification hooks.
--
-- Two halves of the same idea. An administrator should be able to answer "who
-- changed what, when, and was an assistant involved" in one place, and the
-- people a change lands on should be told about it without having to poll a
-- queue.
--
-- ---------------------------------------------------------------------------
-- The audit log
-- ---------------------------------------------------------------------------
--
-- Three append-only tables already record everything the desk does:
--
--   activity_events  ticket history          (M2, attribution added in M5)
--   account_events   account history         (M3)
--   record_events    people, devices, invites, imports, accounts (M5)
--
-- app_audit_log unions them into one shape so the audit screen is a single read
-- rather than three the application would have to interleave and page by hand.
-- It does NOT add a fourth history table: a union over the tables that already
-- hold the truth cannot drift out of step with them, whereas a copy would.
--
-- SECURITY DEFINER and administrator-only. It is definer because it reads
-- account history and actor names across every account, which no technician may
-- see, and it REFUSES a technician rather than returning an empty page: an empty
-- page is indistinguishable from a quiet desk, and would hide the refusal from
-- the person who hit it.
--
-- Every filter is optional and every one of them fails closed. `performed_via`
-- only ever holds 'user' or 'ai' and `entity_type` only ever holds one of six
-- values, so a filter value outside those sets matches nothing rather than
-- silently meaning "no filter".
--
-- ---------------------------------------------------------------------------
-- The notification hooks
-- ---------------------------------------------------------------------------
--
-- Five ticket RPCs are recreated with their existing signatures and bodies, plus
-- one app_notify call each. `create or replace` keeps every EXECUTE grant they
-- already carry, and the bodies are copied from the latest definitions
-- (20260910200300_ticket_rpcs.sql, and 20260910200600_null_safe_authorization.sql
-- for app_add_collaborator) so this file does not quietly revert a later fix.
--
-- One rule governs all of them: nobody is told about their own action. The
-- notice exists to tell somebody something they would not otherwise know, and a
-- person always knows what they just did. An administrator who assigns a ticket
-- to themselves, or an owner who adds themselves, gets nothing.
--
-- Notification bodies carry the ticket title and hrefs are in-app paths, never a
-- link with a token in it. notifications is written only by app_notify and
-- app_notify_admins, which stay revoked from every client role.

-- ---------------------------------------------------------------------------
-- app_audit_log
-- ---------------------------------------------------------------------------

create function public.app_audit_log(
  p_actor uuid default null,
  p_via text default null,
  p_kind text default null,
  p_entity text default null,
  p_from timestamptz default null,
  p_to timestamptz default null,
  p_limit integer default 50,
  p_offset integer default 0
)
returns table (
  source text,
  id uuid,
  at timestamptz,
  actor_id uuid,
  actor_name text,
  performed_via text,
  ai_model text,
  kind text,
  entity_type text,
  entity_id uuid,
  entity_label text,
  summary text,
  detail text,
  total_count bigint
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  -- Refused out loud. An administrator-only read that answered a technician with
  -- an empty page would look like a desk where nothing had happened.
  if not public.app_is_admin() then
    raise exception 'Only an administrator can read the audit log.'
      using errcode = 'insufficient_privilege';
  end if;

  return query
    with combined as (
      -- Ticket history. The label is the ticket number, because that is what a
      -- technician reads off a printout and types into the lookup bar.
      select
        'activity'::text as source,
        e.id,
        e.at,
        e.actor_id,
        e.performed_via,
        e.ai_model,
        e.kind,
        'ticket'::text as entity_type,
        e.ticket_id as entity_id,
        t.number as entity_label,
        e.summary,
        e.detail
      from public.activity_events e
      join public.tickets t on t.id = e.ticket_id

      union all

      -- Account history. This table predates M5 attribution and records no
      -- assistant action: every row in it is written by an administrator working
      -- directly or by a trusted credential flow, so `performed_via` answers
      -- 'user' rather than NULL and the column means the same thing everywhere.
      -- It also carries no summary line, so the kind is rendered as one.
      select
        'account'::text,
        e.id,
        e.at,
        e.actor_id,
        'user'::text,
        null::text,
        e.kind,
        'account'::text,
        e.account_id,
        a.display_name,
        pg_catalog.initcap(pg_catalog.replace(e.kind, '_', ' ')),
        e.detail
      from public.account_events e
      join public.app_accounts a on a.id = e.account_id

      union all

      -- Everything else. The label is whatever names the record to a person: a
      -- machine is known by the tag on its lid, somebody by their name, an
      -- invite by the address it was sent to. A label that comes back NULL means
      -- the record it named is gone, which the screen shows as such rather than
      -- inventing a name for it.
      select
        'record'::text,
        e.id,
        e.at,
        e.actor_id,
        e.performed_via,
        e.ai_model,
        e.kind,
        e.entity_type,
        e.entity_id,
        case e.entity_type
          when 'requester' then (
            select r.display_name from public.requesters r where r.id = e.entity_id
          )
          when 'inventory_device' then (
            select coalesce(
              nullif(pg_catalog.btrim(coalesce(d.asset_tag, '')), ''),
              nullif(pg_catalog.btrim(coalesce(d.serial_number, '')), ''),
              d.external_id
            )
            from public.inventory_devices d where d.id = e.entity_id
          )
          when 'invite' then (
            select i.email from public.account_invites i where i.id = e.entity_id
          )
          -- 'import' stays in the record_events vocabulary and has no label
          -- branch: the in-app importer that wrote those rows is gone with the
          -- tables it wrote, so there is no import to name. An old row would
          -- render the same way a deleted record does.
          when 'account' then (
            select a.display_name from public.app_accounts a where a.id = e.entity_id
          )
        end,
        e.summary,
        e.detail
      from public.record_events e
    ),
    filtered as (
      select c.*
      from combined c
      -- NULL means "every value of this field", not "no value": the audit screen
      -- sends nothing for a filter it is not applying.
      where (p_actor is null or c.actor_id = p_actor)
        and (p_via is null or c.performed_via = p_via)
        and (p_kind is null or c.kind = p_kind)
        and (p_entity is null or c.entity_type = p_entity)
        and (p_from is null or c.at >= p_from)
        and (p_to is null or c.at <= p_to)
    )
    select
      f.source, f.id, f.at, f.actor_id,
      -- Joined rather than rendered through a helper: the caller is an
      -- administrator, who may already read every account row, and an audit line
      -- whose actor rendered as nobody would be worse than useless.
      act.display_name,
      f.performed_via, f.ai_model, f.kind, f.entity_type, f.entity_id,
      f.entity_label, f.summary, f.detail,
      -- Window count over the same filtered set, computed before the page is cut,
      -- so a total never depends on which page is being read.
      pg_catalog.count(*) over () as total_count
    from filtered f
    -- LEFT: a record event written by a trusted server flow has no actor, and
    -- that row still belongs in the log.
    left join public.app_accounts act on act.id = f.actor_id
    -- id breaks ties so paging is deterministic: events written in one
    -- transaction share an instant, which resolving a ticket makes routine.
    order by f.at desc, f.id
    -- Floor of zero, not one: a screen that wants only the total says so by
    -- passing 0. The ceiling keeps one call from reading the whole history.
    limit greatest(0, least(coalesce(p_limit, 50), 200))
    offset greatest(0, coalesce(p_offset, 0));
end;
$$;

comment on function public.app_audit_log(uuid, text, text, text, timestamptz, timestamptz, integer, integer) is
  'Administrator-only audit read: ticket activity, account events and record events in one ordered, paged, filtered list, newest first. Every filter is optional and fails closed. Refuses a technician rather than returning an empty page.';

-- ---------------------------------------------------------------------------
-- Notification hooks
--
-- Same signatures, same bodies, one notice added to each. Restated in full
-- because `create or replace` replaces the whole body: a partial restatement
-- would drop whatever it left out.
-- ---------------------------------------------------------------------------

-- Claiming from the Open Queue.
--
-- Body from 20260910200300_ticket_rpcs.sql. The notice goes to whoever owned the
-- ticket before, which today can only be nobody: this RPC accepts an OPEN,
-- UNOWNED ticket and refuses every other state, and the schema keeps no
-- previous-owner column, so a ticket that was returned to the queue no longer
-- names who had it. The guard is written out rather than assumed, so the day a
-- previous owner becomes knowable the notice is already correct, and it can
-- never fire for the claimer's own action.
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

  if v_previous is not null and v_previous <> v_actor.id then
    perform public.app_notify(
      v_previous,
      'ticket_claimed',
      v_ticket.number || ' was claimed by ' || v_actor.display_name,
      v_ticket.title,
      '/tickets/' || v_ticket.id
    );
  end if;

  return v_ticket.id;
end;
$$;

-- Admin-only: hand a ticket to a different technician.
-- Body from 20260910200300_ticket_rpcs.sql.
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
  -- watching the queue. An administrator who takes one themselves already knows.
  if v_new_owner.id <> v_actor.id then
    perform public.app_notify(
      v_new_owner.id,
      'ticket_assigned',
      'You were assigned ' || v_ticket.number,
      v_ticket.title,
      '/tickets/' || v_ticket.id
    );
  end if;

  return v_ticket.id;
end;
$$;

-- The primary owner (or an admin) releases unfinished work. Every contribution,
-- collaborator, note, device, work log and prior solution is preserved.
-- Body from 20260910200300_ticket_rpcs.sql.
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

  -- Addressed to a ROLE, not to a person: unfinished work is back on the desk
  -- and somebody has to pick it up. The other notices are each ABOUT their
  -- recipient, which is why they exclude the actor; this one announces that the
  -- Open Queue changed, so app_notify_admins() sends it to every active
  -- administrator. A technician returning their own ticket therefore hears
  -- nothing back. An administrator who returns one is on that list and does get
  -- the queue notice, which is the announcement rather than a report of what
  -- they just did.
  perform public.app_notify_admins(
    'ticket_returned',
    v_ticket.number || ' is back in the Open Queue',
    v_ticket.title,
    '/tickets/' || v_ticket.id
  );

  return v_ticket.id;
end;
$$;

-- Body from 20260910200600_null_safe_authorization.sql, which is the latest
-- definition: it made the owner comparison null-safe, and that fix is preserved
-- here verbatim.
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

-- Body from 20260910200300_ticket_rpcs.sql.
create or replace function public.app_reopen_ticket(p_ticket uuid, p_reason text)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_ticket public.tickets;
begin
  v_actor := public.app_require_actor();
  if v_actor.role <> 'admin' then
    raise exception 'Only an administrator can reopen a ticket.' using errcode = 'insufficient_privilege';
  end if;
  v_ticket := public.app_lock_ticket(p_ticket, v_actor);

  if v_ticket.status not in ('resolved', 'cancelled') then
    raise exception 'Only resolved or cancelled tickets can be reopened.' using errcode = 'check_violation';
  end if;
  if length(btrim(coalesce(p_reason, ''))) = 0 then
    raise exception 'Reopening needs a reason.' using errcode = 'check_violation';
  end if;

  -- The stored solution stays as the previous solution; only the resolution
  -- markers are cleared. Every prior event, note, device and log survives.
  update public.tickets
  set status = case when owner_id is null then 'open' else 'assigned' end,
      resolved_by = null,
      resolved_at = null,
      cancel_reason = null
  where id = v_ticket.id;

  perform public.app_log_event(
    v_ticket.id, 'reopened', v_actor.id,
    v_actor.display_name || ' reopened the ticket', btrim(p_reason)
  );

  -- Work the owner thought was finished is theirs again. A ticket reopened while
  -- it sits in the Open Queue has nobody to tell.
  if v_ticket.owner_id is not null and v_ticket.owner_id <> v_actor.id then
    perform public.app_notify(
      v_ticket.owner_id,
      'ticket_reopened',
      v_ticket.number || ' was reopened',
      v_ticket.title,
      '/tickets/' || v_ticket.id
    );
  end if;

  return v_ticket.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants
--
-- The five recreated RPCs keep the ACLs `create or replace` preserved; only the
-- new function needs one. Supabase's default privileges grant EXECUTE on a new
-- public function to PUBLIC, so it is revoked and then granted to signed-in
-- accounts, where the administrator check inside the function is the real gate.
-- ---------------------------------------------------------------------------

revoke execute on function
  public.app_audit_log(uuid, text, text, text, timestamptz, timestamptz, integer, integer)
from public, anon;

grant execute on function
  public.app_audit_log(uuid, text, text, text, timestamptz, timestamptz, integer, integer)
to authenticated;
