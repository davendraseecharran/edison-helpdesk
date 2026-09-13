# Intake and directory update

The September 12 request adds directory-backed intake to the existing helpdesk. Staff and student records are people records, not sign-in accounts. Importing a directory does not grant anyone application access.

## Behavior

- Sign-in uses Email and Password, with a centered card and no email placeholder or forgot-password section.
- Administrators can change existing account roles. The database audits each change, invalidates the target's old sessions, preserves pending/inactive status, and protects the last usable administrator.
- Intake accepts an existing staff/student requester or Requester Unknown. Staff searches use names; student searches use names or OSIS. Searches require two characters and return at most 20 matches. The full directory is no longer sent to every page.
- Issue is the required ticket title; intake Notes are optional. Location remains available and Remote is removed from intake.
- Assigned inventory devices can be added to a ticket. Device type, manufacturer, model and serial are required at intake; asset tag and OS remain optional. Type/manufacturer/model must match the imported catalog. Linked devices use an authoritative database snapshot, not browser-supplied inventory details.
- Existing historical device observations remain readable, including older incomplete records. The ticket-detail form for recording a later observation retains its earlier flexible rules; this release changes new-ticket intake.

## Initial copy and source review

The source workbook was read through the Google Sheets connector without edits. The Staff, Students, DeviceSheet and Master_Inventory tabs supply the initial copy. Audit, StudentOnly, raw helper/import and backup tabs are excluded. Parent contacts, addresses and freeform source notes are not imported.

The prepared copy contains 261 staff, 3,448 students and 4,278 devices, with 113 catalog combinations. Eighteen inventory rows share nine conflicting DeviceIDs; all eighteen are held aside rather than choosing a winner. Twenty-nine retained rows refer to people absent from the supplied directories and are imported without a person link. Twelve retained devices lack a required service field and cannot be added from assigned-device intake until corrected.

A private report lists source row numbers for correction. `.private/inventory-source.json`, the generated SQL, source-row report, and hosted backups must never be committed or deployed. Both Git and Vercel exclude `.private/`.

The preparation command performs no network access or database writes:

```sh
node scripts/prepare-inventory-import.mjs .private/inventory-source.json .private/inventory-import.sql
```

The SQL applies the initial copy in one transaction, checks for an active administrator, and refuses to run if a directory has already been imported. Repeated imports require a separately reviewed refresh. Never reset the hosted database or apply local fixtures to it.

This is an initial snapshot, not an automatic Google Sheets synchronization or an AppSheet cutover. Source changes after the snapshot will not appear automatically. The next inventory phase needs correction/import refresh tooling, device and person management screens, assignment history, and a final reconciled cutover before Supabase becomes the authoritative database.

## Publishing application changes

Local edits do not change the live website. Run checks, review the diff, commit the intended files, and push to the private GitHub repository. Apply reviewed Supabase migrations separately; deploying Next.js does not migrate Postgres. Then deploy the tested source to Vercel and verify the live site.

The last verified deployment uses the authenticated Vercel CLI. GitHub login is connected, but automatic repository deployment has not yet been verified. Until that connection is confirmed, a Git push alone must not be described as a production release. With repository integration configured, feature branches can produce previews and the production branch can deploy on merge. See [Vercel Git deployments](https://vercel.com/docs/git).

Rollbacks of application code do not undo database migrations. These intake changes preserve old ticket records but intentionally reject obsolete intake payloads, so a UI rollback must be reviewed against the updated RPC contract.
