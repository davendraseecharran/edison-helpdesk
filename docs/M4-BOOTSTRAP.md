# First hosted administrator

The operator CLI creates an Auth identity without supplying a password, then reserves a setup-pending administrator through service-role-only `app_trusted_bootstrap_admin`. It binds a generated setup token to the exact grant. The user chooses their own password through the existing web flow. No public bootstrap route exists.

## Guards and recovery

The CLI requires an explicit project reference and an exactly matching HTTPS Supabase URL, a server-only service key, and an exact stable HTTPS application origin. It refuses to adopt an existing Auth identity unless it has the trusted first-admin app-metadata marker. The database serializes bootstrap with other account changes, refuses another administrator, never promotes technicians, and resumes only the exact matching setup-pending administrator.

The provider can populate an opaque password hash even when createUser receives no password. An empty encrypted_password check is therefore not valid evidence of this provisioning flow. The service-written marker and existing-account constraints identify the eligible identity instead.

An interrupted setup may be retried while the exact account remains setup pending, including when the password update succeeded but trusted completion failed. Reissuing supersedes the earlier app grant. After successful activation, bootstrap refuses to run again; use normal recovery. No account or history is automatically deleted on failure.

## Private operator invocation

Apply the reviewed migrations first. Supply the HOSTED values of NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_APP_ORIGIN and SUPABASE_SERVICE_ROLE_KEY in a private environment file outside the source repository. Do not reuse local `.env.local` values or put credentials in command arguments.

```bash
node --env-file=/absolute/private/operator.env scripts/bootstrap-hosted-admin.mjs PROJECT_REF ADMIN_EMAIL "ADMIN_NAME"
```

The setup link is written to a new mode0600 file in `~/.edison-private`, never printed. Open that file locally for private delivery. Directory creation uses mode0700. The terminal prints only the output path. Remove the private link file after use. Setup expires in one hour.

## Local verification

`npm run test:deploy:local` resets only an unlinked local Supabase stack and verifies project/config guards, rejection of unrelated existing identities, pending-only resumption, supersession, interrupted-password-update repair, setup completion, login, authenticated/anonymous RPC denial, and refusal after activation. Run separately from the other reset-based suites. It never targets the hosted project.
