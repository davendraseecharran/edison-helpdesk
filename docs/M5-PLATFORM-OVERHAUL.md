# M5 — platform overhaul

The helpdesk that M3 built around tickets is now the school's IT system: the
same tickets, plus the people and the machines they are about, read from the
district's own directory and inventory, a phone that works as a barcode scanner,
attachments, notifications, an audit log, and an assistant that can
do the work rather than only describe it. Sign-in moved to Google, with invites
and an approval queue for anybody who was not invited.

Phase 2 then rebuilt the directory and the inventory on the owner's live
tables rather than beside them, made roles a set (administrator, NetRider,
skills officer), added Today as the screen a session lands on, and put the
interface on Tailwind v4 with shadcn/ui primitives themed from this project's
own tokens. The in-app CSV importer and the Insights screen are gone; the
former because the data already exists, the latter because the user removed it.

Everything in this document is verified against the local stack. No real
student or staff data is in the repository; the owner's source exports are
handed over out of band and are never in Git.

This document is written for somebody who will read the code.
[docs/OWNER-SETUP.md](OWNER-SETUP.md) is the same release and setup in plain
language, for the person who owns the Supabase project and the Vercel
deployment and will not open the repository.

## Contents

- [What changed for the people using it](#what-changed-for-the-people-using-it)
- [Architecture](#architecture)
- [Sign-in, invites and approvals](#sign-in-invites-and-approvals)
- [Roles](#roles)
- [Today](#today)
- [People and devices](#people-and-devices)
- [Search and the command palette](#search-and-the-command-palette)
- [The phone as a scanner](#the-phone-as-a-scanner)
- [Attachments, notifications and the audit log](#attachments-notifications-and-the-audit-log)
- [The assistant](#the-assistant)
- [Attribution](#attribution)
- [The design system](#the-design-system)
- [Deploy this branch](#deploy-this-branch)
- [Owner runbook for the hosted project](#owner-runbook-for-the-hosted-project)
- [Local setup and commands](#local-setup-and-commands)
- [Known limitations](#known-limitations)

## What changed for the people using it

- **Signing in.** Google is the primary way in. An administrator invites a
  person by email before their first sign-in; anybody else who signs in with a
  verified Google address lands in an approval queue and can reach nothing
  until an administrator approves them. The password form is still there, in a
  disclosure under the Google button, as the administrator's way back in when
  Google is unavailable.
- **Today** is where signing in lands: a greeting by name, a count of what
  needs you, and a ranked list — the unclaimed tickets, your own tickets
  stopped on somebody's reply, and, for an administrator, the people waiting
  for access — each row with one key that does the thing.
- **Navigation.** Today is first, then the queue, My tickets, Collaborating and
  Resolved; People and Devices are the directory; All tickets and
  Administration are administrator-only. A rail on wide screens, a bottom bar
  on phones. The rail shows only what the account's roles allow.
- **Tickets** carry a category, a requester who can be a real person from the
  directory, and links to the machines involved. The timeline shows notes,
  work, observations, attachments and status changes in one place. Intake reads
  what you typed — it drafts the category and the priority from the title and
  the issue, pulls a requester's room and machines when you name them, reads a
  pasted email into the fields, and warns when an open ticket already says the
  same thing.
- **One keyboard model in every list.** `j` and `k` move, `o` opens, `c`
  claims, `r` resolves, `e` edits, the number keys jump. Every one of those
  presses a control that is visible on the row.
- **A phone** pairs with the desktop from a QR code and sends scanned serial
  numbers and asset tags straight into the open form.
- **Ctrl/Cmd+K** opens a command palette over everything: actions, tickets,
  people, devices, and the five things you looked at last.
- **The assistant** (Ctrl/Cmd+J) can answer questions about the data and make
  changes, and every change it makes is labelled as that person's AI.
- **Dark by default**, with light and system in Settings.

## Architecture

Next.js 16 App Router with React 19 on Supabase, the same shape M3 established:
the browser talks to server components and server actions, server code talks to
Postgres with the signed-in person's own JWT, and row-level security decides
what exists.

| Layer | Where | Role |
| --- | --- | --- |
| Tokens and theme | `src/styles/tokens.css`, `src/components/shell/ThemeProvider.tsx` | One palette, two themes, stamped before first paint |
| Shell | `src/components/shell/**` | Rail, top bar, bottom tabs, palette, bell, assistant toggle |
| Session DAL | `src/lib/auth/session.ts` | `getUser()` verification plus roles and status from `app_accounts` |
| Roles | `src/lib/auth/roles.ts` | The pure predicates the screens use. Not the boundary; the database is |
| Reads | `src/lib/data/*.ts` | Today, queues, people, devices, search — all on the person's own client |
| Writes | `src/lib/data/*-actions.ts` | One reviewed RPC per mutation |
| Lists and keys | `src/lib/lists/keys.ts`, `src/components/ui/useRowKeys.ts` | One keyboard model, decided in a pure function |
| Intake reading | `src/lib/intake/draft.ts`, `src/lib/intake/suggest.ts` | Pasted email into fields; category and priority from the words. No network |
| Voice | `src/lib/voice/moments.ts`, `docs/VOICE.md` | The handful of moments that get a sentence |
| Admin client | `src/lib/supabase/admin.ts` | Service role. Auth users, links, storage, `app_trusted_*` only |
| Assistant | `src/lib/ai/**`, `src/app/api/ai/chat/route.ts` | Device-code OAuth, encrypted tokens, streamed tool loop |
| Scanner relay | `src/lib/scan/**`, `scan_sessions`/`scan_events` | Pairing, expiry, caps, Realtime with a polling fallback |

The trust boundaries M3 documented are unchanged and still binding: identity is
`auth.uid()`, role and status come from `app_accounts`, sessions are verified
with `supabase.auth.getUser()`, ticket data always travels on the user's own
JWT, admin operations authorize in the database before any service-role
credential is used, trusted functions are service-role only, and authenticated
pages are never cached. See
[M3 auth and integration](M3-AUTH-AND-INTEGRATION.md#trust-boundaries).

M5 adds three boundaries of its own:

1. **Public sign-up is closed in the database, not only in a setting.** The
   GoTrue *Before User Created* hook (`public.hook_before_user_created`,
   migration `20260914101200_m5_signup_hook.sql`) refuses any user whose
   `app_metadata.provider` is `email`. It also runs on a first Google sign-in
   and passes it, because that provider is `google`. The admin API does not run
   the hook at all, so administrator-created accounts are unaffected.
2. **The assistant's tokens never leave the server.** A person's ChatGPT
   OAuth tokens are encrypted with AES-256-GCM under `AI_TOKEN_KEY` before they
   are written to `ai_connections`, and they are only ever decrypted inside the
   chat route. With `AI_TOKEN_KEY` unset the panel says the assistant is not
   configured and no token can be stored.
3. **Search reads ids under `SECURITY DEFINER` and the rows under RLS.**
   `app_search_candidates` returns nothing but ids, per kind, capped at 200;
   `app_search` joins back to the tables as the caller, so a row the person
   cannot see cannot be reached through the palette. The ticket-number arms of
   the query only run when the query contains digits.

## Sign-in, invites and approvals

| State | How you get there | What you can reach |
| --- | --- | --- |
| `active` | Invited, or approved after an uninvited sign-in | Everything the role allows |
| `pending_approval` | Signed in with a verified Google address, no invite | The pending screen only |
| `denied` | An administrator declined the request | The restricted screen only |
| `setup_pending` | Created by an administrator for a password sign-in | The set-password screen only |
| `inactive` | Deactivated by an administrator | Nothing |

Any Google account with a verified email address may sign in, including a
personal one: the gate is the invite or the approval, not the domain. An
administrator invites by email from Administration; if `RESEND_API_KEY` is set
the invite is mailed, and if it is not, the screen hands over the message text
to send by hand. An invite is a database row, not a link with a token in it, so
a missing mail provider never blocks anybody.

Fifty access requests may be outstanding at once. Beyond that a new uninvited
sign-in is refused and told to come back, no account row is created and no
administrator is notified, so nobody can bury the waiting list under thousands
of rows; answering any request frees the slot immediately. An invite is never
affected by the cap. GoTrue creates the Auth user before the RPC runs, so a
refused attempt still leaves an Auth user behind with no account row; the
bound is on the waiting list, not on how many Auth users can be created.

Password sign-in is the break-glass path. Accounts for it are created by an
administrator, who issues a single-use setup or recovery link and hands it over
directly, exactly as in M3.

## Roles

An account holds a **set** of roles, at least one, from three:

| Role | What it is | What it reaches |
| --- | --- | --- |
| `admin` | Administrator | Everything, including Administration and every ticket |
| `netrider` | What this school calls the students who run the helpdesk | Tickets, the queue, the directory, the inventory, the scanner |
| `skills_officer` | Works the student and staff directory | People, and the inventory read-only. No tickets at all |

`app_accounts.roles text[]` is the source of truth: distinct, sorted, and
checked against that vocabulary. The old single-value `role` column survives as
a **derived** column, written by a trigger, so that the forty-odd
`role = 'admin'` gates written before roles were a set keep working unchanged.
That trigger is two-way — a writer that sets only `role` has it translated into
the set rather than silently undone — and its `technician` literal is the old
internal spelling of `netrider` and is never shown to anybody. Everything a
person reads says NetRider.

A skills officer who is neither a NetRider nor an administrator is refused
tickets in five places, all of them in the database: the `tickets` select
policy, `app_can_view_ticket` (which every child-table policy calls), the lock
every ticket mutation takes, a `before insert` trigger on `public.tickets`, and
the three RPCs that take their own lock (`app_claim_ticket`,
`app_reassign_ticket`, `app_add_collaborator` — the last two check what the
*target* may do, so work cannot be handed to somebody the policy hides it
from). `app_save_inventory_device` and the bulk inventory writers are
NetRider-or-administrator: a skills officer reads the inventory and does not
change it.

`app_set_account_roles(uuid, text[])` is the one door to a role change; it
keeps the last-usable-administrator guard and logs both arrays. Invites carry a
set. Administration → Access edits it as chips and refuses to clear the last
one. Signing in lands wherever the set can work: Today for anybody who works
tickets, People for a skills officer. Migrations
`20260914140000_m5_roles_set.sql`, `…140100`, `…140200`.

## Today

`/today` is the landing page for anybody who works tickets, and the rail's
first item. It is one read — `app_today_briefing()`, SECURITY INVOKER, so
row-level security decides the rows exactly as it does on the queue — returning
four counts and the top few rows under each: the unclaimed queue, your own
tickets stopped waiting on a reply, your live work, and, for an administrator,
the people waiting for access.

The list is ranked by urgency band and then by age, oldest first, and five
identical reports of the same thing are one row rather than five. Each row
carries the one key that acts on it, and the assistant writes a one-line
briefing beside it from the same read, so the panel and the screen cannot
disagree about how many things need you.

Saved views — the filter set somebody named, "Room 214" or "Chromebook
batteries" — live in `account_preferences.saved_views`, written through
`app_set_saved_views` and bounded there, so a browser cannot grow a column that
is read on every authenticated page render.

## People and devices

`requesters` is the district's own directory: 3,448 students and 261 staff, each
with the identifier the school already uses (an OSIS for a student, a staff ID
derived from the email address for a member of staff), their class or
department, and their contact details. `inventory_devices` is the district's own
inventory: 4,278 machines, each with a type, manufacturer, model and serial
number, an asset tag, a location, a free-text status and at most one holder.
`device_catalog` is the list of type/manufacturer/model tuples both intake and
the device editor offer.

Neither table is writable from a session, and `inventory_devices` has row-level
security with no policies at all: every read and every write goes through a
SECURITY DEFINER function. `app_list_people`, `app_get_person`,
`app_save_person`, `app_list_inventory`, `app_get_inventory_device`,
`app_save_inventory_device`, `app_inventory_statuses`, `app_device_catalog` and
`app_staff_directory_options` are the owner's; `app_assign_inventory_device`,
`app_return_inventory_device`, `app_bulk_update_inventory`,
`app_requester_devices`, `app_lookup_inventory_code` and
`app_inventory_facets` were added for the movements a help desk performs. Each
one re-derives the actor from `auth.uid()`.

People is the roster with a students tab and a staff tab; Devices is the whole
inventory. Both are lists with facets rather than a search box alone: status,
type and location are exact filters beside the term, offered from the values
actually present (`app_inventory_facets`), because on 4,278 machines "every
Chromebook in repair" is a question a substring match cannot answer. A
selection can be assigned or returned in one action, and status, location and
notes can be changed across at most two hundred machines at once. A directory
row shows how many open tickets that person has. A scanned code that resolves
to exactly one machine puts a card in the corner offering return, assign and
open, so scan-tap-scan-tap is a rhythm rather than a page load per machine.

Their screens are the only way into the roster: the `InventoryManager` and the
`/inventory/*` routes that arrived with the owner's release were replaced, not
kept alongside, so there is one People and one Devices rather than two of each
over the same rows.

Two rules are worth stating. A machine's status is FREE TEXT with no CHECK
constraint: `app_inventory_statuses()` returns every value in use plus the five
it seeds (Available, Assigned, In repair, Retired, Lost), so a word the district
invents appears on the screens and in the charts rather than being dropped.
And every record carries a `version`: a form sends back the version it opened
on, and a save against a record somebody else has already changed is refused
with "This record changed since you opened it" rather than overwriting them.

A ticket names one requester from the directory, or plainly nobody, and can
link any number of machines. The person page lists what they hold and the
tickets they raised; the machine's page lists the tickets it appears on and the
history of where it has been.

There is no in-app importer, and no CSV path of any kind into these tables. The
directory and the inventory were loaded once by the owner's
`scripts/prepare-inventory-import.mjs` and
`scripts/prepare-inventory-profiles.mjs` — the first refuses outright once a
requester carries an external id or a machine exists, and the second refuses
until that import is there and only updates rows it recognises — and every
change since is an edit from the screens, audited in
`inventory_events`. M5 originally shipped its own `people`, `devices`,
`device_assignments` and `import_runs` tables with an importer that wrote them;
those migrations were deleted rather than reversed, because none of them had
ever been pushed. Data leaves the system as CSV — Administration → Backups, and
the export button on Devices — but nothing comes in that way.

## Search and the command palette

`Ctrl/Cmd+K` (a full-height sheet on a phone) opens one palette over the whole
application: actions first (new ticket, claim by number, go to a section,
toggle the theme, ask the assistant, scan with your phone), then matching
tickets, people and devices, then the five records you opened last. Results
come from `searchAction` → `app_search`, measured under row-level security
rather than as a superuser.

## The phone as a scanner

A desktop session opens a pairing dialog and shows a QR code. The phone opens
it, signs in if it has to (the login page returns it to the same pairing), and
becomes a camera that sends every code it reads to the desktop. Sessions last
thirty minutes, at most five are live per account (the oldest is ended rather
than refusing a new one), and a session stops accepting scans after 500 events.
Delivery is Supabase Realtime on `scan_events` with polling behind it, so a
project with Realtime off still works, only less immediately.

## Attachments, notifications and the audit log

Attachments live in a **private** `attachments` storage bucket with no policies
on `storage.objects` at all: the bucket is reachable only through short-lived
signed URLs the server issues after `app_can_attach` has said the person may
see the parent record. The bucket caps a file at 8 MiB and accepts JPEG, PNG,
WebP, GIF and PDF. `public.attachments` is the registry that says which file
belongs to which ticket or device, and every row names exactly one parent.

Notifications are rows written only by `app_notify` and `app_notify_admins`,
never by a client. The bell shows the unread count and the last few; the
notifications page shows the rest, and a notification carries the action it is
about — Claim, Open — so reading one and doing it are the same gesture. The
audit log (Administration → Audit) records account changes, approvals and role
changes, append-only. Administration → Backups downloads any of the district's
fourteen tables as CSV, through an administrator-only SECURITY DEFINER read for
the two that have row-level security and no policies.

## The assistant

The panel (Ctrl/Cmd+J, a full-screen sheet on a phone) is a chat over the
person's own ChatGPT account.

- **Connecting** is OpenAI's device-code flow: the panel shows a code and a
  link, the person approves it in their browser, and the resulting tokens are
  encrypted and stored. Client id `app_EMoamEEZ73f0CkXaXp7hrann`, endpoints
  under `auth.openai.com/api/accounts/deviceauth/`.
- **Chatting** streams from `https://chatgpt.com/backend-api/codex/responses`.
  **This endpoint is undocumented.** It is what the Codex CLI uses with a
  personal ChatGPT account, and it is tolerated rather than guaranteed: it can
  change without notice. Endpoint, headers and body were read from `openai/codex`
  at commit `36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564` (main, 2026-09-13) and
  the exact source lines are cited in `src/lib/ai/responses-client.ts` and
  `src/lib/ai/codex-auth.ts`. The whole feature is gated behind `AI_TOKEN_KEY`
  for exactly this reason: unset it and the assistant is simply not there.
- **The model** is `gpt-5.6-luna` and nothing else. Reasoning defaults to high;
  Settings offers High, Extra high and Max.
- **Tools** are classified read, write or admin, in one exhaustive list that a
  test asserts against — by counting, not by sampling — so a tool added without
  being classified is a tool that fails the suite rather than one that quietly
  runs. Read tools run. Write tools run without asking by default, and Settings
  has a per-person switch that makes the assistant stop and ask first. Admin
  tools — invites, roles, an access decision, deactivating somebody, taking a
  backup — always stop and ask, whatever the switch says. Which tools an
  account is offered at all follows its role set: a skills officer is given the
  directory tools, their own settings, and no ticket tool.
- **The principle** is that the assistant may do exactly what the signed-in
  person may do, and nothing more. Every tool is gated by `toolsFor(roles)` the
  same way the interface is, every one of them runs the RPC that screen's
  button runs, on that person's own client, and the database re-derives the
  actor from `auth.uid()` inside each function. There is nothing the assistant
  can reach that its operator could not.
- **It reads the same things the screens do.** `get_today_briefing` is the
  Today read, so the panel and the screen agree; `draft_ticket_from_text` is the
  same pure reader the intake form uses on a pasted email. Typing a question
  into the palette offers "Ask the assistant: …" and sends that sentence
  straight through, and a ticket page marks itself so "resolve this one" means
  the ticket on screen.
- Everything it can do, it does through the same RPCs a person uses, on that
  person's own client, so it can never see or change anything they could not.

### Every tool, and who is offered it

Fifty-three tools. A skills officer is offered fourteen, a NetRider forty-three,
an administrator all of them. "Asks" is whether the change is put to the person
before it runs: **setting** means it follows their "ask before changes" switch,
**always** means it asks whatever the switch says, and a read never asks.

| Tool | Does | Roles | Asks |
| --- | --- | --- | --- |
| `search_records` | Tickets, people and devices at once | All | read |
| `get_today_briefing` | The Today screen's own read | NetRider, admin | read |
| `draft_ticket_from_text` | Reads a pasted email as a draft; creates nothing | NetRider, admin | read |
| `get_ticket` | One ticket in full, with history and notes | NetRider, admin | read |
| `list_queue` | Tickets by scope, status, priority, category | NetRider, admin | read |
| `list_my_tickets` | What this person owns | NetRider, admin | read |
| `list_people` | Students or staff | All | read |
| `get_person` | One record, with the machines they hold | All | read |
| `list_devices` | The inventory | All | read |
| `get_device` | One machine | All | read |
| `list_attachments` | The files on a ticket or a device | All | read |
| `list_notifications` | Their own notices | All | read |
| `list_audit` | The whole log, by day, kind, record type or by hand/AI | Admin | read |
| `create_ticket` | Opens one, optionally claimed | NetRider, admin | setting |
| `claim_ticket` | Takes an unclaimed one | NetRider, admin | setting |
| `add_note` | A permanent work note | NetRider, admin | setting |
| `set_priority` / `set_category` | What kind, how urgent | NetRider, admin | setting |
| `set_waiting` / `resume_work` | On hold, and off it again | NetRider, admin | setting |
| `resolve_ticket` | Closes it with what fixed it | NetRider, admin | setting |
| `return_to_queue` | Gives it back | NetRider, admin | setting |
| `add_collaborator` / `remove_collaborator` | Who else is on it | NetRider, admin | setting |
| `log_work` | Minutes against a school day | NetRider, admin | setting |
| `record_device_observation` | A machine that is not in inventory | NetRider, admin | setting |
| `link_device_to_ticket` / `unlink_device_from_ticket` | One that is | NetRider, admin | setting |
| `attach_to_ticket` | A picture from THIS message onto a ticket | NetRider, admin | setting |
| `remove_attachment` | Takes a file off, if they may | NetRider, admin | setting |
| `mark_notifications_read` | Their own, by id or all | All | setting |
| `set_preference` | Their own theme, notices and assistant settings | All | setting |
| `save_view` / `delete_view` | Their own named filter sets | All | setting |
| `create_person` / `update_person` | The directory | All | setting |
| `archive_person` | Records that somebody has left, or has not | All | setting |
| `create_device` / `update_device` | The inventory | NetRider, admin | setting |
| `assign_device` / `return_device` | Handing a machine out and taking it back | NetRider, admin | setting |
| `set_device_status` / `move_device` | Where it is in its life, and where it lives | NetRider, admin | setting |
| `bulk_update_devices` | Up to 200 at once | NetRider, admin | setting |
| `reassign_ticket` | A different owner | Admin | always |
| `reopen_ticket` / `cancel_ticket` | Undoing or voiding a close | Admin | always |
| `review_access_request` | Approve or decline somebody waiting | Admin | always |
| `create_invite` | An address and a role | Admin | always |
| `set_roles` | Replaces what a colleague holds | Admin | always |
| `deactivate_account` / `reactivate_account` | Access away, and back | Admin | always |
| `export_backup` | One table as CSV | Admin | always |

Three of those have a rule worth stating outside the table.

**`attach_to_ticket` only sees this message's pictures.** The model is sent the
bytes in the turn they arrive in; the conversation row keeps the file names and
nothing else, because `ai_messages` refuses a row over 256 KiB and four
megabytes of base64 is many times that. So attaching works in the same message
and says so plainly otherwise. The one exception is an approval: a person with
"ask before changes" on answers on a later request, so the panel sends that
turn's pictures back with the "yes", under their own field, and they never
appear in the conversation as a second message.

It takes the browser's path rather than a shortcut around it — `app_can_attach`
in the person's own session, the path built by the server, the bytes through
the same one-path upload grant, and the row written by the same
read-back-and-verify sequence, which fetches the object again and asks its first
bytes what it really is. A file that disagrees with its own label gets no row
and no bytes.

**`export_backup` will not put a whole table in a chat turn.** Same fourteen
tables as the Backups screen, same constant-not-string lookup, same 50,000-row
ceiling, same "capped" in the file name. Under 200 KB the CSV comes back as a
file to hand over; over it, the result is the row count, the columns and the
first twenty rows, and the download stays on the Backups screen.

**`list_audit` is a read that only an administrator is offered.** The group
answers "is this a change?", and that question is what decides whether somebody
is asked first — so the audit log cannot sit in the admin group, where every
tool asks and asking before a read would be a confirmation card for nothing. A
separate `adminOnly` flag says the second thing, and the suite asserts that a
NetRider is offered every read and write except those.

## Attribution

Every change made through the assistant is recorded as that person's work, made
by their AI. The server client the assistant uses sends `x-edison-via: ai` and
`x-edison-ai-model`; `app_request_via()` reads those headers inside the
database and stamps `performed_via` and `ai_model` on the row it writes. Notes,
work logs, device observations, attachments, resolutions and timeline events
all carry it, and the interface renders it as "Nia's AI" beside the
change. The headers are declared by the client, so the stamp is a label for
readers, never a permission: nothing in the database treats an AI-marked action
differently from the same person's own.

Attachment registration is the one write that does not go out on the person's
own client — `app_trusted_register_attachment` is granted to the service role
alone, because the size and the type in the registry have to be read back off
the stored object rather than claimed by whoever uploaded it. So that call
carries the same two headers, and `app_request_via()` reads them the same way.
The actor still arrives as an id that the function re-reads and re-judges for
itself, and no Server Action takes `via` as an argument: the browser's own
upload path never sets it, so nobody can label their own file as somebody's AI.

## The design system

`src/styles/tokens.css` is the single source of truth and nothing outside it
writes a colour. The palette is monochrome: a gray ladder from the page to the
overlay, hairlines a step above whatever they sit on, three steps of text, and
one muted semantic pair kept for Urgent and High. The school's navy and brass
are retired, and so is the blue that briefly replaced them; the retired token
names survive as aliases pointing at the ink, which is why nine stylesheets
followed the change without being edited. The typeface is Geist Sans and Geist
Mono, through `next/font`, behind the same `--font-sans` and `--font-mono`
names.

Tailwind v4 and shadcn/ui (new-york, CSS variables) are in, and every shadcn
variable is **derived** from a token rather than hand-typed: dark mode runs off
this application's own `[data-theme="dark"]`, bottom sheets are vaul
underneath, and the command palette is cmdk. Where a hand-built primitive was
weaker at the hard part — dragging, focus, dismissal, the keyboard — the
behaviour layer was swapped and the class names and tokens kept. `docs/MOTION.md`
is the table of every animation and where its behaviour comes from;
`docs/VOICE.md` is the handful of moments that get a sentence.

One identity rule is asserted rather than trusted: `--edge-light`, the lift
that means "your next keystroke acts on this", is worn by exactly one element
on a screen. `src/styles/lamp.css` is the only place that decides who holds it,
and `scripts/review-overhaul.cjs` measures the count on every route.

## Deploy this branch

This is what pushing this branch to the hosted project involves. The
[owner runbook](#owner-runbook-for-the-hosted-project) below is the one-time
setup of the project itself and its order still stands; this section is the
release.

**What is pending.** The hosted project carries the nineteen migrations through
`20260914010000_staff_directory_options.sql`. This branch adds thirty-eight
more, every one of them numbered `20260914100000` or above precisely so that
they apply *after* the owner's four (`20260912210000`, `20260912220000`,
`20260913150000`, `20260914010000`) and build on the live `requesters`,
`inventory_devices`, `device_catalog` and `inventory_events` rather than beside
them. They are additive in the sense that matters — no owner table is dropped,
renamed or rewritten, and no owner row is touched — but "nothing of the
owner's is changed" would be too strong, and three things are: one owner policy
is restated tighter (`tickets_select_visible`, `20260914140000`), five owner
functions are replaced in place at the same names (`app_set_account_role` is
superseded by `app_set_account_roles`, and four inventory and directory RPCs
are dropped and recreated with their grants restated), and one column is added
(`requesters.archived_at`, `if not exists`). Every one of the thirty-eight also sorts
strictly after the highest version the hosted project holds, so `db push`
applies them in version order and never needs `--include-all` to accept an
out-of-order file. Confirm the list before you push:

```bash
npx supabase migration list --linked   # nothing local pending, 38 remote-missing
```

**Pre-flight, before the push.**

1. **Vercel environment variables**, Production: `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` are already
   set from M4. Add `NEXT_PUBLIC_APP_ORIGIN` (the stable HTTPS alias — it is
   the only origin used to build setup and recovery links), and, if you want
   them, `RESEND_API_KEY` + `MAIL_FROM` for emailed invites and `AI_TOKEN_KEY`
   (`openssl rand -base64 32`, server-only, never `NEXT_PUBLIC_`) for the
   assistant. The build runs with none of the server-only values available, so
   nothing may read them at module scope; every page that needs a session is
   `force-dynamic` and nothing is prerendered behind a sign-in.
2. **Dashboard, in this order**: the *Before User Created* hook
   (`public.hook_before_user_created`) enabled **first**, then sign-ups allowed,
   then the Google provider, then Realtime on for `scan_events`, and check that
   Storage holds a private `attachments` bucket at 8 MiB with the five accepted
   types. These are runbook steps 2, 3, 4, 10 and 8; the hook before the
   sign-up switch is the one order that matters for security.
3. **Do not import anything.** Runbook step 11.

**The release.**

```bash
npx supabase db push        # applies the 38 pending migrations, in version order
vercel --prod --skip-domain # build and deploy
# then promote the alias once the deployment is Ready and checked
```

**Rollback.** The migrations are additive, so the previous application revision
keeps working against the new schema: re-promote the last known-good Vercel
deployment and nothing in the database needs undoing. There is no down
migration and none is wanted — a destructive rollback of a schema the live
directory now depends on is worse than the fault it would be reverting. Take a
backup before the push all the same (Administration → Backups, or the
provider's own), because a restore is the only answer to a data mistake.

**Local-only settings, for the avoidance of doubt.** `supabase/config.toml`
configures the **local** stack and nothing else; the hosted project never reads
it. Three kinds of value live in it and it is worth separating them.

*Committed, and required for a local stack to behave like the hosted one.*
`[storage] enabled = true`, which differs from the upstream default of `false`.
Migration `20260914100800` creates the `attachments` bucket row only when
`storage.buckets` is present, so with storage off a local reset produced a
schema where an attachment could be registered and never uploaded — and the
bucket, which is half of that feature's security (private, 8 MiB, five mime
types), was never created to be checked. Anybody resetting a local database
needs this on. Also committed: `http://127.0.0.1:3000/auth/callback` in
`additional_redirect_urls`, because Google sign-in against a local stack has to
be allowed to come back to the documented default port.

*Committed, and specific to this machine.*
`http://127.0.0.1:3005/auth/callback`, beside it. 3000 and 3001 are unbindable
under WSL here, so this machine's server runs on 3005; the line belongs in the
uncommitted patch below rather than in the repository, and it is still in the
committed file only because moving it means staging `supabase/config.toml`,
which would carry the rest of that patch with it. Harmless — it is a loopback
address in a file the hosted project never reads — and worth tidying the next
time this file is legitimately staged.

*Uncommitted, and never to be staged.* `[realtime] enabled = true` (the
committed default is `false`, and the hosted project turns Realtime on from the
dashboard instead) and `minimum_password_length = 8` (the committed value is
12, which is what the hosted project enforces). The committed API/database/
Studio ports are the defaults 54321/54322/54323; this machine runs on 55321/2/3
through the same uncommitted patch, and lane 2 on 56321/2/3 with its own
`project_id`.

**The rehearsal.** Applying these thirty-eight migrations onto a database
holding exactly the owner's nineteen — which is what `db push` will do — was
run end to end on a second local stack on 2026-09-14 and again, with the final set, on 2026-09-15. The database was first
rebuilt from `origin/main`'s nineteen migration files alone, and only then were
this branch's files dropped in and applied forward. It needed no manual step,
no edit and no reordering.

```bash
# 1. a database holding exactly what the hosted project holds today
git archive origin/main supabase/migrations | tar -x -C /tmp/main-set
cp -a /tmp/main-set/supabase/migrations supabase/migrations   # 19 files
npx supabase db reset --local
# -> Applying migration 20260910200000_core_schema.sql ... 20260914010000_staff_directory_options.sql
# -> Finished supabase db reset on branch main.
npx supabase migration list --local        # 19 rows, local == remote on every one

# 2. this branch's migrations applied forward, which is what db push does
cp -a <branch>/supabase/migrations supabase/migrations         # 57 files
npx supabase migration up --local --include-all
# -> Applying migration 20260914100000_m5_foundation.sql
# -> ... 38 files ...
# -> Applying migration 20260915020000_m5_join_ticket.sql
# -> {"applied":[ ...38 paths... ],"message":"Migrations applied"}
npx supabase migration list --local        # 57 rows, local == remote on every one

# 3. the suites, against that database
npx vitest run --config vitest.db.config.mts    # 443 tests, 33 files, all passing
npx vitest run --config vitest.auth.config.mts  # 53 tests, 7 files, all passing
```

The single database-suite failure was a test fixture, not the schema: one
staff record was left on the harness's default display name and answered a
search another file asserts the exact results of. It failed identically on a
full local reset in the main worktree, so it says nothing about applying these
migrations onto the owner's database. Named in
`tests/db/m5-today-devices.test.ts`, after which `npm run test:local` is 428 of
428 and 53 of 53.

Every migration applied first time against the owner's live objects — their
`requesters` columns, `inventory_devices`, `device_catalog`, `inventory_events`
and `app_set_account_role` all present and untouched. The auth suite resets the
database in its own global setup, so it necessarily rebuilds from the whole
fifty-seven rather than from the incremental path; the database suite is the one
that ran against the incrementally migrated database, and it is the one that
proves the merge.

## Owner runbook for the hosted project

Do these in order. **Step 2 must happen before step 3.** Turning on sign-ups
before the hook is installed leaves the project open to anybody who knows the
project URL and the anon key, which is public by design.

1. **Apply the migrations.** From a workdir linked to the hosted project,
   `npx supabase db push`. Never run a reset against it; the local reset suites
   must stay pointed at the local stack.
2. **Install the sign-up hook.** Supabase dashboard → Authentication → Hooks →
   *Before User Created* → Postgres function → `public.hook_before_user_created`,
   and enable it. Verify it is enabled before continuing.
3. **Only now, allow sign-ups.** Authentication → Sign In / Providers → *Allow
   new users to sign up*. With the hook in place this permits Google's first
   sign-in and refuses email-and-password sign-up with a 403.
4. **Add Google.** In Google Cloud create an OAuth client of type *Web
   application* and set its authorized redirect URI to
   `<SUPABASE_URL>/auth/v1/callback` — the Supabase callback, not the
   application's own `/auth/callback`, which is where Supabase sends the browser
   afterwards. Paste the client id and secret into Authentication → Sign In /
   Providers → Google and enable it.
5. **Set `NEXT_PUBLIC_APP_ORIGIN` on Vercel** to the stable HTTPS alias, for
   Production. It is the only origin used to build setup and recovery links, and
   nothing accepts a redirect target from a query parameter. The three variables
   M4 already set (`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY`) stay as they are.
6. **Mail, if you want invites emailed.** Verify a sending domain with Resend,
   then set `RESEND_API_KEY` and `MAIL_FROM` (an address on that domain).
   Without them invites still work; the administration screen hands over the
   message to send by hand.
7. **The assistant, if you want it.** Generate a key with
   `openssl rand -base64 32` and set it as `AI_TOKEN_KEY`, server-only, never
   prefixed with `NEXT_PUBLIC_`. Rotating it makes every stored ChatGPT
   connection unreadable and everybody has to connect again.
8. **Check the attachments bucket.** Storage should hold a bucket named
   `attachments`, **not public**, with an 8 MiB file size limit and the mime
   types `image/jpeg`, `image/png`, `image/webp`, `image/gif`,
   `application/pdf`. Migration `20260914100800_m5_attachments.sql` creates it
   where a `storage` schema exists; the application checks for it at startup and
   says so if it is missing. `ATTACHMENT_BUCKET` in
   `src/lib/data/attachments.ts` is the name it expects.
9. **Schedule the scan sweeper.** `public.app_sweep_scan_sessions()` deletes
   pairing sessions that ended more than a day ago. It cannot be driven by
   `pg_cron` as it is written — it is gated on an actor and a cron session
   carries no JWT claims — so call it daily from an external scheduler with the
   service key.
10. **Realtime, optionally.** Enable Realtime for `scan_events` so scans reach
    the desktop immediately. With it off the phone scanner still works by
    polling.
11. **Do not import.** The directory and the inventory are already live on the
    hosted project, and this branch adds no import path of its own.
    `scripts/prepare-inventory-import.mjs` refuses outright once a requester
    carries an external id or a machine exists; run neither preparation script
    again.

**Attachments, periodically.** Deleting a ticket or a device leaves its
uploaded files in the private `attachments` bucket: the cascade removes the
registry rows inside the database, which has no way to reach storage. The
bytes are unreachable (the bucket is private and carries no policies, and a
signed URL is only ever minted for a path the registry returned), so this is
storage cost rather than exposure. To reclaim it, list `storage.objects` in
the `attachments` bucket, left-join `public.attachments` on `name = path`, and
delete the objects with no match. Safe at any time: a registered attachment's
row is committed before its bytes are referenced.

`supabase/config.toml` configures the **local** stack only; changing it does not
configure the hosted project. The values committed there are the defaults
(54321 API, 54322 database, 54323 Studio); a local developer may run on other
ports through an uncommitted patch to that file.

## Local setup and commands

See the [README](../README.md) for the full local setup. In short: `npm install`,
`npm run db:start`, `cp .env.example .env.local` and fill it in from
`npm run db:status`, `npm run bootstrap:admin -- --email you@edison.example
--name "Your Name"`, `npm run dev`.

```bash
npm run check        # typecheck, lint, unit tests, production build
npm run test:local   # reset + DB tests, then reset + auth tests
```

The two reset-based suites destroy local synthetic data, including any account
you bootstrapped. Never run them against a hosted project and never run them
while a browser review is in flight.

Repeatable browser review:

```bash
PLAYWRIGHT_MODULE=/absolute/path/to/playwright \
REVIEW_BASE_URL=http://127.0.0.1:3000 \
node scripts/review-overhaul.cjs
```

It creates one synthetic account of each role through the local admin API,
seeds directory records, machines and tickets through the owner's own RPCs,
signs in with the password form, and walks Today, the queue, a ticket, intake,
My tickets, People (students and staff), a person, Devices, a device,
Administration (Access and the audit log), Settings, notifications, the palette
and the assistant panel, plus the signed-out sign-in page, at 1440×900,
1024×768 and 390×844 on both themes. It asserts that no page scrolls sideways,
that no page logs a browser error, and that never more than one element wears
the lamp. PNGs land in `/tmp/edison-overhaul-review/final`
(`REVIEW_OUTPUT_DIR` overrides). It refuses a non-loopback base URL, a
non-loopback Supabase URL and a linked project.

`scripts/review-intake.cjs` and `scripts/review-inventory-management.cjs` are
**retired**: they drove the owner's intake and `/inventory/*` screens, which
this branch replaced. Each refuses to run and says what covers it now.

## Known limitations

- **Orphaned storage objects.** Deleting a ticket or a device removes its
  `attachments` rows by cascade but not the bytes in the bucket. Nothing can
  read them — there are no policies on `storage.objects` and no signed URL is
  issued for a row that no longer exists — but they occupy storage until
  something sweeps them. See the runbook's "Attachments, periodically" note
  for the reclamation procedure.
- **The scan sweeper needs an external scheduler.** See runbook step 9.
- **The Codex endpoint is unofficial** and may change without notice. The
  assistant is gated behind `AI_TOKEN_KEY` so the rest of the application is
  unaffected if it does.
- **`authUserExists` pages the first 1000 auth users.** Past that, the check an
  administrator's invite screen makes before creating an account can miss an
  existing identity. The school is far below that number, and the unique
  constraint on `app_accounts.email` is the real protection. The fifty-request
  cap on the sign-in waiting list does not help here: it bounds
  `app_accounts`, not `auth.users`, and GoTrue creates the Auth user before
  the RPC that enforces the cap ever runs, so a flood of uninvited Google
  accounts still grows `auth.users` without limit and degrades this check.
- **The conversation cap on the assistant is soft.** Concurrent inserts can
  exceed it briefly before it settles.
- **Realtime is optional but noticeably better.** Without it the phone scanner
  polls, which is slower and costs a request every couple of seconds while a
  pairing is open.
- **No backup rehearsal yet.** M4 left this open and M5 did not close it:
  Administration → Backups exports the tables, and an export is not a restore.
  Prove one before the system carries a day's real tickets.
- **A password changed outside the app supersedes that account's sessions.**
  `account_credential_state` binds a session to a digest of the password hash
  recorded when the account row was written, so any change to
  `auth.users.encrypted_password` that the app did not make reads as
  "superseded": `app_token_is_current` answers false and every RPC says the
  session has been signed out. That is the control working, not a fault — the
  app's own setup and recovery flow re-approves the digest in the same
  transaction as the password change. It does mean that resetting an
  administrator's password from the Supabase dashboard or the admin API locks
  that account out of the application until the digest is re-approved; use a
  recovery link instead. Recorded here because the earlier suspicion was
  different: GoTrue was thought to rehash a stored password on its first
  sign-in, which would have broken the binding with nobody touching anything.
  That was tested deliberately against GoTrue v2.196.0 and does **not** happen —
  the stored hash is byte-identical before and after the first sign-in, and
  stays so even when it was written at a bcrypt cost the server is not
  configured for. See the P2-6b report for the transcript.
- **Some dead stylesheet rules survive their markup.** `src/app/globals.css`
  still carries the `.intake-*` rules the owner's intake form used. Presentation
  only, matched by nothing.
- **`role` is still the derived column.** Forty-odd functions and policies read
  `role = 'admin'`, and the internal `technician` literal is still what a pure
  NetRider's row says. Migrating the literal is an invisible data change nobody
  has needed yet.
