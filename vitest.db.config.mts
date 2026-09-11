import { defineConfig } from 'vitest/config';

/**
 * Database integration suite. Separate from the fast unit config on purpose:
 * these tests need the local Supabase stack running and are excluded from
 * `npm test` / `npm run check`.
 */
export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/db/**/*.test.ts'],
    globalSetup: ['tests/db/globalSetup.ts'],
    // Files share synthetic accounts and some tests deactivate them, so they run
    // one at a time. Concurrency inside a test is created explicitly with
    // separate authenticated clients.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
