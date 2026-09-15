/**
 * THE STAGING SUITE'S RUNTIME AND SCHEMA ARE PART OF WHAT IT CAN VERIFY.
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
 * The next run reached Supabase and stopped at the first table write:
 *
 *   Could not create staging tenant: Could not find the table 'public.tenants' in the
 *   schema cache
 *
 * Nothing had applied the migrations to the new project — the workflow had no step that
 * could — and each world had already created a GoTrue user before it failed, so every failure
 * left one behind. Again not a verdict on auth or RLS: no assertion ran.
 *
 * These tests are offline, need no secret, and run in ordinary `npm test`. They hold the
 * staging pin to the floor the LOCKED Supabase packages declare, hold the workflow to applying
 * the schema before the suite, and hold the harness to checking for that schema before it
 * creates anything — so each of those regressions fails here, in CI, instead of on the next
 * approved staging run.
 *
 * The workflow is read as text rather than parsed: no YAML library is a direct dependency, and
 * importing a transitive one would tie this test to something package.json does not promise.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireStagingSchema } from './staging/harness';

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

describe('staging workflow · the schema is applied before the suite runs', () => {
  const workflow = read('.github/workflows/staging.yml');
  // The comments name the flags this step must never pass; only lines that execute are held.
  const code = workflow.split(/\r?\n/).filter((line) => !line.trim().startsWith('#'));
  const lineOf = (pattern: RegExp) => code.findIndex((line) => pattern.test(line));

  it('migrates the confirmed staging project before it runs the suite', () => {
    const migrate = lineOf(/^\s*npm run db:migrate -- --staging\s*$/);
    const suite = lineOf(/^\s*run:\s*npm run test:staging\s*$/);
    expect(migrate, 'a `npm run db:migrate -- --staging` line').toBeGreaterThan(-1);
    expect(suite, 'the staging suite step').toBeGreaterThan(-1);
    expect(migrate, 'the schema is applied first').toBeLessThan(suite);
  });

  it('runs every database command in --staging mode, never with an override or the seed', () => {
    const commands = code.filter((line) => /npm run db:(migrate|status)\b/.test(line));
    expect(commands.length, 'the workflow runs the migration commands').toBeGreaterThan(0);
    for (const line of commands) expect(line.trim()).toMatch(/ -- --staging$/);
    expect(code.join('\n')).not.toMatch(/--confirm-production|--include-seed/);
  });

  it('takes the connection string from STAGING_DATABASE_URL and nowhere else', () => {
    const urls = code.filter((line) => /^\s*DATABASE_URL:/.test(line));
    expect(urls).toHaveLength(1);
    expect(urls[0]).toMatch(/^\s*DATABASE_URL:\s*\$\{\{\s*secrets\.STAGING_DATABASE_URL\s*\}\}\s*$/);
  });
});

describe('staging harness · a missing schema fails first, and creates nothing', () => {
  type Probe = { error: { code?: string; message: string } | null };

  /** A service-role client that answers the schema probe from a script, and records it. */
  function scripted(answers: readonly Probe[]) {
    const asked: string[] = [];
    const client = {
      from: (table: string) => ({
        select: () => ({
          limit: async () => {
            asked.push(table);
            return answers[Math.min(asked.length, answers.length) - 1]!;
          },
        }),
      }),
    };
    return { client: client as unknown as Pick<SupabaseClient, 'from'>, asked };
  }

  const notInCache: Probe = {
    error: {
      code: 'PGRST205',
      message: "Could not find the table 'public.tenants' in the schema cache",
    },
  };

  it('passes as soon as PostgREST can see the tenants table', async () => {
    const { client, asked } = scripted([{ error: null }]);
    await expect(requireStagingSchema(client)).resolves.toBeUndefined();
    expect(asked).toEqual(['tenants']);
  });

  it('waits out a schema cache that has not reloaded yet', async () => {
    const { client, asked } = scripted([notInCache, notInCache, { error: null }]);
    await requireStagingSchema(client, { waitMs: 5_000, pollMs: 1 });
    expect(asked).toHaveLength(3);
  });

  it('names a schema that never appears as missing, and says nothing was created', async () => {
    const { client } = scripted([notInCache]);
    await expect(requireStagingSchema(client, { waitMs: 20, pollMs: 1 }))
      .rejects.toThrow(/staging schema is missing[\s\S]*Nothing was created/);
  });

  it('does not wait on any other failure, or call it a missing schema', async () => {
    const { client, asked } = scripted([
      { error: { code: '401', message: 'Invalid API key' } }, { error: null },
    ]);
    await expect(requireStagingSchema(client, { waitMs: 60_000, pollMs: 1 }))
      .rejects.toThrow(/Could not check the staging schema/);
    expect(asked).toHaveLength(1);
  });

  it('is checked before the harness creates its first user', () => {
    const harness = read('tests/staging/harness.ts');
    const check = harness.indexOf('await requireStagingSchema(admin)');
    const firstWrite = harness.indexOf('admin.auth.admin.createUser(');
    expect(check, 'the harness checks the schema').toBeGreaterThan(-1);
    expect(firstWrite, 'the harness creates users').toBeGreaterThan(-1);
    expect(check, 'before it creates anything').toBeLessThan(firstWrite);
  });
});
