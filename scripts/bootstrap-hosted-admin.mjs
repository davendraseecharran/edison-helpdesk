/** Operator-only first-admin setup. Never runs from a public app route. */
import { createClient } from '@supabase/supabase-js';
import { createHash } from 'node:crypto';
import { mkdir, open, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function validateConfig(env, args) {
  const [project, emailInput, nameInput] = args;
  if (!/^[a-z]{20}$/.test(project ?? '')) throw Error('Supply the exact hosted project reference.');
  const email = emailInput?.trim().toLowerCase();
  const name = nameInput?.trim();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !name) {
    throw Error('Supply administrator email and display name.');
  }
  const url = `https://${project}.supabase.co`;
  if (env.NEXT_PUBLIC_SUPABASE_URL !== url) throw Error('Hosted URL must exactly match the supplied project.');
  if (!env.SUPABASE_SERVICE_ROLE_KEY) throw Error('Private service-role configuration is missing.');
  const origin = new URL(env.NEXT_PUBLIC_APP_ORIGIN ?? '');
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.origin !== env.NEXT_PUBLIC_APP_ORIGIN) {
    throw Error('Supply the exact stable HTTPS app origin without a trailing slash.');
  }
  return { project, email, name, url, origin: origin.origin, key: env.SUPABASE_SERVICE_ROLE_KEY };
}

function checked(result, step) {
  if (result.error) throw Error(`${step} failed. No credentials were printed; inspect the private operator configuration and account state.`);
  return result.data;
}

export async function bootstrap(config, service) {
  const existing = checked(await service.from('app_accounts').select('id,email,status').eq('role', 'admin'), 'Admin preflight');
  if (existing.some((a) => a.email !== config.email || a.status !== 'setup_pending')) {
    throw Error('An administrator already exists. Use the normal account recovery flow.');
  }

  // Resume only an identity explicitly created by this trusted operator tool.
  // Never adopt or elevate an unrelated pre-existing Auth identity.
  let user;
  for (let page = 1; ; page++) {
    const data = checked(await service.auth.admin.listUsers({ page, perPage: 200 }), 'Auth preflight');
    user = data.users.find((u) => u.email?.toLowerCase() === config.email);
    if (user || data.users.length < 200) break;
  }
  if (user && user.app_metadata?.edison_bootstrap !== 'first-admin-v1') {
    throw Error('This Auth identity was not created by the first-admin bootstrap; refusing to adopt it.');
  }
  if (!user) {
    user = checked(await service.auth.admin.createUser({
      email: config.email, email_confirm: true,
      app_metadata: { edison_bootstrap: 'first-admin-v1' },
    }), 'Auth identity creation').user;
  }
  if (!user) throw Error('Auth identity was not returned.');
  const grant = checked(await service.rpc('app_trusted_bootstrap_admin', {
    p_user: user.id, p_email: config.email, p_display_name: config.name,
  }), 'First-admin reservation');
  const generated = checked(await service.auth.admin.generateLink({ type: 'recovery', email: config.email }), 'Setup link generation');
  const token = generated.properties?.hashed_token;
  if (!token || generated.user?.id !== user.id) throw Error('Unexpected setup-link identity.');
  checked(await service.rpc('app_trusted_bind_credential_link', {
    p_grant: grant, p_digest: createHash('sha256').update(token).digest('hex'),
  }), 'Setup link binding');
  const link = new URL('/auth/confirm', config.origin);
  link.searchParams.set('token_hash', token);
  return link.href;
}

async function main() {
  const config = validateConfig(process.env, process.argv.slice(2));
  // Fixed private directory outside the repository; links must never be staged.
  const directory = path.join(os.homedir(), '.edison-private');
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const resolved = await realpath(directory);
  if (resolved === root || resolved.startsWith(root + path.sep)) throw Error('Private output cannot be inside the source repository.');
  const output = path.join(resolved, `admin-setup-${Date.now()}.txt`);
  // Exclusive creation also tests private delivery before changing remote state.
  const file = await open(output, 'wx', 0o600);
  try {
    const service = createClient(config.url, config.key, { auth: { persistSession: false, autoRefreshToken: false } });
    const link = await bootstrap(config, service);
    await file.writeFile(`Private first-admin setup link (expires in one hour):\n${link}\n`);
    console.log(`Setup link saved privately to ${output}. Open locally; do not paste into chat or tickets.`);
  } finally {
    await file.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
