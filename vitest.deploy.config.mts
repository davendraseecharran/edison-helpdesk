import { defineConfig } from 'vitest/config';

// Isolated local reset: first-admin tests require a database without admins.
export default defineConfig({ test: {
  environment: 'node', include: ['tests/deploy/**/*.test.ts'],
  globalSetup: ['tests/auth/globalSetup.ts'], fileParallelism: false,
  testTimeout: 30_000, hookTimeout: 600_000,
} });
