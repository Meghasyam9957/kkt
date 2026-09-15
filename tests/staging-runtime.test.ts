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
 * These tests are offline, need no secret, and run in ordinary `npm test`. Where behaviour can
 * be run, it is run rather than read: the workflow's migration step executes as written with
 * `npm` stood in for, `scripts/db.ts --staging` runs against a reserved `.invalid` host and must
 * refuse before it connects, and the harness builds and tears down worlds against a client that
 * records every call. Nothing here reaches Supabase or a database.
 *
 * The workflow is read as text rather than parsed: no YAML library is a direct dependency, and
 * importing a transitive one would tie this test to something package.json does not promise.
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { SupabaseClient } from '@supabase/supabase-js';
import { requireStagingSchema, type ConnectSupabase } from './staging/harness';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const WORKFLOW = '.github/workflows/staging.yml';
const MIGRATION_STEP = 'Apply the migrations to the staging project';
const SUITE_STEP = 'Staging suite';

/** RFC 2606 reserves `.invalid`: a connection attempt fails at DNS and can reach nothing. */
const NOWHERE = 'postgresql://postgres@staging-db.makam.invalid:5432/postgres';
const STAGING_URL = 'https://abcdefg.supabase.co';

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

/** One step's lines, from its `- name:` to the next step. Comment lines are kept. */
function stepLines(workflow: string, name: string): string[] {
  const lines = workflow.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  if (start < 0) return [];
  const column = lines[start]!.indexOf('-');
  const body = [lines[start]!];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed !== '' && !trimmed.startsWith('#') && line.search(/\S/) <= column) break;
    body.push(line);
  }
  return body;
}

/** A step's `run: |` script, dedented — the text GitHub hands to bash. */
function stepScript(workflow: string, name: string): string {
  const body = stepLines(workflow, name);
  const at = body.findIndex((line) => /^\s*run:\s*\|\s*$/.test(line));
  if (at < 0) return '';
  const keyColumn = body[at]!.search(/\S/);
  const script: string[] = [];
  for (const line of body.slice(at + 1)) {
    if (line.trim() !== '' && line.search(/\S/) <= keyColumn) break;
    script.push(line);
  }
  const indent = Math.min(...script.filter((l) => l.trim() !== '').map((l) => l.search(/\S/)));
  return script.map((line) => line.slice(indent)).join('\n').trim();
}

/** A step's `env:` block as written: variable → expression. */
function stepEnv(workflow: string, name: string): Record<string, string> {
  const body = stepLines(workflow, name).filter((line) => !line.trim().startsWith('#'));
  const at = body.findIndex((line) => /^\s*env:\s*$/.test(line));
  if (at < 0) return {};
  const column = body[at]!.search(/\S/);
  const env: Record<string, string> = {};
  for (const line of body.slice(at + 1)) {
    if (line.trim() === '') continue;
    if (line.search(/\S/) <= column) break;
    const pair = line.match(/^\s*([A-Z0-9_]+):\s*(.*?)\s*$/);
    if (pair) env[pair[1]!] = pair[2]!;
  }
  return env;
}

/** bash, where there is one. GitHub's runners always have it; so does Git for Windows. */
const BASH = (() => {
  const probe = spawnSync('bash', ['--noprofile', '--norc', '-c', 'echo ready'], { encoding: 'utf8' });
  return probe.status === 0 && probe.stdout.trim() === 'ready' ? 'bash' : null;
})();

type Probe = { error: { code?: string; message: string } | null };

const NOT_IN_CACHE: Probe = {
  error: {
    code: 'PGRST205',
    message: "Could not find the table 'public.tenants' in the schema cache",
  },
};

describe('staging workflow · the runtime the real Supabase suite needs', () => {
  const workflow = read(WORKFLOW);
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
  const workflow = read(WORKFLOW);
  // The comments name the flags this job must never pass; only lines that execute are held.
  const code = workflow.split(/\r?\n/).filter((line) => !line.trim().startsWith('#'));
  const stepAt = (name: string) => code.findIndex((line) => line.trim() === `- name: ${name}`);

  it('migrates before the suite, and the suite cannot run after a failed migration', () => {
    const migrate = stepAt(MIGRATION_STEP);
    const suite = stepAt(SUITE_STEP);
    expect(migrate, 'the migration step').toBeGreaterThan(-1);
    expect(suite, 'the suite step').toBeGreaterThan(-1);
    expect(migrate, 'the schema is applied first').toBeLessThan(suite);
    // GitHub skips every later step once one fails — unless that step declares `if:`.
    const suiteCode = stepLines(workflow, SUITE_STEP).filter((l) => !l.trim().startsWith('#'));
    expect(suiteCode.filter((line) => /^\s*if:/.test(line))).toEqual([]);
  });

  it('hands the guard the staging declaration, the production veto and the staging connection', () => {
    const env = stepEnv(workflow, MIGRATION_STEP);
    const secret = (name: string) => new RegExp(`^\\$\\{\\{\\s*secrets\\.${name}\\s*\\}\\}$`);
    expect(env.STAGING_SUPABASE_URL).toMatch(secret('STAGING_SUPABASE_URL'));
    expect(env.STAGING_CONFIRMED_NOT_PRODUCTION).toMatch(secret('STAGING_CONFIRMED_NOT_PRODUCTION'));
    // Without this the project-ref veto has nothing to compare against.
    expect(env.PRODUCTION_SUPABASE_URL).toMatch(secret('PRODUCTION_SUPABASE_URL'));
    expect(env.DATABASE_URL).toMatch(secret('STAGING_DATABASE_URL'));
  });

  it('takes a database connection in exactly one place', () => {
    expect(code.filter((line) => /^\s*DATABASE_URL:/.test(line))).toHaveLength(1);
  });

  it('never passes the production override or the demo seed', () => {
    expect(code.join('\n')).not.toMatch(/--confirm-production|--include-seed/);
  });
});

describe.skipIf(!BASH)('staging workflow · the migration step, run as written', () => {
  const script = stepScript(read(WORKFLOW), MIGRATION_STEP);

  /**
   * The step's own script under bash, as GitHub runs it (`-eo pipefail`). Its `env:` is given
   * fake, credential-free values, and `npm` is a function that records its arguments and
   * fails where told to — so nothing the step would run is actually run.
   */
  function runStep(
    vars: Readonly<Record<string, string>>, failing: Readonly<Record<string, number>> = {},
  ) {
    const cases = Object.entries(failing)
      .map(([args, code]) => `'${args}') return ${code} ;;`).join(' ');
    const prelude = [
      ...Object.entries(vars).map(([name, value]) => `export ${name}='${value}'`),
      `npm() { echo "npm $*"; case "$*" in ${cases} esac; }`,
    ].join('\n');
    const result = spawnSync(BASH!,
      ['--noprofile', '--norc', '-eo', 'pipefail', '-c', `${prelude}\n${script}`],
      { encoding: 'utf8' });
    return {
      status: result.status,
      output: `${result.stdout}${result.stderr}`,
      npm: result.stdout.split(/\r?\n/).filter((line) => line.startsWith('npm ')),
    };
  }

  const configured = { STAGING_SUPABASE_URL: STAGING_URL, DATABASE_URL: NOWHERE };

  it('is the script this test means to run', () => {
    expect(script).toMatch(/npm run db:migrate -- --staging/);
  });

  it('does nothing at all when no staging project is configured', () => {
    const outcome = runStep({ STAGING_SUPABASE_URL: '', DATABASE_URL: '' });
    expect(outcome.status, outcome.output).toBe(0);
    expect(outcome.npm).toEqual([]);
  });

  it('fails the job, running nothing, when the project is configured but its connection is not', () => {
    const outcome = runStep({ STAGING_SUPABASE_URL: STAGING_URL, DATABASE_URL: '' });
    expect(outcome.status, outcome.output).not.toBe(0);
    expect(outcome.output).toMatch(/CONFIGURATION_REQUIRED/);
    expect(outcome.npm).toEqual([]);
  });

  it('migrates, then reads the ledger back, both in --staging mode', () => {
    const outcome = runStep(configured);
    expect(outcome.status, outcome.output).toBe(0);
    expect(outcome.npm).toEqual(['npm run db:migrate -- --staging', 'npm run db:status -- --staging']);
  });

  it('fails the job when the migration is refused, and goes no further', () => {
    const outcome = runStep(configured, { 'run db:migrate -- --staging': 3 });
    expect(outcome.status, outcome.output).toBe(3);
    expect(outcome.npm).toEqual(['npm run db:migrate -- --staging']);
  });

  it('fails the job when the ledger disagrees with the repository after migrating', () => {
    const outcome = runStep(configured, { 'run db:status -- --staging': 1 });
    expect(outcome.status, outcome.output).toBe(1);
  });
});

describe('scripts/db.ts --staging · refuses before it opens a connection', () => {
  const TSX = path.join(ROOT, 'node_modules', 'tsx', 'dist', 'cli.mjs');

  /** Every variable that could name a target, removed so only what a test gives is seen. */
  const TARGET_VARIABLES = [
    'DATABASE_URL', 'STAGING_SUPABASE_URL', 'STAGING_SUPABASE_ANON_KEY',
    'STAGING_SUPABASE_SERVICE_ROLE_KEY', 'STAGING_CONFIRMED_NOT_PRODUCTION', 'STAGING_DATABASE_URL',
    'PRODUCTION_SUPABASE_URL', 'PRODUCTION_DATABASE_URL', 'PGHOST', 'PGUSER', 'PGPORT', 'PGDATABASE',
  ];

  /** `scripts/db.ts` exactly as `npm run db:*` runs it, seeing only the variables given. */
  function db(args: readonly string[], vars: Readonly<Record<string, string>>) {
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const name of TARGET_VARIABLES) delete env[name];
    const result = spawnSync(process.execPath,
      [TSX, '--conditions=react-server', 'scripts/db.ts', ...args],
      { cwd: ROOT, env: { ...env, ...vars }, encoding: 'utf8', timeout: 90_000 });
    return { status: result.status, output: `${result.stdout}${result.stderr}` };
  }

  /**
   * Refused, and refused FIRST. Exit 3 is the guard's; a connection that had been attempted
   * would fail on the `.invalid` host with a DNS error and exit 1 instead.
   */
  function expectRefusedBeforeConnecting(outcome: { status: number | null; output: string }) {
    expect(outcome.status, outcome.output).toBe(3);
    expect(outcome.output).toMatch(/REFUSED/);
    expect(outcome.output).not.toMatch(/ENOTFOUND|EAI_AGAIN|getaddrinfo|ECONNREFUSED|ETIMEDOUT/);
  }

  it('refuses to migrate when no staging project is declared', () => {
    expectRefusedBeforeConnecting(db(['migrate', '--staging'], { DATABASE_URL: NOWHERE }));
  }, 120_000);

  it('refuses to read the ledger under the same rule', () => {
    expectRefusedBeforeConnecting(db(['status', '--staging'], { DATABASE_URL: NOWHERE }));
  }, 120_000);

  it('refuses --confirm-production alongside --staging', () => {
    const outcome = db(['migrate', '--staging', '--confirm-production'], { DATABASE_URL: NOWHERE });
    expectRefusedBeforeConnecting(outcome);
    expect(outcome.output).toMatch(/contradict/);
  }, 120_000);

  it('refuses a string that names the confirmed project but sends node-postgres elsewhere', () => {
    const outcome = db(['migrate', '--staging'], {
      STAGING_SUPABASE_URL: STAGING_URL,
      STAGING_CONFIRMED_NOT_PRODUCTION: 'yes',
      // The real driver resolves this to the `.invalid` host, not to the project it names.
      DATABASE_URL: 'postgresql://postgres@db.abcdefg.supabase.co:5432/postgres?host=staging-db.makam.invalid',
    });
    expectRefusedBeforeConnecting(outcome);
    expect(outcome.output).toMatch(/different host or user/);
  }, 120_000);

  it('never prints a password carried as a query parameter', () => {
    const outcome = db(['migrate', '--staging'],
      { DATABASE_URL: `${NOWHERE}?password=not-a-real-password` });
    expectRefusedBeforeConnecting(outcome);
    expect(outcome.output).not.toContain('not-a-real-password');
  }, 120_000);
});

describe('staging harness · a missing schema fails first', () => {
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

  it('passes as soon as PostgREST can see the tenants table', async () => {
    const { client, asked } = scripted([{ error: null }]);
    await expect(requireStagingSchema(client)).resolves.toBeUndefined();
    expect(asked).toEqual(['tenants']);
  });

  it('waits out a schema cache that has not reloaded yet', async () => {
    const { client, asked } = scripted([NOT_IN_CACHE, NOT_IN_CACHE, { error: null }]);
    await requireStagingSchema(client, { waitMs: 5_000, pollMs: 1 });
    expect(asked).toHaveLength(3);
  });

  it('names a schema that never appears as missing, and says nothing was created', async () => {
    const { client } = scripted([NOT_IN_CACHE]);
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
});

describe('staging harness · a world is built whole, or leaves nothing behind', () => {
  /** A configuration that resolves as available through the real guard. Every value is fake. */
  const AVAILABLE = {
    STAGING_SUPABASE_URL: STAGING_URL,
    STAGING_SUPABASE_ANON_KEY: 'anon-key-placeholder',
    STAGING_SUPABASE_SERVICE_ROLE_KEY: 'service-key-placeholder',
    STAGING_CONFIRMED_NOT_PRODUCTION: 'yes',
    PRODUCTION_SUPABASE_URL: '',
    PRODUCTION_DATABASE_URL: '',
  };

  /** The harness, imported afresh so that it resolves `staging` from exactly these variables. */
  async function harnessWith(vars: Readonly<Record<string, string>>) {
    for (const [name, value] of Object.entries(vars)) vi.stubEnv(name, value);
    vi.resetModules();
    return import('./staging/harness');
  }

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
  });

  type Call =
    | { readonly kind: 'probe' }
    | { readonly kind: 'createUser'; readonly id: string }
    | { readonly kind: 'insert'; readonly table: string; readonly row: Readonly<Record<string, unknown>> }
    | { readonly kind: 'signIn' }
    | { readonly kind: 'delete'; readonly table: string; readonly column: string | null;
        readonly values: readonly string[] }
    | { readonly kind: 'deleteUser'; readonly id: string };

  /**
   * A Supabase client that records every call, refuses the Nth occurrence of one step when
   * told to, and opens no socket.
   */
  function recordingSupabase(options: {
    readonly refuse?: { readonly step: string; readonly occurrence: number };
    readonly schema?: Probe;
    readonly cleanupThrows?: boolean;
  } = {}) {
    const calls: Call[] = [];
    const seen = new Map<string, number>();
    let users = 0;
    const refusal = (step: string) => {
      const occurrence = (seen.get(step) ?? 0) + 1;
      seen.set(step, occurrence);
      return options.refuse?.step === step && options.refuse.occurrence === occurrence
        ? { message: `refused at ${step} #${occurrence}` } : null;
    };
    const client = {
      auth: {
        admin: {
          createUser: async () => {
            const error = refusal('createUser');
            if (error) return { data: { user: null }, error };
            users += 1;
            const id = `00000000-0000-4000-8000-${String(users).padStart(12, '0')}`;
            calls.push({ kind: 'createUser', id });
            return { data: { user: { id } }, error: null };
          },
          deleteUser: async (id: string) => {
            calls.push({ kind: 'deleteUser', id });
            if (options.cleanupThrows) throw new Error('cleanup exploded');
            return { data: { user: null }, error: null };
          },
        },
        signInWithPassword: async () => {
          calls.push({ kind: 'signIn' });
          return { data: {}, error: refusal('signIn') };
        },
      },
      from: (table: string) => ({
        select: () => ({
          limit: async () => {
            calls.push({ kind: 'probe' });
            return options.schema ?? { error: null };
          },
        }),
        insert: async (row: Record<string, unknown>) => {
          calls.push({ kind: 'insert', table, row });
          return { error: refusal(`insert:${table}`) };
        },
        delete: () => {
          const filtered = async (column: string, values: readonly string[]) => {
            calls.push({ kind: 'delete', table, column, values: [...values] });
            return { error: null };
          };
          return {
            in: filtered,
            eq: (column: string, value: string) => filtered(column, [value]),
            // A delete awaited with no filter at all is recorded too, so it can be ruled out.
            then: (resolve: (value: { error: null }) => void) => {
              calls.push({ kind: 'delete', table, column: null, values: [] });
              resolve({ error: null });
            },
          };
        },
      }),
    };
    const connect = vi.fn(() => client) as unknown as ConnectSupabase & ReturnType<typeof vi.fn>;
    return { connect, calls };
  }

  /** The ids a run created — the only ids its cleanup may name. */
  const created = (calls: readonly Call[]) => ({
    users: calls.flatMap((c) => (c.kind === 'createUser' ? [c.id] : [])),
    tenants: calls.flatMap((c) =>
      (c.kind === 'insert' && c.table === 'tenants' ? [String(c.row.id)] : [])),
  });

  const deleted = (calls: readonly Call[]) => ({
    users: calls.flatMap((c) => (c.kind === 'deleteUser' ? [c.id] : [])),
    tenants: calls.flatMap((c) => (c.kind === 'delete' && c.table === 'tenants' ? c.values : [])),
  });

  /** Every delete is filtered, never by an empty list, and names only ids this run created. */
  function expectOnlyOwnRows(calls: readonly Call[]) {
    const own = created(calls);
    for (const call of calls) {
      if (call.kind === 'deleteUser') expect(own.users, 'a deleted auth user').toContain(call.id);
      if (call.kind !== 'delete') continue;
      expect(call.column, `${call.table}: every delete is filtered`).not.toBeNull();
      expect(call.values.length, `${call.table}: never by an empty list`).toBeGreaterThan(0);
      const ids = call.table === 'app_users' ? own.users : own.tenants;
      for (const value of call.values) expect(ids, `${call.table}.${call.column}`).toContain(value);
    }
  }

  const sorted = (values: readonly string[]) => [...values].sort();

  it('refuses to build anything, or open a client, when staging is not available', async () => {
    for (const vars of [
      { ...AVAILABLE, STAGING_CONFIRMED_NOT_PRODUCTION: '' },
      { ...AVAILABLE, PRODUCTION_SUPABASE_URL: STAGING_URL },
    ]) {
      const harness = await harnessWith(vars);
      const { connect } = recordingSupabase();
      await expect(harness.createStagingWorld(connect)).rejects.toThrow(/Staging is not available/);
      expect(connect).not.toHaveBeenCalled();
    }
  });

  it('builds two tenants deleting nothing, and its teardown removes exactly what it made', async () => {
    const harness = await harnessWith(AVAILABLE);
    expect(harness.staging.available, 'the fake configuration passes the real guard').toBe(true);
    const { connect, calls } = recordingSupabase();

    const world = await harness.createStagingWorld(connect);
    expect(calls.filter((c) => c.kind === 'delete' || c.kind === 'deleteUser')).toEqual([]);
    expect(world.a.tenantId).not.toBe(world.b.tenantId);

    await world.teardown();
    const own = created(calls);
    expect(own.users).toHaveLength(2);
    expect(sorted(deleted(calls).users)).toEqual(sorted(own.users));
    expect(sorted(deleted(calls).tenants)).toEqual(sorted(own.tenants));
    expectOnlyOwnRows(calls);
  });

  it('removes what it made when the second tenant fails partway, and reports that failure', async () => {
    const harness = await harnessWith(AVAILABLE);
    const { connect, calls } = recordingSupabase({
      refuse: { step: 'insert:memberships', occurrence: 2 },
    });

    await expect(harness.createStagingWorld(connect))
      .rejects.toThrow('Could not create membership: refused at insert:memberships #2');
    const own = created(calls);
    expect(own.users, 'both users existed before the failure').toHaveLength(2);
    expect(sorted(deleted(calls).users)).toEqual(sorted(own.users));
    expect(sorted(deleted(calls).tenants)).toEqual(sorted(own.tenants));
    expectOnlyOwnRows(calls);
  });

  it('deletes nothing when it failed before creating anything', async () => {
    const harness = await harnessWith(AVAILABLE);
    const { connect, calls } = recordingSupabase({ refuse: { step: 'createUser', occurrence: 1 } });

    await expect(harness.createStagingWorld(connect)).rejects.toThrow(/Could not create staging user/);
    expect(calls.filter((c) => c.kind === 'delete' || c.kind === 'deleteUser')).toEqual([]);
  });

  it('reports the failure that stopped it, not a failure of its own cleanup', async () => {
    const harness = await harnessWith(AVAILABLE);
    const { connect } = recordingSupabase({
      refuse: { step: 'insert:tenants', occurrence: 2 }, cleanupThrows: true,
    });

    await expect(harness.createStagingWorld(connect))
      .rejects.toThrow('Could not create staging tenant: refused at insert:tenants #2');
  });

  it('asks about the schema before it creates anything, and stops there when it is missing', async () => {
    const harness = await harnessWith(AVAILABLE);
    const { connect, calls } = recordingSupabase({ schema: NOT_IN_CACHE });

    await expect(harness.createStagingWorld(connect, { waitMs: 5, pollMs: 1 }))
      .rejects.toThrow(/staging schema is missing/);
    expect(calls.length, 'the schema was asked about').toBeGreaterThan(0);
    expect(calls.every((c) => c.kind === 'probe'), 'and nothing else was done').toBe(true);
  });
});
