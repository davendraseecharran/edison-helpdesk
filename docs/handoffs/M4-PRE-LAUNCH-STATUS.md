# Edison Helpdesk — resume here

Updated September11,2026 at19:40 EDT. **M3 complete. M4 hosted deployment in progress. Read latest hosted checkpoint below.** This short file supersedes the chronological archive in docs/handoffs/PRE-M4-STATUS.md.

## Authorized deployment

User authorized private GitHub repository creation, Vercel/Supabase configuration, app deployment, and first-admin setup. No ticket/directory/inventory imports in this scope.

- Supabase project: `lfqlkngxgefoaijuuvvx` (user created; no CLI access yet).
- GitHub: https://github.com/davendraseecharran/edison-helpdesk — private, created, initial source pushed on `main` commit03863b4. Later bootstrap preparation is being committed in this handoff.
- Vercel: `thomas-edison-cte-high-school/edison-helpdesk`; project `prj_9NEP7fDNQMsXUpI9VQ4KSfKE7BwL`, team `team_OhQP0pKULim8YlcnUg27qSdX`. Created and linked in ignored `.vercel/project.json`. Framework Next.js; Node24.x; npm ci; npm run build. **No deployment yet.**
- First app admin: **Jessie Kalloo**, **jkalloo@schools.nyc.gov**. **Not created yet.** User chooses password through private setup link.

GitHub CLI authenticated as davendraseecharran; Vercel CLI59.16.0 authenticated as daseecharran-7648. Vercel Git connection failed because the user must add GitHub under Vercel Login Connections. Direct CLI deployment is available and does not depend on this.

## Current blocker and exact next steps

Supabase projects list still reports LegacyPlatformAuthRequiredError. Ask user to complete in their own Terminal:

```bash
cd ~/edison-ticketing
npx --no-install supabase login --agent no --output-format text
```

Browser login returns a verification code: enter it in that terminal, never in chat. Old agent login session22664 may be expired; do not rely on it. Dashboard login alone does not authenticate the CLI. No secrets requested or recorded.

After sign-in:

1. Re-read live usage and verify access to the exact Supabase project. Inspect empty hosted DB, PostgreSQL/provider schemas and pgcrypto compatibility before applying migrations.
2. Apply all15 reviewed migrations, with no fixtures/seeds. Keep deployment linking separate from local workspace so guarded reset tests remain unlinked. Never reset hosted data. Migration102 is a historical no-op; auth test SQL lives in tests/auth/support.
3. Configure hosted Auth (signup disabled, tested password/recovery settings), stable HTTPS origin/callback, and four production-only Vercel variables. `.env.local` contains LOCAL values and a Vercel OIDC token; never use it for production.
4. Deploy the approved revision via CLI, verify the stable alias, then use guarded hosted bootstrap for Jessie. Private setup link is written mode0600 under ~/.edison-private; it is never printed.
5. Verify hosted setup/recovery, session revocation and ticket permissions using synthetic accounts. Demonstrate backup/restore before live ticket entry. Do not claim pilot readiness without those checks.

Runbook: docs/M4-DEPLOYMENT.md. Bootstrap invocation/security: docs/M4-BOOTSTRAP.md. Detailed M3 behavior: docs/M3-AUTH-AND-INTEGRATION.md.

## Completed and verified

M3:81 unit tests,122 DB tests,31 auth tests; real-browser setup/recovery, return/reclaim/persistence/mobile checks passed. Existing auth uses exact token/grant/session binding and approved provider credential fingerprints. Cancelled provider tokens cannot access helpdesk data but may cause temporary password disruption, repairable by admin recovery. Hosted bcrypt/session/AMR compatibility remains to verify.

M4:

- Git history and private repository established; source/secret scan found no current service-key or OIDC-token matches. `.env*`, .vercel and private outputs excluded; safe .env.example tracked.
- Runtime pinned24.x. `npm run check` passed under Node24.21.0 earlier in M4. Latest check after bootstrap changes passed under installed Node25.3.0:81 tests/8files, clean lint/typecheck,14route build. No system Node changed.
- Test-only SQL removed from deploy migrations; installed after guarded local reset using fixed local Docker container psql stdin. Final `npm run test:auth`:31passed/4files.
- `scripts/bootstrap-hosted-admin.mjs` and migration20260911200000 implement first-admin setup. Trusted app-metadata marker, pending-only matching identity, service-only RPC, exclusive account lock, no technician promotion, no new admin after existing admin, exact grant/token binding. Interrupted password mutation can be repaired while setup pending. Provider fills opaque password hashes even without a supplied password, so empty encrypted_password is NOT a valid eligibility test.
- `npm run test:deploy:local`:2passed covering config guards, unrelated-identity refusal, pending retry/supersession, interrupted setup repair, activation/login, anonymous/authenticated RPC denial and rerun refusal. This resets synthetic local DB; never run with another reset suite/browser test.

Supabase local stack was running for final tests; its DB now holds synthetic deployment-test accounts. Preview server was left running earlier; verify process state before relying on it. No hosted migrations, hosted accounts or deployment have occurred.

## Ownership and usage

No active editor; root releases ownership at handoff. Luna helpers stopped/completed. User preference: bounded Luna at max with short fresh context. One helper's earlier broad bootstrap task produced no code; the later bounded SQL task completed. Do not infer completion from delegation.

Latest account-wide usage: Plus, five-hour33%, weekly52%, no reported limit. Five-hour resets 2026-09-12T00:32:05-04:00; weekly September17,20:22:05 EDT. One reset credit remains; no reset was redeemed by these tools. Other threads can change usage. No automatic wakeup configured.

Claude continuation: Read AGENTS.md, this file, docs/M4-DEPLOYMENT.md and docs/M4-BOOTSTRAP.md. Continue authorized M4 after Supabase CLI sign-in. Existing GitHub/Vercel resources must not be recreated. Preserve M3 auth and local-only reset guards. Verify current commit and hosted state before writing. Keep secrets private and record actual deployment/check results.

## Hosted deployment checkpoint — September11 evening

Supabase authenticated. Exact project verified empty/healthy PostgreSQL17, required Auth schemas and pgcrypto in extensions. All15 migrations applied with official db push --linked --project-ref; no seeds; local workspace remains unlinked. Verification:15 history rows,0 public tables without RLS, no test helper, anon/auth cannot bootstrap. Hosted signup disabled, minpassword12, Site URL https://edison-helpdesk.vercel.app and exact callback configured.

All4 production-only Vercel env vars configured via private stdin; service key stored Secret. Private operator env at /tmp/edison-deploy/production.env mode0600 (do not display). Vercel domain verified edison-helpdesk.vercel.app. First build failed because unanchored .vercelignore `supabase` excluded src/lib/supabase. Root anchored all upload exclusions; corrected build is running session15433, deployment edison-helpdesk-in1d44vpi-thomas-edison-cte-high-school.vercel.app. Check before claiming deployed.

Jessie bootstrap completed: setup-pending administrator created; private setup link /Users/davendraseecharran/.edison-private/admin-setup-1789170885470.txt, expiry1hour. Do not open callback automatically (would consume token). User must set password. No real tickets imported.

Temporary hosted smoke runner /tmp/edison-deploy/smoke.cjs creates/deletes exact synthetic identity, checks signup denial/login/session/techadmin denial/intake/logout. Run after build via node --env-file=/tmp/edison-deploy/production.env /tmp/edison-deploy/smoke.cjs with browser/network permission. Does not create tickets. Full hosted recovery/backup restore still not verified.

Last usage81%fivehour60%weekly; no reset credit used. Finish deploy + smoke, record results, commit/push .vercelignore/checkpoint. Avoid starting more large tasks.
