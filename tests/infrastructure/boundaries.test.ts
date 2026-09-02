/**
 * THE TWO BOUNDARIES A DATABASE MILESTONE CAN GET CATASTROPHICALLY WRONG.
 *
 *   THE SECRET BOUNDARY   The service role bypasses row level security completely. It is
 *                         the one credential that makes every isolation guarantee in the
 *                         RLS suite irrelevant, so the only thing that matters about it is
 *                         that it never leaves the server.
 *
 *   THE ENVIRONMENT       This suite creates tenants, employees and bills, and several of
 *   BOUNDARY              its tests delete everything they can reach in order to prove they
 *                         cannot. Pointed at a real customer database, that is not a failed
 *                         test — it is an incident.
 *
 * Both are tested here as code, not as documentation, because both are the kind of rule
 * that holds right up until the afternoon somebody is in a hurry.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';
import {
  resolveTestDatabase, redactConnectionString, hostOf, UnsafeTestDatabaseError, DB_ENV_NAMES,
} from '@/lib/server/db/test-database';

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (['.ts', '.tsx', '.mjs', '.js'].includes(extname(full))) out.push(full);
  }
  return out;
}

const sourceFiles = walk(join(ROOT, 'lib'))
  .concat(walk(join(ROOT, 'app')), walk(join(ROOT, 'components')));

describe('secrets · the service role never reaches a browser', () => {
  it('is read in exactly the modules that are server-only', () => {
    const readers = sourceFiles.filter((f) => /SERVICE_ROLE/.test(readFileSync(f, 'utf8')));
    expect(readers.length, 'a reader exists to be checked').toBeGreaterThan(0);

    for (const file of readers) {
      const relative = file.slice(ROOT.length + 1).replace(/\\/g, '/');
      expect(relative,
        'anything that can name the service role key belongs under lib/server')
        .toMatch(/^lib\/server\//);
      expect(readFileSync(file, 'utf8'),
        `${relative} must import the server-only marker, which throws in a browser bundle`)
        .toMatch(/@\/lib\/server\/only|'server-only'/);
    }
  });

  it('is never exposed through a NEXT_PUBLIC variable', () => {
    for (const file of sourceFiles) {
      const text = readFileSync(file, 'utf8');
      for (const match of text.matchAll(/NEXT_PUBLIC_[A-Z0-9_]+/g)) {
        expect(match[0], `${file} exposes ${match[0]} to the browser`)
          .not.toMatch(/SERVICE_ROLE|SECRET|PRIVATE|PASSWORD|_KEY$|DATABASE_URL/);
      }
    }
  });

  it('is not reachable from any client component', () => {
    // A 'use client' module is compiled into the browser bundle along with everything it
    // imports. None of them may name a server module at all.
    const clientFiles = sourceFiles.filter((f) => {
      const head = readFileSync(f, 'utf8').slice(0, 200);
      return /^\s*['"]use client['"]/m.test(head);
    });
    expect(clientFiles.length, 'there are client components to check').toBeGreaterThan(0);

    for (const file of clientFiles) {
      const text = readFileSync(file, 'utf8');
      // Matched per import STATEMENT so that `import type { X } from '@/lib/server/...'`
      // is recognised as type-only. A type import is erased by the compiler and reaches no
      // bundle, so it carries no code and no credential.
      const valueImports = [...text.matchAll(
        /^import\s+(type\s+)?([^;]*?)from\s+['"](@\/lib\/server\/[^'"]+)['"]/gm)]
        .filter((m) => !m[1] && !/^\s*\{\s*type\s/.test(m[2] ?? ''))
        .map((m) => m[3]);

      expect(valueImports,
        `${file.slice(ROOT.length + 1)} is a client component and must not import server code`)
        .toEqual([]);
    }
  });

  it('keeps every dotenv file out of version control', () => {
    const ignore = readFileSync(join(ROOT, '.gitignore'), 'utf8');
    expect(ignore, 'one pattern must cover .env, .env.local and .env.production alike')
      .toMatch(/^\.env\*/m);
    expect(ignore, 'the template with no values in it is the exception')
      .toMatch(/^!\.env\.example/m);
  });

  it('ships an example file that carries names and no values', () => {
    const example = readFileSync(join(ROOT, '.env.example'), 'utf8');
    for (const line of example.split(/\r?\n/)) {
      const match = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(line.trim());
      if (!match) continue;
      const [, name, value] = match;
      if (!/KEY|SECRET|PASSWORD|TOKEN|JSON_BASE64|URL|SHEET_ID/.test(name!)) continue;
      expect(value, `${name} must ship empty; a real value here is a committed secret`)
        .toBe('');
    }
  });
});

describe('environment · the test suite cannot reach production', () => {
  const base = { [DB_ENV_NAMES.url]: 'postgres://u:p@db.example.com:5432/app' };

  it('uses an in-memory database when nothing is configured', () => {
    expect(resolveTestDatabase({}).kind).toBe('PGLITE');
    expect(resolveTestDatabase({ [DB_ENV_NAMES.url]: '   ' }).kind).toBe('PGLITE');
  });

  it('refuses the host named in the production configuration', () => {
    expect(() => resolveTestDatabase({
      ...base,
      PRODUCTION_SUPABASE_URL: 'https://db.example.com',
    })).toThrow(UnsafeTestDatabaseError);
  });

  it('refuses it even when the confirmation flag is set', () => {
    // The flag exists for a disposable hosted project. It is not an override for
    // production, and there deliberately is none.
    expect(() => resolveTestDatabase({
      ...base,
      PRODUCTION_SUPABASE_URL: 'https://db.example.com',
      [DB_ENV_NAMES.confirmation]: 'yes',
    })).toThrow(/production database/i);
  });

  it('refuses a hosted Supabase project unless it is explicitly disclaimed', () => {
    // No password in the fixture: the guard classifies by hostname alone, so writing one
    // would add nothing to the test and give the secret scanner a real credential shape
    // pointed at a real domain to worry about.
    const hosted = { [DB_ENV_NAMES.url]: 'postgres://user@abcdefg.supabase.co:5432/postgres' };
    expect(() => resolveTestDatabase(hosted)).toThrow(/hosted Supabase/i);
    expect(resolveTestDatabase({ ...hosted, [DB_ENV_NAMES.confirmation]: 'yes' }).kind)
      .toBe('POSTGRES');
  });

  it('accepts an ordinary throwaway server, which is what CI provides', () => {
    const target = resolveTestDatabase({
      [DB_ENV_NAMES.url]: 'postgres://postgres:postgres@localhost:5432/postgres',
    });
    expect(target.kind).toBe('POSTGRES');
  });

  it('refuses a target it cannot even parse rather than assuming it is safe', () => {
    expect(() => resolveTestDatabase({ [DB_ENV_NAMES.url]: 'not a url at all' }))
      .toThrow(UnsafeTestDatabaseError);
  });
});

describe('logs · a failure must not print a credential', () => {
  it('redacts the username and password from a connection string', () => {
    const redacted = redactConnectionString('postgres://admin:hunter2@db.example.com:5432/app');
    expect(redacted).not.toContain('hunter2');
    expect(redacted).not.toContain('admin');
    // The host survives, because knowing WHICH database refused is the useful half.
    expect(redacted).toContain('db.example.com');
  });

  it('reports only the host when identifying a target', () => {
    expect(hostOf('postgres://admin:hunter2@db.example.com:5432/app'))
      .toBe('db.example.com:5432');
  });

  it('never puts a credential in the refusal it throws', () => {
    try {
      resolveTestDatabase({
        [DB_ENV_NAMES.url]: 'postgres://admin:hunter2@db.example.com:5432/app',
        PRODUCTION_SUPABASE_URL: 'https://db.example.com',
      });
      throw new Error('should have refused');
    } catch (error) {
      const message = String(error);
      expect(message).not.toContain('hunter2');
      expect(message).not.toContain('admin');
      expect(message, 'the operator still needs to know which host was refused')
        .toContain('db.example.com');
    }
  });

  it('says nothing about an unparseable string beyond that it is unusable', () => {
    expect(redactConnectionString('postgres://admin:hunter2@@@')).not.toContain('hunter2');
  });
});
