# M4 deployment runbook

## Authorized target

- Private source: https://github.com/davendraseecharran/edison-helpdesk
- Vercel project: thomas-edison-cte-high-school/edison-helpdesk
- Supabase project ref: lfqlkngxgefoaijuuvvx
- First admin identity is recorded in PROJECT_STATUS.md; never store a password or setup link here.

## Prepared release

Node24.x is pinned in package.json and .nvmrc. Vercel uses Next.js, npm ci, npm run build. Local check passed under Node24.21.0. Secrets, .vercel metadata and private operator output are ignored. Test-only recovery-age SQL is installed only by the guarded local auth suite; migration102 remains a historical no-op.

## Hosted steps, in order

1. Authenticate Supabase CLI in an interactive terminal. Never pass a token on the command line or paste it in chat. Verify access to the exact project above.
2. Inspect the empty hosted database before writing: PostgreSQL version; pgcrypto location; auth.users.encrypted_password; auth.sessions and auth.mfa_amr_claims. M3 depends on provider bcrypt and password/otp AMR behavior.
3. Apply the reviewed migrations without seed/test data. Keep a separate deployment workdir or explicit project target so local reset tests remain unlinked. Never run reset against the hosted database. Record migration versions and verify RLS/function grants.
4. Configure hosted Auth: disable public signup, minimum password12, recovery expiry3600 seconds, review secure-password-change setting against the tested setup/recovery flow. Set site URL and allowed callback to the verified stable HTTPS app origin. Local config.toml does not configure the hosted project by itself.
5. Set production-only Vercel variables: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, NEXT_PUBLIC_APP_ORIGIN, SUPABASE_SERVICE_ROLE_KEY. Read keys privately from the exact project; never print/log them. Do not attach production credentials to preview or development deployments.
6. Deploy the approved source revision via authenticated CLI. Verify the stable alias before using it for callback links. Automatic Git deployments additionally require the user to connect GitHub in Vercel login connections.
7. Use guarded operator bootstrap to issue the first admin setup link to a private file; user sets password privately. No public bootstrap route.
8. Verify hosted behavior with synthetic accounts: signup denied, setup/recovery, old-session invalidation, admin/technician restrictions, ticket create/claim/return/collaborate/resolve, reload persistence. Local reset-based suites must never target hosted data.
9. Demonstrate backup/restoration to an isolated target and establish private backup storage before live ticket entry. Include Auth identities and application credential state in a consistent recovery plan; the backup contains sensitive auth material. Review callback logging/redaction and rate limits.

## Launch boundaries

An empty HTTPS deployment is not a completed live pilot. Do not import real ticket, student, staff, or inventory records during deployment setup. Hosted provider compatibility, backup restoration, and smoke tests must be recorded as actual results. Cancelled provider tokens may cause temporary credential disruption but cannot access helpdesk data; fresh admin recovery repairs it.

## Official references

- https://supabase.com/docs/guides/deployment/database-migrations
- https://supabase.com/docs/guides/platform/backups
- https://vercel.com/docs/functions/runtimes/node-js/node-js-versions
