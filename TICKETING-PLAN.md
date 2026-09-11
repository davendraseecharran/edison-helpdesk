# Edison ticketing system — working plan

Prepared September 10, 2026; revised with the user's platform selection. Status: first-release requirements and hosting stack selected. The user confirmed Vercel Hobby works for this project. This is a planning artifact, not an implementation or deployment.

## Objective

Launch an internal helpdesk where a super admin records incoming requests, technicians claim or receive assignments, collaborators contribute, and every completed ticket records the work performed. Extend the same system later with inventory, staff and student records, device assignments, and public intake.

Confirmed scope: around seven technicians, 20–40 new tickets per day, and a queue often resolved before the end of the day. Future inventory and directories cover approximately 2,500 students, 300 staff, and 7,500 devices. Inventory and people data currently live in AppSheet backed by Google Sheets and should eventually migrate into this system, which will become their authoritative home. The user wants a freely hosted public website with a free database; the public URL must expose only login and account-setup surfaces until public intake is introduced, with operational data protected by account permissions.

Latest scope decisions: technicians sign in with student email addresses and a separate application password they choose themselves. Google OAuth/SSO is not part of this release. Attachments and email notifications are deferred. Priority and optional time tracking remain in the first release; recording time is never a prerequisite for resolution.

The first release should be fast, restrained, and easy to operate daily. Build only the ticketing experience now, while giving its records stable identifiers and relationships that support later modules.

## Source review

Source: [Tech Support Calls 2027](https://docs.google.com/spreadsheets/d/1WBvDJNH_RWOotxolCGrS-mtQdReBkO8xBpHhHSYe8jA/edit?gid=0). Read-only review of the single tab, Sheet1, including the remaining grid to confirm there were no additional populated records.

- Nine populated columns: Date Requested, Location, Type, User, Issue, Technican, Resolved (Y/N), Date Resolved, Solution.
- Fourteen tickets, all dated September 10, 2026.
- Intake channels: five Walk-in, seven Call, two Email.
- Six marked resolved, each with a resolution date. Five of those six have no solution recorded.
- Eight have blank resolution status; two of these have solution notes. A note is insufficient evidence to mark a ticket resolved.
- Twelve have technician text; two do not. Two tickets combine two technician names in one cell. There are five distinct technician name tokens, subject to confirmation of account identities.
- The requester field mixes staff names, a role label, and three numeric identifiers. Confirm whether the numeric identifiers are student IDs; do not infer identities or reproduce these identifiers in prototypes.
- One issue explicitly concerns multiple laptops. The data model should permit multiple devices per ticket.
- There are no dedicated ticket IDs, device records, asset identifiers, assignment timestamps, or activity history in the source columns.
- Some location and technician entries contain trailing whitespace. The title says 2027 while the ticket dates are in 2026; confirm whether the title denotes a school year.

## Platform decision

Selected stack: Next.js with TypeScript and the App Router, hosted on Vercel Hobby, with Supabase Postgres and Auth. The user confirmed the Hobby option works and selected it. Treat that hosting decision as settled. Keep the interface and server-side application logic in one Next.js project, using server actions or route handlers for account administration and ticket operations as appropriate. Supabase remains the database and authentication provider, whether connected directly or through Vercel Marketplace.

The target is zero service charges within free allowances. No email provider or attachment-storage service is needed for the first release. Paid upgrades are outside the selected scope. School data-hosting requirements and maintenance/backup ownership are operational setup details to establish before importing live records; they do not reopen the user's Vercel plan selection.

| Component | Selected technology | Responsibility |
| --- | --- | --- |
| Application | Next.js App Router + TypeScript | Admin and technician interface, forms, and server-side workflow logic |
| Hosting | Vercel Hobby | Application deployment, HTTPS, preview deployments, and server runtime |
| Database | Supabase Postgres | Tickets, roles, collaborators, work logs, history, and later people/inventory |
| Authentication | Supabase Auth | Student email plus individually chosen app password; admin-assisted setup/recovery |

Technicians are application users and do not need Vercel or Supabase dashboard accounts. Store privileged provider credentials only on the server; validate identity, role, and ticket access on every protected operation. Enforce database policies as well. Ticket claims and resolution transitions remain atomic database operations. Avoid shared caching of user-specific ticket data. Preview environments must use invented/test records and separate credentials so preview writes cannot change production data.

The original alternatives remain documented below for reference; Vercel has replaced Cloudflare Pages as the selected host.

| Option | Cost boundary | Fit and tradeoff |
| --- | --- | --- |
| Next.js on Vercel Hobby with Supabase | Selected free service tiers within quotas; development, maintenance, and backups remain responsibilities | Selected for exact queue behavior, full visual control, and integrated Next.js deployment. |
| Self-hosted GLPI | Community software is available without a license charge; requires a server and someone to maintain it | Strongest existing helpdesk-plus-inventory foundation. Validate the exact owner/collaborator permissions and desired UI in a pilot. |
| AppSheet | Free testing for up to 10 users; production may have no added license cost if all relevant users already have eligible Workspace licenses | Good option for a quick internal app. Less control over visual design; verify licenses and test simultaneous claiming before committing. |

Current published Supabase Free limits include 500 MB database storage, 1 GB file storage, and 50,000 monthly active users. Free projects may pause after a week of inactivity, and automatic backups are not included. Pro starts at $25/month; that is not a complete operating-cost estimate. These are application user allowances, not a requirement to give technicians Supabase dashboard access.

Use a Vercel-provided subdomain initially to avoid a domain purchase. Vercel hosting and Supabase have separate usage limits; monitor both during the pilot. First-release account setup and recovery use admin-issued links delivered directly, so they do not depend on an email provider. If automatic authentication emails are introduced later, configure a suitable sender instead of relying on Supabase's default test email service.

AppSheet Core is included in Google Workspace for Education Standard and Education Plus. Education Fundamentals is not listed as an included edition. Public access has different licensing and security constraints, so a future public form must be evaluated separately.

AppSheet's documented free prototype allowance is up to 10 active test users; personal apps allow up to three users. Hiding an app's URL or inviting users does not expand those allowances. Do not base the new production system on the current prototype/personal arrangement.

### Capacity and operating assumptions

- Around seven technician accounts plus administration is a small initial user population. The 2,800 future directory people are records, not automatically login accounts.
- Confirmed arrival volume is 20–40 new tickets daily. An illustrative 180-day school year produces 3,600–7,200 tickets; the school calendar remains an assumption. Same-day resolution reduces active queue size but does not eliminate stored history.
- The future directory and inventory start at roughly 10,300 master records. This is modest for Postgres, but notes, indexes, account data, events, and time entries also consume the 500 MB free database allowance. Measure a representative import before claiming a specific capacity or number of supported years.
- With no attachments or notification service at launch, neither file storage nor email quota is an initial constraint. Measure database growth during the pilot and keep resolved tickets searchable under the same permissions.
- Track usage and warn before limits. Do not silently purge history or enable paid upgrades.
- Back up the database to approved storage and test recovery. Free-tier pausing and missing automatic backups remain operational constraints, including during school breaks. Add separate file backups when attachments are introduced.

### Confirmed authentication and proposed onboarding

Login uses each technician's student email address and a separate password they set for this application. No Google OAuth, Workspace SSO configuration, or Google password collection. Authentication is handled by Supabase Auth, with an active app account and server-controlled role independently determining helpdesk access.

Proposed first-release flow without automated email:

1. Super admin enters the technician's name and exact school email, grants the Technician role, and generates an expiring, single-use account-setup link through a trusted server function.
2. Admin confirms the intended technician and hands over the link directly through an approved private channel or in person. This is admin-verified enrollment, not proof of mailbox ownership. Knowing or entering an allowed email address is insufficient to claim the account.
3. The technician opens the setup page and chooses their own password. Keep enrollment accounts restricted until setup completes, enforced in the backend. The admin cannot view the chosen password.
4. Subsequent sign-in uses the email address and app password. Public self-registration is disabled; role and activation fields are not user-editable. No shared temporary passwords.
5. If a password is forgotten, the login page directs the technician to the super admin. After confirming identity, the admin generates a single-use, expiring recovery link for direct delivery. Record the recovery action without logging the link/token; invalidate superseded recovery credentials and revoke existing sessions as part of completed recovery.
6. Admin can deactivate accounts while preserving ticket authorship and contribution history. Permission checks must honor deactivation immediately, including for existing sessions. Bootstrap and recovery for the super admin use the project owner's trusted administrative access.

Use the auth provider's supported invitation/recovery primitives where possible; do not invent password storage. Provider admin credentials stay server-side. Account links are credentials: do not retain full links in activity logs, analytics, or ticket notes. Setup, expiration, replay rejection, recovery, and restricted pre-setup access must be tested before launch.

Sources checked September 10, 2026:

- [Supabase pricing](https://supabase.com/pricing)
- [Supabase row-level security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase email delivery requirements](https://supabase.com/docs/guides/auth/auth-smtp)
- [Next.js on Vercel](https://vercel.com/docs/frameworks/full-stack/nextjs)
- [Vercel Hobby](https://vercel.com/docs/plans/hobby)
- [Vercel Marketplace database integrations](https://vercel.com/docs/marketplace-storage)
- [GLPI features](https://www.glpi-project.org/en/features/)
- [GLPI ticket actors](https://help.glpi-project.org/documentation/modules/assistance/actors)
- [AppSheet pricing](https://about.appsheet.com/pricing/)
- [Workspace editions including AppSheet Core](https://support.google.com/appsheet/answer/10105400?hl=en)
- [AppSheet free-use limits](https://support.google.com/appsheet/answer/10104499?hl=en)
- [Google OAuth app states and Workspace controls](https://developers.google.com/identity/protocols/oauth2/production-readiness/overview)
- [Supabase Google sign-in](https://supabase.com/docs/guides/auth/social-login/auth-google)
- [Supabase password authentication](https://supabase.com/docs/guides/auth/passwords)
- [Supabase administrative link generation](https://supabase.com/docs/reference/javascript/auth-admin-generatelink)
- [Cloudflare R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Cloudflare R2 setup](https://developers.cloudflare.com/r2/get-started/)
- [Resend pricing](https://resend.com/pricing)
- [Brevo free-plan limits](https://help.brevo.com/hc/en-us/articles/208580669-FAQs-What-are-the-limits-of-the-Free-plan)

## First-release workflow

1. Super admin creates a ticket with requester, location, issue, submission date, and intake channel. Submission date defaults to the school's current date and may be backdated. Store the actual creation timestamp and creator separately so backdating does not rewrite the audit record.
2. Assignment defaults to no owner. An unassigned ticket appears in Open Queue. Selecting a technician puts it in that technician's My Tickets view immediately, with status Assigned.
3. A technician claims an open ticket. The server assigns exactly one primary owner and records the claim time. If two technicians claim simultaneously, only one succeeds and the other sees the updated owner.
4. The ticket leaves Open Queue, appears in the owner's queue, and stays visible to the super admin. Queues are filtered views of one ticket record, not separate copies or storage locations.
5. The owner adds collaborators. Views are My Tickets for ownership and Collaborating for assistance. Owners and collaborators can add work notes and resolve the ticket. The primary owner remains recorded even when a collaborator is the resolver. Proposed default: owner/admin manage collaborators; admin manages reassignment.
6. The technician records device observations and troubleshooting as work proceeds. Unknown or inapplicable serial numbers and asset tags must not prevent recording a request.
7. Resolving requires a meaningful solution, resolver identity, and resolution timestamp. Owner or collaborator resolution finishes the ticket immediately; no admin approval stage and no required time entry. Guard concurrent resolution actions so one transition creates one resolution event.
8. The primary technician can return unfinished owned work to Open Queue. Preserve notes, device information, optional time entries, collaborators, and all activity; record who returned it. Clear current ownership and waiting state so another technician can claim it. Collaborators cannot release another owner’s work; resolved/cancelled tickets must first be reopened by admin. Admin can reopen with a reason, reassign, or return work to Open Queue. Preserve previous ownership, status changes, and resolution events. Disabling a technician account must retain their contribution history and surface active work for reassignment.
9. Technicians can create Walk-in tickets only, immediately assigned to themselves, and add collaborators. The server enforces the channel and initial owner. They cannot create unassigned tickets or assign a new walk-in to another technician. Super admin can create any supported intake channel and assign freely.

Proposed statuses: Open, Assigned, In Progress, Waiting, Resolved, Cancelled. Waiting requires a reason such as awaiting user, parts, or vendor. Cancellation requires a reason and does not count as a resolution. Reopening returns a ticket to an active status and creates an activity event.

## Fields and permissions

| Area | First-release fields |
| --- | --- |
| Identity and intake | Immutable internal ID, readable ticket number, submission date, actual creation timestamp, creator, Walk-in/Email/Phone Call, requester, location, short title, issue description |
| Ownership and progress | Status, primary technician, collaborator list, priority (proposed default Normal), assigned/claimed time, waiting reason |
| Device observations | Zero or more device entries: device type, manufacturer/model, OS/version, serial number, asset tag, ownership type if needed |
| Work and completion | Authored and timestamped work notes, solution, resolved by, resolved at, reopen/cancel reason, activity history |
| Launch essentials | Priority and optional per-technician time entries; no attachments or email notifications |

Required at intake: submission date, channel, issue, and a requester entry or explicitly marked unknown requester. Location can be unknown or remote. Device details are optional at intake. Required at resolution: solution; device information should be completed when available, with an explicit unknown/not-applicable option. Time entries are optional; missing time is distinct from a recorded zero and does not block resolution.

| Action | Super admin | Technician owner | Collaborator | Uninvolved technician |
| --- | --- | --- | --- | --- |
| Create technician accounts and change roles | Yes | No | No | No |
| Create intake tickets | Any channel; open queue or selected tech | Walk-in only; assign to self | Walk-in only; assign to self | Walk-in only; assign to self |
| See open claimable requests | Yes | Yes | Yes | Yes |
| Claim an unassigned request | Yes | Yes | Yes | Yes |
| See assigned/resolved ticket details | All | Own | Participating | No |
| Add notes and device observations | Yes | Yes | Proposed yes | No by default |
| Add/remove collaborators | Yes | Proposed yes | No by default | No |
| Resolve | Yes | Yes | Yes | No |
| Return unfinished ticket to Open Queue | Yes | Yes, own tickets | No | No |
| Reassign to another owner or reopen | Yes | No | No | No |
| Export all records | Yes | No by default | No by default | No |

Enforce permissions in the backend/database, including account roles and record history, and extend the same rules to attachments when introduced. Interface visibility alone is insufficient. App super admins manage helpdesk accounts; technicians do not need hosting or database administration accounts. Signing in with a school email and app password requires an authorized, active app account and assigned role.

Technician visibility is restricted to Open Queue plus owned/collaborating tickets. Apply the same rule to search, counts, reports, resolved views, activity feeds, and real-time subscriptions; future attachments inherit it too. Open visibility means currently claimable work, not every unresolved ticket. Proposed rule: related records follow current membership; past contributions remain attributed even when access is removed. Public access and unrelated technicians receive no ticket data. Open Queue access grants reading and claiming, not unrestricted edits to unowned tickets.

### Launch essentials

- **Priority:** proposed Low, Normal, High, Urgent, default Normal. Admin sets any ticket's priority; a technician can set it when creating their walk-in. Propose participant changes with an activity entry; confirm whether later priority changes should be admin-only.
- **Time spent:** optional per-person manual work logs containing work date, minutes, and optional description. Total is person-time: two technicians working together for 20 minutes equals 40 technician-minutes. Track elapsed ticket lifetime separately. Contributors can add/correct their own entries, including after resolution while they retain ticket access, with recorded corrections; admin can correct any entry. Missing entries never block resolution or imply zero effort. Keep the first release simple with manual entry; an optional timer can follow later.
- **Queue updates:** refresh Open Queue, My Tickets, and Collaborating within the app so technicians can see claims and assignments without email. Show an appropriate empty state when the daily queue is cleared.

### Deferred enhancements

- **Attachments:** later introduce private files governed by ticket visibility. Reassess file types, size limits, retention, storage provider, and quotas at that point. No upload controls or attachment-storage provisioning in the first release.
- **Email notifications:** later choose recipients, triggers, sender, and service. Add delivery tracking, retries, and duplicate protection. Password emails can be introduced separately then; launch onboarding/recovery is admin-assisted.
- **Storage/email research retained for later review:** Supabase includes 1 GB file storage; R2 Standard includes 10 GB-month with usage-based charges above its allowance. Brevo's free allowance is 300 deliveries/day; Resend's is 100/day and 3,000/month. Recheck current plans when these features are scheduled. These are not launch dependencies.

Plan for technicians using student accounts and display only requester information needed for the service task. A public submission form later must be able to submit a request without gaining access to internal tickets or person/device directories.

## Foundation for later modules

- **App accounts:** login identity, helpdesk role, active status. Separate from the people directory: a requester does not automatically have login access.
- **People:** stable person ID with a minimal requester record first; later extend with staff/student attributes and approved external directory IDs. Store external identifiers as text to preserve leading zeros.
- **Tickets:** stable requester reference, intake details, lifecycle, and primary owner.
- **Ticket collaborators:** one relationship per participating technician, rather than slash-separated names.
- **Notes and events:** authorship, timestamps, status/assignment changes, and resolutions.
- **Work logs:** optional records with ticket, contributor, work date, duration, and correction history.
- **Later attachments:** ticket, private object key, file name/type/size, uploader, and creation time; file bytes live in object storage. No table or storage setup is required at launch.
- **Later notification outbox:** event, eligible recipient, template, delivery state, attempt count, and next retry time. No email integration is required at launch.
- **Ticket device observations:** support multiple devices and retain the device/person/location details observed at service time. An optional link can connect these to inventory later.
- **Later inventory:** permanent asset records, device identifiers, type/model, location, condition, and lifecycle status.
- **Later device assignments:** asset, assignee, issue date, return date, and assignment history. Current ownership changes must not rewrite historical ticket context.

Do not combine similar names, room numbers, or serial numbers automatically during migration. Link imported entries after review. A ticket about a room-wide network fault may have no individual device.

### Migration from AppSheet and Google Sheets

The destination will become the system of record, with export available for portability. Avoid permanent two-way synchronization with the old sheets. When the directory/inventory phase begins, inspect all source tabs, AppSheet keys and references, formulas and virtual columns, attachment paths, assignment data, and status definitions. Google Sheets rows alone may not contain AppSheet-calculated values or files stored in Drive.

Preserve source IDs as migration references, maintain an explicit ID mapping, and import people, assets, and assignments in dependency order. Validate duplicate IDs, missing references, ambiguous identities, counts by entity/status, and representative device histories. Preserve leading zeros in identifiers. Mark historical gaps as unknown instead of inventing ownership periods. Copy actual attachment files where required; a Drive path alone is not a completed file migration.

Run a staged rehearsal first. At cutover, pause writes to the old AppSheet workflow, import final changes, reconcile, and designate the new system as authoritative. Retain a read-only source snapshot and a defined rollback process that accounts for new writes in the replacement system. Full directory and inventory migration remains a later phase; ticketing starts with minimal requester records.

## Interface direction

Use a restrained application layout: neutral surfaces, clear typography, one accent color, readable status labels, and consistent spacing. Primary navigation for launch: Open Queue, My Tickets, Collaborating, Resolved, with admin-only All Tickets and Administration.

The queue should be a searchable, sortable table with ticket number, age, requester, location, issue, priority, and ownership/status as appropriate. Keep the Claim action visible. The ticket detail view groups request information, devices, and a chronological work timeline. The admin intake form should support quick entry and keyboard navigation.

Make the interface usable on phones during room visits. Status must remain understandable without color, controls need readable contrast and visible keyboard focus, and empty/loading/error states need clear text. Validate this direction with a clickable mockup using invented records before implementing the full interface.

## Delivery stages and exit criteria

1. **Foundation selected:** Next.js + TypeScript on Vercel Hobby with Supabase Postgres/Auth. Account method, approximate count, ticket volume, visibility, collaborator resolution, immediate closure, and optional time tracking are confirmed. Establish school data-hosting requirements and maintenance/backup ownership during deployment preparation.
2. **Review interface prototype:** admin enters and assigns a ticket; technician claims, collaborates, documents, and resolves. Review on desktop and phone with invented data.
3. **Implement ticketing:** school-email/app-password authentication, admin-assisted account setup/recovery, backend permissions, admin intake, self-assigned technician walk-ins, queue claiming, assignments, collaborators, notes, device observations, priorities, optional manual time tracking, search/filtering, resolution/reopening, and activity history. Add export, usage monitoring, and a recoverable database backup process. Attachments and email notifications are excluded from this release.
4. **Migrate and pilot:** review the 14 source tickets, identify account mappings and primary owners for combined names, preserve source dates and missing information, normalize Call to Phone Call, and retain source-row references. Never fabricate missing solutions or mark blank statuses resolved. Reconcile imported counts and prevent repeated imports from duplicating records.
5. **Add inventory:** asset catalog, identifier lookup, multiple device links per ticket, service history, barcode/QR lookup if useful.
6. **Expand people and assignments:** migrate staff/student directories and assignment records from AppSheet/Sheets, checkout/return workflow, current holder and historical assignments, device context in tickets; designate the new system authoritative after reconciliation.
7. **Add optional enhancements and public intake:** attachments and outbound email notifications can be scheduled after the ticketing pilot when needed; they do not require completion of inventory migration first. Later add a public submission form with abuse controls and restricted data access, requester-facing status access if wanted, and separately scoped inbound-email or device-management integration.

Pilot acceptance checks: simultaneous claims produce one owner; unauthorized users cannot read or change restricted records through direct requests; backdating preserves actual creation time; collaborators retain attribution; resolution requires a solution but succeeds without any time entry; reopening retains prior history; disabled users lose access; imported counts reconcile; database recovery is demonstrated.

Additional required checks: technicians cannot forge channel/owner on walk-in creation; a collaborator can resolve immediately with their own resolver identity; unrelated users cannot search restricted tickets; time totals sum person-time correctly and distinguish unlogged work; removing a collaborator revokes future access; simultaneous resolutions create one completion event. A technician can set a password using the intended setup link, expired/replayed links fail, pre-setup accounts cannot access tickets, public signup is denied, admin-assisted recovery works without email, and no password or setup/recovery token appears in logs.

## Open decisions

The first-release scope is sufficiently defined for interface design. The following setup details can be collected when their implementation stage begins:

1. Before live deployment: who owns maintenance/backups, and is the proposed cloud storage allowed for these school records?
2. Before creating accounts: exact technician names/emails, super admin identity, and the approved private method for handing over setup/recovery links. Do not collect passwords.
3. Proposed workflow defaults to review in the prototype: admin-only reassignment/reopening; technician walk-in dates default to today; participant priority changes are logged; manual time entry is optional. Whether technicians may backdate their walk-ins can be decided with the intake form.
4. Before directory migration: campus/location structure and precisely which requester details student technicians need to see.
5. Before ticket import: confirm source identifiers, primary owners for multi-technician historical tickets, and school-year naming.
6. When attachments or email are scheduled: revisit storage, retention, recipients, sender access, and current service limits. These questions do not block the first release.
