# Edison Helpdesk — resume here

Updated September 14, 2026.

## Round 5 (September 23, 2026) — on `platform-overhaul`, NOT pushed

- **Vercel was failing** since the analytics release: `src/app/(app)/analytics/page.tsx`
  imported `tests/fixtures/analytics`, which `.vercelignore` drops. Fixed; guard test
  `tests/vercel-upload.test.ts`. A tree without the ignored dirs builds clean.
- Lists: search box keeps typing while results load (`useUrlSearch`); selection
  survives searches/pages with a removable tray (`useKeptSelection`, `SelectionTray`);
  paintable checkboxes (`usePaintSelect`) on People, Devices, checklists, the register.
- Phone: 16px fields (no iOS zoom), round New-ticket button, tappable Lookup label,
  folded filters, two-row selection bar.
- Features: Forms + public `/f/<slug>` + kiosks (`20260923100000_m5_forms`), scan
  Workflows (`20260923110000_workflows`), ticket opened time / resolved at intake
  (`20260923120000_m5_ticket_opened_at`), spreadsheet import
  (`20260923120100_m5_import_sheet`); assistant on `gpt-6-luna`; motion polish pass.
- Verified: typecheck, lint, 1395 unit tests, rehearsal 76 migrations → 683 DB + 57
  auth tests, Vercel-shaped clean build. Local main stack has the four new migrations.
- Next: the user decides on pushing to `main`; the owner then runs `npx supabase db push`.


Two things are true at once and this file keeps them apart:

- **Hosted is live and carries the district's real directory and inventory.** The
  owner's inventory-management release is deployed at
  https://edison-helpdesk.vercel.app. Do not repeat the imports or the
  migrations.
- **The branch `platform-overhaul` is M5 plus Phase 2, and it is NOT pushed, NOT
  merged and NOT deployed.** It is reviewed locally. The user decides between a
  pull request and a direct merge; nothing goes to `main` without their word.

## What is live on hosted

- Reviewed feature commit `feb2c0c` on `codex/inventory-management` is pushed to
  GitHub (remote ref verified September 14). `main` was fast-forwarded to the
  reviewed feature plus release notes.
- Released build
  https://edison-helpdesk-ki3xsw3ga-thomas-edison-cte-high-school.vercel.app,
  Vercel deployment `dpl_4UrHbFnFtT2TbFhjLjX4nbyJmvc3`, verified Ready
  September 14 and built with the Production environment
  (`--prod --skip-domain`). Promoted September 14 after the user confirmed the
  student and staff pages work. The stable alias
  https://edison-helpdesk.vercel.app points at it. This supersedes the M4
  deployment `dpl_6QFDhS871ZyDeizmf4cafnR8ALYD` recorded in
  docs/handoffs/M4-PRE-LAUNCH-STATUS.md.
- Hosted Supabase has 19 migrations, including `inventory_management` and
  `staff_directory_options`. Profile enrichment applied. Supabase dry-run
  confirms up to date, zero pending migrations. No repeat initial import is
  needed.

### Implemented and verified on hosted

Inventory sidebar category: Students, Staff, Master Inventory. Both active
administrators and technicians can search, add and edit. Profiles show assigned
devices; device forms can reassign people. OSIS is numeric with leading zeros
preserved; staff ID uses the lower-case email prefix. Student parent/guardian
contacts, home phone, address, notes and class/status fields included. Staff
notes included. Department and Staff Role are searchable native datalists
populated from DISTINCT values across the entire staff directory; current and
new saved values are included, and new department/role values are permitted.

Database RPCs enforce live account authorization, validation, revision conflicts
and an append-only audit. Stable UUID links and old ticket device snapshots are
preserved. No deletion feature or audit viewer was requested. The bug where a
student email overwrote the OSIS was fixed during that review.

Checks on the final dropdown release: Node 24.21.0, `npm run check` passes
(typecheck, ESLint, 85 unit tests, 17-route production build); a clean
`npm run test:db` passes 147 tests over 16 files;
`scripts/review-inventory-management.cjs` passed against a local production
build on 3002, including OSIS preservation, student edit, staff and device
create, assignment, search, datalists with new options, and mobile width. (That
script is now retired — see "Branch work" below.) Synthetic screenshots were
reviewed. Prior auth 31 tests and broader ticket browser checks passed before
the inventory work and were not rerun for the dropdown-only change. The user
confirmed both pages on staging before authorizing promotion. Root did not use
an authenticated hosted browser session.

Error #441 was staging calling `app_list_people` / `app_inventory_statuses`
before the migration; root backed up and applied `inventory_management`,
verified the functions and counts, and the user confirmed the fix. The later
blank profiles were the unapplied enrichment, since completed. The
department/role dropdowns needed code plus the `staff_directory_options`
migration; both are done.

### Hosted directory and inventory

Verified after the enrichment apply: 3,448 student first/last names and official
classes, 3,447 emails, 3,442 parent names, 2,768 parent phones, 3,441 addresses,
2,190 numeric class years. 1,257 graduates carry enrolment status `graduated`
with no numeric year; 1 other source designation is retained in notes. Staff:
261 first/last names, departments and roles; 223 emails, 260 DBNs. Remaining
blanks match source omissions; 38 staff without an email keep legacy IDs until
corrected. 496 device notes included.

The import baseline is 3,448 students, 261 staff, 4,278 devices, 113 catalog
combinations (normal use can grow these). 18 conflicting device-ID source rows
were withheld, 29 unmatched assignments left unlinked, and 12 incomplete devices
need correcting before they can be added to a ticket. The source sheets are
unchanged; no automatic sync or AppSheet cutover is configured.

Private mode-0600 enrichment sources, SQL and report remain in `.private/`:
`inventory-profiles-source.json`, `inventory-notes-source.json`,
`inventory-profiles.sql` and its report. The generator
`scripts/prepare-inventory-profiles.mjs` is tracked. Fresh backups are in
`.private/profile-enrichment-release-20260913/{schema,data}.sql` with a private
`enrichment.log`; earlier backups in
`.private/inventory-staging-fix-20260913/{schema,data}.sql`. Never log or
publish their contents. Git and Vercel exclude private files.

## The branch: M5 plus Phase 2 (`platform-overhaul`)

**M5** is Google sign-in with invites and an approval queue, ticket categories
and device links, search with a command palette, attachments, in-app
notifications, an audit log, the phone as a barcode scanner, an AI assistant on
each person's own ChatGPT account, and a dark-first design system.

**Phase 2** then built on the owner's live data rather than beside it:

- **People and Devices are `requesters` and `inventory_devices`.** M5's own
  `people`, `devices`, `device_assignments` and `import_runs` tables are
  **deleted**, with the in-app CSV importer that wrote them; `device_catalog` and
  `inventory_events` are the owner's too. The directory arrives through the
  owner's one-time preparation scripts and is edited afterwards through
  `app_save_person` and `app_save_inventory_device`. There is no import path in
  the application at all. The owner's `InventoryManager` and its `/inventory/*`
  routes were replaced by our People and Devices over the same rows, with facet
  filters for status, type and location, bulk assign and return, and an open
  ticket count on a directory row.
- **Roles are a set** from {admin, netrider, skills_officer}. `netrider`
  replaces `technician` everywhere a person reads it; the single-value `role`
  column survives as a derived column so the forty-odd `role = 'admin'` gates
  keep working. A skills officer is refused tickets in five places in the
  database. `app_set_account_roles` is the one door to a change.
- **Today (`/today`) is the landing page** for anybody who works tickets, and
  the rail's first item; a skills officer lands on People. One read
  (`app_today_briefing`) and one keyboard model across every list.
- **Insights is removed**, by the user's decision: route, nav, components,
  migration and AI tool.
- **The design is monochrome.** Navy and brass are retired, and so is the blue
  that briefly replaced them; the type is Geist; Tailwind v4 and shadcn/ui
  primitives are themed from `tokens.css`; drawers are vaul; `thinking-logos` is
  vendored under `vendor/` as a file dependency. `--edge-light` is worn by
  exactly one element on a screen and `scripts/review-overhaul.cjs` measures it.

What it is and how to turn it on:
**[docs/M5-PLATFORM-OVERHAUL.md](docs/M5-PLATFORM-OVERHAUL.md)** — the release
procedure is [Deploy this branch](docs/M5-PLATFORM-OVERHAUL.md#deploy-this-branch)
and the one-time project setup is the ordered owner runbook, where step 2
(enable the Before User Created hook) must happen before step 3 (allow
sign-ups).

Per-task briefs, reports and review rounds are in
`.superpowers/sdd/2026-09-12-platform-overhaul/`; `progress.md` there is the
ledger of what was implemented, reviewed and ruled on.

### Migrations on the branch

The branch adds 31 migrations, `20260914100000_m5_foundation.sql` through
`20260914170100_m5_public_totals_retire.sql`, on top of the 19 that are live —
50 files in `supabase/migrations/` in total. Every one of them is numbered
`20260914` so that all of them apply AFTER the owner's four
(`20260912210000`, `20260912220000`, `20260913150000`, `20260914010000`), which
is what lets them build on the live tables. They are additive and have been
applied to the local stack only.

The retired migrations are gone rather than reversed, because none of them was
ever pushed: `m5_people`, `m5_people_fixes`, `m5_devices`, `m5_devices_fixes`,
`m5_import`, `m5_import_fixes` and `m5_insights`. The four search migrations are
one file, `20260914100500_m5_search.sql`, which carries the rulings all four
reached.

`supabase/config.toml` on this machine carries an **uncommitted** local patch:
ports 55321/2/3 in the main worktree, 56321/2/3 in lane 2 with a distinct
`project_id`, `[realtime] enabled = true`, and `minimum_password_length = 8`.
The committed values are the defaults (54321/2/3, realtime off, minimum 12) and
the hosted project reads none of them. Never stage that file. The committed copy
also carries `[storage] enabled = true`, which is required rather than local —
`docs/M5-PLATFORM-OVERHAUL.md` explains why — and one loopback callback URL for
this machine's port 3005, which belongs in the uncommitted patch and can move
there the next time a brief allows staging the file.

### Branch work

`scripts/review-overhaul.cjs` creates one synthetic account of each role through
the local admin API, seeds through the owner's own RPCs, signs in with the
password form, and walks Today, the queue, a ticket, intake, My tickets, People
(students and staff), a person, Devices, a device, Administration (Access and
the audit log), Settings, notifications, the palette and the assistant panel,
plus the signed-out sign-in page, at 1440×900, 1024×768 and 390×844 on both
themes — asserting no horizontal overflow, no browser console errors, and never
more than one element wearing the lamp.

`scripts/review-intake.cjs` and `scripts/review-inventory-management.cjs` are
retired: they drove the owner's intake and `/inventory/*` screens, which this
branch replaced. Both files are kept as the record of what those screens
asserted, and each refuses to run and names what covers it now.

### Verification on the branch

- M5 and Phase 2 are verified locally, per task, in the reports under
  `.superpowers/sdd/2026-09-12-platform-overhaul/`. Each task ran typecheck,
  lint and the unit suite; DB-lane tasks ran their DB and auth suites.
- Still to run on the finished tree: the full `npm run check` (the one place the
  production build runs), `npm run test:local`, a final whole-branch review, and
  the hosted-merge rehearsal described in
  [Deploy this branch](docs/M5-PLATFORM-OVERHAUL.md#deploy-this-branch).
- M4 results stand: hosted schema with RLS on every public table, sign-up
  disabled, minimum password 12, HTTPS site and callback; live browser tests for
  sign-up denial, password login, session persistence, a technician's admin
  denial, walk-in intake, logout, setup, recovery and old-browser revocation.

## Live resources

- Supabase project `lfqlkngxgefoaijuuvvx`, us-east-1, PostgreSQL 17. The 19
  migrations through `20260914010000_staff_directory_options.sql` are applied;
  **the 31 branch migrations are not**. The local workspace remains unlinked and
  the hosted CLI uses an explicit project ref.
- GitHub https://github.com/davendraseecharran/edison-helpdesk — private.
- Vercel project `thomas-edison-cte-high-school/edison-helpdesk`, id
  `prj_9NEP7fDNQMsXUpI9VQ4KSfKE7BwL`, team `team_OhQP0pKULim8YlcnUg27qSdX`.
- Next.js on Node 24.x, `npm ci` and build. Four environment variables are set
  for Production only; the service-role key is Secret. `.env.local` is local.

The Vercel repository connection still fails private-repository access, so
automatic deployments are NOT configured; direct authenticated CLI deployments
work. Granting the Vercel GitHub app access to the private repository is what
would enable automatic deployment; no resource needs recreating. A GitHub push
creates Preview builds, and production staging and promotion use the explicit
CLI.

## First administrator — user action required

The first administrator (identity recorded in
docs/handoffs/M4-PRE-LAUNCH-STATUS.md) exists as a setup-pending super admin on
the hosted project; the password is not chosen yet, and the September 12 private
setup link has expired. If it is still pending, rerun the guarded hosted
bootstrap with the same identity to issue a new private link; if it has since
been activated, use normal recovery, not bootstrap. Do not paste a link or token
into chat.

Hosted account counts are unchanged: **1 app account, 1 Auth user, 0 tickets**.
No real ticket data exists anywhere. The directory and the inventory are real
and live, which is the one thing that changed.

## Remaining work

1. Finish the last branch tasks (final review, full verification, captures,
   re-seed), then the user decides pull request or direct merge. Nothing is
   pushed.
2. Rehearse the merge the owner will do: the 31 branch migrations applied onto a
   database holding exactly the 19 that are live, with the DB and auth suites
   against the result. It must apply with zero manual steps.
3. Release the branch as
   [Deploy this branch](docs/M5-PLATFORM-OVERHAUL.md#deploy-this-branch)
   describes, then work through the
   [owner runbook](docs/M5-PLATFORM-OVERHAUL.md#owner-runbook-for-the-hosted-project)
   **in order**. The hook before the sign-up switch is the one step whose order
   matters for security.
4. Complete the first administrator's setup and invite the NetRiders through
   Administration.
5. Nothing to import: the directory and the inventory are already live (3,448
   students, 261 staff, 4,278 devices). Do not repeat the imports or the
   migrations.
6. Demonstrate backup and restoration and establish private backup storage
   before the system carries a day's real tickets. Administration → Backups
   exports the tables; an export is not a restore, and no rehearsal has been
   completed.
7. Review hosted logging and rate limits, and verify the full live ticket
   workflows (claim, collaborate, return, resolve, concurrency) on the hosted
   project; local suites cover them, hosted browser checks did not create
   tickets.
8. Optionally finish Vercel GitHub app repository access for automatic
   deployments. Public intake remains deferred.

Do not claim production or pilot readiness from a deployment alone. M3's
approved-credential fingerprint depends on the provider's bcrypt, session and
AMR schema; cancelled provider recovery tokens cannot reach helpdesk records but
can temporarily disrupt a password until admin recovery. Keep that documented
tradeoff.

## Resources, ownership and continuity

All helper work is reviewed and ownership released. Preserve unrelated
`.claude/`. Preserve existing accounts and passwords; Jessie Kalloo completed
setup. Local fixtures are synthetic; no real student or staff data belongs in
the repository, in a fixture, in a log or in a screenshot.

Hosted operator env exists at `/tmp/edison-deploy/production.env`, mode 0600,
outside Git; it contains a sensitive server key. Do not display its contents.
`scripts/bootstrap-hosted-admin.mjs` accepts an explicit matching project and
HTTPS origin and writes setup links privately. Runbooks:
docs/M5-PLATFORM-OVERHAUL.md (current), docs/M4-DEPLOYMENT.md and
docs/M4-BOOTSTRAP.md (hosted deployment and first admin). Prior history:
docs/handoffs/M4-PRE-LAUNCH-STATUS.md and PRE-M4-STATUS.md.

A production build (`next start -p 3005`) runs locally on this machine (3000 and
3001 are unbindable under WSL); the documented default stays 3000. Do not restart
it. The local database is the unlinked stack on 55321/2/3, and lane 2's is on
56321/2/3.

No automatic wakeup; a user message resumes work.

Claude continuation: read AGENTS.md and this checkpoint, then CLAUDE-HANDOFF.md.
The application is already live; do not recreate or reset hosted resources, and
do not push or merge the branch without the user saying so. Preserve auth
guards, keep credentials private, and checkpoint verified outcomes.
