import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname),
      /*
       * `server-only` throws by design when resolved under any condition other than
       * `react-server` — that is what makes it a build error in a client bundle. Vitest is
       * neither build, so it is pointed at the package's own empty module, which is exactly
       * what Next.js resolves it to in a Server Component build. Nothing is stubbed out:
       * this is the package's real file.
       */
      'server-only': path.resolve(__dirname, 'node_modules/server-only/empty.js'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    /*
     * The staging suites talk to a real hosted Supabase project over the network. They are
     * opt-in, gated on credentials that do not exist by default, and they belong to
     * `npm run test:staging` with its own config — never to an ordinary `npm test`, which
     * must stay offline, deterministic and runnable by anyone who has just cloned this.
     */
    exclude: ['node_modules/**', 'tests/staging/**'],
    // Node for the server/engine/parity suites; jsdom only where components render.
    environmentMatchGlobs: [['tests/**/*.test.tsx', 'happy-dom']],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
  },
});
