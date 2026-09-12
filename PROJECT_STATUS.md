# Edison Helpdesk — resume here

Updated September12,2026 13:28 EDT. **The application is deployed and verified at https://edison-helpdesk.vercel.app.** M3 complete; M4 deployment complete, operational pilot preparation remains.

## Live resources

- Supabase project `lfqlkngxgefoaijuuvvx`, us-east-1, PostgreSQL17. All15 migrations applied through CLI; no fixtures/seeds. Local workspace remains unlinked.
- GitHub https://github.com/davendraseecharran/edison-helpdesk — private. App revision `13a1a19` on main deployed successfully.
- Vercel project `thomas-edison-cte-high-school/edison-helpdesk`, id `prj_9NEP7fDNQMsXUpI9VQ4KSfKE7BwL`, team `team_OhQP0pKULim8YlcnUg27qSdX`. Ready production deployment `dpl_6QFDhS871ZyDeizmf4cafnR8ALYD`, URL https://edison-helpdesk-jgrwrhwma-thomas-edison-cte-high-school.vercel.app, stable alias https://edison-helpdesk.vercel.app.
- Next.js/Node24.x, npm ci/build. Four environment variables set for Production only; service-role key is Secret. Local .env.local is still local.

GitHub login connection resolved the commit-author deployment block. Vercel repository connection still fails private-repository access; automatic deployments are NOT configured. Direct authenticated CLI deployments work. Future automatic deployment setup requires granting the Vercel GitHub app access to this private repository; no need to recreate resources.

## First administrator — user action required

Jessie Kalloo / jkalloo@schools.nyc.gov exists as setup-pending super admin. Password is not chosen yet. Fresh private setup link file:

`/Users/davendraseecharran/.edison-private/admin-setup-1789233924946.txt`

Expires September12 at14:25:24 EDT. Do not paste link/token into chat or open the callback automatically; user opens the private file and follows the link to choose a password. If expired while still pending, rerun guarded hosted bootstrap with the same identity to issue a new private link. If active, use normal recovery, not bootstrap. The older September11 link is superseded.

Final hosted counts: **1 app account,1 Auth user,0 tickets**. Only Jessie remains. No real student/staff/ticket/inventory imports.

## Verification and changes

- Hosted schema:15 migration history rows;0 public tables without RLS; no test-only recovery helper; anon/authenticated cannot call first-admin bootstrap. Signup disabled, minpassword12, HTTPS site/callback configured.
- Production build passed with14 routes. Initial build excluded src/lib/supabase because .vercelignore patterns were unanchored; fixed by anchoring exclusions to root, committed13a1a19.
- Live browser tests passed: signup denial, password login, session persistence/reload, technician admin denial, walk-in intake fields, logout.
- Separate live browser tests passed password setup, recovery, new-password login, and old-browser revocation. Normal cleanup correctly hit append-only audit protections; root removed only the exact synthetic test UUID in a locked transaction and re-enabled both guards before commit. Verified2 enabled audit guards and no leftover synthetic accounts.
- Temporary hosted scripts /tmp/edison-deploy/smoke.cjs and setup-smoke.cjs record the checks. The latter's generic cleanup cannot delete append-only grants/events; do not rerun without controlled cleanup. Never use local reset suites against hosted data.
- Earlier local checks:81 unit tests,122 DB tests,31 auth tests,2 deployment-bootstrap tests; typecheck/lint/build passed. Node24.21.0 also verified for M4 preparation.

## Remaining pilot work

1. User completes Jessie's setup and creates technician accounts through Administration.
2. Demonstrate backup/restoration and establish private backup storage before relying on the system for daily tickets. No backup/restore rehearsal has been completed.
3. Review hosted logging/rate limits and verify full live ticket workflows (claim/collaborate/return/resolve/concurrency); local M3 covered these, but hosted browser checks above did not create tickets.
4. Optionally finish Vercel GitHub app repository access for automatic deployments. Historical ticket import, inventory, directory, public intake, attachments and email remain deferred.

Do not claim complete production/pilot readiness solely from deployment. M3 approved-credential fingerprint depends on provider bcrypt/session/AMR schema. Cancelled provider recovery tokens cannot access helpdesk records, but misuse can temporarily disrupt the password until admin recovery; keep this documented tradeoff.

## Private configuration and continuity

Hosted operator env exists at /tmp/edison-deploy/production.env mode0600, outside Git; contains sensitive server key. Do not display its contents. Scripts/bootstrap-hosted-admin.mjs accepts an explicit matching project/HTTPS origin and writes setup links privately. Runbooks: docs/M4-DEPLOYMENT.md and docs/M4-BOOTSTRAP.md. Prior history: docs/handoffs/M4-PRE-LAUNCH-STATUS.md and PRE-M4-STATUS.md.

No active editor; root releases ownership. Helpers stopped/completed. User prefers bounded Luna max tasks with short context. Live usage at13:28: Plus five-hour27%, weekly4%; resets 2026-09-12T18:23:02-04:00 and 2026-09-19T13:23:02-04:00. No reset redeemed by tools; one credit available. Values account-wide, not predictive. No automatic wakeup configured.

Claude continuation: Read AGENTS.md and this short checkpoint. The app is already live; do not recreate or reset hosted resources. Continue only the user's requested pilot work. Preserve auth guards, keep credentials private, and checkpoint verified outcomes.
