# Publish the verified intake update

The changes are tested locally. These steps publish the code and copy the reviewed directory/inventory snapshot. They do not replace AppSheet or enable automatic synchronization. Run commands from `/Users/davendraseecharran/edison-ticketing` and stop if any command fails.

## 1. Push the tested source branch

```sh
git switch codex/intake-directory-updates
git status --short
git push -u origin codex/intake-directory-updates
```

The pre-existing untracked `.claude/` folder is unrelated. Do not add it or `.private/`. No real directory records or credentials belong in Git. GitHub push alone is not a deployment with the currently verified setup.

## 2. Build the release without switching the live website

```sh
npx --yes vercel@59.16.0 deploy --prod --skip-domain --yes
```

Wait for a successful build and save the returned deployment URL. `--skip-domain` leaves the stable website pointing to its existing release while the new release builds, using the Production environment already configured. Do not promote if the build fails. Avoid testing new authenticated intake on this staged URL until the database migration is applied.

## 3. Refresh private backups

Use a short maintenance window for the remaining steps: ask technicians to pause ticket creation until promotion and verification finish. The old intake form has a different database contract.

```sh
umask 077
release_backup_dir=".private/intake-release-$(date +%Y%m%d-%H%M%S)"
mkdir -p "$release_backup_dir"
npx --no-install supabase db dump --linked --project-ref lfqlkngxgefoaijuuvvx --schema public --file "$release_backup_dir/schema.sql"
npx --no-install supabase db dump --linked --project-ref lfqlkngxgefoaijuuvvx --schema public,auth --data-only --file "$release_backup_dir/data.sql"
```

These backups contain sensitive data. Keep them private. Backup restoration has not yet been rehearsed; that remains an operational pilot task.

## 4. Apply the two reviewed database migrations

```sh
npx --no-install supabase db push --linked --project-ref lfqlkngxgefoaijuuvvx --skip-vault --dry-run
npx --no-install supabase db push --linked --project-ref lfqlkngxgefoaijuuvvx --skip-vault --yes
```

The dry run must list only `20260912210000_account_roles.sql` and `20260912220000_directory_inventory.sql`, or report already applied if resuming a known completed step. Investigate any other migration. Never use a database reset against the hosted project.

## 5. Import the reviewed initial snapshot

The private snapshot was read September12. If the source sheets have since changed, fetch a fresh minimal snapshot and rerun preparation/review before importing.

```sh
node scripts/prepare-inventory-import.mjs .private/inventory-source.json .private/inventory-import.sql
npx --no-install supabase db query --linked --project-ref lfqlkngxgefoaijuuvvx --file .private/inventory-import.sql > "$release_backup_dir/import-result.log" 2>&1
```

The prepared import is one transaction and refuses to run if imported records already exist. An error is not permission to delete records or bypass that guard. Check the private log locally without pasting person/device details into chat.

Expected initial counts:261 staff,3,448 students,4,278 devices,113 catalog entries.18 conflicting device rows are withheld.29 assignments remain unlinked because their IDs do not match the supplied directories.12 retained devices need required details corrected before assigned-device intake can use them. Row numbers are in `.private/inventory-import.sql.report.json`.

Verify aggregate counts only:

```sh
npx --no-install supabase db query --linked --project-ref lfqlkngxgefoaijuuvvx "select kind,count(*) from public.requesters where external_id is not null group by kind; select count(*) as inventory_devices from public.inventory_devices; select count(*) as catalog_entries from public.device_catalog;"
```

## 6. Switch the live website to the successful staged release

Replace the example text below with the exact URL returned in step2:

```sh
npx --yes vercel@59.16.0 promote PASTE_DEPLOYMENT_URL_HERE --yes
```

Open https://edison-helpdesk.vercel.app and sign in. Check Email/Password, role editing, a staff lookup, a student OSIS lookup, assigned-device Add, and a ticket with an Issue and blank Notes. Verify technician visibility and normal return/resolve behavior with the intended pilot accounts. Account promotion signs the affected user out; they sign in again for the new role.

If migration/import succeeded but promotion fails, resolve promotion before resuming intake. Do not blindly roll application code back against the changed intake RPC contract, and do not reset or delete the database.

## 7. Finalize the repository and handoff

After the live checks pass, bring main to this tested release without rewriting history:

```sh
git switch main
git merge --ff-only codex/intake-directory-updates
git push origin main
```

If fast-forward fails, review the intervening changes rather than forcing it. Record the deployment URL, commit, applied migrations, import counts and any unresolved exceptions in PROJECT_STATUS.md.

Vercel GitHub login is connected; automatic deployment access for this private repository has not been verified. Configure the Vercel GitHub app's repository access separately if you want future main pushes to deploy automatically. Until verified, use the explicit deploy/promote flow above.
