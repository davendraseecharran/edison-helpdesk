# Edison Helpdesk — resume here

Updated September13,2026. **Requested intake/sign-in/role updates are implemented and locally verified, awaiting publishing.** Existing live site remains https://edison-helpdesk.vercel.app on the previous release. No new hosted migrations, directory import, push or deployment has occurred for these updates.

## Current work and ownership

Branch `codex/intake-directory-updates`. Root completed helper review, fixes and verification; all helpers released. No active editing ownership. Preserve unrelated pre-existing `.claude/`; do not stage it. Local release commit records intended code/docs/tests only; inspect git log for its ID.

Implemented: centered login; Email/Password labels without email placeholder or forgot-password section; admin role changes with audit/session revocation and last usable admin protection; existing staff/student or unknown requester; debounced name/OSIS lookup; assigned-device Add; required catalog type/manufacturer/model/serial; optional asset/OS; required Issue and optional Notes; no Remote intake. Linked inventory details are read-only authoritative snapshots. Requester changes remove linked drafts; incomplete assigned devices cannot be added. Historical incomplete observations remain readable; ticket-detail later-observation form retains earlier flexible rules.

Root fixes during review: removed full requester loading from runtime, strengthened last-admin guard against unapproved credentials, made lookup selection invalidation and linked draft reset consistent, blocked incomplete inventory Add, disabled editing linked details, corrected stale browser selectors and order-dependent requester visibility fixture, repaired browser error redaction.

## Verification

- `npm run check` under Node24.21.0: typecheck, lint,85 unit tests and production build pass (14 routes).
- Clean `npm run test:db`:135 tests pass, including roles, directory searches, inventory snapshots, transaction rollback and existing authorization/concurrency.
- Additional `tests/db/import-preparation.test.ts`:1test passes; actual generated import SQL executes against isolated local tables and rolls back, preserving person links and quoted names.
- `npm run test:auth`:31 tests pass.
- `scripts/review-m3.cjs`:browser login, protected routes, technician intake, notes, collaborators, return/reclaim/access loss, resolution, mobile view, account setup/recovery and old-session revocation pass.
- `scripts/review-intake.cjs`:browser centered login, requester searches, assigned devices, snapshot detail, blank Notes, required fields, stale selection prevention, phone layout and actual admin-role promotion pass. Synthetic phone screenshot visually reviewed.
- Hosted migration dry run lists exactly the two new migrations. No hosted mutations made.

Auth suite resets local DB and leaves additional admin fixtures: rerun last-admin tests via a clean `npm run test:db`, not a standalone DB test after auth/browser fixtures. No resets concurrently with browser scripts.

## Exact next step

Follow `docs/PUBLISH-INTAKE-UPDATE.md`:push branch; stage Vercel production build with --skip-domain; refresh private backups; apply reviewed migrations; import reviewed snapshot; promote staged deployment; verify live; fast-forward main. User explicitly requested direct publishing steps after verification. Do not claim the updates are live yet.

New migrations: `20260912210000_account_roles.sql`, `20260912220000_directory_inventory.sql`.

## Private directory/inventory copy

Google workbook read-only September12. Used Staff,Students,DeviceSheet,Master_Inventory; excluded Audit,StudentOnly and raw helper/backup tabs. Snapshot `.private/inventory-source.json`. Import script `scripts/prepare-inventory-import.mjs` produces private `.private/inventory-import.sql` and row-number report. Source sheets unchanged; no automatic sync or authoritative AppSheet cutover.

Prepared counts:261 staff,3,448 students,4,278 devices,113 catalog combinations.18 rows sharing9 conflicting device IDs excluded;29 unmatched assignments unlinked;12 retained incomplete devices blocked from assigned intake until corrected. Imported person fields only name/kind/external ID; no parent/address/email/freeform source notes. People records are NOT login accounts. If sheets changed since snapshot, refresh and review before import. SQL is atomic and refuses a repeat initial import.

Both Git and .vercelignore exclude .private. Never log/publish real records. Existing private backups `.private/pre-intake-data.sql` (public+auth data) and `.private/pre-intake-schema.sql` (public schema), mode0600. Refresh before release. Restoration rehearsal remains uncompleted pilot work.

## Existing live resources

- Supabase `lfqlkngxgefoaijuuvvx`,us-east-1,PG17.15migrations deployed through hosted_bootstrap. Workspace is not linked. Last hosted read:1active admin,0tickets,0requesters (recheck before release).
- Jessie Kalloo completed setup; do not use old bootstrap links. Existing accounts and passwords must be preserved.
- GitHub private `davendraseecharran/edison-helpdesk`; prior app release13a1a19 on main, later docs e999242.
- Vercel `thomas-edison-cte-high-school/edison-helpdesk`, project `prj_9NEP7fDNQMsXUpI9VQ4KSfKE7BwL`, team `team_OhQP0pKULim8YlcnUg27qSdX`. Existing deployment `dpl_6QFDhS871ZyDeizmf4cafnR8ALYD`. Node24,Next.js, npm ci/build. Production env configured.
- GitHub login connected; private-repository automatic deployment not verified. Authenticated Vercel CLI deployment works. --prod --skip-domain verified supported before explicit promote.
- Hosted operator env /tmp/edison-deploy/production.env is sensitive; never print. Local.env remains local. Local Supabase/Docker and next dev on3000 remain running with synthetic fixtures. No synthetic data on hosted project from these checks.

## Continuity

Latest Plus usage September13:16%five-hour,24%weekly; reset timestamps1789324883/1789838582. No credit redeemed. No automatic wakeup configured. User prefers small Luna-max helpers; this resumed turn finished locally without additional delegation.

Short implementation overview:docs/INTAKE-DIRECTORY-UPDATE.md. Publishing:docs/PUBLISH-INTAKE-UPDATE.md. Older resume notes:docs/handoffs/INTAKE-DIRECTORY-RESUME.md (superseded by this verified checkpoint). Do not recreate resources or reset hosted data.
