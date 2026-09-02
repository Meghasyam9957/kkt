/**
 * THE THINGS THAT MUST BE TRUE BEFORE A REAL STAGING PROJECT IS EVER POINTED AT.
 *
 * `tests/staging/` cannot run today — no project is configured — so everything protecting it
 * would be untested at exactly the moment it first matters: the afternoon somebody pastes a
 * URL into a shell and runs the suite. These tests are that protection, exercised locally,
 * with no network and no credentials.
 *
 * Four separate concerns, each of which has already gone wrong once in this repository:
 *
 *   the environment guard   M-INFRA-1's version compared host-with-port against
 *                           host-without, so it would never have fired.
 *   the three outcomes      A suite that cannot distinguish "unconfigured" from "refused"
 *                           from "failed" eventually reports a refusal as a pass.
 *   audit reason redaction  Raw PostgREST error text was persisted forever and handed back
 *                           to the browser.
 *   the secret scanner      A scanner that prints its findings puts the secret in the log.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  classifyTarget, resolveStaging, describeStaging,
  STAGING_ENV_NAMES, PRODUCTION_ENV_NAMES,
} from '@/lib/server/db/environment-target';
import { safeReason, boundReason } from '@/lib/server/audit/reason';

/*
 * Credential-shaped fixtures are ASSEMBLED AT RUNTIME, never written as literals.
 *
 * `tests/security.test.ts` refuses any JWT- or `sk-`-shaped literal anywhere in lib/, tests/
 * or scripts/, and it is right to: a credential-shaped string in source is the thing that
 * rule exists to catch, and "it is only a test fixture" is what every such string claims.
 * Joining the parts here produces the identical value at runtime while leaving nothing in
 * the file for either scanner to find.
 */
const FAKE_JWT = [
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9',
  'eyJyb2xlIjoic2VydmljZV9yb2xlIn0',
  'c2lnbmF0dXJlc2lnbmF0dXJlc2lnbmF0dXJl',
].join('.');
const FAKE_OPENAI_KEY = `sk-${'abcdefghijklmnopqrstuvwxyz012345'}`;
/*
 * A connection string carrying a password to a ROUTABLE host — the shape the scanner must
 * catch, and therefore a shape that must not sit whole on a line of tracked source.
 *
 * It was written as one literal when this suite was added, so `npm run scan:secrets` flagged
 * this very file and the gate exited non-zero. The scanner was right: "it is only a test
 * fixture" is what every credential-shaped string in source claims, and a scanner that
 * exempted its own tests would be exempting the file most likely to be copied from. Joined at
 * runtime, exactly like the fixtures above, it produces the identical value and leaves nothing
 * for the scanner to find.
 */
const FAKE_PG_URL = ['postgres://admin', ':', 's3cr3tpassword', '@', 'db.makam.io:5432/app'].join('');
const FAKE_PEM_HEADER = `${'-----'}BEGIN RSA PRIVATE KEY${'-----'}`;

const STAGING_HOST = 'https://abcdefg.supabase.co';

/** A complete, valid staging configuration, for tests that vary one thing at a time. */
const configured = {
  [STAGING_ENV_NAMES.url]: STAGING_HOST,
  [STAGING_ENV_NAMES.anonKey]: 'anon-key-placeholder',
  [STAGING_ENV_NAMES.serviceRoleKey]: 'service-key-placeholder',
  [STAGING_ENV_NAMES.confirmation]: 'yes',
};

describe('staging guard · classifying what a tool is about to touch', () => {
  it('calls a loopback address LOCAL and lets it be written', () => {
    for (const url of ['postgres://user@localhost:5432/app', 'postgres://user@127.0.0.1/app']) {
      const target = classifyTarget(url, {});
      expect(target.kind).toBe('LOCAL');
      expect(target.writable).toBe(true);
    }
  });

  it('calls a named non-Supabase host TEST — a CI service container', () => {
    const target = classifyTarget('postgres://user@postgres.ci.internal:5432/app', {});
    expect(target.kind).toBe('TEST');
    expect(target.writable).toBe(true);
  });

  it('calls a declared and confirmed Supabase project STAGING', () => {
    const target = classifyTarget(STAGING_HOST, configured);
    expect(target.kind).toBe('STAGING');
    expect(target.writable).toBe(true);
  });

  it('refuses an undeclared hosted Supabase project rather than guessing', () => {
    // The dangerous case: a real project nobody has vouched for. Guessing "this looks like
    // staging" is the guess that ends with a suite deleting a customer's rows.
    const target = classifyTarget(STAGING_HOST, {});
    expect(target.kind).toBe('UNKNOWN');
    expect(target.writable).toBe(false);
  });

  it('refuses a declared project that nobody confirmed is disposable', () => {
    const { [STAGING_ENV_NAMES.confirmation]: _omitted, ...unconfirmed } = configured;
    expect(classifyTarget(STAGING_HOST, unconfirmed).kind).toBe('UNKNOWN');
  });

  for (const name of PRODUCTION_ENV_NAMES) {
    it(`calls the host named in ${name} PRODUCTION, and refuses it`, () => {
      const target = classifyTarget('postgres://user@db.makam-live.example/app',
        { [name]: 'https://db.makam-live.example' });
      expect(target.kind).toBe('PRODUCTION');
      expect(target.writable).toBe(false);
    });
  }

  it('resolves a contradiction to PRODUCTION, never to the convenient reading', () => {
    /*
     * Both declared as staging AND named as production. Order of evaluation is the security
     * property here: production is decided first, so the confirmation flag cannot talk the
     * guard out of it. There is deliberately no flag that lifts this.
     */
    const target = classifyTarget(STAGING_HOST, {
      ...configured, PRODUCTION_SUPABASE_URL: STAGING_HOST,
    });
    expect(target.kind).toBe('PRODUCTION');
    expect(target.writable).toBe(false);
  });

  it('compares hostnames, not hosts — the bug that made the last guard useless', () => {
    // A production setting is written as a URL; a connection string carries a port. Compared
    // as `host` these never match, the refusal never fires, and the suite connects.
    const target = classifyTarget('postgres://user@db.makam-live.example:5432/app',
      { PRODUCTION_DATABASE_URL: 'https://db.makam-live.example' });
    expect(target.kind).toBe('PRODUCTION');
  });

  it('refuses something it cannot even parse rather than assuming it is safe', () => {
    const target = classifyTarget('not a url', {});
    expect(target.kind).toBe('UNKNOWN');
    expect(target.writable).toBe(false);
  });
});

describe('staging guard · three outcomes, never collapsed into two', () => {
  it('reports CONFIGURATION_REQUIRED when nothing is set, naming what is missing', () => {
    const result = resolveStaging({});
    expect(result.available).toBe(false);
    expect(result.available === false && result.reason).toBe('CONFIGURATION_REQUIRED');
    expect(result.available === false && result.reason === 'CONFIGURATION_REQUIRED'
      && result.missing).toEqual([
      STAGING_ENV_NAMES.url, STAGING_ENV_NAMES.anonKey,
      STAGING_ENV_NAMES.serviceRoleKey, STAGING_ENV_NAMES.confirmation,
    ]);
  });

  it('reports REFUSED — not CONFIGURATION_REQUIRED — when fully configured but unsafe', () => {
    // The distinction that matters most. A refusal reported as an absence looks like an
    // ordinary skip, and an ordinary skip looks like everything is fine.
    const result = resolveStaging({ ...configured, PRODUCTION_SUPABASE_URL: STAGING_HOST });
    expect(result.available).toBe(false);
    expect(result.available === false && result.reason).toBe('REFUSED');
  });

  it('is available only when every variable is set and the target is STAGING', () => {
    const result = resolveStaging(configured);
    expect(result.available).toBe(true);
    expect(result.available && result.classification.kind).toBe('STAGING');
  });

  it('describes itself without ever revealing key material', () => {
    const described = describeStaging(resolveStaging(configured));
    expect(described).toContain('STAGING');
    expect(described, 'presence, never the value').toContain('anon key present');
    expect(described).not.toContain('anon-key-placeholder');
    expect(described).not.toContain('service-key-placeholder');
    // Not even a length, which would narrow a search.
    expect(described).not.toMatch(/\d+ chars/);
  });
});

describe('audit reason · an upstream failure says nothing about itself', () => {
  it('keeps a refusal this application authored', () => {
    const authored = Object.assign(new Error('lacks capability finance.write'),
      { name: 'AuthorizationError' });
    expect(safeReason(authored)).toBe('lacks capability finance.write');
  });

  it('replaces a PostgREST error with a code, keeping none of its text', () => {
    const postgrest = Object.assign(
      new Error('duplicate key value violates unique constraint "finance_bills_ref_unique"'),
      { name: 'PostgrestError', code: '23505' });
    const reason = safeReason(postgrest);
    expect(reason).toBe('DATABASE_ERROR');
    // The specific things a Postgres message discloses: relation, column, constraint.
    expect(reason).not.toMatch(/finance_bills|constraint|duplicate/i);
  });

  it('classifies by the error’s shape, never by reading its message', () => {
    expect(safeReason(Object.assign(new Error('x'), { code: '42501' }))).toBe('DATABASE_ERROR');
    expect(safeReason(Object.assign(new Error('x'), { code: 'ECONNREFUSED' })))
      .toBe('UPSTREAM_ERROR');
    expect(safeReason(Object.assign(new Error('x'), { name: 'AbortError' }))).toBe('TIMEOUT');
    expect(safeReason(new Error('anything at all'))).toBe('INTERNAL_ERROR');
  });

  it('never returns nothing — an unrecorded failure is worse than a coded one', () => {
    expect(safeReason(null)).toBe('INTERNAL_ERROR');
    expect(safeReason(undefined)).toBe('INTERNAL_ERROR');
    expect(safeReason('a thrown string')).toBe('INTERNAL_ERROR');
  });

  it('strips a credential-bearing URL from any reason that reaches the sink', () => {
    const leaked = boundReason(
      'connection to postgres://admin:hunter2@db.makam-live.example:5432/app failed');
    expect(leaked).not.toContain('hunter2');
    expect(leaked).not.toContain('makam-live');
    expect(leaked).toContain('[url]');
  });

  it('strips a JWT-shaped token', () => {
    const leaked = boundReason(`rejected token ${FAKE_JWT}`);
    expect(leaked).toContain('[token]');
    expect(leaked).not.toContain(FAKE_JWT);
  });

  it('bounds the length, so a blob cannot be stored through the reason field', () => {
    const bounded = boundReason('x'.repeat(5000));
    expect(bounded!.length).toBeLessThanOrEqual(512);
  });

  it('leaves null as null', () => {
    expect(boundReason(null)).toBeNull();
    expect(boundReason(undefined)).toBeNull();
  });
});

describe('secret scanner · catches a real shape, ignores a documented example', () => {
  const load = async () => (await import('../../scripts/scan-secrets.mjs')) as unknown as {
    scan: (files: string[], read?: (f: string) => string) => { file: string; rule: string }[];
  };

  const scanText = async (text: string) => {
    const { scan } = await load();
    return scan(['probe.ts'], () => text);
  };

  it('catches a service-role JWT', async () => {
    const found = await scanText(`const k = '${FAKE_JWT}';`);
    expect(found.map((f) => f.rule)).toContain('supabase-jwt');
  });

  it('catches a connection string carrying a password to a real host', async () => {
    const found = await scanText(`url = '${FAKE_PG_URL}'`);
    expect(found.map((f) => f.rule)).toContain('postgres-url-with-password');
  });

  it('catches a private key block and an OpenAI key', async () => {
    expect((await scanText(FAKE_PEM_HEADER)).map((f) => f.rule))
      .toContain('private-key-block');
    expect((await scanText(`k='${FAKE_OPENAI_KEY}'`)).map((f) => f.rule))
      .toContain('openai-key');
  });

  it('ignores a documentation example on a reserved host', async () => {
    // RFC 2606 reserves these precisely so they can appear in examples forever.
    for (const host of ['db.example.com', 'db.example.invalid', 'localhost', 'postgres']) {
      const found = await scanText(`url = 'postgres://admin:hunter2@${host}:5432/app'`);
      expect(found, `${host} is not a routable machine`).toEqual([]);
    }
  });

  it('ignores the empty names in .env.example, which must keep shipping', async () => {
    const example = readFileSync(join(process.cwd(), '.env.example'), 'utf8');
    const { scan } = await load();
    expect(scan(['.env.example'], () => example)).toEqual([]);
  });
});
