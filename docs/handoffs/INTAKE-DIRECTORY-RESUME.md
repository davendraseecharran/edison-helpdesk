# Resume September 12 intake updates

**Historical cap checkpoint. Superseded September 13 by PROJECT_STATUS.md: browser checks and final verification now pass. Follow docs/PUBLISH-INTAKE-UPDATE.md for publishing.**

Read AGENTS.md and PROJECT_STATUS.md first. Existing live app is https://edison-helpdesk.vercel.app. Work branch is `codex/intake-directory-updates`. Do not recreate projects or reset hosted data. No source edits, new hosted migrations, imports, commits, pushes or deployments have happened for this change.

## Implemented locally

- Centered login; Email/Password labels; no email placeholder or forgot-password section.
- Admin role editing via authenticated `app_set_account_role`, audited, session-revoking, preserves account status and last usable admin (including approved credential check).
- Intake existing staff/student or unknown only. Live debounced name/OSIS search, assigned-device Add, inventory catalog type/manufacturer/model selection, required serial, optional asset/OS, Issue required/Notes optional, no Remote.
- Linked inventory details are read-only and snapshotted authoritatively by SQL. Changing requester removes linked drafts. Incomplete assigned records cannot be added.
- Minimal requester external IDs, inventory/catalog tables and bounded authenticated lookup RPCs. Existing full requester loading removed from runtime. Historical ticket observations preserved.
- Source preparation script with duplicate quarantine, safe quoting, transaction and first-import rerun guard. Source unchanged, no ongoing Sheet sync.

## Files/data

New migrations `20260912210000_account_roles.sql` and `20260912220000_directory_inventory.sql`. New action module `src/lib/data/inventory-actions.ts`, SearchSelect and rebuilt new-ticket page. See `git diff` and untracked list; preserve unrelated `.claude/`, never add `.private/`.

Private source snapshot `.private/inventory-source.json` was fetched read-only through Google Sheets connector. Source tabs Staff, Students, DeviceSheet, Master_Inventory. Excludes Audit/StudentOnly/helper imports. Minimal imported fields: people name/kind/external ID; inventory type/manufacturer/model/OS/serial/asset/status/location/explicit assignment. No parent/address/notes/emails copied into DB.

`node scripts/prepare-inventory-import.mjs .private/inventory-source.json .private/inventory-import.sql` produces 261 staff,3448 students,4278 devices,113 catalog combinations.18 rows with9 conflicting DeviceIDs quarantined;29 unmatched assignment IDs left unlinked;12 retained incomplete devices. Private row-number report `.private/inventory-import.sql.report.json`.

Backups: `.private/pre-intake-data.sql` has hosted public+auth data, `.private/pre-intake-schema.sql` has public schema. Both0600 inside0700 directory. Do not print contents. Restore rehearsal has not been completed. Last hosted read:1active admin,0tickets,0requesters. The user finished Jessie's setup; do not use old bootstrap link.

## Verification and next commands

`npm run check` passed after UI review fixes (85 units, typecheck/lint/build). `npm run test:auth`31passed. Main DB suite initially134passed; added last-admin unapproved credential test (now135). A clean rerun exposed requester visibility test depending on another file's directory seed; fixed that test to seed its own synthetic requester. Check PROJECT_STATUS for latest rerun outcome.

Only use DB integration suites locally. Auth tests reset the local database and leave extra administrator fixtures; a last-admin DB test rerun afterward requires `npm run test:db` (clean reset), not `test:db:only`. Do not run resets while browser scripts run.

Existing `scripts/review-m3.cjs` updated for Email/Password and Issue/Notes. First run failed at old exact Notes selector; fixed to #issue. Needs a successful rerun. New `scripts/review-intake.cjs` is being completed by Luna Nash; see status for whether it has run.

Browser invocation pattern:

```sh
PLAYWRIGHT_MODULE=/Users/davendraseecharran/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright CHROME_PATH='/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' node scripts/review-intake.cjs
```

Same environment for `scripts/review-m3.cjs`. Both must use local Supabase and localhost. A next dev server listens on3000; Docker/local Supabase is running. Screenshots must contain synthetic data only.

After browser fixes/checks:

1. Review diff and importer SQL generation; test importing a synthetic prepared file against an isolated local database if needed. Never import real source records into fixture DB or expose private SQL error text with real rows.
2. Hosted migration dry run already lists exactly the two new migrations. Apply reviewed schema via `npx --no-install supabase db push --linked --project-ref lfqlkngxgefoaijuuvvx --skip-vault --yes` only after verification.
3. Apply the prepared initial import through `supabase db query --linked --project-ref ... --file .private/inventory-import.sql`. It refuses if imported data already exists. Keep error output private; verify only aggregate counts/relationships. Check readiness and data quality review first. Do not modify Google source or declare an AppSheet cutover.
4. Commit only intended code/docs/tests, push source intentionally. GitHub private repo davendraseecharran/edison-helpdesk. Vercel project edison-helpdesk uses Node24; existing local Node25. Production CLI works; repository automatic deployment is not yet verified. Never assume git push deployed it.
5. `npx --yes vercel@59.16.0 deploy --prod --yes`, verify ready and stable alias. Supabase migrations are separate from app deployment. All production env already configured; local.env remains local. Hosted env private at /tmp/edison-deploy/production.env.
6. Report what is live, exact checks, import exceptions, and explain update flow + future directory/inventory management and cutover. See docs/INTAKE-DIRECTORY-UPDATE.md.

Root paused because live Plus quota reached91% five-hour/20%weekly; five-hour resets September13 at01:00AM EDT. No credit consumed. Finish safely without recreating or resetting hosted resources.
