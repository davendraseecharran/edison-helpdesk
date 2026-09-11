import { defineConfig } from 'vitest/config';

/**
 * Authentication and account-lifecycle suite.
 *
 * Needs the local Supabase stack. Resets the database in global setup, so it
 * must not run alongside the database suite — both own the same fixtures.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/auth/**/*.test.ts'],
    globalSetup: ['tests/auth/globalSetup.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 600_000,
  },
});
