/**
 * The opt-in staging suite: real Supabase, real GoTrue, real PostgREST, real RLS.
 *
 * Separate from `vitest.config.mts` for the same reason `playwright.visual.config.ts` is
 * separate from the ordinary Playwright config — it reaches something outside this machine,
 * so running it must be a decision rather than a side effect of typing `npm test`.
 *
 * Single-threaded and generously timed on purpose: every assertion is a network round trip
 * to a hosted project, and parallel files would race each other's tenants through one
 * PostgREST instance.
 */
import { defineConfig } from 'vitest/config';
import path from 'node:path';

export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
      'server-only': path.resolve(__dirname, 'node_modules/server-only/empty.js'),
    },
  },
  test: {
    include: ['tests/staging/**/*.staging.test.ts'],
    environment: 'node',
    testTimeout: 120_000,
    hookTimeout: 180_000,
    fileParallelism: false,
  },
});
