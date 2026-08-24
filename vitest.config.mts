import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'node:path';

export default defineConfig({
  plugins: [react()],
  resolve: { alias: { '@': path.resolve(__dirname) } },
  test: {
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    // Node for the server/engine/parity suites; jsdom only where components render.
    environmentMatchGlobs: [['tests/**/*.test.tsx', 'happy-dom']],
    environment: 'node',
    setupFiles: ['tests/setup.ts'],
    testTimeout: 30_000,
  },
});
