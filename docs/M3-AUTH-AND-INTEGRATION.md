# M3 — real authentication and persisted ticketing

The approved interface now runs on real local Supabase Auth and persisted data.
Technicians sign in with a school email and a separate app password they choose
themselves; administrators create accounts and hand over single-use setup and
recovery links in person. Everything is local and synthetic: no hosted project,
no deployment, no real school data.

## Contents

- [Architecture](#architecture)
- [Trust boundaries](#trust-boundaries)
- [Account lifecycle](#account-lifecycle)
- [Session invalidation](#session-invalidation)
- [Provider behaviour we verified](#provider-behaviour-we-verified)
- [RPC mapping](#rpc-mapping)
- [Setup and commands](#setup-and-commands)
- [Test results](#codex-final-review-results)
- [Known gaps](#known-gaps)

## Architecture

| Layer | File(s) | Role |
| --- | --- | --- |
| Config | `src/lib/supabase/config.ts` | Validates env, raises a clear setup error rather than degrading |
| Server client | `src/lib/supabase/server.ts` | Cookie-bound client carrying the user's JWT. All ticket reads/writes |
| Browser client | `src/lib/supabase/browser.ts` | Interactive auth calls only (sign-in, password update, sign-out) |
| Admin client | `src/lib/supabase/admin.ts` | Service role. Only for auth-user creation, link generation, `app_trusted_*` |
| Session DAL | `src/lib/auth/session.ts` | `getUser()` verification + database-sourced role/status, memoised per render |
| Proxy | `src/proxy.ts` | Session cookie refresh only. No authorization |
| Reads | `src/lib/data/tickets.ts` | Queues, counts, detail, directory — all via the user's own client |
| Writes | `src/lib/data/actions.ts` | Ticket mutations, one reviewed RPC each |
| Accounts | `src/lib/data/account-actions.ts` | Authorizes account provisioning and link issuance |

Next.js 16 renamed `middleware` to `proxy`; the file is `src/proxy.ts`. Next's
own guidance treats proxy checks as optimistic and puts real checks in a Data
Access Layer, which is why `src/lib/auth/session.ts` exists and why deleting the
proxy would cost token refresh, not security.

## Trust boundaries

1. **Identity is `auth.uid()`.** No server action, RPC, or SQL function accepts
   an actor id, role, status, or timestamp from a client. The M1 demo passed
   `actorId` and `now` into every operation; those parameters do not exist in the
   database contract.
2. **Role and status come from `app_accounts`**, which no technician can write —
   not from JWT metadata, not from a request body, not from a cookie.
3. **Sessions are verified with `supabase.auth.getUser()`**, which validates the
   token with the auth server, never `getSession()` or raw cookie contents.
4. **Ticket data always travels on the user's own JWT**, so row-level security
   decides what exists. Nothing fetches with the service role and filters in
   JavaScript. Search, ordering, counting and pagination all run inside
   `app_list_tickets`, a SECURITY INVOKER function, so RLS still applies.
5. **Admin operations authorize in the database first.** Every account action
   calls `app_admin_request_*` in the admin's own session; those functions
   re-derive the actor from `auth.uid()` and raise for a technician, an
   anonymous caller, or a deactivated admin — *before* any service-role
   credential is used.
6. **Trusted functions are service-role only.** `app_trusted_finalize_account`,
   `app_trusted_verify_grant` and `app_trusted_complete_credential_action` are
   granted to `service_role` alone and revoked from `authenticated`, so a browser
   cannot reach them even with a forged body.
7. **No state-changing GET** except `/auth/confirm`, which exists because a
   handed-over link is necessarily a GET. It accepts only `token_hash` — no
   `redirect_to`, `next`, or `type` — so there is no open redirect and no way to
   steer the flow from the URL. It redirects immediately to a clean path and
   sends `Referrer-Policy: no-referrer`.
8. **Authenticated pages are never cached.** The `(app)` layout sets
   `dynamic = 'force-dynamic'`, `revalidate = 0` and `fetchCache = 'force-no-store'`
   for the whole subtree, and the root layout holds no client store, so nothing
   authenticated survives a sign-out or crosses accounts.

## Account lifecycle

```
admin creates account ──► setup_pending (no access at all)
        │
        ├─ admin issues setup link ──► credential_action_pending = true
        │         │
        │         └─ /auth/confirm exchanges token ──► restricted session
        │                    │                          (still no ticket access)
        │                    └─ password set + trusted completion ──► active
        │
        └─ later: admin issues recovery link ──► access suspended until completed
```

Rules enforced in the database, not the UI:

- **Activation requires both** a verified, unexpired, unconsumed grant **and** a
  successful password change. Authentication alone, a submitted account id, or
  an ordinary status change can never activate an account. The ordinary
  `app_set_account_status` RPC explicitly refuses `setup_pending` accounts
  (Codex's M2 fix, preserved).
- **A restricted session reaches nothing.** `credential_action_pending` blocks
  all helpdesk access, which is what stops a stolen recovery link from browsing
  tickets before the password actually changes.
- **Recovery never elevates.** It changes the password only: it does not promote
  a role and does not reactivate a deactivated account. Issuing a recovery link
  for an inactive account is refused outright.
- **Partial failure fails closed and is recoverable.** Provisioning reserves a
  row keyed by a unique email first, so a retry returns the same reservation
  rather than creating a second account, and `app_trusted_finalize_account` is
  idempotent. If the password changes but completion fails, helpdesk access remains
  restricted. A fresh administrator-issued link repairs the account; some
  failures permit retry after the two-minute completion lease.
- **One live grant per account.** Issuing a new link supersedes any earlier one,
  matching the provider, and makes the app-level purpose unambiguous.

## Session invalidation

Codex review replaced the original JWT-issuance-time check. Ordinary access now
requires a real provider session with password authentication, created after the
account's revocation cutoff. Refreshing a JWT does not change that session's
creation time, so a revoked session cannot return by refreshing. Deactivation
uses the actual row-update time, including when a transaction waited for a lock.

Private credential state stores a SHA-256 fingerprint of the provider's encrypted
password, never the password or a bearer token. Access requires it to match the
current provider credential. A password change made directly through provider
Auth outside the approved application flow therefore fails closed, including a
subsequent fresh password sign-in. A trusted setup/recovery completion approves
the new fingerprint after transiently verifying the requested password against
the provider's current bcrypt hash under a row lock. Supabase remains the password
writer; this is approval evidence, not a second password store. This integration
depends on the local provider's bcrypt format and auth session/AMR schema; verify
compatibility before provider upgrades or hosted rollout.

Each generated link is bound to the exact grant using a digest of its provider
token. Callback verification binds that grant to the verified provider session.
Completion reserves a short one-winner lease before changing the password, then
checks the same grant/session and provider credential before activation. An old
browser cannot consume another browser's grant, and a superseded token cannot
verify a replacement grant. Failed or uncertain attempts may require a new link;
the lease permits retry after two minutes while the grant remains live.

Cancelled provider tokens may still be exchanged directly with Auth, but their
OTP sessions cannot read helpdesk records. A resulting direct password change
also blocks fresh password sessions until an administrator issues a new recovery
link and the trusted flow completes. This prevents unauthorized record access;
it cannot prevent temporary account disruption through those provider-level
credentials. M4 must explicitly review this tradeoff before deployment.

Restricted setup/recovery screens remain reachable, but the server action checks
exact grant/session authorization before any password mutation. Successful
completion advances the revocation cutoff and signs out the current browser.
The database cutoff remains effective even if provider sign-out fails.

## Provider behaviour we verified

Measured against the local stack rather than assumed:

| Behaviour | Result |
| --- | --- |
| `createUser` without a password | Works; the account has no password until setup |
| `generateLink({type:'invite'})` for an existing user | **Fails** — "already been registered" |
| `generateLink({type:'recovery'})` for a passwordless user | Works |
| Replaying a consumed token | Rejected by the provider |
| Using a superseded token after a new link | Rejected by the provider |
| Newest token after supersession | Works |

Because `invite` is unusable for accounts that already exist, **both setup and
recovery ride on the provider's `recovery` token type**. The app-level purpose
therefore cannot come from the callback URL — it is read from the single live
grant row, which is checked together with the exact token digest and verified session.

Exact token/grant/session association is additionally enforced by migration103.

Link expiry is provider-enforced (`otp_expiry = 3600`) and independently
enforced by `account_credential_grants.expires_at`. Rate limits are the CLI
defaults in `supabase/config.toml`: 30 sign-in/sign-up and 30 OTP verifications
per 5 minutes per IP, 150 token refreshes. A deployment would need these
reviewed, plus a captcha provider, since they are per-IP.

## RPC mapping

| UI action | Server action | Database function |
| --- | --- | --- |
| Sign in / out | `signInAction`, `signOutAction` | Supabase Auth |
| Open setup/recovery link | `/auth/confirm` route | `app_trusted_verify_grant` |
| Set password | `completeCredentialAction` | `app_trusted_complete_credential_action` |
| Create account | `createTechnicianAccountAction` | `app_admin_request_account` + `app_trusted_finalize_account` |
| Issue link | `issueCredentialLinkAction` | `app_admin_request_credential_grant` |
| Cancel link | `cancelCredentialActionAction` | `app_admin_cancel_credential_action` |
| Activate/deactivate | `setAccountStatusAction` | `app_set_account_status` |
| Intake | `createTicketAction` | `app_create_ticket` |
| Claim | `claimTicketAction` | `app_claim_ticket` |
| Return to Open Queue | `returnTicketAction` | `app_return_ticket_to_queue` |
| Reassign | `reassignTicketAction` | `app_reassign_ticket` |
| Collaborators | `add/removeCollaboratorAction` | `app_add/remove_collaborator` |
| Note / device / priority | `addNoteAction`, `recordDeviceAction`, `setPriorityAction` | matching `app_*` |
| Waiting / resume | `setWaitingAction`, `resumeWorkAction` | `app_set_waiting`, `app_resume_work` |
| Log time | `logWorkAction` | `app_log_work` |
| Resolve / reopen / cancel | `resolveTicketAction`, `reopenTicketAction`, `cancelTicketAction` | matching `app_*` |
| Queues, counts, detail | server components | `app_list_tickets`, `app_queue_counts`, `app_ticket_detail` |

## Setup and commands

```bash
npm run db:start                  # local Supabase (needs Docker)
cp .env.example .env.local        # fill from `npm run db:status`
npm run bootstrap:admin -- --email you@edison.example --name "Your Name"
npm run dev                       # http://127.0.0.1:3000
```

`bootstrap:admin` is the only way to create the first administrator. There is no
public bootstrap endpoint and no hardcoded account. It refuses to run against a
non-loopback or linked project, refuses to run if an admin already exists, never
accepts a password as a command-line argument, and prints a generated password
exactly once (or reads one from stdin with `--stdin-password`).

| Command | Purpose |
| --- | --- |
| `npm run check` | typecheck, lint, 81 offline unit tests, production build |
| `npm run test:db` | Resets the local database, runs 122 database tests |
| `npm run test:auth` | Resets the local database, runs 31 auth/lifecycle tests |
| `npm run test:local` | `test:db` then `test:auth`, sequenced |

Both service-dependent suites reset the whole local database and own the same
fixtures, so they must not run concurrently — `test:local` sequences them, and
both are excluded from the offline `npm test`. Each **fails rather than skips**
when the stack is unavailable, and both refuse any non-loopback or linked target.

On this machine Docker Desktop's credential helper is outside the default PATH;
`export PATH="/Applications/Docker.app/Contents/Resources/bin:$PATH"` fixes image
pulls. The test harnesses add it automatically.

## Original Claude test results

All commands run 2026-09-10 against the local stack.

| Command | Result |
| --- | --- |
| `npm run check` | **exit 0** — 80 unit tests in 7 files, clean lint/typecheck, 14-route build |
| `npm run test:db` | **exit 0** — 118 tests in 9 files (M2 baseline preserved) |
| `npm run test:auth` | **exit 0** — 23 tests in 3 files |

The auth suite covers: admin-only account creation with anonymous, technician and
deactivated-admin attempts refused; public signup denied; idempotent duplicate
and retried provisioning; a pending account reaching nothing and being unable to
activate itself by any route; restricted sessions after a link exchange but
before a password is set; replayed, superseded, expired and malformed links;
purpose confusion between setup and recovery; recovery changing the password and
invalidating a **captured raw access token** from another session; access
suspended from the moment a recovery link is issued; admin cancellation restoring
access; recovery never promoting a role or reactivating an inactive account;
deactivation invalidating a captured token with reactivation not reviving it;
identical login failure messages for wrong password, unknown address and
restricted accounts; and an assertion that no link, token, or password appears in
any account table — written so a failure reports booleans rather than echoing the
values.

**Browser verification** (dev server, desktop 1360×900 and phone 375×812):

- Unauthenticated `curl` of `/queue`, `/my-tickets`, `/collaborating`,
  `/resolved`, `/all-tickets`, `/admin`, `/tickets/new` → all HTTP 307 to
  `/login`, with no ticket data in the body.
- Real password sign-in as the bootstrapped admin; no demo switcher exists.
- Admin created a technician (setup pending), issued a setup link shown once,
  containing only a `token_hash` on this app's own origin.
- Opening the link produced a restricted session: fetching `/queue` from inside
  it landed on `/set-password` and leaked no queue markup.
- Setting the password activated the account and signed the browser out.
- Technician signed in; `/admin` and `/all-tickets` redirect to `/queue` with no
  admin markup in the response.
- Technician intake showed channel, date and owner locked; created a real ticket,
  added a note, had a blank solution rejected, then resolved it with no time
  recorded and correct resolver attribution.
- A full reload preserved the ticket, its note, its resolution and 5 activity
  events — data is persisted, not in-memory.
- Two independent authenticated sessions claiming the same ticket at once:
  exactly one winner, loser saw `That ticket is not available to claim.`, one
  `claimed` event, ownership assigned.
- Deactivating the technician mid-session immediately cut off the already-open
  browser session: both the ticket page and `/queue` redirected to `/restricted`.
  Reactivation did not revive that token.
- Phone layout: no horizontal page overflow (`scrollWidth == clientWidth == 375`).
- Build artifacts: the service-role key appears nowhere in `.next/static`, nowhere
  in any build artifact, and in no tracked file.

## Known gaps

1. **Local only.** No hosted project, no deployment, no real accounts or school
   data. Rate limits are per-IP CLI defaults and need review, plus a captcha
   provider, before any deployment.
2. **No automated email.** Links are handed over in person by design. If email is
   introduced later, a sender must be configured and the link must not be
   weakened to suit it.
3. **Review strengthened session revocation.** Session creation time and approved credential fingerprints now enforce the boundary, as described above.
4. **Role changes are not exposed anywhere.** Roles are set at provisioning
   (technician) or by the bootstrap script (admin). Promoting an account is
   deliberately not an application operation.
5. **The demo store still exists as test material.** `src/lib/demo/store.tsx` is
   marked test-fixture-only and is imported by no route, layout, or component;
   the offline unit suite exercises its mutation guard. It must never be
   reintroduced as an auth fallback.
6. **Not covered here:** backup/restore, volume performance, real imports, and
   anything hosted. Those belong to M4.

## Codex review changes

Added migrations103 (credential binding/session enforcement),104 (permitted owner
labels/search, safe owner filters and stable ordering), and105 (actual-time
revocation). Queue loaders recover when a page becomes empty, and URL filters
normalize repeated/malformed pagination values. Auth callbacks are omitted from
Next.js development request logs; production gateway log redaction remains M4.

Added `tests/auth/credential-binding.test.ts`, `tests/db/persisted-queries.test.ts`,
`tests/queue-params.test.ts`, and strengthened the deterministic actor-locking
fixture to use a verified session identity. `scripts/review-m3.cjs` is a repeatable
local-only browser runner using ephemeral accounts. Supply PLAYWRIGHT_MODULE and
CHROME_PATH if using an external Playwright runtime. Run browser checks only after
all reset-based suites finish. Latest final results are in PROJECT_STATUS.md.

The callback returns session cookies on its redirect response and uses the
configured application origin. Next.js can normalize a loopback request URL to
localhost; redirecting there would lose cookies issued on 127.0.0.1. Development
explicitly allows 127.0.0.1 so the password form can hydrate on that origin.
The obsolete whole-second JWT refresh workaround was removed; authorization
now uses the underlying session creation time.


## Codex final review results

September 11, 2026: **M3 local review complete.** `npm run check` passed with
81 unit tests in 8 files, clean typecheck/lint and a 14-route production build.
`npm run test:local` passed sequentially with 122 database tests in 10 files and
31 auth tests in 4 files. All 14 migrations applied on the fresh local database.
The final browser runner passed real account creation, setup, recovery, fresh
password login, old-browser revocation, protected routes, ticket intake, notes,
collaborators, return/reclaim/access loss, resolution without time, reload
persistence, logout and phone layout, with no page runtime errors. The current
service key had zero matches in `.next/static`.

Services remain running with synthetic fixtures. M4 has not started. The provider
cancellation/disruption tradeoff and schema dependencies above remain explicit
hosted-rollout considerations; local verification does not establish production
readiness.
