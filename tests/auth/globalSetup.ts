/**
 * Auth suite setup. Fails loudly when the local stack is unavailable, and
 * resets the database so every run starts from the same schema and no data.
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import type { TestProject } from 'vitest/node';
import {
  assertDatabaseReachable,
  resolveLocalStack,
  PROJECT_ROOT,
  type LocalStack,
} from '../db/support/local-only';
import { installLocalAuthTestSupport } from './support/local-setup';

declare module 'vitest' {
  export interface ProvidedContext {
    stack: LocalStack;
  }
}

const EXTRA_PATHS = [
  '/Applications/Docker.app/Contents/Resources/bin',
  '/usr/local/bin',
  '/opt/homebrew/bin',
];

export default async function setup(project: TestProject): Promise<void> {
  // resolveLocalStack refuses anything that is not a loopback, unlinked stack.
  const stack = resolveLocalStack();
  await assertDatabaseReachable(stack);

  const extras = EXTRA_PATHS.filter((entry) => existsSync(entry));
  execFileSync('npx', ['--no-install', 'supabase', 'db', 'reset', '--local'], {
    cwd: PROJECT_ROOT,
    env: { ...process.env, PATH: [...extras, process.env.PATH ?? ''].join(path.delimiter) },
    stdio: 'ignore',
    timeout: 600_000,
  });

  // Test-only SQL is installed after the guarded local reset. It is not part
  // of the migration set and therefore cannot reach a hosted deployment.
  await installLocalAuthTestSupport(stack);

  project.provide('stack', stack);
}
