#!/usr/bin/env node
/**
 * Creates the first administrator account on a LOCAL stack.
 *
 * There is no public bootstrap endpoint and no hardcoded account: the first
 * admin has to be created by someone with operator access to the database, and
 * this script is that path. It refuses to run against anything but a loopback
 * Supabase API, and it refuses to run if an admin already exists.
 *
 * The password is never taken from a command-line argument (those leak into
 * shell history and process listings) and is never printed. Provide it on stdin,
 * or let the script generate one and write it only to your terminal once.
 *
 *   npm run bootstrap:admin -- --email you@edison.example --name "Your Name"
 *   printf '%s' "$PASSWORD" | npm run bootstrap:admin -- --email ... --name ... --stdin-password
 */

import { createClient } from '@supabase/supabase-js';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';

const DOCKER_PATHS = [
  '/Applications/Docker.app/Contents/Resources/bin',
  '/usr/local/bin',
  '/opt/homebrew/bin',
];

function commandEnv() {
  const extras = DOCKER_PATHS.filter((entry) => existsSync(entry));
  return { ...process.env, PATH: [...extras, process.env.PATH ?? ''].join(path.delimiter) };
}

function parseArgs(argv) {
  const args = { stdinPassword: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--email') args.email = argv[++i];
    else if (arg === '--name') args.name = argv[++i];
    else if (arg === '--stdin-password') args.stdinPassword = true;
  }
  return args;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function localStack() {
  const raw = execFileSync('npx', ['--no-install', 'supabase', 'status', '-o', 'json'], {
    encoding: 'utf8',
    env: commandEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 120_000,
  });
  const status = JSON.parse(raw);

  if (status.linked_project) {
    throw new Error('Refusing to run: this workspace is linked to a hosted project.');
  }
  const host = new URL(status.API_URL).hostname;
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    throw new Error(`Refusing to run against non-local host "${host}".`);
  }
  return status;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.email || !args.name) {
    console.error('Usage: npm run bootstrap:admin -- --email <address> --name "<full name>"');
    process.exit(2);
  }

  const status = localStack();
  const admin = createClient(status.API_URL, status.SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: existing, error: existingError } = await admin
    .from('app_accounts')
    .select('id, email')
    .eq('role', 'admin')
    .limit(1);
  if (existingError) throw new Error(`Could not read accounts: ${existingError.message}`);
  if ((existing ?? []).length > 0) {
    console.error(
      'An administrator account already exists. Use the Administration screen to add people,\n' +
        'or reset the local database first with: npm run db:reset:local',
    );
    process.exit(1);
  }

  const email = args.email.trim().toLowerCase();
  // Ephemeral by default; only ever held in memory and shown once below.
  const password = args.stdinPassword ? await readStdin() : `Ed-${randomUUID()}`;
  if (password.length < 12) {
    throw new Error('The password must be at least 12 characters.');
  }

  const { data: created, error: createError } = await admin.auth.admin.createUser({
    email,
    password,
    email_confirm: true,
  });
  if (createError || !created?.user) {
    throw new Error(`Could not create the auth user: ${createError?.message}`);
  }

  // Active immediately: this account sets its own password here, so there is no
  // setup link to complete. Every later account goes through the normal
  // setup_pending flow instead.
  const { error: accountError } = await admin.from('app_accounts').insert({
    id: created.user.id,
    display_name: args.name,
    email,
    role: 'admin',
    status: 'active',
  });
  if (accountError) {
    await admin.auth.admin.deleteUser(created.user.id);
    throw new Error(`Could not create the account row: ${accountError.message}`);
  }

  console.log(`\nAdministrator created for ${email}.`);
  if (args.stdinPassword) {
    console.log('Use the password you supplied on stdin. It was not stored or echoed.');
  } else {
    console.log('\nGenerated password (shown once, not stored anywhere):\n');
    console.log(`    ${password}\n`);
    console.log('Sign in at http://127.0.0.1:3000/login and keep it somewhere safe.');
  }
}

main().catch((error) => {
  console.error(`\n${error.message}\n`);
  process.exit(1);
});
