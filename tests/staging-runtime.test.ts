/**
 * THE STAGING SUITE'S RUNTIME IS PART OF WHAT IT CAN VERIFY.
 *
 * The first real run of `.github/workflows/staging.yml` failed before a single request reached
 * Supabase. Every `createClient()` in `tests/staging/` threw:
 *
 *   Node.js detected but native WebSocket not found.
 *
 * `@supabase/supabase-js` builds its Realtime client inside the constructor, and
 * `@supabase/realtime-js` resolves a NATIVE global `WebSocket` — which Node ships unflagged
 * from 22. The workflow pinned Node 20. The run therefore reported failures that said nothing
 * about authentication, RLS or tenant isolation: the suite never got far enough to ask.
 *
 * This test is offline, needs no secret, and runs in ordinary `npm test`. It holds the staging
 * pin to the floor the LOCKED Supabase packages declare, so an upgrade that raises that floor
 * fails here, in CI, instead of on the next approved staging run.
 *
 * The workflow is read as text rather than parsed: no YAML library is a direct dependency, and
 * importing a transitive one would tie this test to something package.json does not promise.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** The first Node major whose global `WebSocket` is available without a flag. */
const NATIVE_WEBSOCKET_MAJOR = 22;

/** The client packages that construct the WebSocket, and so set the floor. */
const SUPABASE_CLIENT_PACKAGES = ['@supabase/supabase-js', '@supabase/realtime-js'] as const;

/**
 * Every `node-version` given to an `actions/setup-node` step, in file order.
 *
 * A step's keys sit at the column of its `uses:` key; the step ends at the first line indented
 * LESS than that, which is the next list item's dash. `node-version-file` does not match.
 */
function setupNodeVersions(workflow: string): string[] {
  const lines = workflow.split(/\r?\n/);
  const versions: string[] = [];
  lines.forEach((line, i) => {
    if (!/^\s*(?:-\s+)?uses:\s*actions\/setup-node@/.test(line)) return;
    const keyColumn = line.indexOf('uses:');
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j]!;
      const trimmed = next.trim();
      if (trimmed === '' || trimmed.startsWith('#')) continue;
      if (next.search(/\S/) < keyColumn) break;
      const pinned = next.match(/^\s*node-version:\s*['"]?([^'"\s#]+)/);
      if (pinned) {
        versions.push(pinned[1]!);
        break;
      }
    }
  });
  return versions;
}

/** The major a `node-version` input pins — or null when it floats (`lts/*`, `latest`, `node`). */
function pinnedMajor(spec: string): number | null {
  const match = spec.match(/^v?(\d+)(?:\.(?:\d+|x))*$/);
  return match ? Number(match[1]) : null;
}

/** The minimum Node major a locked package declares, e.g. `>=22.0.0` → 22. */
function lockedEngineFloor(pkg: string): number | null {
  const lock = JSON.parse(read('package-lock.json')) as {
    packages: Record<string, { engines?: { node?: string } }>;
  };
  const spec = lock.packages[`node_modules/${pkg}`]?.engines?.node;
  const match = spec?.match(/>=\s*v?(\d+)/);
  return match ? Number(match[1]) : null;
}

describe('staging workflow · the runtime the real Supabase suite needs', () => {
  const workflow = read('.github/workflows/staging.yml');
  // Counted with the same line-anchored pattern the parser uses, so a commented-out step is
  // neither counted nor read.
  const steps = workflow.split(/\r?\n/)
    .filter((line) => /^\s*(?:-\s+)?uses:\s*actions\/setup-node@/.test(line));
  const versions = setupNodeVersions(workflow);

  it('is the workflow that runs the staging suite', () => {
    // If the suite moves to another workflow, this guard has to move with it.
    expect(workflow).toMatch(/^\s*run:\s*npm run test:staging\s*$/m);
    expect(steps.length, 'Node is installed through actions/setup-node').toBeGreaterThan(0);
  });

  it('pins every setup-node step to an explicit major, never a floating alias', () => {
    expect(versions, 'every setup-node step states a node-version').toHaveLength(steps.length);
    for (const version of versions) {
      expect(pinnedMajor(version), `"${version}" must name a major version`).not.toBeNull();
    }
  });

  it('runs on a Node with a native global WebSocket', () => {
    // Stands alone: an empty list must fail here, not pass the loop below vacuously.
    expect(versions.length, 'a staging node-version was found').toBeGreaterThan(0);
    for (const version of versions) {
      expect(pinnedMajor(version)!, `staging node-version ${version}`)
        .toBeGreaterThanOrEqual(NATIVE_WEBSOCKET_MAJOR);
    }
  });

  it('meets the Node floor the locked Supabase client packages declare', () => {
    const floors = SUPABASE_CLIENT_PACKAGES
      .map((pkg) => ({ pkg, floor: lockedEngineFloor(pkg) }))
      .filter((entry): entry is { pkg: typeof entry.pkg; floor: number } => entry.floor !== null);
    // Not vacuous: at least one client package must actually state its floor, and there must
    // be a pinned version to hold against it.
    expect(floors.length, 'a Supabase client package declares engines.node').toBeGreaterThan(0);
    expect(versions.length, 'a staging node-version was found').toBeGreaterThan(0);

    for (const { pkg, floor } of floors) {
      for (const version of versions) {
        expect(pinnedMajor(version)!, `staging node-version ${version} against ${pkg} >=${floor}`)
          .toBeGreaterThanOrEqual(floor);
      }
    }
  });
});
