-- `app_public_totals` stops being reachable without signing in.
--
-- It existed for one line on the sign-in screen — "4,278 devices. 3,709
-- people. One queue." — and that line is gone: the sign-in page is the mark,
-- "Sign in", the Google button and a quiet password disclosure, and nothing
-- else above the fold. Nothing in the application calls the function now.
--
-- The review asked for a cache in front of it, because `count(*)` over
-- `inventory_devices`, `requesters` and `tickets` is three sequential scans
-- whose cost grows with the district, and an anonymous caller could ask for
-- them as fast as it liked. With no caller left, taking the grant away is the
-- better answer to the same finding: a cache makes the scan cheap, and this
-- makes it unreachable.
--
-- The function itself stays, granted to `authenticated`. It leaks nothing to
-- somebody who is already signed in — three magnitudes, no row, no name — and
-- a screen that wants them later should not have to reinvent it. This is why
-- the migration revokes rather than drops: dropping it would take the shape of
-- the answer away with the grant.

revoke execute on function public.app_public_totals() from anon;

comment on function public.app_public_totals() is
  'Three magnitudes: machines, people, tickets resolved. Takes no argument and '
  'returns no row, so it cannot be used to probe for one. No longer granted to '
  'anon: the sign-in screen that used it no longer shows a count, and an '
  'ungated caller could ask for three sequential scans as fast as it liked.';
