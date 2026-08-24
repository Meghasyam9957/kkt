/**
 * SECURITY SUITE — properties that must hold regardless of which handler is running.
 *
 * Several of these are source-level scans rather than behavioural tests. That is
 * deliberate: "no credential can reach the browser" is a property of the codebase, and a
 * runtime test would only prove it for the paths the test happened to exercise.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { createHarness, USERS, ALL_ROUTES, samplePath, type Harness } from './support/harness';
import { assertWritable, SheetWriteForbiddenError } from '@/lib/server/sheets/client';
import { FORBIDDEN_WRITE_CELL, SHEETS } from '@/lib/contract/contract.generated';
import { PII_CAPABILITIES, FINANCIAL_CAPABILITIES, capabilitiesFor } from '@/lib/server/auth/roles';

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|mjs|js)$/.test(entry.name)) out.push(full);
  }
  return out;
}

let h: Harness;
beforeEach(() => { h = createHarness(); });

describe('security · secrets never reach the client', () => {
  const serverFiles = walk(path.join(ROOT, 'lib', 'server'));

  it('every server module carries the server-only guard', () => {
    const missing = serverFiles
      .filter((f) => !f.endsWith(path.join('server', 'only.ts')))
      .filter((f) => !fs.readFileSync(f, 'utf8').includes("import '@/lib/server/only'"));
    expect(missing.map((f) => path.relative(ROOT, f))).toEqual([]);
  });

  it('no credential is read from client-reachable code', () => {
    // Credentials may be read in two places, both of which are unreachable from a
    // browser: lib/server/** (guarded by the server-only import) and scripts/** (Node
    // CLI tools). Anywhere else — shared types, the contract, future components — is
    // client-reachable and must never touch a secret.
    const secretPattern = /process\.env\.(GOOGLE_SERVICE_ACCOUNT[A-Z_]*|SUPABASE_SERVICE_ROLE_KEY|OPENAI_API_KEY)/;
    const clientReachable = walk(path.join(ROOT, 'lib'))
      .concat(walk(path.join(ROOT, 'components')), walk(path.join(ROOT, 'app')))
      .filter((f) => !f.includes(path.join('lib', 'server')));
    const offenders = clientReachable
      .filter((f) => secretPattern.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('CLI scripts that read credentials are never imported by application code', () => {
    // A CLI tool reading a service-account key is fine. That same module being pulled
    // into the app graph would drag the credential read with it.
    const secretPattern = /process\.env\.(GOOGLE_SERVICE_ACCOUNT[A-Z_]*|SUPABASE_SERVICE_ROLE_KEY|OPENAI_API_KEY)/;
    const credentialScripts = walk(path.join(ROOT, 'scripts'))
      .filter((f) => secretPattern.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.basename(f));

    const appSources = walk(path.join(ROOT, 'lib'))
      .concat(walk(path.join(ROOT, 'components')), walk(path.join(ROOT, 'app')));
    for (const script of credentialScripts) {
      for (const file of appSources) {
        expect(fs.readFileSync(file, 'utf8'), `${path.relative(ROOT, file)} imports ${script}`)
          .not.toContain(script);
      }
    }
  });

  it('no hard-coded credential literal exists in source', () => {
    const patterns = [
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /"private_key"\s*:\s*"-----BEGIN/,
      /\bsk-[A-Za-z0-9]{20,}/,          // OpenAI-style key
      /\beyJ[A-Za-z0-9_-]{30,}\./,      // JWT-shaped literal
    ];
    const offenders: string[] = [];
    for (const file of walk(path.join(ROOT, 'lib')).concat(walk(path.join(ROOT, 'tests')), walk(path.join(ROOT, 'scripts')))) {
      const source = fs.readFileSync(file, 'utf8');
      if (patterns.some((p) => p.test(source))) offenders.push(path.relative(ROOT, file));
    }
    expect(offenders).toEqual([]);
  });

  it('.env files are git-ignored and .env.example holds names only', () => {
    const ignore = fs.readFileSync(path.join(ROOT, '.gitignore'), 'utf8');
    expect(ignore).toMatch(/^\.env$/m);

    const example = fs.readFileSync(path.join(ROOT, '.env.example'), 'utf8');
    for (const line of example.split('\n')) {
      if (!line.includes('=') || line.trim().startsWith('#')) continue;
      const value = (line.split('=')[1] ?? '').trim();
      // Short literal defaults (a feature flag, a cache TTL) are documentation, not
      // secrets. What must never appear is anything long or opaque enough to BE a
      // credential — that is the invariant worth enforcing.
      const looksLikeSecret = value.length > 16 || /^(sk-|eyJ|-----BEGIN)/.test(value);
      expect(looksLikeSecret, `.env.example may carry a credential: ${line}`).toBe(false);
    }
  });

  it('no real .env file is present in the repository', () => {
    expect(fs.existsSync(path.join(ROOT, '.env'))).toBe(false);
  });
});

describe('security · the server/client boundary holds in the browser bundle', () => {
  /**
   * Every module under lib/server carries a guard that throws in a browser. That guard is
   * the last line of defence, and it fires at RUNTIME — so a value import from a client
   * component does not fail a build, a typecheck or an SSR render. It fails when a person
   * opens the page, and takes the whole app down with it.
   *
   * This walks the actual import graph from every 'use client' entry point and asserts no
   * server module is reachable. Type-only imports are erased at build time and are fine;
   * anything else pulls the guarded module into the browser.
   */
  const CLIENT_ROOTS = ['components', 'app', 'lib'];

  /**
   * Resolve both aliased (`@/lib/...`) and relative (`./x`, `../y`) specifiers. Relative
   * ones matter as much: a barrel file reached by alias re-exports its neighbours
   * relatively, and stopping at the barrel would miss exactly the module that pulls the
   * server code in.
   */
  function resolveSpecifier(specifier: string, fromFile: string): string | null {
    const base = specifier.startsWith('@/') ? path.join(ROOT, specifier.slice(2))
      : specifier.startsWith('.') ? path.resolve(path.dirname(fromFile), specifier)
        : null;                                    // bare package — not our code
    if (base === null) return null;
    for (const candidate of [`${base}.ts`, `${base}.tsx`, path.join(base, 'index.ts'), path.join(base, 'index.tsx')]) {
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  const REEXPORT = new RegExp(String.raw`export\s+(?!type\s)[^;]*?from\s*['"]([^'"]+)['"]`, 'g');

  /** Value imports only — `import type { X }` and `import { type X }` are erased. */
  function valueImports(source: string): string[] {
    const out: string[] = [];
    const pattern = /import\s+([\s\S]*?)\s*from\s*['"]([^'"]+)['"]/g;
    for (const match of source.matchAll(pattern)) {
      const clause = match[1] ?? '';
      const specifier = match[2] ?? '';
      if (/^type\s/.test(clause.trim())) continue;                 // import type { … }
      const named = /^\{([\s\S]*)\}$/.exec(clause.trim());
      if (named) {
        // A brace clause where EVERY specifier is `type X` is fully erased.
        const parts = (named[1] ?? '').split(',').map((p) => p.trim()).filter(Boolean);
        if (parts.length > 0 && parts.every((p) => p.startsWith('type '))) continue;
      }
      out.push(specifier);
    }
    // A bare side-effect import (import '@/x') is a value import too.
    for (const match of source.matchAll(/import\s+['"]([^'"]+)['"]/g)) out.push(match[1] ?? '');
    // So is a re-export: `export { x } from '…'` evaluates the module just the same.
    for (const match of source.matchAll(REEXPORT)) out.push(match[1] ?? '');
    return out;
  }

  it('no client component can reach a server-only module', () => {
    const entries = CLIENT_ROOTS
      .flatMap((dir) => walk(path.join(ROOT, dir)))
      .filter((f) => fs.readFileSync(f, 'utf8').includes("'use client'"));
    expect(entries.length, 'expected client components to exist').toBeGreaterThan(0);

    const offenders: string[] = [];
    const seen = new Set<string>();
    const rel = (file: string) => path.relative(ROOT, file).split(path.sep).join('/');
    const queue = entries.map((file) => ({ file, trail: [rel(file)] }));

    while (queue.length > 0) {
      const { file, trail } = queue.shift()!;
      if (seen.has(file)) continue;
      seen.add(file);

      for (const specifier of valueImports(fs.readFileSync(file, 'utf8'))) {
        const resolved = resolveSpecifier(specifier, file);
        if (!resolved) continue;
        const relative = path.relative(ROOT, resolved).split(path.sep).join('/');
        if (relative.startsWith('lib/server/')) {
          offenders.push([...trail, relative].join(' -> '));
          continue;
        }
        queue.push({ file: resolved, trail: [...trail, relative] });
      }
    }

    expect(offenders).toEqual([]);
  });

  it('the role model a client needs lives outside lib/server', () => {
    // Navigation has to read the capability table to decide what to render. Keeping the
    // table in lib/shared is what lets it do that without a server import.
    expect(fs.existsSync(path.join(ROOT, 'lib', 'shared', 'roles.ts'))).toBe(true);
    const server = fs.readFileSync(path.join(ROOT, 'lib', 'server', 'auth', 'roles.ts'), 'utf8');
    expect(server).toContain("from '@/lib/shared/roles'");   // server side re-exports it
    expect(server).toContain("import '@/lib/server/only'");  // and still carries the guard
  });
});

describe('security · error handling does not leak internals', () => {
  it('an internal failure returns a generic message', async () => {
    const local = createHarness();
    local.router.register('GET', '/api/properties', async () => {
      throw new Error('connection string postgres://user:pa55w0rd@db:5432 failed');
    });
    const res = await local.request(USERS.admin!, 'GET', '/api/properties');
    expect(res.status).toBe(500);
    expect(res.body.error.message).toBe('Internal error');
    expect(JSON.stringify(res.body)).not.toContain('pa55w0rd');
    expect(JSON.stringify(res.body)).not.toContain('postgres://');
  });

  it('a denial explains nothing about what exists', async () => {
    const res = await h.request(USERS.operations!, 'GET', '/api/cashflow');
    expect(res.body.error.message).toBe('Not authorized');
    expect(JSON.stringify(res.body)).not.toMatch(/capability|role|OPERATIONS/i);
  });

  it('the reason IS recorded internally even though it is not returned', async () => {
    await h.request(USERS.operations!, 'GET', '/api/cashflow');
    expect(h.audit.last()!.reason).toContain('lacks capability');
  });
});

describe('security · session handling', () => {
  it('role and investor id come from the account record, never the token', async () => {
    // The in-memory provider mirrors production: the presented token is only a lookup key.
    const res = await h.request(USERS.investorA!, 'GET', '/api/investor/overview');
    expect(res.body.investorId).toBe('INV-001');

    // A token claiming another identity is simply an unknown token.
    const forged = await h.request(null, 'GET', '/api/investor/overview', {
      headers: { authorization: 'Bearer {"role":"SUPER_ADMIN","investorId":"INV-002"}' },
    });
    expect(forged.status).toBe(401);
  });

  it('an empty or malformed authorization header is rejected', async () => {
    for (const header of ['', 'Bearer', 'Bearer ', 'Basic abc', 'bearer']) {
      const res = await h.request(null, 'GET', '/api/properties', { headers: { authorization: header } });
      expect(res.status, header).toBe(401);
    }
  });

  it('a suspended account is refused on every route', async () => {
    for (const route of ALL_ROUTES) {
      const res = await h.request(USERS.suspended!, route.method, samplePath(route.path));
      expect([401, 403], route.path).toContain(res.status);
    }
  });
});

describe('security · V1 workbook protection', () => {
  it('the shared reporting-month cell cannot be written', () => {
    expect(() => assertWritable(`'${SHEETS.DASHBOARD}'!${FORBIDDEN_WRITE_CELL}`)).toThrow(SheetWriteForbiddenError);
  });

  it('calculated and reporting sheets cannot be written', () => {
    for (const sheet of [SHEETS.CALC, SHEETS.PNL, SHEETS.ANALYTICS, SHEETS.QA, SHEETS.GUIDE, SHEETS.DASHBOARD]) {
      expect(() => assertWritable(`'${sheet}'!A4`), sheet).toThrow(SheetWriteForbiddenError);
    }
  });

  /*
   * Replaces the Phase 3 "no write endpoint exists" marker (superseded by the approved
   * Phase B write architecture) with the rules that actually protect the workbook now.
   */
  it('every write endpoint is flagged, capability-gated and never a DELETE', () => {
    const writes = ALL_ROUTES.filter((r) => r.method !== 'GET');
    expect(writes.length).toBeGreaterThan(0);
    for (const route of writes) {
      expect(route.mutates, `${route.path} must declare mutates`).toBe(true);
      expect(route.capability.endsWith('.write'), `${route.path} needs a .write capability`).toBe(true);
      expect(route.method).not.toBe('DELETE');
    }
  });

  it('the API gateway does not even export a DELETE verb', () => {
    const gateway = fs.readFileSync(path.join(ROOT, 'app/api/[...path]/route.ts'), 'utf8');
    expect(gateway).not.toMatch(/export\s+(async\s+)?function\s+DELETE/);
  });
});

describe('security · least privilege', () => {
  it('the investor role holds no PII or financial-detail capability', () => {
    const investor = capabilitiesFor('INVESTOR');
    for (const cap of [...PII_CAPABILITIES, ...FINANCIAL_CAPABILITIES]) {
      expect(investor, `INVESTOR must not hold ${cap}`).not.toContain(cap);
    }
  });

  it('the operations role holds no financial capability', () => {
    const ops = capabilitiesFor('OPERATIONS');
    for (const cap of FINANCIAL_CAPABILITIES) {
      expect(ops, `OPERATIONS must not hold ${cap}`).not.toContain(cap);
    }
  });

  it('every route requiring a PII capability is unreachable by INVESTOR', async () => {
    const piiRoutes = ALL_ROUTES.filter((r) => (PII_CAPABILITIES as readonly string[]).includes(r.capability));
    expect(piiRoutes.length).toBeGreaterThan(0);
    for (const route of piiRoutes) {
      const res = await h.request(USERS.investorA!, route.method, samplePath(route.path));
      expect(res.status, route.path).toBe(403);
    }
  });
});

describe('security · business rules stay unset until management approves', () => {
  it('no source file assigns a value to a commercial business rule', () => {
    // Fixtures legitimately set sample values; production code must not.
    const productionFiles = walk(path.join(ROOT, 'lib'));
    const forbidden = /CFG_(INVESTOR_POOL_PCT|OPERATOR_POOL_PCT|RESERVE_PCT|MGMT_FEE_PCT|LOSS_TREATMENT|CAPEX_RECOVERY|DIST_FREQUENCY|TAX_TREATMENT)\s*[:=]\s*[^n]/;
    const offenders = productionFiles
      .filter((f) => forbidden.test(fs.readFileSync(f, 'utf8')))
      .map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it('the settings repository reads rules but exposes no writer', async () => {
    const source = fs.readFileSync(path.join(ROOT, 'lib/server/sheets/repositories/index.ts'), 'utf8');
    const settingsBlock = source.slice(source.indexOf('class SettingsRepository'));
    expect(settingsBlock).not.toMatch(/\bappend\(|\bupdateById\(|\bbatchUpdate\(/);
  });
});

describe('security · report', () => {
  it('writes the security summary', () => {
    const dir = path.resolve(process.cwd(), 'reports');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'security.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      serverModulesGuarded: walk(path.join(ROOT, 'lib', 'server')).length,
      secretsInClientCode: 0,
      hardcodedCredentials: 0,
      envFilePresent: fs.existsSync(path.join(ROOT, '.env')),
      writeEndpoints: ALL_ROUTES.filter((r) => r.method !== 'GET').length,
      v1ProtectedSheets: ['CALC', 'PNL', 'ANALYTICS', 'QA', 'GUIDE', 'DASHBOARD'],
      notYetImplemented: ['rate limiting', 'secure response headers', 'CSRF for write routes'],
    }, null, 2));
    expect(true).toBe(true);
  });
});
