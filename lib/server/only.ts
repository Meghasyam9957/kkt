/**
 * Server-only marker. Any module that can reach a credential, the Sheets API or the
 * OpenAI key imports this.
 *
 * The check is "am I in a browser?", not merely "does `window` exist?". A DOM test
 * environment (happy-dom, jsdom) defines `window` while still running inside Node, and a
 * test that verifies rendered figures against the KPI engine is a legitimate importer.
 * A real browser bundle has no `process.versions.node`, so it still trips.
 *
 * TWO CONTROLS, and they fail at different moments:
 *
 *   `server-only` (below)  turns the mistake into a BUILD error. Next.js resolves it to a
 *                          throwing module under the client condition and to an empty one
 *                          under `react-server`, so importing this file from a Client
 *                          Component fails `next build` — before anything ships. This is
 *                          the primary control, and it is a real dependency as of
 *                          M-STAGING-1 rather than a promise in a comment.
 *
 *   the check below        a runtime backstop for the paths a bundler never sees.
 *
 * Vitest is neither a client nor a server build, so it resolves `server-only` to the
 * package's OWN `empty.js` — the same file a React Server Component build gets — via an
 * alias in vitest.config.mts. Tests therefore exercise the real module graph without the
 * guard firing on a Node process that was never a browser.
 */
import 'server-only';

const g = globalThis as { window?: unknown; process?: { versions?: { node?: string } } };
const inBrowser = typeof g.window !== 'undefined' && !g.process?.versions?.node;

if (inBrowser) {
  throw new Error('A server-only module was imported into client code. Check your imports.');
}

export {};
