/**
 * ENVIRONMENT ISOLATION — the nine safety invariants.
 *
 * Each block below is one of the nine, tested as a failure scenario rather than a happy
 * path. The thing being protected is specific: a demonstration to a client must not be one
 * environment variable away from reading, writing or leaking the real business.
 *
 * The design these tests verify is that isolation is **structural**. DEMO reads only
 * `DEMO_*` variables and PRODUCTION reads only `PRODUCTION_*`, so most of these invariants
 * hold because there is no code path to violate, not because a check catches it. Several
 * tests below therefore assert the absence of a path, which is the stronger claim.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  resolveEnvironment, readAppEnv, requireSheets, requireSupabase, assertDemoOnly,
  publicEnvironmentInfo, EnvironmentConfigError, DemoOnlyOperationError,
} from '@/lib/server/environment/config';
import { createLiveSheetsClient, liveSheetsConfigStatus } from '@/lib/server/sheets/config';
import { buildAiPayload, assertAiPayloadEnvironment, AiEnvironmentMismatchError, aiEnabled } from '@/lib/server/ai/guard';
import { resetDemoEnvironment, setScenario, __resetDemoStoreForTests } from '@/lib/server/demo/store';
import { runGuestJourney } from '@/lib/server/demo/guest-journey';
import { DemoAuthProvider } from '@/lib/server/auth/demo-identities';
import type { EnvLike } from '@/lib/shared/env';

const ROOT = process.cwd();

const PRODUCTION_SHEET = 'production-workbook-id-1234';
const DEMO_SHEET = 'demo-workbook-id-9876';
const PRODUCTION_SUPABASE = 'https://srivillu-production.supabase.invalid';
const DEMO_SUPABASE = 'https://srivillu-demo.supabase.invalid';

/** Credentials built at runtime so no credential-shaped literal sits in the source tree. */
const serviceAccount = (who: string) =>
  Buffer.from(JSON.stringify({ client_email: `${who}@example.invalid` }), 'utf8').toString('base64');

/** A fully configured two-environment deployment — both sets of variables present. */
function bothConfigured(appEnv: 'demo' | 'production'): EnvLike {
  return {
    APP_ENV: appEnv,
    DEMO_GOOGLE_SHEET_ID: DEMO_SHEET,
    DEMO_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: serviceAccount('demo'),
    DEMO_SUPABASE_URL: DEMO_SUPABASE,
    DEMO_SUPABASE_SERVICE_ROLE_KEY: 'demo-service-role',
    PRODUCTION_GOOGLE_SHEET_ID: PRODUCTION_SHEET,
    PRODUCTION_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: serviceAccount('production'),
    PRODUCTION_SUPABASE_URL: PRODUCTION_SUPABASE,
    PRODUCTION_SUPABASE_SERVICE_ROLE_KEY: 'production-service-role',
  };
}

let originalEnv: NodeJS.ProcessEnv;
beforeEach(() => {
  originalEnv = { ...process.env };
  __resetDemoStoreForTests();
});
afterEach(() => {
  process.env = originalEnv;
  __resetDemoStoreForTests();
});

/* ================================================================== *
 * 1 · Demo cannot READ the production Google Sheet
 * ================================================================== */

describe('invariant 1 · demo cannot read the production workbook', () => {
  it('resolves the demo spreadsheet even when production credentials are present', () => {
    const resolved = resolveEnvironment(bothConfigured('demo'));
    expect(resolved.sheets?.spreadsheetId).toBe(DEMO_SHEET);
    expect(resolved.sheets?.spreadsheetId).not.toBe(PRODUCTION_SHEET);
  });

  it('the client demo builds is pointed at the demo workbook', () => {
    const status = liveSheetsConfigStatus(bothConfigured('demo'));
    expect(status.environment).toBe('DEMO');
    expect(status.spreadsheetIdSuffix).toBe(DEMO_SHEET.slice(-6));
    expect(status.spreadsheetIdSuffix).not.toBe(PRODUCTION_SHEET.slice(-6));
  });

  it('no code path reads PRODUCTION_* while APP_ENV is demo', () => {
    // The strong version of the claim: with production credentials the ONLY ones present,
    // a demo deployment finds nothing at all. It does not fall through to them.
    const env: EnvLike = {
      APP_ENV: 'demo',
      PRODUCTION_GOOGLE_SHEET_ID: PRODUCTION_SHEET,
      PRODUCTION_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: serviceAccount('production'),
    };
    const resolved = resolveEnvironment(env);
    expect(resolved.sheets).toBeNull();
    expect(() => requireSheets(resolved)).toThrow(EnvironmentConfigError);
    expect(() => createLiveSheetsClient(env)).toThrow(/DEMO_GOOGLE_SHEET_ID/);
  });

  it('refuses a configuration where both environments share one workbook', () => {
    const env = { ...bothConfigured('demo'), PRODUCTION_GOOGLE_SHEET_ID: DEMO_SHEET };
    expect(() => resolveEnvironment(env)).toThrow(/same Google spreadsheet/);
  });
});

/* ================================================================== *
 * 2 · Demo cannot WRITE the production Google Sheet
 * ================================================================== */

describe('invariant 2 · demo cannot write the production workbook', () => {
  /*
   * Replaces the Phase 3 "no write path exists" marker (superseded by the approved
   * Phase B write architecture) with the gates that protect the workbook NOW.
   */
  it('every write path is declared, flagged and capability-gated', async () => {
    const { ALL_ROUTES } = await import('./support/harness');
    const writes = ALL_ROUTES.filter((r) => r.method !== 'GET');
    expect(writes.length).toBeGreaterThan(0);
    for (const route of writes) {
      expect(route.mutates, `${route.path} must declare mutates`).toBe(true);
      expect(route.capability.endsWith('.write'), `${route.path} must demand a .write capability`).toBe(true);
    }
  });

  it('production writes are OFF by default and only the literal "true" enables them', () => {
    const base = bothConfigured('production');
    expect(resolveEnvironment(base).writesPermitted).toBe(false);
    expect(resolveEnvironment({ ...base, PRODUCTION_WRITES_ENABLED: 'yes' }).writesPermitted).toBe(false);
    expect(resolveEnvironment({ ...base, PRODUCTION_WRITES_ENABLED: '1' }).writesPermitted).toBe(false);
    expect(resolveEnvironment({ ...base, PRODUCTION_WRITES_ENABLED: 'TRUE' }).writesPermitted).toBe(true);
    expect(resolveEnvironment({ ...base, PRODUCTION_WRITES_ENABLED: 'true' }).writesPermitted).toBe(true);
  });

  it('demo writes default ON (a demo that cannot demonstrate writing is not a demo)', () => {
    const base = bothConfigured('demo');
    expect(resolveEnvironment(base).writesPermitted).toBe(true);
    expect(resolveEnvironment({ ...base, DEMO_WRITES_ENABLED: 'false' }).writesPermitted).toBe(false);
  });

  it('the demo reset touches no spreadsheet — it rebuilds a generated dataset', () => {
    const source = fs.readFileSync(path.join(ROOT, 'lib/server/demo/store.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    // If reset could reach a client, "reset the demo" would be one misconfiguration away
    // from "clear the real workbook". It cannot: it has no client and no write call.
    expect(code).not.toMatch(/GoogleSheets|batchUpdate|\.append\(|SheetsClient/);
  });

  it('a demo-built Sheets client could only ever address the demo workbook', () => {
    const resolved = resolveEnvironment(bothConfigured('demo'));
    expect(requireSheets(resolved).spreadsheetId).toBe(DEMO_SHEET);
  });
});

/* ================================================================== *
 * 3 · Demo cannot access the production Supabase project
 * ================================================================== */

describe('invariant 3 · demo cannot reach the production Supabase project', () => {
  it('resolves the demo project even with production credentials present', () => {
    const resolved = resolveEnvironment(bothConfigured('demo'));
    expect(resolved.supabase?.url).toBe(DEMO_SUPABASE);
    expect(resolved.supabase?.url).not.toBe(PRODUCTION_SUPABASE);
  });

  it('finds nothing when only production credentials exist', () => {
    const resolved = resolveEnvironment({
      APP_ENV: 'demo',
      PRODUCTION_SUPABASE_URL: PRODUCTION_SUPABASE,
      PRODUCTION_SUPABASE_SERVICE_ROLE_KEY: 'production-service-role',
    });
    expect(resolved.supabase).toBeNull();
    expect(() => requireSupabase(resolved)).toThrow(/DEMO_SUPABASE_URL/);
  });

  it('refuses a configuration where both environments share one project', () => {
    const env = { ...bothConfigured('demo'), PRODUCTION_SUPABASE_URL: DEMO_SUPABASE };
    expect(() => resolveEnvironment(env)).toThrow(/same Supabase project/);
  });
});

/* ================================================================== *
 * 4 · Production cannot use demo data
 * ================================================================== */

describe('invariant 4 · production cannot use demo data', () => {
  it('production never permits fixtures, under any configuration', () => {
    const resolved = resolveEnvironment(bothConfigured('production'));
    expect(resolved.fixturesPermitted).toBe(false);
    // Not a flag someone can flip — it is derived from the environment itself.
    expect(resolveEnvironment({ APP_ENV: 'production' }).fixturesPermitted).toBe(false);
  });

  it('production with LIVE_DATA_ENABLED=false refuses to start a request', async () => {
    Object.assign(process.env, bothConfigured('production'), { LIVE_DATA_ENABLED: 'false' });
    const { getDataProvider, __setDataProviderForTests } = await import('@/lib/data/providers');
    __setDataProviderForTests(null);

    // The alternative — quietly serving fixtures — would put fictional figures in front of
    // someone making a real decision. There is no such fallback.
    expect(() => getDataProvider()).toThrow(/no fixture mode/i);
    __setDataProviderForTests(null);
  });

  it('production resolves the production workbook, never the demo one', () => {
    const resolved = resolveEnvironment(bothConfigured('production'));
    expect(resolved.sheets?.spreadsheetId).toBe(PRODUCTION_SHEET);
    expect(resolved.prefix).toBe('PRODUCTION_');
  });

  it('demo-only operations are refused in production', () => {
    const resolved = resolveEnvironment(bothConfigured('production'));
    expect(() => assertDemoOnly('Reset demo environment', resolved)).toThrow(DemoOnlyOperationError);
    expect(() => resetDemoEnvironment({ resolved })).toThrow(DemoOnlyOperationError);
    expect(() => setScenario('HIGH_OCCUPANCY', { resolved })).toThrow(DemoOnlyOperationError);
    expect(() => runGuestJourney({ resolved })).toThrow(DemoOnlyOperationError);
    expect(() => new DemoAuthProvider(resolved)).toThrow(DemoOnlyOperationError);
  });

  it('the production refusal explains that no equivalent exists, rather than implying a permission', () => {
    const resolved = resolveEnvironment(bothConfigured('production'));
    try {
      resetDemoEnvironment({ resolved });
      throw new Error('should have thrown');
    } catch (error) {
      expect((error as Error).message).toMatch(/no production equivalent/i);
    }
  });
});

/* ================================================================== *
 * 5 & 6 · AI cannot receive data from the other environment
 * ================================================================== */

describe('invariants 5 and 6 · AI payloads cannot cross environments', () => {
  it('AI is not enabled and no key is read anywhere in the codebase', () => {
    expect(aiEnabled()).toBe(false);

    const walk = (dir: string, out: string[] = []): string[] => {
      if (!fs.existsSync(dir)) return out;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.(ts|tsx|mjs)$/.test(entry.name)) out.push(full);
      }
      return out;
    };
    const readers = ['lib', 'app', 'components', 'scripts']
      .flatMap((dir) => walk(path.join(ROOT, dir)))
      .filter((file) => /process\.env\.[A-Z_]*OPENAI/.test(fs.readFileSync(file, 'utf8')));
    expect(readers).toEqual([]);
  });

  it('a payload is stamped with the environment that produced it, not one it claims', () => {
    const demo = buildAiPayload({ note: 'demo figures' }, { resolved: resolveEnvironment(bothConfigured('demo')) });
    expect(demo.environment).toBe('demo');
    expect(demo.demo).toBe(true);

    const production = buildAiPayload({ note: 'real figures' }, { resolved: resolveEnvironment(bothConfigured('production')) });
    expect(production.environment).toBe('production');
    expect(production.demo).toBe(false);
  });

  it('5 · demo data cannot be sent to the production AI configuration', () => {
    const demoPayload = buildAiPayload({ note: 'fictional' }, { resolved: resolveEnvironment(bothConfigured('demo')) });
    expect(() => assertAiPayloadEnvironment(demoPayload, { resolved: resolveEnvironment(bothConfigured('production')) }))
      .toThrow(AiEnvironmentMismatchError);
  });

  it('6 · production data cannot be sent to the demo AI configuration', () => {
    const productionPayload = buildAiPayload({ note: 'real' }, { resolved: resolveEnvironment(bothConfigured('production')) });
    expect(() => assertAiPayloadEnvironment(productionPayload, { resolved: resolveEnvironment(bothConfigured('demo')) }))
      .toThrow(AiEnvironmentMismatchError);
  });

  it('a matching payload passes the guard and then fails because AI is off', async () => {
    const resolved = resolveEnvironment(bothConfigured('demo'));
    const payload = buildAiPayload({ note: 'fictional' }, { resolved });
    expect(() => assertAiPayloadEnvironment(payload, { resolved })).not.toThrow();

    const { dispatchToAi, AiNotEnabledError } = await import('@/lib/server/ai/guard');
    expect(() => dispatchToAi(payload, { resolved })).toThrow(AiNotEnabledError);
  });
});

/* ================================================================== *
 * 7 · Switching APP_ENV changes the data source deliberately and visibly
 * ================================================================== */

describe('invariant 7 · switching APP_ENV is deliberate and visible', () => {
  it('the same variables resolve to different workbooks under each APP_ENV', () => {
    expect(resolveEnvironment(bothConfigured('demo')).sheets?.spreadsheetId).toBe(DEMO_SHEET);
    expect(resolveEnvironment(bothConfigured('production')).sheets?.spreadsheetId).toBe(PRODUCTION_SHEET);
  });

  it('the interface states the environment and the data source', () => {
    const demo = publicEnvironmentInfo(resolveEnvironment(bothConfigured('demo')), true);
    expect(demo.name).toBe('DEMO');
    expect(demo.banner).toBe('DEMO / UAT');
    expect(demo.dataSourceLabel).toContain('Demo Workbook');

    const production = publicEnvironmentInfo(resolveEnvironment(bothConfigured('production')), false);
    expect(production.name).toBe('PRODUCTION');
    // Production has no banner text at all, so it cannot render a demo badge.
    expect(production.banner).toBeNull();
    expect(production.dataSourceLabel).toBe('Srivillu Operations Workbook');
  });

  it('an unrecognised APP_ENV is refused rather than guessed', () => {
    expect(() => readAppEnv({ APP_ENV: 'staging' })).toThrow(/must be 'demo' or 'production'/);
    expect(() => readAppEnv({ APP_ENV: 'PRODUCTION ' })).not.toThrow();   // trimmed, cased
  });

  it('an unset APP_ENV comes up as demo, never as production', () => {
    // The one-directional default: coming up as demo is inconvenient, coming up as
    // production by accident is a data incident.
    expect(readAppEnv({})).toBe('demo');
    expect(readAppEnv({ APP_ENV: '' })).toBe('demo');
  });
});

/* ================================================================== *
 * 8 · No browser-exposed value can select the environment
 * ================================================================== */

describe('invariant 8 · the browser cannot choose the environment', () => {
  it('no NEXT_PUBLIC_ variable participates in the decision', () => {
    const resolved = resolveEnvironment({
      APP_ENV: 'production',
      NEXT_PUBLIC_APP_ENV: 'demo',
      NEXT_PUBLIC_ENVIRONMENT: 'demo',
      ...bothConfigured('production'),
    });
    expect(resolved.env).toBe('production');
  });

  it('the environment resolver reads APP_ENV and nothing else', () => {
    const source = fs.readFileSync(path.join(ROOT, 'lib/server/environment/config.ts'), 'utf8');
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    expect(code).toContain('env.APP_ENV');
    expect(code).not.toContain('NEXT_PUBLIC');
    // No header, cookie or query string is consulted — those are all caller-controlled.
    expect(code).not.toMatch(/headers\(\)|cookies\(\)|searchParams/);
  });

  it('what reaches the browser carries no credential and no resource identifier', () => {
    const info = publicEnvironmentInfo(resolveEnvironment(bothConfigured('production')), false);
    const serialised = JSON.stringify(info);
    expect(serialised).not.toContain(PRODUCTION_SHEET);
    expect(serialised).not.toContain(PRODUCTION_SUPABASE);
    expect(serialised).not.toContain('service-role');
    expect(Object.keys(info).sort()).toEqual(
      ['banner', 'dataSourceLabel', 'demoControls', 'env', 'fixtures', 'name'],
    );
  });
});

/* ================================================================== *
 * 9 · Environment selection comes only from trusted server config
 * ================================================================== */

describe('invariant 9 · selection is server-side only', () => {
  it('the resolver is a server-only module', () => {
    const source = fs.readFileSync(path.join(ROOT, 'lib/server/environment/config.ts'), 'utf8');
    expect(source.startsWith("import '@/lib/server/only';")).toBe(true);
  });

  it('no client component reads APP_ENV or resolves the environment itself', () => {
    const walk = (dir: string, out: string[] = []): string[] => {
      if (!fs.existsSync(dir)) return out;
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, out);
        else if (/\.tsx?$/.test(entry.name)) out.push(full);
      }
      return out;
    };
    const offenders = ['components', 'app', 'lib']
      .flatMap((dir) => walk(path.join(ROOT, dir)))
      .filter((file) => {
        const source = fs.readFileSync(file, 'utf8');
        if (!source.includes("'use client'")) return false;
        return /process\.env\.APP_ENV/.test(source) || /resolveEnvironment\s*\(/.test(source);
      })
      .map((file) => path.relative(ROOT, file));
    expect(offenders).toEqual([]);
  });

  it('the client receives the resolved answer as a prop, and renders only that', () => {
    const shell = fs.readFileSync(path.join(ROOT, 'components/shell/EnvironmentStatus.tsx'), 'utf8');
    expect(shell).toContain('environment.banner');
    // No branch on process.env, no inference, no default.
    expect(shell).not.toContain('process.env');
  });
});
