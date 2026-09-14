# Publish inventory management

**Released September14:** User approved staging; deployment `dpl_4UrHbFnFtT2TbFhjLjX4nbyJmvc3` was promoted to https://edison-helpdesk.vercel.app. Supabase migrations and enrichment are complete. The procedure below is retained for release history, not instructions to rerun imports.

**September13 update:** Both inventory migrations (including `20260914010000_staff_directory_options.sql`) and private profile enrichment are now applied to hosted Supabase. Do not rerun the initial import. Use the latest staging URL in PROJECT_STATUS.md, review the pages, then continue at step5 for promotion. Earlier commands below are the historical release sequence.

Run these steps from `/Users/davendraseecharran/edison-ticketing` on the reviewed branch `codex/inventory-management`. Stop if a command fails. This release keeps the existing intake release live until the staged application passes its checks.

## Release boundary

The hosted project already has the intake release, migrations `20260912210000_account_roles.sql` and `20260912220000_directory_inventory.sql`, and the initial directory/inventory copy. This release adds exactly one migration, `20260913150000_inventory_management.sql`, plus Students, Staff, and Master Inventory management. Active administrators and technicians can create, read, and update these records through the authenticated RPCs.

The private `.private/inventory-profiles.sql` file is already prepared. It enriches the imported rows with student parent contacts, addresses, notes, and device notes. The source report records 3,448 students, 261 staff, 38 staff rows without email, 496 device notes, 1,257 graduates, one other student status, and 18 conflicting device rows withheld from enrichment. Staff rows without email retain their legacy IDs; rows with email use the lower-case text before `@` as the Staff ID. New staff records require a valid email and derive the same prefix.

Do not run `scripts/prepare-inventory-import.mjs` or `.private/inventory-import.sql`. The initial import is already applied and must never be repeated, reset, deleted, or replaced. Do not commit or deploy `.private/` or `.claude/`.

## 1. Sync the reviewed source branch and stage Vercel

Confirm that the intended feature commit and this runbook are present, and inspect the status before pushing. Do not stage private files.

```sh
git switch codex/inventory-management
git status --short
git push -u origin codex/inventory-management
npx --yes vercel@59.16.0 deploy --prod --skip-domain --yes
```

Save the exact deployment URL returned by Vercel. `--skip-domain` builds with the Production environment while leaving `https://edison-helpdesk.vercel.app` on its current release. Do not promote a failed or incomplete build.

## 2. Take fresh private backups

Use a short maintenance window and ask technicians to pause ticket and inventory changes during the database steps. Keep both backup files private; they include application and Auth data.

```sh
umask 077
release_backup_dir=".private/inventory-management-release-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$release_backup_dir"
npx --no-install supabase db dump --linked --project-ref lfqlkngxgefoaijuuvvx --schema public --file "$release_backup_dir/schema.sql"
npx --no-install supabase db dump --linked --project-ref lfqlkngxgefoaijuuvvx --schema public,auth --data-only --file "$release_backup_dir/data.sql"
```

## 3. Dry-run and apply the one new migration

The installed CLI was checked read-only on September 13, 2026 (`supabase --version` returned `2.117.0`). The dry run must list only `20260913150000_inventory_management.sql`. If it lists an older migration or anything else, stop and investigate; never use `--include-all`, a seed, or `db reset` against the hosted project.

```sh
npx --no-install supabase db push --linked --project-ref lfqlkngxgefoaijuuvvx --skip-vault --dry-run
npx --no-install supabase db push --linked --project-ref lfqlkngxgefoaijuuvvx --skip-vault --yes
```

The apply command must complete successfully before the enrichment query is run. Record the migration version in the release log.

## 4. Apply the prepared profile enrichment

The verified readonly CLI help reports `supabase db query [flags] [<sql>]`, with `--linked`, `--project-ref`, and `--file`. Use the prepared file exactly as checked in the private directory; do not regenerate it or use the initial import file.

```sh
npx --no-install supabase --version
npx --no-install supabase db query --help
npx --no-install supabase db query --linked --project-ref lfqlkngxgefoaijuuvvx --file .private/inventory-profiles.sql > "$release_backup_dir/profile-enrichment.log" 2>&1
```

The SQL is one transaction, locks the enrichment run, updates only version-one imported rows, preserves edits made after import, audits changes, and reports aggregate entity counts. Keep the log private and inspect it locally; do not paste names, addresses, phone numbers, emails, serials, or SQL into chat. A failure is not permission to rerun the initial import or remove records.

After the query succeeds, verify aggregate counts and the Staff ID rule with a read-only query. The expected baseline remains 261 staff, 3,448 students, 4,278 devices, and 113 catalog entries; account for any approved changes made since the initial copy.

```sh
npx --no-install supabase db query --linked --project-ref lfqlkngxgefoaijuuvvx \
  "select (select count(*) from public.requesters where kind='student') as students, (select count(*) from public.requesters where kind='staff') as staff, (select count(*) from public.inventory_devices) as inventory_devices, (select count(*) from public.device_catalog) as catalog_entries, (select count(*) from public.requesters where kind='staff' and email is null) as staff_without_email, (select count(*) from public.requesters where kind='staff' and email is not null and external_id <> split_part(lower(email),'@',1)) as staff_id_prefix_mismatches, (select count(*) from public.requesters where guardian_name is not null) as profiles_with_guardian, (select count(*) from public.requesters where address is not null) as profiles_with_address;"
```

## 5. Promote and smoke-check in the browser

First open the staged deployment URL from step 1 and verify that login and the three Inventory pages load successfully against the migrated database. Then replace the placeholder below with that exact URL and promote only after the migration, enrichment, aggregate checks, and staged page checks pass.

```sh
npx --yes vercel@59.16.0 promote PASTE_DEPLOYMENT_URL_HERE --yes
```

Open `https://edison-helpdesk.vercel.app` in a browser and use the existing pilot administrator and technician accounts. Check that:

- login and the existing ticket intake still work;
- both roles can open Students, Staff, and Master Inventory, search, open details, and see the correct form validation and save controls;
- student parent contacts, address, notes, assigned devices, and device notes render from the database;
- staff without an email retain their legacy ID, while an emailed staff record displays the lower-case email prefix as its Staff ID; and
- the browser shows no runtime error or failed inventory request after reload, search, detail navigation, and a return to ticket intake.

Use only an approved disposable canary for production writes. The release has no delete RPC, so do not create test people or devices that cannot be retained and identified. Do not use real directory values in screenshots or logs.

If promotion or smoke checks fail, keep the database intact, leave the issue on the staged deployment or restore the prior application alias through the normal Vercel process, and review compatibility before any application rollback. Never reset or delete hosted data.

## 6. Sync GitHub after the live check

Once the stable URL passes the browser smoke check, fast-forward GitHub without rewriting history:

```sh
git switch main
git merge --ff-only codex/inventory-management
git push origin main
```

If the fast-forward fails, stop and review intervening commits. Record the deployment URL, release commit, migration version, enrichment aggregate counts, browser result, and any unresolved exception in `PROJECT_STATUS.md`.
