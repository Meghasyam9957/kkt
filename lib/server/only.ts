/**
 * Server-only marker. Any module that can reach a credential, the Sheets API or the
 * OpenAI key imports this.
 *
 * The check is "am I in a browser?", not merely "does `window` exist?". A DOM test
 * environment (happy-dom, jsdom) defines `window` while still running inside Node, and a
 * test that verifies rendered figures against the KPI engine is a legitimate importer.
 * A real browser bundle has no `process.versions.node`, so it still trips.
 *
 * This is a runtime backstop. The primary control is the `server-only` package, which
 * turns the same mistake into a BUILD error; it is wired in as soon as a client bundle
 * can reach this graph. The import site stays identical either way.
 */
const g = globalThis as { window?: unknown; process?: { versions?: { node?: string } } };
const inBrowser = typeof g.window !== 'undefined' && !g.process?.versions?.node;

if (inBrowser) {
  throw new Error('A server-only module was imported into client code. Check your imports.');
}

export {};
