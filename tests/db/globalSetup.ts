/**
 * Global setup for the database suite.
 *
 * Fails loudly when the local stack is unavailable — the suite must never skip
 * or silently pass when the database it is supposed to prove things about is not
 * running. Seeds synthetic identities with the service role and hands the live
 * connection details to the tests via Vitest's provide/inject.
 */

import type { TestProject } from 'vitest/node';
import { assertDatabaseReachable, resolveLocalStack } from './support/local-only';
import { seedIdentities } from './support/identities';
import type { LocalStack } from './support/local-only';
import type { SeededIdentity } from './support/identities';

declare module 'vitest' {
  export interface ProvidedContext {
    stack: LocalStack;
    identities: SeededIdentity[];
  }
}

export default async function setup(project: TestProject): Promise<void> {
  const stack = resolveLocalStack();
  await assertDatabaseReachable(stack);
  const identities = await seedIdentities(stack);

  project.provide('stack', stack);
  project.provide('identities', identities);
}
