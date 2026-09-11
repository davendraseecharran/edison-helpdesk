# Executable handoff — M3 real accounts and persisted ticketing

User approved M1 and Codex completed M2 review; user now authorized M3. Claude implements, Codex reviews independently. Read AGENTS.md, PROJECT_STATUS.md, TICKETING-PLAN.md, docs/M2-DATABASE.md and migrations 006/007 before editing. Prior handoffs are docs/handoffs/M1.md and M2.md.

## Scope

Connect the approved Next.js interface to LOCAL Supabase Auth and persisted ticketing. Implement school email plus a separate user-set app password, admin-managed accounts, privately delivered single-use setup/recovery links, and every approved ticket workflow. Use synthetic identities only. No Google OAuth/SSO, public signup, automated email, attachments, directory/inventory migration, hosted provisioning, deployment, or real imports. No actual technician emails or passwords need to be collected for this milestone.

Record editing ownership in PROJECT_STATUS.md; work sequentially. Preserve existing work, pinned compatible dependencies and one lockfile. Checkpoint after auth, account flows, persisted ticketing, and verification. If interrupted, record exact commands/results and next action. Do not claim completion when blocked. Release ownership at handback.

## Preflight and implementation order

1. Confirm local Supabase is running (last observed API 54321, DB 54322, Studio 54323). Existing next dev on 3000 may also be running; do not silently interrupt it. Read package scripts and local-only guards before reset. DB reset destroys synthetic state: run only against the explicit local stack, never a linked/remote project.
2. Read current official Supabase and installed Next.js documentation for SSR auth/cookies, session verification, password setup/recovery, Admin generateLink, OTP verification, refresh/revocation and cache behavior. Document the implemented contracts and provider limitations, with official sources. Do not infer behavior from M1 simulations.
3. Build authenticated server/browser client boundaries and session handling, then trusted account provisioning/setup/recovery, then replace the demo store with authenticated database reads/RPCs. Keep changes reviewable in stages; do not rewrite the approved layout.
4. Use additive migrations for M3 schema/security changes. Preserve all M2 regressions, particularly NULL-safe checks and deactivation locking. Trusted status/role/setup mutations must coordinate with migration007's advisory-lock protocol. No client-controllable setup completion or role promotion.

## Authentication and account lifecycle

- Real login uses a school-email identity and separate app password managed by Supabase Auth. Do not implement password hashing/storage. No shared temporary passwords. Normalize emails consistently; authorized account membership is the gate, not merely an email suffix. Keep role/status in protected database records.
- Public signup remains disabled. Bootstrap only the first synthetic admin through a local-only trusted script; no public bootstrap endpoint or hardcoded account/password. Provide a repeatable setup procedure using ephemeral/in-memory test credentials or private terminal input without printing passwords. Do not write secrets to tracked files, screenshots, command arguments, or logs.
- Active admin creates technician accounts through a server-only operation. Verify the current session and live admin status for every privileged operation before using provider admin credentials; technician-supplied actor/role/status/redirect values are never trusted. Creation starts setup_pending. Protect against duplicate/retried creation and partial failure between Auth and app-account insertion; make retries recoverable and avoid unusable orphan accounts.
- Admin generates a single-use, expiring setup link and copies it for direct private delivery. Display it only in the authorized result flow, not persistent history. Login directs forgotten-password users to the admin. Admin can issue recovery links after their out-of-band identity check. No automated email needed.
- Use supported provider link/token primitives where feasible. Prove expiry, replay rejection, and superseded-link invalidation. Do not invent an insecure substitute when provider semantics differ; implement the smallest secure server-side control required and document it. Never store raw link/token values in audit records or analytics. Avoid credential-bearing query logging/referrers and open redirects; allow only known local app callback destinations, later configurable for production.
- Account activation requires verified setup authorization AND successful password setting. Plain authentication of a setup_pending user, a submitted account id, or a normal status change must not activate it. Recovery updates password without elevating role or reactivating an inactive account. Password and activation operations may span systems: define retry/failure behavior that fails closed.
- Completed recovery revokes old sessions. Test stale access and refresh tokens, not just logging out the recovery browser. If provider revocation leaves access tokens valid until expiry, enforce the required invalidation in the application/database; do not claim immediate revocation without evidence. Restricted recovery/setup sessions must not provide ordinary ticket access before the intended completion.
- Login errors must be useful without disclosing account existence/status to unauthenticated probes. Signed-in pending/inactive users get an appropriate restricted screen. Logout clears session cookies and authenticated UI data. Add reasonable server/provider rate limits to credential and privileged link actions; document local settings and deployment dependencies.
- Provider admin/service credentials are server-only. Use authenticated user JWTs for normal ticket queries and mutations so RLS remains enforced. Do not fetch all tickets with a service-role client and filter in JavaScript. Verify sessions using the documented server verification approach, not untrusted cookie contents alone. Protect state-changing server endpoints against cross-site requests; no state-changing GETs other than explicitly secured auth callback exchanges.

## Persisted interface

Preserve Open Queue, My Tickets, Collaborating, Resolved, admin All Tickets/Administration, intake, and ticket detail. Use documented SQL-to-TypeScript mapping. Persist via the reviewed RPCs; do not send the whole browser dataset to the backend. Refresh affected queries/counts after mutations and handle concurrent changes gracefully.

Required workflows: admin intake defaults open/unassigned or explicitly assigned, any approved channel, backdated submission separate from creation timestamp; technician walk-in self-owned/today; requester selection/new minimal requester/unknown; optional device observations; claim; collaborators; notes; priority; waiting/resume; optional positive-minute time logs; owner/collaborator resolve with solution and no time requirement; admin reassign/reopen/cancel; primary owner/admin return unfinished work to Open Queue.

Return preserves collaborators, notes, devices, time entries, past solutions and history. A collaborator can still help/resolve returned work, but cannot manage its collaborators without ownership. A former owner who no longer has access after another technician claims must see a safe unavailable state. Failed claims use the database's generic message, never disclose an invisible ticket's owner.

Search, filtering, counts and pagination must apply to authorized database data, with coherent ordering and no hidden records leaked through totals. Keep year/date behavior in America/New_York and separate date keys from timestamps. Retain authorship using minimal directory labels, without leaking account email/credential metadata. Avoid cross-user caching of authenticated pages, loaders, API responses or client state. Clear/reload caches on logout/account change/deactivation; verify direct route access and child data restrictions.

Remove the demo identity switcher, simulated mutations and Reset demo data controls from the authenticated app. Prefer a separate explicitly isolated preview route/build if preserving M1 is useful; it must not become an auth fallback when config is missing or login fails. Development-only demo code must never grant production access. Missing configuration should produce a clear setup error. Keep neutral, modern desktop/phone layouts with useful loading, empty, validation, pending and error states; prevent duplicate submissions.

## Required verification

Maintain `npm run check` and `npm run test:db` (baseline 80 unit tests, 118 DB tests; justified replacements/extensions can change totals). DB tests must fail if the local stack is unavailable. Add reproducible local auth/integration/browser test commands with positive local-only guards before any reset or seeded writes. Avoid concurrent suites sharing destructive fixtures.

Prove with real synthetic accounts and sessions:

1. Password login/logout, session refresh, direct protected-route rejection, persistence after browser reload and server restart, and no credentials/session state crossing users.
2. Active admin-only account creation and link issuance; technician/anonymous/inactive attempts through direct requests fail. Public signup remains denied; forged role/status/actor/redirect parameters fail. Duplicate provisioning/retry and partial failure recovery leave consistent restricted accounts.
3. Pending account cannot reach ticket endpoints or activate itself. Valid setup sets the chosen password and completes activation through the trusted flow. Expired, replayed, superseded, wrong-purpose and malformed links fail. Interrupted/failed setup cannot grant access prematurely.
4. Recovery changes password; old password and prior sessions cannot access helpdesk data afterward. Inactive account stays inactive. Recovery tokens cannot promote an account or complete an unrelated pending account. Actual session invalidation behavior is asserted, not inferred from provider API success.
5. Two browser contexts show one-winner claim; collaborator resolution preserves owner/resolver; all ticket changes persist after refresh. Return-to-queue preserves contributions, allows reclaim, and then revokes former-owner access where required. Optional time never blocks resolution.
6. Deactivation/collaborator removal affect existing sessions and direct API calls; unauthorized users cannot read ticket child rows, search results, totals, cached pages or stale data after an account switch. Keep M2 NULL and deterministic locking tests green.
7. Admin account screens and all ticket workflows work on desktop and phone. No browser runtime errors, horizontal page overflow, or live demo shortcuts. Check pending/error states and denied access after mid-session changes.
8. Review browser bundles, logs and generated artifacts for server keys/passwords/setup/recovery tokens. Automated checks must avoid echoing matching secret values on failure. Test protected server actions through direct requests, not only hidden buttons.

Do not invent success for hard auth cases. If a provider limitation or missing prerequisite prevents an acceptance test, describe the exact gap, complete independent work, and leave M3 incomplete for review.

## Deliverables and stop

- Real authenticated Next.js routes, server-only admin account operations, persisted ticket data layer, additive migrations as needed, local-only bootstrap/test scripts, and automated auth/browser coverage.
- `.env.example` with placeholders and clear public/server-only distinctions; ignored local config can use local runtime values without printing them. No secrets in versioned artifacts.
- `docs/M3-AUTH-AND-INTEGRATION.md`: architecture, session/link trust boundaries, activation/recovery failure handling, token invalidation, RPC mapping, setup/run/test commands, actual results and remaining gaps. Update README and PROJECT_STATUS.md.
- Exact handback: files, commands/exit statuses/test counts, known limitations, current services, and next Codex review action. No Git repository existed at M2 completion; do not invent a branch/commit. Git initialization/local history is optional, no remote/push.

Stop at locally verified M3 for Codex review. No hosted project, deployment, real school accounts/data, or M4 work. Do not start another milestone automatically.
