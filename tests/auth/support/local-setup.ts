/**
 * Installs SQL that belongs only to the local authentication test suite.
 *
 * The caller must resolve and validate the local stack, then reset it, before
 * invoking this function. Keeping this SQL outside supabase/migrations prevents
 * test helpers from being deployed to a hosted project.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROJECT_ROOT, localDatabaseContainer, type LocalStack } from '../../db/support/local-only';

const EXTRA_PATHS = [
  '/Applications/Docker.app/Contents/Resources/bin',
  '/usr/local/bin',
  '/opt/homebrew/bin',
];

const SUPPORT_SQL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test-support.sql');

function commandEnv(): NodeJS.ProcessEnv {
  const extras = EXTRA_PATHS.filter((entry) => existsSync(entry));
  return { ...process.env, PATH: [...extras, process.env.PATH ?? ''].join(path.delimiter) };
}

/**
 * Waits until PostgREST can answer the readiness marker defined last in the
 * support SQL.
 *
 * The helpers are created after PostgREST has already started and built its
 * schema cache, and the reload the support SQL asks for is asynchronous. Without
 * this wait, whichever test file vitest schedules first can call a helper that
 * the API does not know about yet — an intermittent failure that depends only on
 * scheduling. PGRST202 is the schema-cache miss; anything else means the
 * function was reached.
 */
async function waitForSchemaCache(stack: LocalStack): Promise<void> {
  const deadline = Date.now() + 30_000;
  let lastMessage = 'no response';

  while (Date.now() < deadline) {
    const response = await fetch(`${stack.apiUrl}/rest/v1/rpc/app_test_support_ready`, {
      method: 'POST',
      headers: {
        apikey: stack.serviceRoleKey,
        Authorization: `Bearer ${stack.serviceRoleKey}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    }).catch(() => null);

    if (response?.ok) return;
    lastMessage = response ? `HTTP ${response.status}` : 'unreachable';
    await new Promise((resolve) => setTimeout(resolve, 200));
  }

  throw new Error(
    `The auth test helpers never became visible to the API (${lastMessage}). ` +
      'PostgREST did not reload its schema cache after tests/auth/support/test-support.sql.',
  );
}

/** Installs the auth helpers into the already-reset local database only. */
export async function installLocalAuthTestSupport(stack: LocalStack): Promise<void> {
  execFileSync(
    'docker',
    ['exec', '-i', localDatabaseContainer(), 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
    {
      cwd: PROJECT_ROOT,
      env: commandEnv(),
      input: readFileSync(SUPPORT_SQL),
      stdio: ['pipe', 'ignore', 'pipe'],
      timeout: 120_000,
    },
  );

  await waitForSchemaCache(stack);
}
