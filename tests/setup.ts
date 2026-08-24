/** Vitest setup: DOM matchers, and a stable clock/env for UI tests. */
import '@testing-library/jest-dom/vitest';

process.env.LIVE_DATA_ENABLED = process.env.LIVE_DATA_ENABLED ?? 'false';
