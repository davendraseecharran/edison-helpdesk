-- ---------------------------------------------------------------------------
-- The account-event vocabulary is the union of both branches, not the later one.
--
-- `account_events_kind_valid` has been rewritten three times: M3 wrote it,
-- M5's `20260912100100_m5_account_states_invites.sql` widened it for Google
-- sign-in (identity_linked, invite_accepted, access_requested, access_approved,
-- access_denied) and the owner's `20260912210000_account_roles.sql` widened it
-- for role changes.
--
-- Each of those rewrites was `drop constraint` then `add constraint` with a
-- complete list, which is correct in one line of history and lossy in a merge:
-- theirs is dated later, so on a merged database it applies last and REMOVES
-- M5's five kinds. Linking an identity, accepting an invite and approving or
-- denying an access request then all fail on the check constraint -- the whole
-- Google sign-in path.
--
-- So the vocabulary is written once more, as the union. Theirs adds
-- 'role_changed', which M5's list already carried, so the union is M5's list;
-- it is spelled out in full here rather than left implied.
--
-- Additive: a constraint is widened, never narrowed, so no existing row can
-- stop being valid.
-- ---------------------------------------------------------------------------

alter table public.account_events drop constraint account_events_kind_valid;

alter table public.account_events add constraint account_events_kind_valid check (
  kind in (
    'account_provisioned', 'setup_issued', 'setup_verified', 'setup_completed',
    'recovery_issued', 'recovery_verified', 'recovery_completed',
    'credential_action_cancelled', 'status_changed', 'sessions_invalidated',
    'identity_linked', 'invite_accepted', 'access_requested', 'access_approved',
    'access_denied', 'role_changed'
  )
);
