-- Invariants that a CHECK constraint cannot express: rules referring to the
-- current time (not IMMUTABLE), and cross-row rules.
--
-- These are the last line of defence. The RPCs in later migrations also check
-- these conditions so callers get readable errors; a trigger firing means a code
-- path tried something the RPC layer should already have refused.

-- --- Tickets: immutable creation facts -------------------------------------

create or replace function public.app_tickets_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    -- Backdating is allowed; post-dating is not.
    if new.submitted_on > public.app_today() then
      raise exception 'The submission date cannot be in the future.'
        using errcode = 'check_violation';
    end if;
  elsif tg_op = 'UPDATE' then
    -- The real creation record can never be rewritten, including by backdating.
    if new.created_at is distinct from old.created_at then
      raise exception 'The ticket creation timestamp is immutable.'
        using errcode = 'check_violation';
    end if;
    if new.created_by is distinct from old.created_by then
      raise exception 'The ticket creator is immutable.'
        using errcode = 'check_violation';
    end if;
    if new.number is distinct from old.number then
      raise exception 'The ticket number is immutable.'
        using errcode = 'check_violation';
    end if;
    if new.submitted_on is distinct from old.submitted_on then
      raise exception 'The submission date cannot be changed after intake.'
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end;
$$;

create trigger tickets_guard
before insert or update on public.tickets
for each row execute function public.app_tickets_guard();

-- --- Collaborators: nobody is both primary owner and collaborator ----------

create or replace function public.app_collaborator_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_owner uuid;
begin
  select t.owner_id into v_owner
  from public.tickets t
  where t.id = new.ticket_id
  for update;

  if v_owner is not null and v_owner = new.account_id then
    raise exception 'The primary owner cannot also be a collaborator.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger ticket_collaborators_guard
before insert or update on public.ticket_collaborators
for each row execute function public.app_collaborator_guard();

-- --- Work logs: no future-dated work --------------------------------------

create or replace function public.app_work_log_guard()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if new.work_date > public.app_today() then
    raise exception 'The work date cannot be in the future.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

create trigger work_logs_guard
before insert or update on public.work_logs
for each row execute function public.app_work_log_guard();

-- --- Activity events: append-only -----------------------------------------

create or replace function public.app_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'Activity history is append-only and cannot be % .', lower(tg_op)
    using errcode = 'insufficient_privilege';
end;
$$;

-- Applies to every role including the definer used by the RPCs, so no code path
-- can quietly rewrite or erase history.
create trigger activity_events_append_only
before update or delete on public.activity_events
for each row execute function public.app_append_only();
