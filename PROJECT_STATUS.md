# Edison Helpdesk — resume here

Updated September14,2026. **Inventory management, profile enrichment, and staff dropdowns are LIVE. User reviewed staging and authorized final deployment.** Do not repeat imports or migrations.

## Current release

- Reviewed feature commit `feb2c0c` on `codex/inventory-management` is pushed to GitHub (remote ref verified September14).
- Released build: https://edison-helpdesk-ki3xsw3ga-thomas-edison-cte-high-school.vercel.app
- Vercel deployment `dpl_4UrHbFnFtT2TbFhjLjX4nbyJmvc3`, verified Ready September14. Built with Production environment via `--prod --skip-domain`. Promoted September14 after user confirmed student and staff pages work.
- Stable site https://edison-helpdesk.vercel.app promoted successfully to this deployment September14. GitHub main is being fast-forwarded to the reviewed feature plus release notes.
- Hosted Supabase has19 migrations, including inventory_management and staff_directory_options. Profile enrichment successfully applied. No repeat initial import needed.

## Implemented and verified

Inventory sidebar category: Students, Staff, Master Inventory. Both active administrators and technicians can search, add and edit. Profiles show assigned devices; device forms can reassign people. OSIS is numeric with leading zeros preserved; staff ID uses lower-case email prefix. Student parent/guardian contacts, home phone, address, notes and class/status fields included. Staff notes included. Department and Staff Role are searchable native datalists populated from DISTINCT values across the entire staff directory; current/new saved values are included. New department/role values are permitted.

Database RPCs enforce live account authorization, validation, revision conflicts and append-only audit. Stable UUID links and old ticket device snapshots are preserved. No deletion feature or audit viewer requested. Student email overwriting OSIS bug fixed during prior review.

Checks on final dropdown release: Node24.21.0 `npm run check` passes (typecheck, ESLint,85unit tests,17-route production build); clean `npm run test:db` passes147tests/16files; `scripts/review-inventory-management.cjs` passes against local PRODUCTION build on3002, including OSIS preservation, student edit, staff/device create, assignment, search, datalist/newoptions and mobile width. Synthetic screenshots visually reviewed earlier. Prior auth31tests and broader ticket browser checks passed before inventory work; not rerun for dropdown-only changes. User confirmed both student and staff pages work on staging before authorizing promotion. Root did not use an authenticated hosted browser session.

## Hosted profile enrichment

Verified after apply:3448 student first/last names and official classes,3447emails,3442parent names,2768parent phones,3441addresses,2190numeric class years.1257graduates have enrollment status graduated with no numeric year;1other source designation retained in notes. Staff261first/last names, departments and roles;223emails,260DBNs. Remaining blanks match source omissions;38staff without email keep legacy IDs until corrected.496device notes included.

Original import baseline remains3448students,261staff,4278devices,113catalog combinations (normal use can grow counts).18conflicting device-ID source rows withheld,29unmatched assignments unlinked,12incomplete devices need correction before ticket Add. Source sheets unchanged; no automatic sync/AppSheet cutover configured.

Private mode0600 enrichment sources/SQL/report remain in `.private/`: inventory-profiles-source.json,inventory-notes-source.json,inventory-profiles.sql and its report. Generator scripts/prepare-inventory-profiles.mjs tracked. Fresh backups `.private/profile-enrichment-release-20260913/{schema,data}.sql`, private enrichment.log. Earlier backups `.private/inventory-staging-fix-20260913/{schema,data}.sql`. Never log/publish their contents. Git and Vercel exclude private files.

## Release status and next work

User approved release September14. Vercel promotion succeeded for dpl_4UrHbFnFtT2TbFhjLjX4nbyJmvc3. Supabase dry-run confirms up-to-date, zero pending migrations. Source and release checkpoint are synchronized to main for collaborators; no force push. Do not repeat imports or migrations. Future work starts from main and a new feature branch. GitHub may run a same-code build from main; the explicitly promoted build is the verified release.

Error #441 was caused by staging calling missing app_list_people/app_inventory_statuses before migration. Root backed up and applied inventory_management, verified functions/counts and up-to-date migrations; user confirmed fixed. Later profile blanks were the unapplied enrichment, now completed. Department/role dropdowns required code plus staff_directory_options migration, both completed.

The branch `platform-overhaul` (M5, below) is merged on top of this live release, and M5 now builds ON the inventory tables above. `requesters`, `inventory_devices` and `device_catalog` are the source of truth: the M5 `people`, `devices`, `device_assignments` and `import_runs` tables are **deleted**, with the in-app CSV importer that wrote them. The directory arrives through the owner's one-time preparation scripts and is edited afterwards through `app_save_person` and `app_save_inventory_device`.

Updated September 14, 2026. **M5, the platform overhaul, is built and reviewed on the branch `platform-overhaul`; it is NOT pushed, NOT merged and NOT deployed.** The live M4 application at https://edison-helpdesk.vercel.app is untouched and still runs the M4 revision. M3 complete; M4 deployment complete; M5 local.

## M5 — platform overhaul (branch `platform-overhaul`)

Google sign-in with invites and an approval queue, the district's own directory and inventory (`requesters` / `inventory_devices`), ticket categories and device links, search with a command palette, attachments, in-app notifications, an audit log, the phone as a barcode scanner, an AI assistant on each technician's own ChatGPT account, and a dark-first design system. What it is and how to turn it on: **[docs/M5-PLATFORM-OVERHAUL.md](docs/M5-PLATFORM-OVERHAUL.md)** — the owner runbook is ordered, and step 2 (enable the Before User Created hook) must happen before step 3 (allow sign-ups).

Per-task briefs, reports and review rounds are in `.superpowers/sdd/2026-09-12-platform-overhaul/`; `progress.md` there is the ledger of what was implemented, reviewed and ruled on.

The branch adds migrations `20260914100000_m5_foundation.sql` through `20260914160000_m5_public_totals.sql`. Every M5 migration is numbered `20260914` so that all of them apply AFTER the owner's four (`20260912210000`, `20260912220000`, `20260913150000`, `20260914010000`), which is what lets M5 build on the live tables rather than beside them. They are additive and have been applied to the local stack only. `supabase/config.toml` on this machine carries an **uncommitted** local port patch (55321/2/3 in the main worktree, 56321/2/3 in lane 2, each with its own `project_id`); the committed values are the defaults (54321/2/3). Never stage that file.

The retired migrations are gone rather than reversed, because none of them was ever pushed: `m5_people`, `m5_people_fixes`, `m5_devices`, `m5_devices_fixes`, `m5_import` and `m5_import_fixes`. The four search migrations are one file, `20260914100500_m5_search.sql`, which carries the rulings all four reached.

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
- `scripts/review-overhaul.cjs` (new) walks login, queue, ticket detail, new ticket, my tickets, people (students and staff), a person, devices, a device, administration (access, audit), settings, notifications and the assistant panel at 1440×900, 1024×768 and 390×844 on both themes, asserting no horizontal overflow and no browser console errors. It creates its own synthetic accounts through the local admin API and seeds through the ordinary RPCs.
- Still to run on this branch: the full `npm run check` (the one place the production build runs) and `npm run test:local`. Those are Task 30b, after the polish pass lands.
- M4 results stand: hosted schema with RLS on every public table, signup disabled, minimum password 12, HTTPS site/callback; live browser tests for signup denial, password login, session persistence, technician admin denial, walk-in intake, logout, setup, recovery and old-browser revocation.

## Remaining work

1. Finish the last M5 tasks on the branch (polish pass, final whole-branch review), then the user decides PR or direct merge. Nothing is pushed.
2. Apply the M5 migrations to the hosted project and work through the [owner runbook](docs/M5-PLATFORM-OVERHAUL.md#owner-runbook-for-the-hosted-project) **in order**. The hook before the sign-up switch is the one step whose order matters for security.
3. Complete Jessie's setup and invite the technicians through Administration.
4. Nothing to import: the directory and the inventory are already live on the hosted project (3,448 students, 261 staff, 4,278 devices). Do not repeat the imports or the migrations.
5. Demonstrate backup and restoration and establish private backup storage before the system carries a day's real tickets. No backup/restore rehearsal has been completed.
6. Review hosted logging and rate limits, and verify the full live ticket workflows (claim/collaborate/return/resolve/concurrency) on the hosted project; local suites cover them, hosted browser checks did not create tickets.
7. Optionally finish Vercel GitHub app repository access for automatic deployments. Public intake remains deferred.

Do not claim production or pilot readiness from a deployment alone. M3's approved-credential fingerprint depends on the provider's bcrypt/session/AMR schema; cancelled provider recovery tokens cannot reach helpdesk records but can temporarily disrupt a password until admin recovery. Keep that documented tradeoff.

## Resources, ownership and continuity

Supabase lfqlkngxgefoaijuuvvx/us-east-1/PG17. Local workspace deliberately unlinked; hosted CLI uses explicit project-ref. Preserve existing accounts/passwords; Jessie Kalloo completed setup. GitHub private davendraseecharran/edison-helpdesk. Vercel edison-helpdesk / thomas-edison-cte-high-school, Node24/Next.js/npm ci/build. GitHub push creates Preview builds; production staging/promotion uses explicit CLI.

All helper work reviewed and ownership released. Preserve unrelated `.claude/`; no other pending app-code changes. Local Supabase, dev3000 and production3002 were left running previously; their continued process health was not rechecked September14. Localfixtures synthetic. Sensitive hosted env /tmp/edison-deploy/production.env; never print.

September14 live Plus usage at resume1%five-hour/53%weekly; resets1789405702/1789838582. No credit redeemed. No new delegation this resume. No automatic wakeup; a user message resumes work. Save actual promotion/main-sync outcomes here after release.

Hosted operator env exists at /tmp/edison-deploy/production.env mode 0600, outside Git; it contains a sensitive server key. Do not display its contents. `scripts/bootstrap-hosted-admin.mjs` accepts an explicit matching project/HTTPS origin and writes setup links privately. Runbooks: docs/M5-PLATFORM-OVERHAUL.md (current), docs/M4-DEPLOYMENT.md and docs/M4-BOOTSTRAP.md (hosted deployment and first admin). Prior history: docs/handoffs/M4-PRE-LAUNCH-STATUS.md and PRE-M4-STATUS.md.

A local dev server runs on port 3005 on this machine (3000/3001 were unbindable under WSL); the documented default stays 3000. Do not restart it during a review. The local database is the unlinked stack on 55321/2/3.

Claude continuation: read AGENTS.md and this checkpoint, then CLAUDE-HANDOFF.md. The M4 application is already live; do not recreate or reset hosted resources, and do not push or merge the branch without the user saying so. Preserve auth guards, keep credentials private, and checkpoint verified outcomes.
