# Edison Helpdesk

The school's IT system: tickets, the people they are about, the machines they
are about, and the work done on them. M1 established the interface, M2 added
database permissions and transactions, M3 connected real accounts and ticket
workflows, M4 deployed it, and M5 — the platform overhaul — added Google
sign-in with invites and approvals, the district's own directory and
inventory, search and a command palette, attachments,
notifications, an audit log, a phone that works as a barcode scanner,
and an assistant that can do the work rather than only describe it.

Phase 2 of that overhaul rebuilt People and Devices on the district's live
`requesters` and `inventory_devices` rows rather than on tables of M5's own,
made roles a set (administrator, NetRider, skills officer), and added Today —
the screen a session lands on, which answers "what needs me" rather than "what
exists". There is no importer and no Insights screen.

Current state and review results: [PROJECT_STATUS.md](PROJECT_STATUS.md).
Requirements: [TICKETING-PLAN.md](TICKETING-PLAN.md).
Implementation handoff: [CLAUDE-HANDOFF.md](CLAUDE-HANDOFF.md).
What M5 built, and the owner's runbook for the hosted project:
[docs/M5-PLATFORM-OVERHAUL.md](docs/M5-PLATFORM-OVERHAUL.md).
Deploying and setting the hosted project up, in plain language:
[docs/OWNER-SETUP.md](docs/OWNER-SETUP.md).

## Local setup

Node 24 (pinned in `package.json` and `.nvmrc`), npm, and Docker for the local
Supabase stack.

```bash
npm install
npm run db:start
cp .env.example .env.local
```

Fill the ignored `.env.local` from the local Supabase configuration. The public
URL, anon key and app origin are distinct from the server-only service-role key.
Never publish the latter. `npm run db:status` displays local keys, so avoid
sharing its output. See [database setup](docs/M2-DATABASE.md) for the Docker
helper PATH workaround on this machine.

`.env.example` documents every variable. Four are required and the rest are
optional switches:

| Variable | Required | What it does |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` | yes | Public by design; row-level security is what protects the data |
| `NEXT_PUBLIC_APP_ORIGIN` | yes | The only origin used to build setup and recovery links |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Server only. Bypasses row-level security completely |
| `SUPABASE_AUTH_EXTERNAL_GOOGLE_CLIENT_ID`, `SUPABASE_AUTH_EXTERNAL_GOOGLE_SECRET` | for Google sign-in | Read by `supabase/config.toml` through `env()`, so no credential is committed |
| `RESEND_API_KEY`, `MAIL_FROM` | for emailed invites | Without them an invite still works; the admin screen hands over the message to send by hand |
| `AI_TOKEN_KEY` | for the assistant | `openssl rand -base64 32`. Encrypts each person's ChatGPT tokens at rest; unset, the assistant is not there |

Create the first synthetic administrator only on an empty local setup:

```bash
npm run bootstrap:admin -- --email you@edison.example --name "Your Name"
npm run dev
```

Open the configured app origin (normally `http://127.0.0.1:3000`). Bootstrap
refuses nonlocal/linked projects and an existing administrator. It displays a
newly generated local password once, or accepts private stdin input with
`--stdin-password`. No password belongs in command arguments, source, or tickets.

## Signing in

Google is the primary way in and is offered first on the login page. An
administrator invites a person by email before their first sign-in; anybody who
signs in with a verified Google address without an invite lands in an approval
queue and can reach nothing until an administrator approves or denies them. Any
verified Google address works, including a personal one — the gate is the invite
or the approval, not the domain.

Password sign-in is still there, in a disclosure beneath the Google button, as
the administrator's way back in when Google is unavailable. Those accounts are
created by an administrator, who issues a single-use setup or recovery link and
hands it over directly. Links are credentials: copy privately, never paste into
ticket notes.

Public password sign-up is closed by the *Before User Created* auth hook, not
only by a dashboard setting. On a hosted project the hook must be enabled
**before** sign-ups are turned on — see the
[runbook](docs/M5-PLATFORM-OVERHAUL.md#owner-runbook-for-the-hosted-project).
Detailed auth contracts and limitations:
[auth and integration](docs/M3-AUTH-AND-INTEGRATION.md).

## What is in it

- **Today.** `/today` is where signing in lands: a greeting by name, how much
  needs you, and a ranked list — unclaimed tickets, your own work stopped on
  somebody's reply, and, for an administrator, people waiting for access. One
  key per row does the thing.
- **Roles, as a set.** An account holds one or more of administrator, NetRider
  (what this school calls the students who run the helpdesk) and skills
  officer. A skills officer works the student and staff directory, reads the
  inventory, and cannot reach a ticket at all — enforced in the database, not
  only in the rail.
- **Tickets.** Admins create any approved channel, optionally assign an owner,
  and can backdate the submission date. A NetRider's walk-ins are self-owned
  and dated today. NetRiders see open claimable work and owned/collaborating
  tickets. Owners and collaborators resolve with a solution; time recording is
  optional. Primary owners can return unfinished tickets to Open Queue, keeping
  notes, devices, time entries, collaborators and history; somebody else can
  then claim it. Admins also reassign, reopen and cancel. School dates use
  America/New_York.
- **Intake that reads what you typed.** The category and the priority are
  drafted from the title and the issue; a pasted email becomes the fields; and
  an open ticket that already says the same thing is shown as a warning, never
  a block.
- **People and devices.** The district's own records: 3,448 students, 261 staff
  and 4,278 machines, in `requesters` and `inventory_devices`. Who is holding
  what, what state a machine is in, and links from a ticket to the machines
  involved. Status, type and location are filters rather than search terms; a
  selection can be assigned or returned at once. They arrive through the
  owner's one-time preparation scripts and are corrected afterwards from their
  own pages; there is no in-app importer and no CSV path in.
- **Search.** `Ctrl/Cmd+K` opens a command palette over tickets, people,
  devices, actions and what you looked at last. Paste an asset tag, a serial, an
  OSIS or a ticket number and it goes there.
- **The phone as a scanner.** Pair from a QR code and send scanned serials and
  asset tags straight into the open form, or straight to the machine they name.
- **Attachments, notifications and an audit log**, plus CSV backups of the
  district's tables under Administration.
- **The assistant.** `Ctrl/Cmd+J`, on the person's own ChatGPT account, with
  the tools their roles allow. Every change it makes is recorded as that
  person's AI.
- **Dark by default**, with light and system in Settings. Monochrome, Geist,
  Tailwind v4 and shadcn/ui primitives themed from this project's own tokens.

## Checks

```bash
npm run check       # typecheck, lint, unit tests, production build
npm run test:local  # sequential reset + DB tests, reset + auth tests
```

Both service-dependent suites reset the local synthetic database. Do not run
them concurrently or during browser checks. They fail when the stack is missing.
The resets remove manually created local accounts; re-bootstrap afterward if
needed. No test command should target a hosted project.

Optional repeatable browser verification:

```bash
PLAYWRIGHT_MODULE=/absolute/path/to/playwright CHROME_PATH=/absolute/path/to/chrome node scripts/review-overhaul.cjs
```

With Playwright and its Chromium already resolvable by Node, omit those
variables. Override `REVIEW_BASE_URL` for a different loopback origin, and
`REVIEW_OUTPUT_DIR` for a different PNG folder. Start the dev server first. The
runner creates one synthetic account of each role through the local admin API,
seeds directory records, machines and tickets through the owner's own RPCs,
signs in with the password form, and walks Today, the queue, a ticket, intake,
My tickets, People, a person, Devices, a device, Administration, Settings,
notifications, the palette and the assistant panel, plus the signed-out sign-in
page, at 1440×900, 1024×768 and 390×844 on both themes — asserting that no page
scrolls sideways, that no page logs a browser error, and that never more than
one element wears the lamp. Screenshots land in
`/tmp/edison-overhaul-review/final`. It leaves its synthetic fixtures behind.

`review-m3.cjs` is the older M3 runner and `review-m1.cjs` is historical
demo-only material. `review-intake.cjs` and `review-inventory-management.cjs`
are retired: they drove screens this branch replaced, and each says so and
refuses to run.

Other commands: `npm run build`, `npm start`, `npm run typecheck`,
`npm run lint`, `npm test`, `npm run db:stop`,
`npm run db:reset:local`, `npm run test:db`, `npm run test:auth`, and
`npm run test:deploy:local`.

## Remaining work

M5 and Phase 2 are built and reviewed locally on the branch
`platform-overhaul`, which is not pushed. What is left is operational: release
the branch as [Deploy this branch](docs/M5-PLATFORM-OVERHAUL.md#deploy-this-branch)
describes, work through the
[owner runbook](docs/M5-PLATFORM-OVERHAUL.md#owner-runbook-for-the-hosted-project)
in order, and demonstrate backup and restoration before the system carries a
day's real tickets. The directory and the inventory are already live; do not
repeat the imports. Public intake remains deferred. Review the documented provider/session
schema and credential-fingerprint dependencies before any Auth upgrade.
