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
import { PROJECT_ROOT } from '../../db/support/local-only';

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

/** Installs the auth helper into the already-reset local database only. */
export function installLocalAuthTestSupport(): void {
  execFileSync(
    'docker',
    ['exec', '-i', 'supabase_db_edison-ticketing', 'psql', '-U', 'postgres', '-d', 'postgres', '-v', 'ON_ERROR_STOP=1'],
    {
      cwd: PROJECT_ROOT,
      env: commandEnv(),
      input: readFileSync(SUPPORT_SQL),
      stdio: ['pipe', 'ignore', 'pipe'],
      timeout: 120_000,
    },
  );
}
