/**
 * LIVE PARITY — the operator's path.
 *
 * The preflight runs once, on an operator's machine, at the moment a release gate is
 * being closed. That is the worst possible time to discover a regex does not match, a
 * shell separator is POSIX-only, or a credential variable has the wrong name. Everything
 * standing between the operator and a comparison is tested here.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// Plain ESM modules, shared with the parity scripts.
import { findContactData, findSecrets, mask, looksFictional, titleLooksLikeCopy, textOf }
  from '../scripts/parity-scan.mjs';
import { resolveParityEnv, forbiddenMatches, maskSheetId } from '../scripts/parity-env.mjs';
import { REQUIRED_SCENARIOS } from '../scripts/parity-preflight.mjs';

const rows = (...values: string[][]) => values;

/** Line feed. A trailing CR on CRLF files is harmless to the checks below. */
const NEWLINE = String.fromCharCode(10);

const sourceOf = (file: string) => fs.readFileSync(path.resolve(process.cwd(), file), 'utf8');
const pkg = () => JSON.parse(fs.readFileSync(path.resolve(process.cwd(), 'package.json'), 'utf8'));

describe('preflight · real personal data', () => {
  it('passes a workbook seeded with fictional records', () => {
    expect(findContactData(rows(
      ['BK-001', 'Test Guest One (FICTIONAL)', 'test-one@example.com'],
      ['BK-002', 'Demo Guest Two', 'guest2@example.org'],
      ['RNT-001', 'Test Landlord A', ''],
    ))).toEqual([]);
  });

  it('catches a real email address', () => {
    expect(findContactData(rows(['BK-001', 'Priya Menon', 'priya.menon@gmail.com'])))
      .toEqual(['priya.menon@gmail.com']);
  });

  it('catches an Indian mobile number, with or without the country code', () => {
    expect(findContactData(rows(['BK-001', 'Guest', '9876543210']))).toEqual(['9876543210']);
    expect(findContactData(rows(['BK-002', 'Guest', '+91 9123456780'])))
      .toEqual(['+91 9123456780']);
  });

  it('does not mistake an amount, a date or a booking id for a phone number', () => {
    expect(findContactData(rows(
      ['BK-2026-0001', 'Test Guest', '2026-04-01'],
      ['', 'amount', '1234567890'],       // starts with 1 — not an Indian mobile
      ['', 'serial', '46114'],
    ))).toEqual([]);
  });

  it('ignores non-string cells rather than throwing on them', () => {
    const mixed = [['BK-001', 12345, null, undefined, true, 'ok@example.com']] as unknown as string[][];
    expect(() => findContactData(mixed)).not.toThrow();
    expect(findContactData(mixed)).toEqual([]);
  });

  it('de-duplicates a value that appears on many rows', () => {
    expect(findContactData(rows(
      ['a', 'x@real.co'], ['b', 'x@real.co'], ['c', 'x@real.co'],
    ))).toEqual(['x@real.co']);
  });

  it('masks a finding enough to recognise but not to reuse', () => {
    expect(mask('priya.menon@gmail.com')).toBe('pr***@gmail.com');
    expect(mask('9876543210')).toBe('987*******');
    expect(mask('9876543210')).not.toContain('543210');
  });
});

describe('preflight · stored secrets', () => {
  /**
   * Synthetic test vectors, assembled at runtime rather than written as literals.
   *
   * `tests/security.test.ts` scans this repository for credential-shaped literals, and it
   * should keep doing exactly that. Splitting these keeps that guard able to fail on a
   * real key instead of having to exempt a file — the scanner under test still receives
   * the complete string.
   */
  const cases: Array<[string, string]> = [
    ['Google API key', 'AIza' + 'SyA1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q'],
    ['Google OAuth token', 'ya29.' + 'a0AfH6SMBx1234567890abcdef'],
    ['OpenAI-style secret key', 'sk-' + 'abcdefghijklmnopqrstuvwxyz012345'],
    ['AWS access key id', 'AKIA' + 'IOSFODNN7EXAMPLE'],
    ['Slack token', 'xoxb-' + '123456789012-abcdefghijkl'],
    ['private key', '-----BEGIN RSA PRIVATE ' + 'KEY-----'],
    ['GitHub token', 'ghp_' + 'abcdefghijklmnopqrstuvwxyz0123456789'],
  ];

  for (const [label, sample] of cases) {
    it(`detects a ${label}`, () => {
      expect(findSecrets(rows(['Notes', `credentials: ${sample}`]))).toContain(label);
    });
  }

  it('does not fire on ordinary workbook text', () => {
    expect(findSecrets(rows(
      ['CFG_BIZ_NAME', 'Srivillu Home Stays'],
      ['Notes', 'Monthly rent — Landlord A units'],
      ['Notes', 'Wiring repair (see maintenance ticket)'],
      ['CFG_INVESTOR_POOL_PCT', 'TBD'],
    ))).toEqual([]);
  });

  it('accepts a pre-joined string as well as rows', () => {
    expect(findSecrets('key=' + 'AKIA' + 'IOSFODNN7EXAMPLE')).toEqual(['AWS access key id']);
  });
});

describe('preflight · workbook identity', () => {
  it.each([
    ['Homestay Ops — PARITY COPY', true],
    ['Copy of Homestay Ops', true],
    ['Homestay Ops TEST', true],
    ['Srivillu sandbox', true],
    ['Homestay Ops', false],
    ['Srivillu Home Stays — Operations', false],
  ])('%s → parity copy: %s', (title, expected) => {
    expect(titleLooksLikeCopy(title)).toBe(expected);
  });

  it('treats a missing title as not-a-copy rather than throwing', () => {
    expect(titleLooksLikeCopy(undefined)).toBe(false);
  });

  it.each([
    ['Test Guest One', true],
    ['Demo Guest', true],
    ['Guest 4', true],
    ['Sample Person', true],
    ['Priya Menon', false],
  ])('%s → visibly fictional: %s', (name, expected) => {
    expect(looksFictional(name)).toBe(expected);
  });
});

describe('preflight · the module itself', () => {
  const source = sourceOf('scripts/parity-preflight.mjs');

  it('reads the contract from disk, not through an import assertion', () => {
    // Node 20.8 rejects `with { type: 'json' }` and Node 22 rejects `assert`. The
    // preflight must not be the thing that fails on the operator's Node version.
    const importsTheModel = source.split(NEWLINE)
      .filter((line) => line.includes('contract.model.json') && line.includes('import('));
    expect(importsTheModel).toEqual([]);
    expect(source).toContain('readFileSync');
  });

  it('asks Google for read-only access, and never writes', () => {
    expect(source).toContain('spreadsheets.readonly');
    expect(source).not.toMatch(/values\.(update|append|batchUpdate|clear)/);
    expect(source).not.toMatch(/spreadsheets\.batchUpdate/);
  });

  it('covers all nine preparation-checklist points', () => {
    for (const point of [
      'required environment variables', 'credentials decode', 'the workbook is reachable',
      'NOT the production workbook', 'all 22 V1 tabs exist', 'required named ranges',
      'fixture/test records', 'test scenarios exist',
      'CFG_REPORT_MONTH names a month that has data',
    ]) {
      expect(source.toLowerCase(), `checklist point missing: ${point}`)
        .toContain(point.toLowerCase());
    }
  });

  it('names all eleven scenarios, and carries a fix for each', () => {
    expect(REQUIRED_SCENARIOS).toHaveLength(11);
    for (const name of REQUIRED_SCENARIOS) {
      expect(source, `no fix text for scenario: ${name}`).toContain(`'${name}':`);
    }
  });

  it('reuses the shared scanners rather than duplicating them', () => {
    expect(source).toContain('./parity-scan.mjs');
    expect(source).not.toMatch(/const\s+EMAIL\s*=/);
    expect(textOf([['a', 1, 'b']])).toBe('a' + NEWLINE + 'b');
  });
});

describe('operator entry point · Windows safety', () => {
  it('npm run parity is a single Node command, with no shell chaining', () => {
    // `a; b` is a POSIX separator. cmd.exe reads the semicolon as part of the filename,
    // and the whole gate died before its first check ran.
    expect(pkg().scripts.parity).toBe('node scripts/parity.mjs');
  });

  it('no npm script uses POSIX-only shell syntax', () => {
    const posixOnly = [';', '$(', '`', 'export ', 'unset ', '2>/dev/null', '||'];
    const offenders: string[] = [];
    for (const [name, command] of Object.entries(pkg().scripts as Record<string, string>)) {
      for (const token of posixOnly) {
        if (command.includes(token)) offenders.push(`${name}: contains "${token}"`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('spawns children without a shell, using the running Node binary', () => {
    const source = sourceOf('scripts/parity.mjs');
    expect(source).toContain('process.execPath');
    expect(source).toContain('shell: false');
    // A shell-resolved `vitest` would hit the .cmd shim on Windows and a shell script on
    // POSIX; naming the .mjs entry point behaves identically everywhere.
    expect(source).toContain("path.join('node_modules', 'vitest', 'vitest.mjs')");
  });

  it('runs all three stages from the one command', () => {
    const source = sourceOf('scripts/parity.mjs');
    expect(source).toContain('runPreflight');
    expect(source).toContain('tests/parity.live.test.ts');
    expect(source).toContain("path.join('scripts', 'parity-report.mjs')");
  });

  it('stops before comparing anything when a preflight check fails', () => {
    const source = sourceOf('scripts/parity.mjs');
    const stop = source.slice(source.indexOf("'NOT READY'"), source.indexOf('Step 2 of 3'));
    expect(stop).toContain('process.exit(1)');
    expect(stop).toContain('printFailures');
  });

  it('treats absent credentials as NOT CONFIGURED, not as a failure', () => {
    // Exiting non-zero here would stop the offline layers from running at all — the
    // report would not even get to say LIVE PENDING.
    const source = sourceOf('scripts/parity.mjs');
    const branch = source.slice(
      source.indexOf("'NOT CONFIGURED'"), source.indexOf('Step 2 of 3'));
    expect(branch).not.toContain('process.exit');
    expect(branch).toContain('PowerShell');
  });
});

describe('credential resolution', () => {
  const KEY = { client_email: 'parity@example.iam.gserviceaccount.com', private_key: 'x' };
  const keyFile = path.join(os.tmpdir(), 'srivillu-parity-key.test.json');
  beforeAll(() => fs.writeFileSync(keyFile, JSON.stringify(KEY)));
  afterAll(() => { try { fs.unlinkSync(keyFile); } catch { /* already gone */ } });

  it('reports NOT CONFIGURED, naming what is missing, when nothing is set', () => {
    const r = resolveParityEnv({});
    expect(r.configured).toBe(false);
    expect(r.problems).toEqual([]);
    expect(r.missing.join(' ')).toContain('PARITY_SHEET_ID');
  });

  it('accepts a key file path — the form that survives copy-paste on Windows', () => {
    const r = resolveParityEnv({ PARITY_SHEET_ID: 'abc123', PARITY_SERVICE_ACCOUNT_FILE: keyFile });
    expect(r.configured).toBe(true);
    expect(r.clientEmail).toBe(KEY.client_email);
    expect(Buffer.from(r.base64 ?? '', 'base64').toString('utf8')).toContain('client_email');
  });

  it('accepts base64 text', () => {
    const base64 = Buffer.from(JSON.stringify(KEY), 'utf8').toString('base64');
    const r = resolveParityEnv({ PARITY_SHEET_ID: 'abc123', PARITY_SERVICE_ACCOUNT_JSON_BASE64: base64 });
    expect(r.configured).toBe(true);
    expect(r.clientEmail).toBe(KEY.client_email);
  });

  it('still accepts the legacy names, and says to prefer the parity-only ones', () => {
    const base64 = Buffer.from(JSON.stringify(KEY), 'utf8').toString('base64');
    const r = resolveParityEnv({ GOOGLE_SHEET_ID: 'abc123', GOOGLE_SERVICE_ACCOUNT_JSON_BASE64: base64 });
    expect(r.configured).toBe(true);
    expect(r.notes.join(' ')).toContain('PARITY_SHEET_ID');
  });

  it('explains a broken base64 value instead of throwing', () => {
    const r = resolveParityEnv({ PARITY_SHEET_ID: 'abc', PARITY_SERVICE_ACCOUNT_JSON_BASE64: 'not base64' });
    expect(r.configured).toBe(false);
    expect(r.problems.join(' ')).toContain('line break');
  });

  it('names the missing file rather than reporting a vague failure', () => {
    const r = resolveParityEnv({ PARITY_SHEET_ID: 'abc', PARITY_SERVICE_ACCOUNT_FILE: 'C:/no/such/key.json' });
    expect(r.configured).toBe(false);
    expect(r.problems.join(' ')).toContain('does not exist');
  });

  it('rejects a key with no private key', () => {
    const base64 = Buffer.from(JSON.stringify({ client_email: 'a@b.c' }), 'utf8').toString('base64');
    const r = resolveParityEnv({ PARITY_SHEET_ID: 'abc', PARITY_SERVICE_ACCOUNT_JSON_BASE64: base64 });
    expect(r.configured).toBe(false);
    expect(r.problems.join(' ')).toContain('private_key');
  });

  it('never carries the private key into anything printable', () => {
    const r = resolveParityEnv({ PARITY_SHEET_ID: 'abcdef123456', PARITY_SERVICE_ACCOUNT_FILE: keyFile });
    expect(maskSheetId(r.sheetId)).toBe('…123456');
    expect(maskSheetId(r.sheetId)).not.toContain('abcdef');
    expect(r.credentialFrom).not.toContain(KEY.private_key);
  });
});

describe('production-workbook refusal', () => {
  it('refuses a workbook that is also a configured environment workbook', () => {
    expect(forbiddenMatches('SAME', { PRODUCTION_GOOGLE_SHEET_ID: 'SAME' }))
      .toEqual(['PRODUCTION_GOOGLE_SHEET_ID']);
    expect(forbiddenMatches('SAME', { DEMO_GOOGLE_SHEET_ID: 'SAME' }))
      .toEqual(['DEMO_GOOGLE_SHEET_ID']);
  });

  it('does not refuse a genuinely distinct copy', () => {
    expect(forbiddenMatches('COPY', { PRODUCTION_GOOGLE_SHEET_ID: 'PROD' })).toEqual([]);
  });

  it('is not fooled by an unset or blank variable', () => {
    expect(forbiddenMatches('', { PRODUCTION_GOOGLE_SHEET_ID: '' })).toEqual([]);
    expect(forbiddenMatches('COPY', {})).toEqual([]);
  });

  it('refuses before it ever connects to Google', () => {
    const source = sourceOf('scripts/parity-preflight.mjs');
    const before = source.slice(0, source.indexOf('googleapis'));
    expect(before).toContain('forbiddenMatches');
    expect(before).toContain('REFUSING');
  });
});
