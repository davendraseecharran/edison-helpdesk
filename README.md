# Edison Helpdesk

A local Next.js helpdesk with Supabase authentication and persisted ticketing.
M1 established the interface, M2 added database permissions and transactions,
and M3 connected real accounts and ticket workflows. Hosting, real school data,
imports, backups, and pilot rollout remain M4 work.

Current state and review results: [PROJECT_STATUS.md](PROJECT_STATUS.md).
Requirements: [TICKETING-PLAN.md](TICKETING-PLAN.md).
Implementation handoff: [CLAUDE-HANDOFF.md](CLAUDE-HANDOFF.md).

## Local setup

Use a supported Node LTS compatible with the dependencies, npm, and Docker.
The reviewed machine runs Node25.3.0; no system runtime was changed.

```bash
npm install
npm run db:start
cp .env.example .env.local
```

Fill the ignored `.env.local` from the local Supabase configuration. The public
URL/anon key and app origin are distinct from the server-only service-role key.
Never publish the latter. `npm run db:status` displays local keys, so avoid sharing
its output. See [database setup](docs/M2-DATABASE.md) for the Docker helper PATH
workaround on this machine.

Create the first synthetic administrator only on an empty local setup:

```bash
npm run bootstrap:admin -- --email you@edison.example --name "Your Name"
npm run dev
```

Open the configured app origin (normally `http://127.0.0.1:3000`). Bootstrap
refuses nonlocal/linked projects and an existing administrator. It displays a
newly generated local password once, or accepts private stdin input with
`--stdin-password`. No password belongs in command arguments, source, or tickets.
There is no public signup or demo identity switcher in the authenticated app.

The administrator creates technicians and generates setup/recovery links for
private delivery. Users sign in with their authorized email and separate app
password. Links are credentials: copy privately, never paste into ticket notes.
Detailed contracts and limitations: [auth and integration](docs/M3-AUTH-AND-INTEGRATION.md).

## Ticket workflows

Admins create any approved channel, optionally assign an owner, and can backdate
the submission date. Technician walk-ins are self-owned and dated today.
Technicians see open claimable work and owned/collaborating tickets. Owners and
collaborators can resolve with a solution; time recording is optional.

Primary owners can return unfinished tickets to Open Queue. Notes, devices,
time entries, collaborators and history remain. Another technician can claim
it; the former owner then follows normal visibility rules. Admins also reassign,
reopen and cancel. School dates use America/New_York.

## Checks

```bash
npm run check       # typecheck, lint, 81 offline tests, production build
npm run test:local  # sequential reset + 122 DB tests, reset + 31 auth tests
```

Both service-dependent suites reset the local synthetic database. Do not run
them concurrently or during browser checks. They fail when the stack is missing.
The resets remove manually created local accounts; re-bootstrap afterward if
needed. No test command should target a hosted project.

Optional repeatable browser verification:

```bash
PLAYWRIGHT_MODULE=/absolute/path/to/playwright CHROME_PATH=/absolute/path/to/chrome node scripts/review-m3.cjs
```

With Playwright and its Chromium already resolvable by Node, omit those variables.
Override `REVIEW_BASE_URL` for a different loopback origin. Start the dev server
first. This runner creates synthetic accounts with in-memory passwords and checks
real login, ticket persistence/return/reclaim, setup/recovery, logout and phone
layout. It leaves synthetic fixtures behind; screenshots are in
`/tmp/edison-m3-review`. The older review-m1 script is historical demo-only material.

Other commands: `npm run build`, `npm start`, `npm run typecheck`, `npm run lint`,
`npm test`, `npm run db:stop`, `npm run db:reset:local`, and `npm run test:auth`.

## Remaining work

M4 will cover hosted configuration, backup/restore, reviewed imports, volume
checks, operational logging/rate limits, and a small pilot. No deployment or
real-data import has happened. Review the documented provider/session schema
and credential-fingerprint dependencies before hosted rollout or Auth upgrades.
Attachments, notifications, inventory, student/staff migration, and public intake
remain deferred.
