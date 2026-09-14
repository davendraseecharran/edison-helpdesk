# Edison Helpdesk — resume here

Updated September 13, 2026. **Inventory management is staged; its hosted migration is now applied. Profile enrichment is now applied; staff dropdown update is in progress and promotion remains pending.** The user confirms the previous intake release is live and working, including its two migrations and initial directory/device import. Do not repeat the initial import.

## Latest verified follow-up — resume here first

Profile enrichment APPLIED and verified; available names, class/contact/address fields and staff email/DBN/department/role now populated. Source omissions remain blank. Staff Department/Role searchable datalists implemented and verified against local PRODUCTION build on3002. Node24 check (85unit/build) passes; clean DB147tests passes; browser suite including datalist/newoptions passes. New migration20260914010000_staff_directory_options.sql APPLIED hosted after dryrun listed only it. Both new migrations and enrichment are complete. Root reviewed Luna helper; all editing ownership released.

Next bounded task: commit/push changes and stage Vercel with --prod --skip-domain; record new deployment URL. Do NOT promote yet. Old staging9yiyt54px already shows enriched profiles; updated staging needed for dropdown UI. No rerun of enrichment/import required. Runbook steps1–4 are complete once new staging is recorded. Main sync still follows final promotion.

Local production server session17983 port3002 running; dev3000 and Supabase also remain. Latest Plus quota95%five-hour /52%weekly, resets1789359906/1789838582. No new large task or delegation. No credits consumed. Checkpoint before stopping.

## Current source and ownership

Branch `codex/inventory-management` builds on `162319b` (prior intake release). The intended feature commit follows that commit; use `git log -1` for its ID. Main was still `e999242` at review; final sync follows publishing. Root completed final fixes and checks; all helpers released and no active editor ownership. Preserve unrelated `.claude/`. Private source data, SQL and backups remain ignored by Git and Vercel.

User decisions: new Inventory sidebar category with Students, Staff, Master Inventory; active administrators AND technicians can add/edit all directory and inventory records. Include student parent contacts, address and notes, and assigned devices. Valid emails, numeric OSIS with leading zeros, Staff ID derived from lower-case email prefix. No deletion feature requested.

Implemented: three searchable, paginated lists and edit/add forms; assigned-device lists and device reassignment; optional staff/student notes; parent/guardian and home phones; class/year and enrollment status; separate type/manufacturer/model suggestions; required device serial and optional asset tag. Authenticated database RPCs enforce access and validation, preserve stable UUID links, reject stale edits, retain ticket snapshots and append immutable before/after audit records. New catalog values become available for intake. Audit viewer is not part of this release.

Root review fixes: student email no longer overwrites OSIS with staff ID calculation; phone inputs styled consistently; staff Notes enabled; search verification waits for actual filtered result; single-record count label corrected. Synthetic desktop and phone screenshots visually reviewed. No real source records were used in browser tests/screenshots.

## Verified September 13

- `npx --yes --package=node@24 -c 'node --version && npm run check'`: Node24.21.0, typecheck, ESLint,85 unit tests and production build pass;17 routes.
- Clean `npm run test:db`:144 tests /15 files pass. Includes management access for both roles, validation, revision conflicts, stable links, preserved ticket observations, audit, and actual generated enrichment SQL executed twice against isolated local tables within rollback.
- `scripts/review-inventory-management.cjs` with bundled Playwright and Chrome: technician navigation; student create/edit; staff/device creation; email/OSIS validation and staff ID derivation; device assignment; persisted notes; actual OSIS search; mobile width pass. Screenshots /tmp/edison-inventory-management/{desktop,mobile}.png.
- `git diff --check` passes. Prior intake release auth31 tests and prior full ticket browser regression passed before this feature; not rerun this turn because auth implementation is unchanged.

## Exact next step: publish this release

Follow `docs/PUBLISH-INVENTORY-MANAGEMENT.md` in order: push reviewed branch; stage production deployment with `--skip-domain`; fresh private schema/data backups; dry-run/apply exactly ONE migration `20260913150000_inventory_management.sql`; run prepared private profile enrichment; inspect aggregate checks and staged pages; promote; smoke-check stable URL; fast-forward main and push for collaborators. The user pushed and staged the feature. Root subsequently applied the new migration to fix staging error #441; see incident details below.

The previous `docs/PUBLISH-INTAKE-UPDATE.md` is historical and already performed by the user. Do not rerun its import or migrations. Do not reset hosted data or recreate resources/accounts. Automatic Git deployment remains unverified; explicit Vercel CLI staging works.

## Current follow-up: complete profile fields and staff dropdowns

User confirmed staging works after #441 fix, then reported missing profile fields and requested Staff Role/Department dropdowns. Root verified all3709 original profile rows stillversion1, regenerated SQL in memory and matched reviewed private file exactly, took fresh schema/data backups `.private/profile-enrichment-release-20260913/{schema,data}.sql`, then applied `.private/inventory-profiles.sql` successfully (private enrichment.log).

Hosted aggregate verification:3448/3448 student first/last names and official classes;3447 emails;3442 parent names;2768 parent phones;3441 addresses;2190 numeric class years (1257 graduates plus1 other designation intentionally have no numeric year). Staff261/261 first/last names, departments and roles;223emails,260DBNs. Remaining blanks match source omissions. Device notes were included in the same transaction. No initial import repeated and no record IDs/assignments replaced.

Root owns verification/release/checkpoint. Luna helper `staff_dropdowns` owns InventoryManager, inventory-management-actions, new migration20260914010000_staff_directory_options.sql and tests/db/staff-options.test.ts. It is adding source-derived searchable Department/Staff Role dropdowns for all staff records, not only first page, with active actor authorization. Next: review helper, run checks, apply new options migration, commit/push and stage updated app without promotion. No other editors.

Latest live Plus usage at follow-up start65%five-hour /48%weekly; reset timestamps unchanged. Reduce delegation/checkpoint at70%. One bounded Luna helper active.

## Staging error #441 fixed — September 13

Staging deployment: https://edison-helpdesk-9yiyt54px-thomas-edison-cte-high-school.vercel.app (production environment, unpromoted). Vercel also created Preview fd5tqeceq, confirming GitHub-triggered preview deployment works.

Root cause confirmed from staging runtime logs: app_list_people and app_inventory_statuses missing from PostgREST schema cache. Hosted dry run confirmed inventory_management migration was pending. Fresh private backups completed in `.private/inventory-staging-fix-20260913/{schema,data}.sql`; root then applied exactly `20260913150000_inventory_management.sql`. Read-only verification confirms people/list inventory/status functions exist and counts remain3448 students,261 staff,4278 devices. No app-code change needed. No profile enrichment, promotion, initial reimport, or record edits performed for this fix. Browser session was not available for an authenticated hosted UI check; user should refresh staging.

Next release action is step4 (prepared private enrichment) in `docs/PUBLISH-INVENTORY-MANAGEMENT.md`, followed by staged-page checks and promotion. Steps1–3 have now been completed; do not redo the initial import. Existing private backup directory can be used for the enrichment log if shell variable from prior session is unavailable.

## Private source enrichment

Ignored mode0600 files: `.private/inventory-profiles-source.json`, `.private/inventory-notes-source.json`, `.private/inventory-profiles.sql`, `.private/inventory-profiles.sql.report.json`. Generator `scripts/prepare-inventory-profiles.mjs` is tracked. No real data goes in Git, logs or screenshots.

Prepared September13 source:3448 students,261 staff,1257 graduates,1 other class designation,38 staff without email,496 device notes. Preserve legacy IDs on staff missing emails until corrected; new staff require email.18 duplicate device-ID rows withheld, matching the prior import exclusions. Enrichment only updates untouched version-one rows, preserves later edits, UUIDs and assignments, and audits changes. Student GRAD maps to graduated; numeric class designation maps to year/current; ST maps to other with source designation retained in notes. Hosted enrichment applied and verified in current follow-up.

Initial live import baseline:261 staff,3448 students,4278 devices,113 catalog combinations (may grow with normal use).18 conflicting device-ID rows excluded;29 unmatched assignments remain unlinked;12 incomplete devices require correction before ticket Add. Source sheets are unchanged. No automatic sync or AppSheet cutover is configured; choose a single operational source when releasing edits to avoid divergence.

## Existing resources and processes

- Stable site: https://edison-helpdesk.vercel.app. User promoted prior intake deployment https://edison-helpdesk-8qjd7xl7o-thomas-edison-cte-high-school.vercel.app.
- Supabase `lfqlkngxgefoaijuuvvx`,us-east-1,PG17;18 migrations through inventory_management now applied. Local workspace deliberately unlinked; CLI uses explicit project ref for hosted operations. Preserve existing accounts/passwords; Jessie Kalloo completed setup.
- Private GitHub `davendraseecharran/edison-helpdesk`; Vercel project `edison-helpdesk`, team `thomas-edison-cte-high-school`, Node24/Next.js/npm ci/build. Production environment configured; do not print credentials. Sensitive hosted env /tmp/edison-deploy/production.env.
- Local Supabase/Docker running with synthetic fixtures from final clean DB suite. Fresh `npm run dev` session95722 on3000; stale PID91155 was stopped. No Claude writer active.

## Continuity and usage

Latest live Plus usage September13 ~20:52 EDT:41% five-hour used,44% weekly used; resets1789359906 /1789838582. No reset credits consumed. One fresh Luna-max helper wrote only release instructions; existing UI helper work reviewed locally. No automatic wakeup; user message resumes work. Update this checkpoint with actual push/deployment/migration results after release.
