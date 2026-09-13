import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * Fast unit suite: pure domain rules, no services required.
 *
 * Both service-dependent suites are excluded so `npm run check` stays offline:
 *   - tests/db   → `npm run test:db`   (vitest.db.config.mts)
 *   - tests/auth → `npm run test:auth` (vitest.auth.config.mts)
 * Each needs the local Supabase stack and resets the database, so neither may
 * run inside the fast suite or alongside the other.
 */
export default defineConfig({
  // The `@/` alias from tsconfig, so component modules resolve in tests.
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/db/**', 'tests/auth/**', 'tests/deploy/**'],
  },
});
