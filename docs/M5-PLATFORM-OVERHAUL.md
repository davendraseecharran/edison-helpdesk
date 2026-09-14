# M5 — platform overhaul

The helpdesk that M3 built around tickets is now the school's IT system: the
same tickets, plus the people and the machines they are about, read from the
district's own directory and inventory, a phone that works as a barcode scanner,
attachments, notifications, an audit log, and an assistant that can
do the work rather than only describe it. Sign-in moved to Google, with invites
and an approval queue for anybody who was not invited.

Everything in this document is verified against the local stack. No real
student or staff data is in the repository; the CSV exports are handed over by
the owner out of band.

## Contents

- [What changed for the people using it](#what-changed-for-the-people-using-it)
- [Architecture](#architecture)
- [Sign-in, invites and approvals](#sign-in-invites-and-approvals)
- [People and devices](#people-and-devices)
- [Search and the command palette](#search-and-the-command-palette)
- [The phone as a scanner](#the-phone-as-a-scanner)
- [Attachments, notifications and the audit log](#attachments-notifications-and-the-audit-log)
- [The assistant](#the-assistant)
- [Attribution](#attribution)
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
- **Navigation.** The queue, My tickets, Collaborating and Resolved are still
  the work; People and Devices are new; All tickets and
  Administration are still administrator-only. A rail on wide screens, a
  bottom bar on phones.
- **Tickets** carry a category, a requester who can be a real person from the
  directory, and links to the machines involved. The timeline shows notes,
  work, observations, attachments and status changes in one place.
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
| Session DAL | `src/lib/auth/session.ts` | `getUser()` verification plus role and status from `app_accounts` |
| Reads | `src/lib/data/*.ts` | Queues, people, devices, search — all on the person's own client |
| Writes | `src/lib/data/*-actions.ts` | One reviewed RPC per mutation |
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
2. **The assistant's tokens never leave the server.** A technician's ChatGPT
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
`app_requester_devices` and `app_lookup_inventory_code` were added for the
movements a help desk performs. Each one re-derives the actor from `auth.uid()`.

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

There is no in-app importer. The directory and the inventory were loaded once
by the owner's `scripts/prepare-inventory-import.mjs` and
`scripts/prepare-inventory-profiles.mjs`, and every change since is an edit
from the screens, audited in `inventory_events`.

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
notifications page shows the rest. The audit log (Administration → Audit)
records account changes, imports, approvals and role changes, append-only.

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
- **The model** is `gpt-5.6-luna` and nothing else. Reasoning defaults to high
  and can be changed in Settings.
- **Tools** are classified read, write or admin. Read tools run. Write tools
  run without asking by default, and Settings has a per-person switch that
  makes the assistant stop and ask first. Admin tools — invites, roles,
  committing an import — always stop and ask, whatever the switch says.
- Everything it can do, it does through the same RPCs a person uses, on that
  person's own client, so it can never see or change anything they could not.

## Attribution

Every change made through the assistant is recorded as that person's work, made
by their AI. The server client the assistant uses sends `x-edison-via: ai` and
`x-edison-ai-model`; `app_request_via()` reads those headers inside the
database and stamps `performed_via` and `ai_model` on the row it writes. Notes,
work logs, device observations, attachments, imports, resolutions and timeline
events all carry it, and the interface renders it as "Nia's AI" beside the
change. The headers are declared by the client, so the stamp is a label for
readers, never a permission: nothing in the database treats an AI-marked action
differently from the same person's own.

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
    hosted project. Repeating either preparation script would duplicate them,
    and both refuse to run a second time for exactly that reason.

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

It creates its own synthetic administrator and technician through the local
admin API, seeds people, devices and tickets through the ordinary RPCs, signs
in with the password form, and walks every route at 1440×900, 1024×768 and
390×844 on both themes, asserting that no page scrolls sideways and no page
logs a browser error. PNGs land in `/tmp/edison-overhaul-review/final`
(`REVIEW_OUTPUT_DIR` overrides). It refuses a non-loopback base URL, a
non-loopback Supabase URL and a linked project.

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
- **No backup rehearsal yet.** M4 left this open and M5 did not close it: prove
  a restore before the system carries a day's real tickets.
