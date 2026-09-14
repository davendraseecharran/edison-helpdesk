-- ---------------------------------------------------------------------------
-- P2-3: a role is a SET, not a single value.
--
-- Three roles exist: `admin`, `netrider` and `skills_officer`. An account holds
-- at least one of them and may hold all three. "NetRider" is what this school
-- calls the students who work the helpdesk, so it replaces "technician" in
-- everything a person reads. A skills officer works the student and staff
-- directory and never touches a ticket.
--
-- WHY `role` SURVIVES. Every authorization decision in this database is written
-- as `v_actor.role = 'admin'` — in roughly forty functions, in policies, and in
-- the app's own types. Rewriting all of them in one migration would be a very
-- large diff whose only observable effect is a renamed literal. So `role` stays
-- as a DERIVED column: a trigger keeps it equal to 'admin' when `admin` is in
-- the set and 'technician' otherwise. Every existing gate therefore keeps
-- working, unchanged, and keeps meaning exactly what it meant before.
--
-- The literal `technician` survives INTERNALLY for the same reason. Nothing a
-- person sees says it any more; a later cleanup may migrate the literal to
-- `netrider` once the derived column has no readers left.
--
-- The trigger is TWO-WAY on purpose. A writer that sets `roles` states the set
-- and `role` follows it. A writer that sets only `role` — `app_admin_set_role`,
-- `app_admin_review_access_request`, the test seeds, any service-role fix-up —
-- is translated into the set instead of being silently undone on the next
-- read. Demoting an administrator that way removes `admin` and KEEPS whatever
-- else they held, which is the answer a person would expect.
--
-- WHAT A SKILLS OFFICER MAY REACH. With neither `netrider` nor `admin`:
--   * `requesters`: read, and write through app_save_person. Their job.
--   * `inventory_devices`: read through the inventory RPCs. Not write.
--   * tickets, notes, work logs, attachments, insights, administration: no.
-- The last line is enforced here, not in the browser: the ticket policy, the
-- ticket visibility predicate, the ticket lock, an insert trigger on
-- `public.tickets`, and the insights entry point all require a ticket worker.
--
-- Additive: one new column on two tables, new functions, one tightened policy.
-- No data is deleted and no existing row changes meaning.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- The set itself.
-- ---------------------------------------------------------------------------

alter table public.app_accounts
  add column roles text[] not null default array['netrider']::text[];

-- Rows are kept in canonical form by the trigger below: distinct and sorted.
-- The sort is what lets "no duplicates" be expressed as a plain CHECK — a
-- subquery is not allowed in one, and `a < b < c` implies all three differ.
alter table public.app_accounts
  add constraint app_accounts_roles_valid check (
    pg_catalog.cardinality(roles) between 1 and 3
    and roles <@ array['admin', 'netrider', 'skills_officer']::text[]
    and (pg_catalog.cardinality(roles) < 2 or roles[1] < roles[2])
    and (pg_catalog.cardinality(roles) < 3 or roles[2] < roles[3])
  );

update public.app_accounts
   set roles = case when role = 'admin'
                    then array['admin']::text[]
                    else array['netrider']::text[] end;

comment on column public.app_accounts.roles is
  'What this account may do, as a set of admin / netrider / skills_officer. Canonical form: distinct and sorted. Server-controlled; never writable by the account holder.';
comment on column public.app_accounts.role is
  'DERIVED from roles by app_derive_role_from_roles(): admin when the set holds admin, otherwise technician. Kept so every existing role = ''admin'' gate keeps working; the internal literal technician is the old name for netrider and is not shown to anyone.';

-- ---------------------------------------------------------------------------
-- Normalising input. One place decides what a role array is allowed to be, so
-- every RPC that takes one refuses the same things with the same sentence.
--
-- `technician` is accepted as an input spelling of `netrider`, because invites,
-- AI tool calls and saved admin forms in flight during the rename still say it.
-- ---------------------------------------------------------------------------

create function public.app_normalize_roles(p_roles text[])
returns text[]
language plpgsql
immutable
set search_path = ''
as $$
declare
  v_roles text[];
begin
  if p_roles is null or pg_catalog.cardinality(p_roles) = 0 then
    raise exception 'Choose at least one role.' using errcode = 'check_violation';
  end if;

  select pg_catalog.array_agg(distinct v order by v) into v_roles
  from (
    select case pg_catalog.lower(pg_catalog.btrim(r))
             when 'technician' then 'netrider'
             else pg_catalog.lower(pg_catalog.btrim(r))
           end as v
    from pg_catalog.unnest(p_roles) as t(r)
  ) normalized;

  if not (v_roles <@ array['admin', 'netrider', 'skills_officer']::text[]) then
    raise exception 'Choose administrator, NetRider or skills officer.'
      using errcode = 'check_violation';
  end if;

  return v_roles;
end;
$$;

comment on function public.app_normalize_roles(text[]) is
  'Canonical role set from caller input: trimmed, lowercased, technician read as netrider, de-duplicated, sorted, and refused unless every element is a real role.';

revoke execute on function public.app_normalize_roles(text[]) from public, anon;
grant execute on function public.app_normalize_roles(text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- The derived column. One trigger function, used by app_accounts and by
-- account_invites, both of which carry the same pair of columns.
-- ---------------------------------------------------------------------------

create function public.app_derive_role_from_roles()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_roles text[];
begin
  v_roles := coalesce(new.roles, array['netrider']::text[]);

  if tg_op = 'UPDATE'
     and new.roles is not distinct from old.roles
     and new.role is distinct from old.role then
    -- A writer that knows only the old column. Translate the single value into
    -- the set rather than letting the set overwrite it on the way out. An
    -- administrator demoted this way keeps every other role they held.
    if new.role = 'admin' then
      v_roles := old.roles || array['admin']::text[];
    else
      v_roles := array(
        select r from pg_catalog.unnest(old.roles) as t(r) where r <> 'admin'
      );
      if pg_catalog.cardinality(v_roles) = 0 then
        v_roles := array['netrider']::text[];
      end if;
    end if;
  elsif tg_op = 'INSERT'
        and new.roles is not distinct from array['netrider']::text[] then
    -- Nothing was said about the set, so `role` is the whole statement of
    -- intent. An insert that names a non-default set is taken at its word, and
    -- `role` follows it: that is the only way to create a skills officer.
    v_roles := case when new.role = 'admin'
                    then array['admin']::text[]
                    else array['netrider']::text[] end;
  end if;

  new.roles := array(
    select distinct r from pg_catalog.unnest(v_roles) as t(r) order by r
  );
  new.role := case when 'admin' = any(new.roles) then 'admin' else 'technician' end;
  return new;
end;
$$;

comment on function public.app_derive_role_from_roles() is
  'Keeps role and roles in agreement on app_accounts and account_invites. roles is the source of truth; a writer that sets only role has it translated into the set.';

create trigger app_accounts_derive_role
  before insert or update on public.app_accounts
  for each row execute function public.app_derive_role_from_roles();

-- ---------------------------------------------------------------------------
-- Predicates. These follow app_is_admin(): SECURITY DEFINER, STABLE, and
-- non-raising, because a policy that raised would turn "you may not see this
-- row" into a failed query rather than an empty list.
-- ---------------------------------------------------------------------------

create function public.app_has_role(p_role text)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.app_accounts a
    where a.id = (select auth.uid())
      and a.status = 'active'
      and p_role = any(a.roles)
  );
$$;

comment on function public.app_has_role(text) is
  'Whether the caller is an active account holding this role. False for anonymous, inactive, setup_pending, pending_approval and denied accounts.';

create function public.app_can_work_tickets()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.app_accounts a
    where a.id = (select auth.uid())
      and a.status = 'active'
      and a.roles && array['admin', 'netrider']::text[]
  );
$$;

comment on function public.app_can_work_tickets() is
  'Whether the caller may see and work tickets at all: an active admin or NetRider. A skills officer with neither role is refused every ticket, note, work log and attachment.';

revoke execute on function
  public.app_has_role(text),
  public.app_can_work_tickets()
from public, anon;

grant execute on function
  public.app_has_role(text),
  public.app_can_work_tickets()
to authenticated;

-- ---------------------------------------------------------------------------
-- Ticket access. Four gates, all of which a pure skills officer now fails.
-- ---------------------------------------------------------------------------

-- Restated from 20260910200200 with one added conjunct. "Any active account"
-- became too generous the moment an account could exist that does not work
-- tickets at all.
drop policy tickets_select_visible on public.tickets;

create policy tickets_select_visible
  on public.tickets for select to authenticated
  using (
    -- Implies an active account: app_can_work_tickets() reads status too.
    public.app_can_work_tickets()
    and (
      public.app_is_admin()
      or (status = 'open' and owner_id is null)
      or owner_id = public.app_active_account_id()
      or public.app_is_collaborator(id)
    )
  );

-- Restated from 20260910200200. Every child-table policy calls this, so notes,
-- work logs, collaborators, device observations, ticket devices, attachments
-- and activity events all inherit the new conjunct.
create or replace function public.app_can_view_ticket(p_ticket uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.tickets t
    where t.id = p_ticket
      and public.app_can_work_tickets()
      and (
        public.app_is_admin()
        -- Unowned open work is claimable, so every active NetRider sees it.
        or (t.status = 'open' and t.owner_id is null)
        or t.owner_id = public.app_active_account_id()
        or public.app_is_collaborator(t.id)
      )
  );
$$;

comment on function public.app_can_view_ticket(uuid) is
  'Ticket visibility predicate: admin sees all; NetRiders see claimable open work plus tickets they own or collaborate on; a skills officer who is neither sees nothing.';

-- Restated from 20260910200600 with the same added conjunct. This is the lock
-- every ticket mutation takes before it changes anything, so one line here
-- closes claim, reassign, release, notes, work logs, priority, waiting,
-- resolve, reopen, cancel, device links, categories and attachments at once.
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
    or not (p_actor.roles && array['admin', 'netrider']::text[])
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

-- Creating a ticket takes no lock, and app_create_ticket is rewritten often
-- enough that a guard inside its body would be easy to lose. The rule lives on
-- the table instead, where no path can go round it.
--
-- Trusted server paths — service_role seeds, migrations, the scan relay's own
-- inserts — carry no auth.uid() and are not gated here. Every client path does.
create function public.app_tickets_require_worker()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if (select auth.uid()) is not null and not public.app_can_work_tickets() then
    raise exception 'Only a NetRider or an administrator can open a ticket.'
      using errcode = 'insufficient_privilege';
  end if;
  return new;
end;
$$;

create trigger tickets_require_worker
  before insert on public.tickets
  for each row execute function public.app_tickets_require_worker();

revoke execute on function
  public.app_derive_role_from_roles(),
  public.app_tickets_require_worker()
from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Insights are a ticket report. A skills officer has no tickets to report on,
-- and the payload names every NetRider and their throughput.
--
-- The existing function is RENAMED rather than rewritten, so the report itself
-- is preserved exactly, byte for byte, and the new public entry point is only
-- the authorization decision. The internal name is reachable by nobody: its
-- EXECUTE is revoked from every client role.
-- ---------------------------------------------------------------------------

alter function public.app_insights(integer) rename to app_insights_report;

revoke execute on function public.app_insights_report(integer)
from public, anon, authenticated;

comment on function public.app_insights_report(integer) is
  'Builds the insights payload. Internal: it makes no authorization decision of its own. Callers go through app_insights(integer).';

create function public.app_insights(p_days integer default 30)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
begin
  v_actor := public.app_require_actor();
  if not (v_actor.roles && array['admin', 'netrider']::text[]) then
    raise exception 'Only a NetRider or an administrator can read insights.'
      using errcode = 'insufficient_privilege';
  end if;
  return public.app_insights_report(p_days);
end;
$$;

comment on function public.app_insights(integer) is
  'Insights payload for an active NetRider or administrator. Refuses a skills officer who is neither.';

revoke execute on function public.app_insights(integer) from public, anon;
grant execute on function public.app_insights(integer) to authenticated;

-- ---------------------------------------------------------------------------
-- Inventory is readable by a skills officer and writable only by a ticket
-- worker. Restated from 20260913150000 with one added guard; everything else
-- is that migration's body unchanged.
-- ---------------------------------------------------------------------------

create or replace function public.app_save_inventory_device(p_id uuid, p_version integer, p_data jsonb)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare a public.app_accounts; d public.inventory_devices; v_before jsonb; v_key text; v_serial text; v_assignee uuid;
begin
  a := public.app_require_actor();
  if not (a.roles && array['admin', 'netrider']::text[]) then
    raise exception 'Only a NetRider or an administrator can change inventory.'
      using errcode = 'insufficient_privilege';
  end if;
  perform public.app_validate_profile(p_data);
  foreach v_key in array array['deviceType','manufacturer','model','serialNumber'] loop
    if length(btrim(coalesce(p_data->>v_key,'')))=0 then raise exception 'Device type, manufacturer, model and serial number are required.'; end if;
  end loop;
  v_serial:=btrim(p_data->>'serialNumber');
  v_assignee:=nullif(p_data->>'assignedRequesterId','')::uuid;
  if v_assignee is not null and not exists(select 1 from public.requesters r where r.id=v_assignee and r.kind in ('staff','student')) then
    raise exception 'Select an existing student or staff member for the assignment.';
  end if;
  if p_id is not null then
    select * into d from public.inventory_devices where id=p_id for update;
    if not found then raise exception 'That device no longer exists.'; end if;
    if p_version is distinct from d.version then raise exception 'This device changed since you opened it. Reload it before saving.' using errcode='serialization_failure'; end if;
    v_before:=to_jsonb(d);
  end if;
  -- Serialize competing new serials; legacy duplicates remain editable unless
  -- their serial is changed. No old rows are deleted or silently merged.
  perform pg_advisory_xact_lock(hashtextextended(lower(v_serial),1162103124));
  if (p_id is null or lower(v_serial) is distinct from lower(d.serial_number)) and exists(
    select 1 from public.inventory_devices i where lower(i.serial_number)=lower(v_serial) and i.id is distinct from p_id
  ) then raise exception 'That serial number is already recorded in inventory.' using errcode='unique_violation'; end if;
  if p_id is null then
    insert into public.inventory_devices(external_id,device_type,manufacturer,model,serial_number)
      values('DEV-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,12)),btrim(p_data->>'deviceType'),btrim(p_data->>'manufacturer'),btrim(p_data->>'model'),v_serial)
      returning * into d;
  end if;
  update public.inventory_devices set device_type=btrim(p_data->>'deviceType'),manufacturer=btrim(p_data->>'manufacturer'),model=btrim(p_data->>'model'),
    serial_number=v_serial,os_version=nullif(btrim(p_data->>'osVersion'),''),asset_tag=nullif(btrim(p_data->>'assetTag'),''),
    status=nullif(btrim(p_data->>'status'),''),location=nullif(btrim(p_data->>'location'),''),notes=nullif(btrim(p_data->>'notes'),''),assigned_requester_id=v_assignee
    where id=d.id returning * into d;
  insert into public.device_catalog(device_type,manufacturer,model) values(d.device_type,d.manufacturer,d.model) on conflict do nothing;
  insert into public.inventory_events(entity,entity_id,actor_id,before_record,after_record) values('device',d.id,a.id,v_before,to_jsonb(d));
  return d.id;
end;
$$;

comment on function public.app_save_inventory_device(uuid, integer, jsonb) is
  'Creates or updates one inventory device. NetRiders and administrators only: a skills officer reads the inventory but does not change it.';

-- ---------------------------------------------------------------------------
-- Reading an account's own roles, and the colleague list.
-- ---------------------------------------------------------------------------

-- Adding an OUT column changes the row type, so the old signature is dropped
-- first and the grants are restated below.
drop function public.app_my_account();

create function public.app_my_account()
returns table (
  id uuid,
  display_name text,
  email text,
  role text,
  roles text[],
  status text,
  credential_action_pending boolean,
  session_is_current boolean
)
language sql
stable
security definer
set search_path = ''
as $$
  select a.id, a.display_name, a.email, a.role, a.roles, a.status,
         a.credential_action_pending,
         public.app_token_is_current(a)
  from public.app_accounts a
  where a.id = (select auth.uid());
$$;

comment on function public.app_my_account() is
  'The caller''s own account, including the full role set. The only place the application learns what an identity may do.';

revoke execute on function public.app_my_account() from public, anon;
grant execute on function public.app_my_account() to authenticated;

-- Restated from 20260914100100 with roles added, so an owner picker can leave
-- out a colleague who does not work tickets.
drop function public.app_directory();

create function public.app_directory()
returns table (
  id uuid,
  display_name text,
  role text,
  roles text[],
  status text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if public.app_active_account_id() is null then
    raise exception 'This account cannot access helpdesk records.'
      using errcode = 'insufficient_privilege';
  end if;

  return query
    select a.id, a.display_name, a.role, a.roles, a.status
    from public.app_accounts a
    where a.status not in ('pending_approval', 'denied')
    order by a.display_name;
end;
$$;

comment on function public.app_directory() is
  'Colleagues who can be named on a ticket or shown as an author, with their role set. Excludes accounts still waiting for, or refused, an access decision.';

revoke execute on function public.app_directory() from public, anon;
grant execute on function public.app_directory() to authenticated;

-- ---------------------------------------------------------------------------
-- Changing an account's roles.
--
-- Replaces app_set_account_role(uuid, text). The last-usable-admin guard is
-- kept exactly as it was: the only change is that "is this a demotion?" now
-- asks whether `admin` is leaving the set.
-- ---------------------------------------------------------------------------

drop function public.app_set_account_role(uuid, text);

create function public.app_set_account_roles(p_account uuid, p_roles text[])
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_target public.app_accounts;
  v_roles text[];
  v_usable_admins bigint;
begin
  -- Take the exclusive lock before app_require_actor's shared lock. This is
  -- the account-access lock used by status and credential mutations, and keeps
  -- a role change from racing an authorization decision.
  perform pg_catalog.pg_advisory_xact_lock(1162103123, 1);
  v_actor := public.app_require_actor();

  if v_actor.role <> 'admin' then
    raise exception 'Only an administrator can change account roles.'
      using errcode = 'insufficient_privilege';
  end if;

  v_roles := public.app_normalize_roles(p_roles);

  select * into v_target
    from public.app_accounts a
   where a.id = p_account
   for update;

  if not found then
    raise exception 'That account no longer exists.' using errcode = 'check_violation';
  end if;
  if v_target.roles = v_roles then
    raise exception 'That account already has these roles.' using errcode = 'check_violation';
  end if;

  -- A role edit never changes status: pending and inactive accounts remain
  -- restricted, even when an administrator prepares their future roles.
  if v_target.role = 'admin'
     and not ('admin' = any(v_roles))
     and v_target.status = 'active'
     and not v_target.credential_action_pending then
    select count(*) into v_usable_admins
      from public.app_accounts a
      join public.account_credential_state c on c.account_id = a.id
      join auth.users u on u.id = a.id
     where c.approved_digest = encode(extensions.digest(coalesce(u.encrypted_password,''),'sha256'),'hex')
       and coalesce(u.encrypted_password,'') <> ''
       and (u.banned_until is null or u.banned_until <= now())
       and a.role = 'admin'
       and a.status = 'active'
       and not a.credential_action_pending;
    if v_usable_admins <= 1 then
      raise exception 'The last active administrator cannot be removed.'
        using errcode = 'insufficient_privilege';
    end if;
  end if;

  update public.app_accounts
     set roles = v_roles,
         -- Role changes invalidate tokens issued before the committed change.
         -- clock_timestamp() records when the change actually takes effect,
         -- including time spent waiting for the access-state lock.
         sessions_valid_from = pg_catalog.clock_timestamp()
   where id = v_target.id;

  insert into public.account_events (account_id, kind, actor_id, detail)
  values (
    v_target.id,
    'role_changed',
    v_actor.id,
    'Roles changed from ' || pg_catalog.array_to_string(v_target.roles, ', ')
      || ' to ' || pg_catalog.array_to_string(v_roles, ', ') || '.'
  );

  return v_target.id;
end;
$$;

comment on function public.app_set_account_roles(uuid, text[]) is
  'Sets an account''s full role set. Administrator session only. Refuses to leave the helpdesk without a usable administrator, and invalidates the target''s older sessions.';

revoke execute on function public.app_set_account_roles(uuid, text[])
from public, anon, authenticated;
grant execute on function public.app_set_account_roles(uuid, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- Invites carry the set too, so the first sign-in lands on the right access.
-- ---------------------------------------------------------------------------

alter table public.account_invites
  add column roles text[] not null default array['netrider']::text[];

alter table public.account_invites
  add constraint account_invites_roles_valid check (
    pg_catalog.cardinality(roles) between 1 and 3
    and roles <@ array['admin', 'netrider', 'skills_officer']::text[]
    and (pg_catalog.cardinality(roles) < 2 or roles[1] < roles[2])
    and (pg_catalog.cardinality(roles) < 3 or roles[2] < roles[3])
  );

update public.account_invites
   set roles = case when role = 'admin'
                    then array['admin']::text[]
                    else array['netrider']::text[] end;

comment on column public.account_invites.roles is
  'The roles the invited person gets when they first sign in. Changing them afterwards goes through app_set_account_roles.';

create trigger account_invites_derive_role
  before insert or update on public.account_invites
  for each row execute function public.app_derive_role_from_roles();

-- Adding a parameter creates a new function rather than replacing the old one,
-- and PostgREST could not then choose between them, so the three-argument
-- signature is dropped. A caller that names p_email, p_role and p_display_name
-- still resolves here and still behaves exactly as before.
drop function public.app_admin_create_invite(text, text, text);

create function public.app_admin_create_invite(
  p_email text,
  p_role text default null,
  p_display_name text default null,
  p_roles text[] default null
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_email text := pg_catalog.lower(pg_catalog.btrim(coalesce(p_email, '')));
  v_name text := nullif(pg_catalog.btrim(coalesce(p_display_name, '')), '');
  v_roles text[];
  v_superseded uuid;
  v_invite uuid;
begin
  -- Exclusive BEFORE app_require_actor takes shared, matching migration 007:
  -- never upgrade a shared lock. An invite decides what access the next sign-in
  -- gets, so it is serialized against linking and against status changes.
  perform pg_catalog.pg_advisory_xact_lock(1162103123, 1);

  v_actor := public.app_require_actor();
  if v_actor.role <> 'admin' then
    raise exception 'Only an administrator can invite someone.'
      using errcode = 'insufficient_privilege';
  end if;

  if v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    raise exception 'Enter a valid school email address.' using errcode = 'check_violation';
  end if;

  -- p_roles is the statement of intent. p_role is the single-value spelling
  -- kept for callers written before roles became a set.
  if p_roles is not null then
    v_roles := public.app_normalize_roles(p_roles);
  elsif p_role is not null then
    v_roles := public.app_normalize_roles(array[p_role]);
  else
    raise exception 'Choose administrator, NetRider or skills officer.'
      using errcode = 'check_violation';
  end if;

  if v_name is not null and pg_catalog.length(v_name) > 120 then
    raise exception 'Enter a shorter name.' using errcode = 'check_violation';
  end if;

  -- Somebody who already has an account does not need an invite. If they are
  -- waiting for a decision, the answer is to review that request, not to add a
  -- second, contradictory record of what role they should have.
  if exists (select 1 from public.app_accounts a where a.email = v_email) then
    raise exception 'That address already has an account. Review the account instead.'
      using errcode = 'check_violation';
  end if;

  -- Re-inviting the same address supersedes the earlier invite rather than
  -- colliding with the live-invite index, so an administrator can correct a role
  -- or a name without first hunting down the old row.
  for v_superseded in
    with replaced as (
      update public.account_invites
      set revoked_at = pg_catalog.now()
      where email = v_email
        and accepted_at is null
        and revoked_at is null
      returning id
    )
    select id from replaced
  loop
    perform public.app_log_record_event(
      'invite', v_superseded, 'revoked', v_actor.id, 'Replaced by a newer invite.'
    );
  end loop;

  insert into public.account_invites (email, roles, display_name, invited_by)
  values (v_email, v_roles, v_name, v_actor.id)
  returning id into v_invite;

  perform public.app_log_record_event(
    'invite', v_invite, 'invited', v_actor.id,
    'Invited ' || v_email || ' as ' || pg_catalog.array_to_string(v_roles, ', ') || '.'
  );

  return v_invite;
end;
$$;

comment on function public.app_admin_create_invite(text, text, text, text[]) is
  'Pre-authorizes an address for a set of roles. Supersedes any live invite for the same address. Administrator session only. p_role is the older single-value spelling and is read as a one-element set.';

revoke execute on function public.app_admin_create_invite(text, text, text, text[])
from public, anon, authenticated;
grant execute on function public.app_admin_create_invite(text, text, text, text[]) to authenticated;

-- Restated from 20260914100100 with roles added to the row type.
drop function public.app_admin_list_invites();

create function public.app_admin_list_invites()
returns table (
  id uuid,
  email text,
  role text,
  roles text[],
  display_name text,
  invited_by uuid,
  invited_by_name text,
  created_at timestamptz,
  expires_at timestamptz,
  accepted_at timestamptz,
  revoked_at timestamptz,
  state text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not public.app_is_admin() then
    raise exception 'Only an administrator can review invites.'
      using errcode = 'insufficient_privilege';
  end if;

  return query
    select i.id, i.email, i.role, i.roles, i.display_name, i.invited_by, b.display_name,
           i.created_at, i.expires_at, i.accepted_at, i.revoked_at,
           case
             when i.accepted_at is not null then 'accepted'
             when i.revoked_at is not null then 'revoked'
             when i.expires_at <= pg_catalog.now() then 'expired'
             else 'pending'
           end
    from public.account_invites i
    join public.app_accounts b on b.id = i.invited_by
    order by i.created_at desc;
end;
$$;

comment on function public.app_admin_list_invites() is
  'Every invite with its role set and its derived state (pending, accepted, expired, revoked). Administrator session only.';

revoke execute on function public.app_admin_list_invites() from public, anon, authenticated;
grant execute on function public.app_admin_list_invites() to authenticated;

-- ---------------------------------------------------------------------------
-- Approving an access request chooses the set. Restated from 20260914100100
-- with p_roles added; p_role keeps working and means the same one-element set.
-- ---------------------------------------------------------------------------

drop function public.app_admin_review_access_request(uuid, text, text);

create function public.app_admin_review_access_request(
  p_account uuid,
  p_decision text,
  p_role text default 'technician',
  p_roles text[] default null
)
returns void
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_target public.app_accounts;
  v_roles text[];
begin
  -- Exclusive first: this changes an account's access (migration 007 protocol).
  perform pg_catalog.pg_advisory_xact_lock(1162103123, 1);

  v_actor := public.app_require_actor();
  if v_actor.role <> 'admin' then
    raise exception 'Only an administrator can review an access request.'
      using errcode = 'insufficient_privilege';
  end if;
  if p_decision is null or p_decision not in ('approve', 'deny') then
    raise exception 'Choose approve or deny.' using errcode = 'check_violation';
  end if;
  if p_decision = 'approve' then
    v_roles := public.app_normalize_roles(coalesce(p_roles, array[p_role]));
  end if;

  select * into v_target
  from public.app_accounts a
  where a.id = p_account
  for update;

  if not found then
    raise exception 'That account no longer exists.' using errcode = 'check_violation';
  end if;
  -- Nobody approves themselves, so a request can never become access without a
  -- second person deciding.
  if v_target.id = v_actor.id then
    raise exception 'You cannot review your own access request.'
      using errcode = 'insufficient_privilege';
  end if;
  if v_target.status not in ('pending_approval', 'denied') then
    raise exception 'That account is not waiting for an access decision.'
      using errcode = 'check_violation';
  end if;

  if p_decision = 'approve' then
    -- Roles and status move together: approving IS the moment access is chosen.
    update public.app_accounts
    set status = 'active', roles = v_roles
    where id = v_target.id;

    insert into public.account_events (account_id, kind, actor_id, detail)
    values (v_target.id, 'access_approved', v_actor.id,
            'Access approved as ' || pg_catalog.array_to_string(v_roles, ', ') || '.');

    if v_target.roles is distinct from v_roles then
      insert into public.account_events (account_id, kind, actor_id, detail)
      values (v_target.id, 'role_changed', v_actor.id,
              'Roles set to ' || pg_catalog.array_to_string(v_roles, ', ') || '.');
    end if;

    perform public.app_notify(
      v_target.id,
      'access_approved',
      'Your access request was approved',
      case when v_roles && array['admin', 'netrider']::text[]
           then 'You can start working on tickets.'
           else 'You can start working on the student and staff directory.' end,
      case when v_roles && array['admin', 'netrider']::text[] then '/queue' else '/people' end
    );
  else
    if v_target.status = 'denied' then
      raise exception 'That account has already been denied.' using errcode = 'check_violation';
    end if;

    -- Denied is not deactivation: the account never had access to revoke. The
    -- row is kept so the decision is recorded and the next sign-in is answered
    -- the same way instead of quietly opening a new request.
    update public.app_accounts
    set status = 'denied'
    where id = v_target.id;

    insert into public.account_events (account_id, kind, actor_id, detail)
    values (v_target.id, 'access_denied', v_actor.id, 'Access request denied.');

    perform public.app_notify(
      v_target.id,
      'access_denied',
      'Your access request was declined',
      'Contact the helpdesk administrator if you think this is a mistake.',
      '/restricted'
    );
  end if;
end;
$$;

comment on function public.app_admin_review_access_request(uuid, text, text, text[]) is
  'Approves (with a set of roles) or denies an account waiting for access. Administrator session only, and never the reviewer''s own account.';

revoke execute on function public.app_admin_review_access_request(uuid, text, text, text[])
from public, anon, authenticated;
grant execute on function public.app_admin_review_access_request(uuid, text, text, text[]) to authenticated;

-- ---------------------------------------------------------------------------
-- The Google first sign-in. Restated from 20260914101400 with three changes:
-- an invited account is created with the invite's SET, an uninvited one is
-- created as {netrider}, and the invite-accepted event names the set. The
-- fifty-outstanding-request bound and the email binding are unchanged.
-- ---------------------------------------------------------------------------

create or replace function public.app_trusted_link_identity(p_user uuid)
returns table (outcome text, account_id uuid, status text)
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user auth.users;
  v_email text;
  v_verified boolean;
  v_has_provider_identity boolean;
  v_account public.app_accounts;
  v_invite public.account_invites;
  v_has_invite boolean;
  v_name text;
  v_new public.app_accounts;
  v_pending bigint;
begin
  -- Exclusive, before anything is read: this creates access.
  perform pg_catalog.pg_advisory_xact_lock(1162103123, 1);

  if p_user is null then
    raise exception 'That sign-in could not be completed.' using errcode = 'check_violation';
  end if;

  select * into v_user from auth.users u where u.id = p_user;
  if not found then
    raise exception 'That sign-in could not be completed.' using errcode = 'check_violation';
  end if;

  v_email := pg_catalog.lower(pg_catalog.btrim(coalesce(v_user.email, '')));

  -- Both proofs are bound to v_email: a verification only ever speaks for the
  -- address it was issued for.
  v_verified := (
      v_user.email_confirmed_at is not null
      and pg_catalog.lower(pg_catalog.btrim(coalesce(v_user.email, ''))) = v_email
    )
    or exists (
      select 1
      from auth.identities i
      where i.user_id = p_user
        and i.identity_data ->> 'email_verified' = 'true'
        and pg_catalog.lower(pg_catalog.btrim(coalesce(i.identity_data ->> 'email', ''))) = v_email
    );

  -- Fails closed. A malformed address is treated the same as an unconfirmed one
  -- rather than being pushed at the account table's shape constraint.
  if not v_verified or v_email !~ '^[^\s@]+@[^\s@]+\.[^\s@]+$' then
    return query select 'unverified'::text, null::uuid, null::text;
    return;
  end if;

  -- 'email' is the provider GoTrue records for a password account, so anything
  -- else is a real external identity. Read once and used at all three sites.
  v_has_provider_identity := exists (
    select 1
    from auth.identities i
    where i.user_id = p_user
      and i.provider <> 'email'
  );

  select * into v_account
  from public.app_accounts a
  where a.id = p_user
  for update;

  if found then
    -- Recorded once, and only when there is genuinely a provider identity to
    -- record, so a returning user neither fills their own audit trail with one
    -- row per sign-in nor gains an event describing a link they do not have.
    if v_has_provider_identity and not exists (
      select 1
      from public.account_events e
      where e.account_id = v_account.id
        and e.kind = 'identity_linked'
    ) then
      insert into public.account_events (account_id, kind, detail)
      values (v_account.id, 'identity_linked', 'Provider identity linked to this account.');
    end if;

    return query select 'existing'::text, v_account.id, v_account.status;
    return;
  end if;

  -- A different Auth user already holds this address. The provider normally
  -- links the identities itself rather than creating a second user, so this is
  -- the fail-closed branch: refuse rather than silently create an account that
  -- would collide with the unique address, or worse, attach to the wrong person.
  if exists (select 1 from public.app_accounts a where a.email = v_email) then
    raise exception 'That email address already belongs to another account.'
      using errcode = 'check_violation';
  end if;

  select * into v_invite
  from public.account_invites i
  where i.email = v_email
    and i.accepted_at is null
    and i.revoked_at is null
    and i.expires_at > pg_catalog.now()
  for update;
  v_has_invite := found;

  if v_has_invite then
    v_name := nullif(pg_catalog.btrim(coalesce(v_invite.display_name, '')), '');
  end if;
  if v_name is null then
    v_name := nullif(pg_catalog.btrim(coalesce(v_user.raw_user_meta_data ->> 'full_name', '')), '');
  end if;
  if v_name is null then
    v_name := nullif(pg_catalog.btrim(coalesce(v_user.raw_user_meta_data ->> 'name', '')), '');
  end if;
  if v_name is null then
    v_name := nullif(pg_catalog.btrim(pg_catalog.split_part(v_email, '@', 1)), '');
  end if;
  -- The account table allows 1 to 120 characters; a provider name is untrusted
  -- input, so it is bounded here rather than raising on a long one.
  v_name := pg_catalog.left(coalesce(v_name, 'Helpdesk user'), 120);

  if v_has_invite then
    insert into public.app_accounts (id, display_name, email, roles, status)
    values (p_user, v_name, v_email, v_invite.roles, 'active')
    returning * into v_new;

    update public.account_invites
    set accepted_at = pg_catalog.now(), accepted_account_id = v_new.id
    where id = v_invite.id;

    if v_has_provider_identity then
      insert into public.account_events (account_id, kind, detail)
      values (v_new.id, 'identity_linked', 'Provider identity linked to this account.');
    end if;
    insert into public.account_events (account_id, kind, detail)
    values (v_new.id, 'invite_accepted',
            'Invite accepted as ' || pg_catalog.array_to_string(v_invite.roles, ', ') || '.');

    -- No actor: the person accepted it themselves through a trusted flow.
    perform public.app_log_record_event(
      'invite', v_invite.id, 'accepted', null, 'Invite accepted by ' || v_email || '.'
    );

    return query select 'invited'::text, v_new.id, v_new.status;
    return;
  end if;

  -- Nobody invited them, so this is a request. Count what is already waiting
  -- before adding to it: under the advisory lock held since the first statement,
  -- this count and the insert below cannot race another sign-in.
  select pg_catalog.count(*) into v_pending
  from public.app_accounts a
  where a.status = 'pending_approval';

  if v_pending >= 50 then
    -- No row, no notification, and the identity stays unlinked. The address can
    -- try again once an administrator has answered somebody.
    raise exception 'access_requests_full' using errcode = 'P9003';
  end if;

  -- The account exists only so the request can be answered; pending_approval
  -- reaches nothing until an administrator decides. An uninvited request is
  -- always {netrider}: an administrator chooses the real set when they approve.
  insert into public.app_accounts (id, display_name, email, roles, status)
  values (p_user, v_name, v_email, array['netrider']::text[], 'pending_approval')
  returning * into v_new;

  if v_has_provider_identity then
    insert into public.account_events (account_id, kind, detail)
    values (v_new.id, 'identity_linked', 'Provider identity linked to this account.');
  end if;
  insert into public.account_events (account_id, kind, detail)
  values (v_new.id, 'access_requested', 'Signed in without an invite and is waiting for a decision.');

  perform public.app_notify_admins(
    'access_requested',
    'Someone requested helpdesk access',
    v_name || ' (' || v_email || ') signed in without an invite.',
    '/admin'
  );

  return query select 'requested'::text, v_new.id, v_new.status;
end;
$$;

comment on function public.app_trusted_link_identity(uuid) is
  'Trusted server entry point for a provider sign-in. Returns existing, invited, requested or unverified. An invited account is created with the invite''s role set; an uninvited one waits as a NetRider until an administrator chooses. Raises access_requests_full (P9003) rather than creating a 51st outstanding request. Never granted to authenticated or anon.';

-- CREATE OR REPLACE preserves the existing EXECUTE ACLs. Restated so this
-- migration describes the whole access state of the object it redefines.
revoke execute on function public.app_trusted_link_identity(uuid)
from public, anon, authenticated;

grant execute on function public.app_trusted_link_identity(uuid) to service_role;
