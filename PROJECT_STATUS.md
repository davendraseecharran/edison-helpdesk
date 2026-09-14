# Edison Helpdesk — resume here

Updated September 14, 2026. **M5, the platform overhaul, is built and reviewed on the branch `platform-overhaul`; it is NOT pushed, NOT merged and NOT deployed.** The live M4 application at https://edison-helpdesk.vercel.app is untouched and still runs the M4 revision. M3 complete; M4 deployment complete; M5 local.

## M5 — platform overhaul (branch `platform-overhaul`)

Google sign-in with invites and an approval queue, a people directory and a device inventory imported from the AppSheet CSV exports, ticket categories and device links, search with a command palette, attachments, in-app notifications, an audit log, insights, the phone as a barcode scanner, an AI assistant on each technician's own ChatGPT account, and a dark-first design system. What it is and how to turn it on: **[docs/M5-PLATFORM-OVERHAUL.md](docs/M5-PLATFORM-OVERHAUL.md)** — the owner runbook is ordered, and step 2 (enable the Before User Created hook) must happen before step 3 (allow sign-ups).

Per-task briefs, reports and review rounds are in `.superpowers/sdd/2026-09-12-platform-overhaul/`; `progress.md` there is the ledger of what was implemented, reviewed and ruled on.

The branch adds migrations `20260912100000_m5_*` through `20260912101400_m5_access_request_cap.sql`. They are additive and have been applied to the local stack only. `supabase/config.toml` on this machine carries an **uncommitted** local port patch (55321/2/3); the committed values are the defaults (54321/2/3). Never stage that file.

## Live resources (M4, unchanged)

- Supabase project `lfqlkngxgefoaijuuvvx`, us-east-1, PostgreSQL 17. The 15 M3/M4 migrations are applied; **the M5 migrations are not**. No fixtures/seeds. Local workspace remains unlinked.
- GitHub https://github.com/davendraseecharran/edison-helpdesk — private. App revision `13a1a19` on main deployed successfully.
- Vercel project `thomas-edison-cte-high-school/edison-helpdesk`, id `prj_9NEP7fDNQMsXUpI9VQ4KSfKE7BwL`, team `team_OhQP0pKULim8YlcnUg27qSdX`. Ready production deployment `dpl_6QFDhS871ZyDeizmf4cafnR8ALYD`, stable alias https://edison-helpdesk.vercel.app.
- Next.js/Node 24.x, npm ci/build. Four environment variables set for Production only; service-role key is Secret. Local .env.local is still local.

Vercel repository connection still fails private-repository access; automatic deployments are NOT configured. Direct authenticated CLI deployments work. Granting the Vercel GitHub app access to the private repository is what would enable automatic deployment; no resource needs recreating.

## First administrator — user action required (M4, unchanged)

The first administrator (identity recorded in docs/handoffs/M4-PRE-LAUNCH-STATUS.md) exists as a setup-pending super admin on the hosted project; the password is not chosen yet, and the September 12 private setup link has expired. If it is still pending, rerun the guarded hosted bootstrap with the same identity to issue a new private link; if it has since been activated, use normal recovery, not bootstrap. Do not paste a link or token into chat.

Hosted counts are unchanged: **1 app account, 1 Auth user, 0 tickets**. No real student/staff/ticket/inventory imports have happened anywhere.

## Verification

- M5 is verified locally, per task, in the reports under `.superpowers/sdd/2026-09-12-platform-overhaul/`. Each task ran typecheck, lint and the unit suite; DB-lane tasks ran their DB and auth suites.
- `scripts/review-overhaul.cjs` (new) walks login, queue, ticket detail, new ticket, my tickets, people, a person, devices, a device, insights, administration (access, import, audit), settings, notifications and the assistant panel at 1440×900, 1024×768 and 390×844 on both themes, asserting no horizontal overflow and no browser console errors. It creates its own synthetic accounts through the local admin API and seeds through the ordinary RPCs.
- Still to run on this branch: the full `npm run check` (the one place the production build runs) and `npm run test:local`. Those are Task 30b, after the polish pass lands.
- M4 results stand: hosted schema with RLS on every public table, signup disabled, minimum password 12, HTTPS site/callback; live browser tests for signup denial, password login, session persistence, technician admin denial, walk-in intake, logout, setup, recovery and old-browser revocation.

## Remaining work

1. Finish the last M5 tasks on the branch (polish pass, final whole-branch review), then the user decides PR or direct merge. Nothing is pushed.
2. Apply the M5 migrations to the hosted project and work through the [owner runbook](docs/M5-PLATFORM-OVERHAUL.md#owner-runbook-for-the-hosted-project) **in order**. The hook before the sign-up switch is the one step whose order matters for security.
3. Complete Jessie's setup and invite the technicians through Administration.
4. Import the real directory and inventory: dry run first, read the counts and the skipped rows, then commit — students, then staff, then devices.
5. Demonstrate backup and restoration and establish private backup storage before the system carries a day's real tickets. No backup/restore rehearsal has been completed.
6. Review hosted logging and rate limits, and verify the full live ticket workflows (claim/collaborate/return/resolve/concurrency) on the hosted project; local suites cover them, hosted browser checks did not create tickets.
7. Optionally finish Vercel GitHub app repository access for automatic deployments. Public intake remains deferred.

Do not claim production or pilot readiness from a deployment alone. M3's approved-credential fingerprint depends on the provider's bcrypt/session/AMR schema; cancelled provider recovery tokens cannot reach helpdesk records but can temporarily disrupt a password until admin recovery. Keep that documented tradeoff.

## Private configuration and continuity

Hosted operator env exists at /tmp/edison-deploy/production.env mode 0600, outside Git; it contains a sensitive server key. Do not display its contents. `scripts/bootstrap-hosted-admin.mjs` accepts an explicit matching project/HTTPS origin and writes setup links privately. Runbooks: docs/M5-PLATFORM-OVERHAUL.md (current), docs/M4-DEPLOYMENT.md and docs/M4-BOOTSTRAP.md (hosted deployment and first admin). Prior history: docs/handoffs/M4-PRE-LAUNCH-STATUS.md and PRE-M4-STATUS.md.

A local dev server runs on port 3005 on this machine (3000/3001 were unbindable under WSL); the documented default stays 3000. Do not restart it during a review. The local database is the unlinked stack on 55321/2/3.

Claude continuation: read AGENTS.md and this checkpoint, then CLAUDE-HANDOFF.md. The M4 application is already live; do not recreate or reset hosted resources, and do not push or merge the branch without the user saying so. Preserve auth guards, keep credentials private, and checkpoint verified outcomes.
