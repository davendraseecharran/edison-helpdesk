# Edison ticketing — resume here

Checkpoint: September 11, 2026, 2:01 PM America/New_York. **M3 complete; M4 release preparation underway, hosted deployment blocked on Supabase sign-in.** Historical implementation notes below are superseded by the final review record.

## Current state

- Stage: **M3 review complete; ready to plan M4.** M4 has not started.
- Selected stack: Next.js App Router + TypeScript, Vercel Hobby, Supabase Postgres/Auth. Unchanged; not reopened.
- Existing product artifact: TICKETING-PLAN.md. Cross-agent instructions: AGENTS.md, CLAUDE.md, CLAUDE-HANDOFF.md, and this file. New: README.md.
- The application now authenticates and persists: `src/` (auth + data layer + approved UI), `tests/` (81 offline unit), `tests/db/` (122 integration), `tests/auth/` (31 auth), `supabase/` (config + 14 migrations), `docs/M2-DATABASE.md`, `docs/M3-AUTH-AND-INTEGRATION.md`, `scripts/bootstrap-admin.mjs`, gitignored `.env.local`. Still absent by design: Git repository, **hosted** Supabase project, any deployment, any real data.
- Workspace: /Users/davendraseecharran/edison-ticketing.
- Environment observed: macOS, zsh, Node v25.3.0, npm 11.13.0, Python 3.13.7. No runtime was changed. `package.json` declares `engines.node >= 20.9.0`; a supported LTS is preferred for later milestones.
- Source spreadsheet was reviewed read-only in prior turns: 14 tickets. **Real records have still not been imported, and must not be until M4.**
- Active editor/worker: **None; Codex editing ownership released.** M3 review is complete. No helper is editing.
- Next task: see [Exact next task](#exact-next-task).
- Running services: local Supabase Auth/database/API/Studio and `next dev` on port 3000 are running. Docker Desktop was restarted during this continuation. API `http://127.0.0.1:54321`, Studio `http://127.0.0.1:54323`, app `http://127.0.0.1:3000`. Stop Supabase with `npm run db:stop`. Database contains synthetic auth-suite fixtures plus the final browser-run accounts/ticket. Browser passwords were ephemeral and not saved. No hosted or real data.

## M1 implementation summary

Built the local interactive prototype specified in CLAUDE-HANDOFF.md, on synthetic data only.

**Dependencies chosen** (all pinned exactly, one lockfile): next 16.3.4, react/react-dom 19.3.0; dev: typescript 5.9.3, @types/node 26.5.1, @types/react(-dom) 19.3.0, eslint 9.39.5, eslint-config-next 16.3.4, vitest 4.1.11. Two deliberate version decisions:

- **TypeScript 5.9.3, not 7.0.2** (which is current `latest`). TS 7 is the new native compiler; Next 16 and the typescript-eslint chain are not yet a proven pairing with it. Revisit in a later milestone.
- **ESLint 9.39.5, not 10.10.0.** ESLint 10 crashes the `eslint-plugin-react` copy bundled inside `eslint-config-next@16.3.4` (`TypeError: contextOrFilename.getFilename is not a function`). ESLint 9 is what Next 16 targets. Recheck when `eslint-config-next` ships an ESLint 10-compatible plugin set.
- **Vitest 4.1.11, not 5.0.0.** Vitest 5 declares `engines.node ^22.12 || ^24 || >=26`, which excludes the installed Node 25. Vitest 4 accepts `>=24`.

**Files created**

| Path | Purpose |
| --- | --- |
| `package.json`, `package-lock.json`, `tsconfig.json`, `next.config.ts`, `eslint.config.mjs`, `vitest.config.mts`, `.gitignore`, `.env.example` | Scaffold and configuration |
| `README.md` | Setup, scripts, demo entry point, reset behaviour, remaining work |
| `.claude/launch.json` | Local preview configs (`edison-ticketing-dev`, `edison-ticketing-prod`) |
| `src/lib/domain/types.ts` | Entities, shaped like the tables planned for M2 |
| `src/lib/domain/permissions.ts` | Visibility and action rules, one module |
| `src/lib/domain/operations.ts` | Every mutation as a pure `(data, context, input) => result` function |
| `src/lib/domain/selectors.ts` | Queue, search, counts, ticket-detail read models |
| `src/lib/demo/fixtures.ts` | Synthetic dataset (6 accounts, 6 requesters, 11 tickets, 7 devices, 7 notes, 4 work logs, 40 activity events) |
| `src/lib/demo/store.tsx` | Prototype-only state container and demo switcher |
| `src/lib/format.ts` | Date, time, duration formatting |
| `src/app/**` | Routes: `/login`, `/set-password`, `/queue`, `/my-tickets`, `/collaborating`, `/resolved`, `/all-tickets`, `/admin`, `/tickets/new`, `/tickets/[id]` |
| `src/components/**` | Shared UI; `components/ticket/*` are the seven detail panels |
| `tests/**` | 70 Vitest tests across visibility, intake, workflow, accounts |

**Design notes for review:** neutral surfaces with one accent, no gradients or marketing cards, dense sortable tables that become stacked cards on phones, status and priority never signalled by colour alone (text label always present, priority adds a glyph), visible focus rings, a skip link, and a persistent prototype banner. Mutations run through a ~260 ms artificial delay so loading and disabled states are reviewable.

## Original Claude verification

All commands run in `/Users/davendraseecharran/edison-ticketing` on 2026-09-10.

| Command | Result |
| --- | --- |
| `npm install` | Success, 372 packages, one lockfile |
| `npm run typecheck` (`tsc --noEmit`) | Pass, no output |
| `npm run lint` (`eslint .`) | Pass, 0 errors, 0 warnings |
| `npm test` (`vitest run`) | **70 passed / 70**, 4 files |
| `npm run build` (`next build`) | Success, 12 routes; 11 static, `/tickets/[id]` dynamic |
| `npm run check` (all four in order) | **exit 0** |

**Behaviour verified by tests** (`tests/`): unrelated technicians cannot see another technician's assigned or resolved tickets through queues, counts, history, or search; setup-pending and deactivated accounts see nothing; a technician's intake is forced to walk-in and self-ownership, and a forged channel or owner is *rejected* rather than silently corrected; admin intake routes to the Open Queue by default and backdating preserves the real `createdAt`; claiming moves a ticket between queues and a second claim fails; a collaborator can resolve while the primary owner is preserved and the resolver recorded separately; blank and trivial solutions are rejected; resolution needs no time entry; two resolution attempts produce exactly one completion event; person-time totals sum across contributors and "not recorded" stays distinct from zero; removing a collaborator revokes access but keeps their authored notes; admin reassign, return-to-queue, reopen-with-reason, and cancel-with-reason all preserve prior history; account creation starts Setup pending; deactivation revokes access immediately, preserves history, and surfaces live tickets for reassignment; and no serialised state anywhere contains a token, password, or URL.

**Verified visually in a browser** (production build at `http://localhost:3000`, desktop 1360×900 and phone 375×812): sign-in and demo switcher; Open Queue with a working Claim and live count updates; My Tickets; Collaborating; ticket detail with three devices, unknown serial/OS handling, notes with authorship, person-time summary, and the activity timeline; blank-solution validation error; a collaborator resolving while the owner stayed recorded; admin All Tickets and Administration; admin intake creating EDT-1012 into the Open Queue; `/set-password`. On the phone viewport the queue renders as labelled cards with no horizontal page scroll. Four layout bugs were found and fixed this way (switcher row overflow, `.cell-sub` not applying outside the request column, top-bar overflow at 375 px, and stacked-card row width).

Those remaining browser gaps were covered by the Codex review below.

## Codex M1 review — September 10, 2026

Read the handoff, project plan, shared instructions, and source. No Git repository exists, so this was a source inspection rather than a Git diff review. No M2 implementation, hosting changes, imports, or dependency changes were made.

Fixed four concrete issues:

- Overlapping delayed actions could overwrite each other’s in-memory snapshots. The demo store now admits one pending write at a time; another submission receives a retry message. Reset, identity changes, and unmount invalidate old pending actions. This is only single-tab demo protection, not database concurrency.
- Date keys and displayed timestamps depended on the viewer’s timezone despite the school-local requirement. Formatting and synthetic fixtures now use America/New_York, with historical timestamps including the year. Fixture dates are stable across UTC midnight and daylight-saving offsets.
- The password design falsely marked “Different from your school password” as satisfied by any nonempty value. It now gives plain advice and explicitly says the app cannot check the school password.
- The admin ownership selector could retain its previous value after a claim in the People panel. The panel now resets when ticket ownership changes.

Files changed: `src/lib/demo/store.tsx`, new `src/lib/demo/mutation-guard.ts`, `src/lib/demo/fixtures.ts`, `src/lib/format.ts`, `src/app/set-password/page.tsx`, `src/app/(app)/tickets/[id]/page.tsx`, new `tests/demo-mutation.test.ts` and `tests/format.test.ts`, new `scripts/review-m1.cjs`, README.md, and this checkpoint. Next.js automatically appended its framework guidance to AGENTS.md when the dev server started.

Final verification:

- `npm run check` — **exit 0**: typecheck and lint clean; **76/76 tests in 6 files**; production build successful, 12 routes.
- `node /tmp/edison-browser-inspect.cjs` — **exit 0**. This local launcher supplied the bundled Playwright module and installed Chrome to the checked-in `scripts/review-m1.cjs`. README documents the portable environment-variable invocation.
- Browser checked at 1360×900 and 375×812 with the browser timezone deliberately set to America/Los_Angeles. Passed: pending claim cancelled by reset/switch; claiming and empty queue; collaborator resolves with primary owner preserved; blank solution rejection; technician self-assigned walk-in; resolution without time; waiting/resume; admin reassign/cancel/reopen/return to queue; ownership selector refresh after claim; overlapping note and resolution submissions preserve the note on retry; password guidance; no browser runtime errors; no horizontal page overflow on phone queue/detail.
- Desktop queue and phone queue/detail screenshots were inspected. Temporary artifacts: `/tmp/edison-m1-review/`. Browser checks used the development server; the production build was compiled separately.
- Local dev server on port 3100 was stopped after verification; no review processes remain running.

Ready for user design review. Known prototype boundaries below still apply.

## Follow-up: technician return to Open Queue

User requested that technicians can release tickets they cannot finish without losing any added information. Implemented in the People panel for the primary owner or admin, on unfinished tickets only. Collaborators cannot release someone else's ticket. Existing collaborators remain attached. The operation clears current owner, assignment time, and waiting state, sets status Open, and appends an attributed return event; all notes, devices, time logs, ticket information, previous solutions, and prior events are preserved. After a new technician claims it, the former owner follows normal visibility rules (no access unless still a collaborator).

Updated `permissions.ts`, `operations.ts`, `OwnershipPanel.tsx`, the plan/permission matrix, AGENTS.md, README, and browser regression script. Added `tests/return-to-queue.test.ts` covering Assigned/In Progress/Waiting returns, retained contributions and history, queue membership, subsequent claiming/access, and rejection of collaborator/unrelated/inactive/closed-ticket/other-owner reassignment attempts.

`npm run check`: exit 0, typecheck/lint clean, **80 tests in 7 files passed**, production build successful. `REVIEW_BASE_URL=http://localhost:3000 node /tmp/edison-browser-inspect.cjs`: exit 0, including technician return with preserved note and attributed activity, followed by re-claim and resolution. Desktop/phone checks and all existing browser regressions passed without runtime errors. The initial 127.0.0.1 attempt failed because the existing server blocks that development origin; localhost passed without configuration changes. No M2 work or deployment. Next task remains user design review.

## M2 implementation — September 10, 2026 (Claude)

Local Supabase database foundation. Full detail in `docs/M2-DATABASE.md`; this is the checkpoint summary.

### Environment resolved

Docker Desktop **is** installed and running. The earlier preflight failure was a wrong-context check: the `default` context points at `/var/run/docker.sock`, which does not exist, while the active `desktop-linux` context uses `~/.docker/run/docker.sock`, which does. Docker Engine 29.7.2 answered normally.

One real blocker was found and worked around without changing system config: image pulls failed with `docker-credential-desktop: executable file not found in $PATH`. The helper exists at `/Applications/Docker.app/Contents/Resources/bin/`. Prepending that directory to `PATH` fixes it; the test harness adds it automatically when shelling out to the CLI. The user's `~/.docker/config.json` was not modified.

Supabase CLI installed as a pinned devDependency (`supabase@2.117.0`) rather than globally; one lockfile preserved. `@supabase/supabase-js@2.116.0` added as a devDependency for the tests.

### Files added

| Path | Purpose |
| --- | --- |
| `supabase/config.toml` | Local stack config. Public signup disabled, email login enabled, confirmations off, 12-character minimum, realtime/storage disabled, `db.seed` disabled (see below) |
| `supabase/migrations/20260910200000_core_schema.sql` | 8 tables, constraints, indexes, ticket-number sequence, `app_today()` |
| `supabase/migrations/20260910200100_invariant_triggers.sql` | Immutability, date windows, owner≠collaborator, append-only history |
| `supabase/migrations/20260910200200_identity_rls.sql` | Identity helpers, RLS on all 8 tables, grants (SELECT only, `anon` gets nothing) |
| `supabase/migrations/20260910200300_ticket_rpcs.sql` | 15 transactional ticket RPCs |
| `supabase/migrations/20260910200400_account_rpcs.sql` | Account status admin, `app_my_account()`, `app_directory()` |
| `supabase/migrations/20260910200500_lock_down_trigger_functions.sql` | Revokes public EXECUTE from trigger functions |
| `tests/db/support/local-only.ts` | Local-only guard and connection discovery |
| `tests/db/support/identities.ts` | Synthetic identity seeding (ephemeral passwords) |
| `tests/db/support/harness.ts` | Authenticated session helpers, RPC helpers, school-local dates |
| `tests/db/globalSetup.ts` | Fails loudly when the stack is down; provides connection details |
| `tests/db/{schema,visibility,privilege,intake,lifecycle,revocation,concurrency}.test.ts` | 106 integration tests |
| `vitest.db.config.mts` | Separate DB suite config (sequential files) |
| `docs/M2-DATABASE.md` | Schema/mapping, trust boundaries, permission + RPC contracts, transactions, results, gaps |

Files changed: `package.json` (db scripts, two devDependencies), `package-lock.json`, `vitest.config.mts` (excludes `tests/db/**`), `.gitignore` (supabase local artifacts), `.env.example` (notes that M2 needs no env vars), and this file.

**No application source changed.** `src/**` is byte-for-byte as M1 left it, so the approved demo UI — including technician return-to-queue — still behaves exactly as reviewed.

### Commands and results

| Command | Result |
| --- | --- |
| `npm run db:start` | Local stack up: Postgres 17, Auth, PostgREST, Studio |
| `npm run db:reset:local` | All 6 migrations apply cleanly from scratch, repeatedly |
| `npm run test:db` | **exit 0 — 106 tests in 7 files passed** (resets the DB, then runs against the live stack) |
| `npm run check` | **exit 0** — typecheck, lint, **80 unit tests in 7 files**, production build (12 routes). Baseline preserved |
| `npm run test:db:only` with the stack stopped | **exit 1**, `Error: The local Supabase stack is not reachable`, with remediation. It fails rather than skipping |

Security posture verified directly in the database: RLS enabled on all 8 tables; `authenticated` holds SELECT only; **`anon` holds no table privilege and no EXECUTE on any function**; every SECURITY DEFINER function has a fixed `search_path`; internal helpers are revoked from all client roles.

### What the integration tests prove

All authorization assertions run through real signed-in sessions over PostgREST, not through the TypeScript predicates. The service role only seeds identities and reads ground truth; it never performs an operation whose authorization is under test.

Visibility (unrelated/inactive/setup_pending/anonymous leak nothing, on parent and every child table); direct INSERT/UPDATE/DELETE refused on every table for technicians *and* admins; no self-elevation of role or status; authorship and timestamps always server-derived; backdating preserves the real creation instant; technician intake forced to walk-in/self-owned/today with forged fields **rejected**; a failed intake rolls back completely; owner and collaborator resolution with no time recorded; blank and trivial solutions refused; reopen then re-resolve retaining both completion events; return-to-queue preserving every contribution and collaborator, re-queued, reclaimable, with the former owner losing access while keeping authorship; deactivation and collaborator removal revoking access **on an already-open session**; and genuine concurrency — two and six simultaneous claims, two resolutions, resolve vs return, contribution vs close/removal, parallel intake, deactivation vs contribution — each asserting exactly one coherent final state with no duplicate events and no partial mutation.

### Deliberate decisions Codex should confirm

1. **A failed claim never names the owner** (the handoff's requested privacy adjustment). Missing, invisible, already-owned and non-open tickets all return `That ticket is not available to claim.` This intentionally differs from the M1 demo message; M3's UI must use this contract.
2. **Technicians cannot backdate a walk-in.** M1 left this open and the UI simply defaulted to today; the database now rejects it outright.
3. **Zero-minute work logs are rejected**, keeping "not recorded" unambiguous.
4. **Rule worth a decision:** a return to the Open Queue preserves collaborators, and a collaborator can then resolve the now-unowned ticket, giving a resolved ticket with no primary owner. This follows the existing M1 rules rather than adding anything, and the concurrency test accepts it as one of two coherent outcomes. If releasing work should also end collaborator authority, that is a small change to `app_resolve_ticket` plus a test.
5. **No `seed.sql`.** Seeding would require committing a password for a synthetic auth user; identities are created ephemerally by the harness instead. `db.seed` is disabled in config.toml to avoid a misleading warning.
6. **Account creation and credential links are deliberately absent.** M2 exposes no RPC that would make the M1 mockup's simulated setup/recovery actions look like working security operations. That is M3.

### M2 gaps

- The UI is still demo-backed; no screen reads or writes this database. That is M3.
- No account onboarding or password recovery; accounts exist only via a privileged inserter (the test harness).
- Backup/restore, volume performance, and anything hosted are untested — M4.
- No Git repository exists, so there is no commit or branch for this work; all changes are uncommitted files on disk.

## Codex M2 review — September 10, 2026

Inspected the handoff, schema, triggers, grants/RLS, RPCs, harness, and integration coverage. Original `npm run check` passed (80 unit tests plus lint/typecheck/build), and original `npm run test:db` passed (106 tests). No Git repository exists; this was a source review.

Found and fixed three issues with additive migrations:

1. **NULL ownership permission bypass.** `NOT(NULL)` skipped rejection in SQL. Unrelated technicians could add notes/devices/time, change priority, resolve unclaimed work, or alter collaborators; invisible unowned closed tickets also leaked status through RPC errors. Added migration `20260910200600_null_safe_authorization.sql` and `tests/db/unowned-authorization.test.ts`. Eight of nine initial regression tests failed against the original implementation, proving the gap independently of Claude's suite. NULL owner comparisons now produce false, and existing RPC privileges are preserved.
2. **Stale authorization during deactivation.** A write checked its actor before waiting for the ticket lock and could continue after deactivation. Migration `20260910200700_actor_locking.sql` uses shared transaction advisory locks for mutations and exclusive locks for account status changes, taken before authorization reads. Writes stay parallel; status changes serialize against them. Deterministic tests observe actual blocked locks and validate both orderings, rather than accepting either result without establishing order.
3. **Pending setup bypass.** The ordinary status RPC could activate a setup-pending account (including indirectly through inactive). It now manages active/inactive accounts only; pending setup completion is reserved for the trusted M3 flow.

Final verification: `npm run test:db` **exit 0, 118 tests in 9 files**, after all eight migrations replayed cleanly. `npm run check` **exit 0, 80 tests in 7 files**, clean typecheck/lint, successful 12-route production build. The database tests used local synthetic data and authenticated requests; the new ordering tests use local SQL transactions only as deterministic barriers and for one authenticated status operation. No application source or dependency changes in this review.

The database test command initially hit the Codex filesystem sandbox on CLI telemetry; rerunning through normal tool approval succeeded. Local Supabase remains running with synthetic test data. No M3, hosted provisioning, deployment, or real imports performed.

Accepted implementation choices: failed claims use a generic message; technician walk-ins are today-only; time is optional and recorded entries are positive minutes; collaborators remain attached and can resolve returned work. Ephemeral auth fixtures are appropriate; absence of seed.sql is a harness choice, not a technical requirement to commit passwords. M3 must use the database contracts and the account-locking protocol, and must not reuse the demo's identity switcher or simulated setup completion as authentication.

## M3 implementation — September 10, 2026 (Claude)

Real local authentication, trusted admin-managed account setup/recovery, and persisted ticketing. Full detail in `docs/M3-AUTH-AND-INTEGRATION.md`.

### Dependencies

Added `@supabase/ssr@0.12.7` and `server-only@0.0.1`; promoted `@supabase/supabase-js@2.116.0` from devDependency to dependency (it is now application runtime code). All pinned exactly, one lockfile.

### Files added

| Path | Purpose |
| --- | --- |
| `src/lib/supabase/{config,server,browser,admin}.ts` | Client boundaries; config validation with a clear setup error |
| `src/lib/auth/session.ts` | Data Access Layer: `getUser()` verification + database-sourced role/status |
| `src/lib/auth/{actions,credential-actions}.ts` | Sign-in/out; trusted setup/recovery completion |
| `src/proxy.ts` | Session cookie refresh (Next 16 renamed `middleware` → `proxy`) |
| `src/lib/data/{tickets,mapping,actions,account-actions,admin-view}.ts` | Authorized reads, row mapping, ticket mutations, account administration |
| `src/lib/directory.ts`, `src/lib/useNow.ts` | Attribution labels; shared clock extracted from the demo store |
| `src/components/AppRuntime.tsx` | Client runtime replacing the demo store; holds no ticket dataset |
| `src/components/auth/*`, `src/components/admin/AdministrationScreen.tsx` | Login, set-password, sign-out, administration |
| `src/app/auth/confirm/route.ts`, `src/app/restricted/page.tsx` | Link callback; restricted-account screen |
| `supabase/migrations/20260910210000_m3_account_lifecycle.sql` | Credential grants, provisions, audit, access gates, trusted RPCs |
| `supabase/migrations/20260910210100_m3_ticket_queries.sql` | SECURITY INVOKER queue/detail/count readers |
| `supabase/migrations/20260910210200_m3_test_support.sql` | Service-role-only token ageing, so expiry is testable |
| `scripts/bootstrap-admin.mjs` | Local-only first-admin bootstrap |
| `tests/auth/**`, `vitest.auth.config.mts` | 23 authentication tests |
| `docs/M3-AUTH-AND-INTEGRATION.md` | Architecture, trust boundaries, results, gaps |

Rewritten: all `src/app/(app)/**` pages (server components reading the database), every `src/components/ticket/*` panel (server actions instead of demo operations), `TicketListView` (URL-driven, server-side filtering and pagination), `AppShell`, `login`, `set-password`, root layout. Changed: `package.json`, `vitest.config.mts`, `.env.example`, `README.md`, `src/lib/format.ts` (added `schoolToday`).

The approved M1 layout, wording and components are preserved; what changed underneath them is where the data and the identity come from.

### Commands and results

| Command | Result |
| --- | --- |
| `npm run check` | **exit 0** — 80 unit tests in 7 files, clean typecheck/lint, 14-route build |
| `npm run test:db` | **exit 0** — **118 tests in 9 files** (M2 baseline preserved) |
| `npm run test:auth` | **exit 0** — **23 tests in 3 files** |

Browser verification (desktop 1360×900, phone 375×812), recorded in full in the M3 doc: anonymous `curl` of all seven protected routes returns 307 to `/login` with no ticket data; real password sign-in; admin created a technician and issued a setup link shown once; the link produced a restricted session that could not reach `/queue`; setting the password activated the account and signed the browser out; a technician was redirected away from `/admin` and `/all-tickets`; technician intake locked channel/date/owner; a real ticket was created, noted, had a blank solution rejected, and was resolved with no time recorded; a full reload preserved everything; two concurrent sessions claiming one ticket produced exactly one winner and one event; deactivation cut off the already-open browser session immediately and reactivation did not revive that token; no horizontal overflow on the phone; and the service-role key appears in no client bundle, no build artifact, and no tracked file.

### Two M2 tests deliberately updated

M3 strengthens deactivation: it now moves `sessions_valid_from` forward, so tokens minted before it are refused permanently. Two M2 tests asserted the older, weaker behaviour and were updated, with the reasons in the test comments:

1. `tests/db/revocation.test.ts` — "reactivation restores the same live session" became the stronger assertion that the pre-deactivation token stays refused and only a fresh sign-in works.
2. `tests/db/visibility.test.ts` — the `app_my_account()` field list gained `credential_action_pending` and `session_is_current`, both about the caller's own session. No other account's email or credential metadata is exposed.

A `resignIn` helper was added to the database harness for the same reason. All 118 database tests pass unchanged otherwise, including Codex's NULL-safety and advisory-lock regressions.

### Defects found and fixed during this work

- **`count(*)` over a LEFT JOIN** reported 1 ticket on an empty database, so the admin "All Tickets" badge showed 1 when there were none. Now `count(t.id)`.
- **Token-currency check refused callers with no JWT claims**, which broke the legacy `request.jwt.claim.sub` path used by Codex's deterministic locking tests. Scoped so the check only applies once an account actually has an invalidation cutoff — it is a revocation mechanism, not an authentication one.
- **The one-second `iat` boundary** made revocation timing-dependent. Resolved by refusing the cutoff second (fail closed) and having `signInAction` re-mint a token once the clock moves on, rather than loosening the comparison.
- **A secret-leak test echoed the payload on failure.** Rewritten to reduce to booleans first, so a failure never prints the values it is checking for.

### Decisions Codex should confirm

1. **Both setup and recovery use the provider's `recovery` token type.** Measured: `generateLink({type:'invite'})` fails for an already-registered user, and every account here is created before a link is issued. The app-level purpose therefore comes from the single live grant row, never from the callback URL — which removes wrong-purpose confusion entirely.
2. **Issuing a link suspends the account's access** (`credential_action_pending`) until the action completes or an admin cancels it. This is what stops a stolen recovery link from reaching tickets before the password changes, at the cost that an accidental link temporarily locks someone out; admins can cancel.
3. **Session invalidation is database-enforced**, because the provider cannot revoke another browser's outstanding access token in this SDK version. Proven against a captured raw token, not inferred from an API success.
4. **Deactivation now also invalidates outstanding tokens**, a strengthening of M2 behaviour (see the two updated tests).
5. **Role changes are not an application operation.** Roles are set at provisioning or by the bootstrap script.
6. **`/auth/confirm` is the only state-changing GET**, accepting only `token_hash`, redirecting immediately, with `Referrer-Policy: no-referrer` and no redirect parameter of any kind.

### M3 gaps

- Local only: no hosted project, deployment, real accounts, or school data.
- Rate limits are the CLI defaults and are per-IP; a deployment needs them reviewed plus a captcha provider.
- No automated email; links are handed over in person by design.
- A sub-second revocation boundary exists by construction (JWT `iat` is whole-second); the sign-in path compensates, and anything bypassing the app is simply refused.
- `src/lib/demo/store.tsx` remains as test-fixture material only, imported by no route; it must never return as an auth fallback.
- No Git repository exists, so there is no commit or branch for this work.

## UI prototype limitations — database reviewed separately above

1. **The demo user switcher is not authentication.** It checks no password, issues no token, and creates no session. It must never become a sign-in path.
2. **Permission checks are not access control.** Everything in `permissions.ts` runs in the browser and is bypassable with developer tools. It documents the intended rules; it enforces nothing. Real enforcement = Supabase Auth + row-level security (M2/M3).
3. **Nothing proves concurrency safety.** The "already claimed by …" and "already resolved by …" guards are single-tab checks against in-memory state. One-winner claiming and single-completion resolution require atomic database operations, which the reviewed M2 database provides; the UI has not yet been connected.
4. **No persistence.** All state is React state in one tab; a reload rebuilds the fixtures. Nothing is written to storage, cookies, or a server.
5. **One deliberate disclosure to review.** `claimTicket` names the current owner when a claim loses the race, because the workflow in TICKETING-PLAN.md requires the loser to see the updated owner. It is the only path that reveals anything about a ticket outside the caller's queue. In M2 this must be scoped server-side (answer only for a ticket the caller could see as claimable) so the claim endpoint cannot be used to probe ownership by ticket id. Every other operation returns an identical "not available" message whether a ticket is missing or merely invisible.
6. **No real data, no credentials.** Every person, device, serial, asset tag, and ticket is invented; emails use the reserved `edison.example` domain. Password design inputs remain temporary component state only; use invented values. No password is persisted or transmitted, and no setup or recovery link or token is generated, shown, or logged — Administration only records that an admin took an action.
7. **Prototype-only conveniences:** the artificial mutation delay, and fixtures anchored to the current date with fixed times of day.

## Decisions taken during M1 that a reviewer should confirm

- Technician walk-ins are dated today; only an admin may backdate. TICKETING-PLAN.md left this open.
- Participants (not only admins) may change priority, and every change is logged. TICKETING-PLAN.md left this open.
- Notes, devices, and priority edits are blocked once a ticket is resolved or cancelled; an admin must reopen. Work logs remain allowed after resolution, per the plan's time-tracking rules.
- Reopening keeps the recorded solution visible as the previous solution and clears only `resolvedById`/`resolvedAt`.
- The Resolved view holds cancelled tickets too, labelled distinctly and never counted as resolutions.
- A solution must be at least 5 characters after trimming, to discourage "ok" as a resolution.

## Confirmed scope

Seven technicians, 20–40 incoming tickets/day, often resolved the same day. School email + separate user-chosen app password. Admin manages accounts. Admin creates all channels and routes to Open Queue by default or to a technician. Technicians can create self-assigned walk-ins and add collaborators. Technicians see only open claimable tickets and owned/collaborating tickets. Owners/collaborators can resolve with a solution, without admin approval or required time entries. Priority and optional manual time tracking included. Attachments/email deferred. Inventory and people migration follow ticketing; the new system eventually becomes authoritative.

## Codex subscription and usage snapshot

Live tool read September 11, 2026 near 1:24 PM EDT: **Plus**, five-hour usage **27%**, weekly usage **36%**, no reported rate limit. Five-hour reset September 11 at 6:16:53 PM EDT (1789165013); weekly reset September 17 at 8:22:05 PM EDT (1789690925). One reset credit available; no reset consumed by this review.

These account-wide readings can change with other work; they do not predict when a cap will be reached. No automatic wakeup is configured. Resume with a user message and re-read live usage. Persistent handoffs, not chat memory, are the continuation source.

## Milestones

| Milestone | Status | Exit condition |
| --- | --- | --- |
| M0 Requirements/platform | Complete | Scope captured in TICKETING-PLAN.md |
| M1 Local interactive prototype | **Approved by user (2026-09-10)** | Next.js runs locally; core demo flows work with synthetic data; desktop/mobile checked |
| M2 Database and access enforcement | **Reviewed and fixed by Codex (2026-09-10)** | SQL migrations, RLS, atomic operations, synthetic integration tests |
| M3 Real account setup and ticketing integration | **Reviewed, fixed and locally verified by Codex (2026-09-11)** | Password setup/recovery and real persisted workflows validated |
| M4 Pilot preparation/deployment | Not started | Imports reviewed, recovery tested, deployment configured and verified |
| Later inventory/directory/public form | Deferred | Separately scoped after pilot |

## Verification in the earlier planning handoff turn

- Listed workspace and confirmed only the plan existed before adding continuity files.
- Read live usage and converted reported Unix reset timestamps to America/New_York.
- Reviewed official Codex pricing/subagent documentation; usage depends on task/model/context/tool work and cannot be predicted precisely.
- Used one read-only subagent to review the milestone scope and security boundaries.
- Checked continuity-file references and scope alignment. No application tests/build existed to run at that point.

(M1's own verification is recorded in [Original Claude verification](#original-claude-verification) above.)

## Final Codex M3 review

**Complete for local M3.** No hosted project, deployment, real accounts/data, Git repository, commit/branch, or M4 work. The older M1 limitations and original Claude findings above are historical; the authenticated application uses database enforcement and persistence.

Changes made during review:

- Migration103 binds each provider token digest to the exact live grant and verified session, reserves completion, and validates the changed provider credential before activation. Direct/cancelled provider tokens cannot bypass application access controls. Old sessions stay revoked after refresh, recovery, and reactivation.
- Migration104 repairs permitted owner labels/search through the minimal directory, malformed owner filters, and deterministic ordering. Queue loaders fall back to page one if a page becomes empty; URL parameters are normalized.
- Migration105 consolidates deactivation triggers and records the actual update time so lock waits cannot leave a newly created session valid. The deterministic locking fixture now carries a verified provider session identity.
- `/auth/confirm` returns cookies on its redirect and uses the configured application origin. This fixes Next's 127.0.0.1-to-localhost normalization losing the browser session. `allowedDevOrigins` permits the loopback host to load development assets. Callback request URLs are omitted from Next development logs.
- Removed the obsolete whole-second JWT refresh workaround. Updated README and auth documentation; added repeatable local browser coverage and DB/auth/URL regressions.

Final verification on September 11, 2026:

| Check | Result |
| --- | --- |
| `npm run check` | Exit 0: 81 unit tests / 8 files, clean typecheck/lint, production build / 14 routes |
| `npm run test:local` | Exit 0, sequential resets: 122 DB tests / 10 files; 31 auth tests / 4 files |
| `scripts/review-m3.cjs` with bundled Playwright and installed Chrome | Exit 0 after final reset: real setup/recovery/new-password login, old-browser revocation, protected routes, intake, collaborators, notes, return/reclaim/access loss, solution without time, reload persistence, logout, phone layout; no page runtime errors |
| Current service-role key scan of `.next/static` | 0 matches; key not printed |

Browser invocation on this machine:

```bash
PLAYWRIGHT_MODULE=/Users/davendraseecharran/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node scripts/review-m3.cjs
```

Run reset suites sequentially, never during browser tests. Screenshots are local synthetic artifacts in `/tmp/edison-m3-review`.

Material deployment consideration: provider cancellation does not revoke its recovery token itself. OTP sessions cannot access helpdesk records; direct password changes fail the approved-credential fingerprint check. Misuse can temporarily disrupt an account, recoverable through a fresh admin-issued recovery flow. The implementation depends on provider bcrypt and auth session/AMR schema. Review these dependencies and the disruption tradeoff during M4 before rollout. Hosted logging, rate limits, backups/restoration and real-data handling remain unverified.

## Exact next task

M3 needs no further implementation to close its local review. On the user's instruction to proceed, prepare a concrete M4 handoff: local pilot/volume checks and backup/restore rehearsal first; then hosted configuration and logging/rate limits, authorized account setup, reviewed import mapping/reconciliation, and a small pilot. Do not reopen platform selection. Do not deploy or import real records as part of this completed M3 review. Read `docs/M3-AUTH-AND-INTEGRATION.md` for the provider dependencies before planning hosted work.

Claude continuation instruction: “Read AGENTS.md, PROJECT_STATUS.md and docs/M3-AUTH-AND-INTEGRATION.md. Codex completed M3 review on September 11. Use the final review record over historical checkpoints. Keep M3 fixes and tests intact. M4 has not started; proceed only with the M4 scope the user authorizes. Use local synthetic data and keep ownership/checkpoints current.”

## Resume protocol

1. Read this file and AGENTS.md; inspect actual files and Git status if Git exists. Treat actual state as authoritative over this checkpoint.
2. Recheck Codex usage if available. Claude records its own known limit status without inventing Codex access.
3. Confirm no other tool is actively editing the target files; record current worker and bounded task here.
4. Execute the next milestone or the user's chosen task, preserving prior work.
5. Record changed files, exact verification commands/results, known gaps, active processes, and the next step. Release editing ownership.

When Claude returns work, Codex should inspect the diff/source, run the documented checks, test the main flows, fix actionable findings, and update this checkpoint before starting the next milestone.

## M4 deployment planning — September 11 follow-up

User prioritizes deployment as soon as possible. Use Luna at max reasoning for bounded helpers with short fresh contexts; primary reviews results. One read-only helper reviewed deployment blockers. M3 remains complete. No hosted mutations or M4 implementation yet.

Next work: prepare a guarded hosted first-admin bootstrap (existing script is local-only), separate test-only SQL support from deployable migrations, validate hosted provider/schema assumptions, and document exact hosted Auth settings and environment variables. Establish source history/private repository for repeatable releases. Deploy an empty authenticated pilot first and verify setup/recovery/access boundaries on HTTPS with synthetic accounts. Establish backup/restore before live ticket entry; historical imports and inventory are not prerequisites for the first deployment.

Asked user which GitHub/Vercel/Supabase accounts and projects already exist; no secrets requested. Hosting remains Vercel + Supabase. Configure production credentials separately from previews/local tests; never run reset-based tests on hosted data.

## Active M4 deployment checkpoint

User authorized connecting accounts, creating private GitHub/Vercel projects, deploying to supplied Supabase project lfqlkngxgefoaijuuvvx, and creating first admin Jessie Kalloo (jkalloo@schools.nyc.gov). No ticket/import data authorized in this turn.

Root owns release/repository/deployment. Luna max helpers own hosted bootstrap and moving test-only SQL. Git initialized on main; private repository created: https://github.com/davendraseecharran/edison-helpdesk. Vercel project created/linked: thomas-edison-cte-high-school/edison-helpdesk, project prj_9NEP7fDNQMsXUpI9VQ4KSfKE7BwL. Git connection failed because Vercel requires user to connect GitHub under Login Connections; CLI deployment remains possible. No commit/push/deployment yet.

GitHub authenticated as davendraseecharran; Vercel authenticated as daseecharran-7648. Supabase CLI browser login awaits verification code in terminal session22664; no hosted access yet. Vercel sign-in session44542 may have finished. Never save credentials in this checkpoint.

Root pinned deployment runtime Node24.x, added .nvmrc and deployment/secret ignores. Existing .env.local preserved, Vercel added an OIDC token; file remains ignored. First auth-suite attempt after test-helper separation failed during helper SQL installation; Luna repairing it, not an application test failure. Must rerun auth/check before commit.

Usage at start: Plus, five-hour45%, weekly39%; reset September11 18:16:53 EDT / September17 20:22:05 EDT. No reset credit consumed.

### M4 checkpoint at usage threshold

Live usage now five-hour85%, weekly45%; same reset times. No reset redeemed. Vercel project configured Next.js/Node24.x/npm ci/npm run build. GitHub private repo verified. `npx --yes --package=node@24 -c 'node --version && npm run check'` passed under Node24.21.0:81 unit tests, lint/typecheck/build. Source candidate scan found no current service-key or OIDC-token matches.

Supabase still awaits interactive verification in session22664. User can run `npx --no-install supabase login --agent no --output-format text` in their own Terminal if this session is inaccessible; enter the browser verification code directly there. Vercel CLI authorization completed. GitHub auto-deploy connection requires Vercel Settings > Login Connections > GitHub; direct CLI deployment is an available alternative.

Luna migration helper's CLI SQL install failed; root interrupted helper and replaced installation with fixed local Docker container psql stdin (after local guard/reset). Auth regression running session43945. Hosted bootstrap helper asked to finish at threshold; review its actual output before use. No Supabase mutation, real admin account creation or application deployment yet.

### Verified release preparation handoff

Root repair passed `npm run test:auth`:31 tests/4 files, exit0. Final typecheck/lint also passed. Both Luna helpers stopped; no ongoing file ownership. Hosted bootstrap was NOT implemented; no bootstrap files exist. Preserve local bootstrap guards. Next worker must implement the guarded operator-only hosted first-admin path compatible with exact token/grant/session binding, then review/test before creating Jessie. Do not assume delegated work is done.

Next exact tasks after Supabase browser authorization: verify exact hosted project and empty schema; prepare/test hosted bootstrap; apply migrations with no test helpers/seeds; configure Auth; inject production-only secrets into Vercel; deploy; verify HTTPS synthetic workflows and backup/restore before live use. Current .env.local remains LOCAL; never deploy its values. See docs/M4-DEPLOYMENT.md.

Claude instruction: Read AGENTS.md, the latest checkpoint in PROJECT_STATUS.md and docs/M4-DEPLOYMENT.md. Continue the authorized M4 deployment to project lfqlkngxgefoaijuuvvx. GitHub and Vercel projects now exist; Supabase CLI sign-in may still be pending. Do not recreate them. Preserve reviewed M3 auth controls and the local-only test setup. Hosted first-admin bootstrap remains unimplemented. User supplied Jessie Kalloo / jkalloo@schools.nyc.gov as the first app admin. No passwords or secrets in chat/logs. Verify and checkpoint actual actions; no real ticket imports.
