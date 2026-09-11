-- Identity helpers, row-level security, and grants.
--
-- Trust model:
--   * Identity is auth.uid() only. Nothing reads a role or an account id from
--     client input, JWT app_metadata, or a request header.
--   * Role and status come from public.app_accounts, which no technician can
--     write. Inactive and setup_pending accounts are treated as having no access
--     at all, so deactivation takes effect on the next statement of an existing
--     session rather than at next sign-in.
--   * Clients get SELECT only. Every write goes through a mutation RPC in a
--     later migration, so there is no direct REST insert/update/delete path.
--
-- Helpers are SECURITY DEFINER with a fixed empty search_path and fully
-- qualified references. They are DEFINER specifically so that a policy on one
-- table can consult another table without re-entering that table's own policy,
-- which would recurse. Each returns only a boolean or the caller's own id, so it
-- cannot be used to read data the caller could not already select.

-- --- Identity helpers ------------------------------------------------------

create or replace function public.app_active_account_id()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select a.id
  from public.app_accounts a
  where a.id = (select auth.uid())
    and a.status = 'active';
$$;

comment on function public.app_active_account_id() is
  'The caller''s account id, or NULL when anonymous, inactive, or setup_pending.';

create or replace function public.app_is_admin()
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
      and a.role = 'admin'
  );
$$;

create or replace function public.app_is_collaborator(p_ticket uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.ticket_collaborators tc
    where tc.ticket_id = p_ticket
      and tc.account_id = public.app_active_account_id()
  );
$$;

-- Single source of truth for ticket visibility, mirroring canViewTicket() in
-- src/lib/domain/permissions.ts. Child-table policies call this so that every
-- contribution inherits exactly the parent ticket's visibility.
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
      and public.app_active_account_id() is not null
      and (
        public.app_is_admin()
        -- Unowned open work is claimable, so every active technician sees it.
        or (t.status = 'open' and t.owner_id is null)
        or t.owner_id = public.app_active_account_id()
        or public.app_is_collaborator(t.id)
      )
  );
$$;

comment on function public.app_can_view_ticket(uuid) is
  'Ticket visibility predicate: admin sees all; technicians see claimable open work plus tickets they own or collaborate on.';

-- --- Row-level security ----------------------------------------------------

alter table public.app_accounts enable row level security;
alter table public.requesters enable row level security;
alter table public.tickets enable row level security;
alter table public.ticket_collaborators enable row level security;
alter table public.device_observations enable row level security;
alter table public.notes enable row level security;
alter table public.work_logs enable row level security;
alter table public.activity_events enable row level security;

-- Accounts: your own row, plus everything for an admin. A technician reading
-- this table directly therefore never sees another person's email or credential
-- metadata. Own-row access is deliberately allowed even when inactive or
-- setup_pending: that is the minimal self-status response M3 needs to route a
-- restricted account to the right screen. It exposes no ticket information.
create policy app_accounts_select_self_or_admin
  on public.app_accounts for select to authenticated
  using (id = (select auth.uid()) or public.app_is_admin());

-- Requesters: readable by any active account so technicians can record a
-- walk-in. Documented separately from ticket visibility in docs/M2-DATABASE.md;
-- this is a minimal requester lookup, not a student/staff directory.
create policy requesters_select_active
  on public.requesters for select to authenticated
  using (public.app_active_account_id() is not null);

create policy tickets_select_visible
  on public.tickets for select to authenticated
  using (
    public.app_active_account_id() is not null
    and (
      public.app_is_admin()
      or (status = 'open' and owner_id is null)
      or owner_id = public.app_active_account_id()
      or public.app_is_collaborator(id)
    )
  );

-- Every child record inherits the parent ticket's visibility exactly.
create policy ticket_collaborators_select_visible
  on public.ticket_collaborators for select to authenticated
  using (public.app_can_view_ticket(ticket_id));

create policy device_observations_select_visible
  on public.device_observations for select to authenticated
  using (public.app_can_view_ticket(ticket_id));

create policy notes_select_visible
  on public.notes for select to authenticated
  using (public.app_can_view_ticket(ticket_id));

create policy work_logs_select_visible
  on public.work_logs for select to authenticated
  using (public.app_can_view_ticket(ticket_id));

create policy activity_events_select_visible
  on public.activity_events for select to authenticated
  using (public.app_can_view_ticket(ticket_id));

-- Deliberately absent: INSERT, UPDATE and DELETE policies. Even if a future
-- grant were added by mistake, no write policy exists to satisfy.

-- --- Grants ----------------------------------------------------------------
-- Supabase's default privileges grant ALL on new public tables to anon and
-- authenticated, so every table must be revoked explicitly and then re-granted
-- read-only. anon gets nothing at all.

revoke all on table
  public.app_accounts,
  public.requesters,
  public.tickets,
  public.ticket_collaborators,
  public.device_observations,
  public.notes,
  public.work_logs,
  public.activity_events
from anon, authenticated;

grant select on table
  public.app_accounts,
  public.requesters,
  public.tickets,
  public.ticket_collaborators,
  public.device_observations,
  public.notes,
  public.work_logs,
  public.activity_events
to authenticated;

-- Ticket numbers are assigned by the database only.
revoke all on sequence public.ticket_number_seq from anon, authenticated;

-- Helper predicates: readable-boolean only, and never granted to anon.
revoke execute on function
  public.app_today(),
  public.app_active_account_id(),
  public.app_is_admin(),
  public.app_is_collaborator(uuid),
  public.app_can_view_ticket(uuid)
from public, anon;

grant execute on function
  public.app_today(),
  public.app_active_account_id(),
  public.app_is_admin(),
  public.app_is_collaborator(uuid),
  public.app_can_view_ticket(uuid)
to authenticated;
