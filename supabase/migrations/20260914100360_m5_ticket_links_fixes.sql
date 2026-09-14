-- M5 ticket links: one correction to app_category_labels.
--
-- A separate migration rather than an edit to
-- 20260914100350_m5_ticket_category_devices.sql, because that one is already
-- applied. The tables, the indexes, the policies and the functions are
-- untouched.
--
-- app_category_labels() was described in 100350 as an internal helper "not
-- granted to any client role" and then granted to `authenticated` in the same
-- file. The comment was right and the grant was wrong: the labels are in
-- TICKET_CATEGORY_LABELS in src/lib/domain/types.ts, no client calls the
-- function, and the two callers that do are SECURITY DEFINER and so run as the
-- owner regardless.
--
-- This file also used to recreate app_create_ticket, to make the requester
-- find-or-create for a directory person one statement instead of a select
-- followed by an insert. That race is gone with the second people table it
-- raced over: `public.requesters` IS the directory now, a ticket names a
-- requester row directly, and there is nothing to find or create. Intake is
-- written once, in 20260914120000_m5_create_ticket_merged.sql.

-- ---------------------------------------------------------------------------
-- Grants
--
-- app_category_labels() joins the internal helpers it was always described as
-- one of. service_role is named explicitly: Supabase's default privileges grant
-- ALL ON FUNCTIONS to it directly, so it does not lose EXECUTE when the grant to
-- PUBLIC is revoked.
-- ---------------------------------------------------------------------------

revoke execute on function public.app_category_labels()
from public, anon, authenticated, service_role;
