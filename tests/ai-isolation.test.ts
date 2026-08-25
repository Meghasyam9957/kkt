/**
 * AI ISOLATION — ARCHITECTURE §8.1, §8.2, §8.3.
 *
 * §8.1 names this file by name: it must assert that a tool registry returns only
 * whitelisted fields and that no financial repository is reachable from one. That is
 * written here against the real seam, not a mock of it — a mocked boundary proves the
 * mock, and the whole point of an isolation suite is that it fails when the boundary
 * moves.
 *
 * The suite covers the management copilot. The guest assistant §8.1 also describes does
 * not exist yet, and a tripwire at the bottom fails the day someone starts it without
 * bringing its whitelist tests along.
 *
 * Two properties are asserted behaviourally rather than by reading the source, because
 * only the behaviour is binding:
 *
 *   - the provider is proxied, so the set of reads the context assembler actually
 *     performs is measured. "Arbitrary workbook access is impossible" is then a
 *     recorded fact rather than a claim about what the code appears to do;
 *   - the assembled context is serialised and searched for the guest names the source
 *     board really contains, so §8.3's stripping is tested against live text rather
 *     than a fixture written to pass.
 *
 * AI is off throughout, and the last block proves it is still off at the end.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { FixtureDashboardDataProvider } from '@/lib/data/providers/fixture-provider';
import { DemoGridProvider } from '@/lib/data/providers/demo-grid-provider';
import type { DashboardDataProvider, ReportFilters } from '@/lib/data/providers/types';
import {
  buildCopilotContext, stripGuestNames, capabilityForTool,
  COPILOT_TOOLS, COPILOT_CAPABILITIES, CopilotNotPermittedError,
  type CopilotContext, type CopilotToolName,
} from '@/lib/server/ai/copilot-context';
import { aiEnabled, dispatchToAi, AiNotEnabledError } from '@/lib/server/ai/guard';
import { API_ROUTES, findRoute } from '@/lib/server/api/routes';
import { ROLES, capabilitiesFor, type Role } from '@/lib/server/auth/roles';
import { PNL as PNL_CONTRACT } from '@/lib/contract/contract.generated';

const ROOT = process.cwd();
const AI_DIR = path.join(ROOT, 'lib', 'server', 'ai');
const FIXED_NOW = new Date('2027-01-19T06:00:00.000Z');

/**
 * Every AI module, with its comments removed.
 *
 * The scans below ask what the code reaches, and a prose paragraph explaining why the
 * copilot may not touch `AnalyticsRepository` is not the code reaching it. Stripping the
 * comments keeps the assertion about behaviour rather than about vocabulary.
 */
function aiSources(): Array<{ file: string; text: string }> {
  const withoutComments = (text: string): string => text
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
  // Recursive on purpose. A flat read of the directory would stop scanning the moment
  // someone organised the AI layer into `tools/` or `prompts/` — which is exactly when
  // the scans below start mattering, and exactly the kind of silent coverage loss that
  // makes a security suite worse than none.
  const walk = (dir: string, prefix = ''): Array<{ file: string; text: string }> =>
    fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
      const full = path.join(dir, entry.name);
      const label = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) return walk(full, label);
      if (!entry.name.endsWith('.ts')) return [];
      return [{ file: label, text: withoutComments(fs.readFileSync(full, 'utf8')) }];
    });
  return walk(AI_DIR);
}

/**
 * The AI layer, by name.
 *
 * An inventory rather than a count: a module added anywhere under `lib/server/ai` fails
 * this list until somebody writes it down, and writing it down means reading what the
 * scans below now cover it with. Cheap, and it is the only assertion here that notices a
 * file nobody thought to tell the suite about.
 */
const AI_MODULES = [
  'config.ts', 'copilot-context.ts', 'copilot.ts', 'dispatch.ts', 'guard.ts',
  'guardrails.ts', 'mock-provider.ts', 'openai-provider.ts', 'provider.ts',
];

/**
 * The modules allowed to do something the rest of the AI layer may not, and the only
 * thing each of them is allowed to do.
 *
 * An exemption that is a category anyone may join is not a boundary. These are
 * enumerated, and each test below asserts both halves: the named module may, and
 * every other module may not.
 */
const MAY_REACH_NETWORK = ['openai-provider.ts'];
const MAY_READ_ENVIRONMENT = ['config.ts', 'guard.ts'];
/** And only one of those may name the credential variable at all. */
const MAY_NAME_THE_CREDENTIAL = ['config.ts'];

/** Every key name appearing anywhere in a payload, at any depth. */
function allKeys(value: unknown, out: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) { out.add(key); allKeys(child, out); }
  }
  return out;
}

/**
 * A provider that records which reads were made through it.
 *
 * The methods still run for real — this measures the surface the assembler touches
 * without weakening what it returns.
 */
function recording(inner: DashboardDataProvider): { provider: DashboardDataProvider; calls: string[] } {
  const calls: string[] = [];
  const provider = new Proxy(inner, {
    get(target, prop) {
      const value = Reflect.get(target, prop) as unknown;
      if (typeof value !== 'function') return value;
      const fn = value as (...args: unknown[]) => unknown;
      return (...args: unknown[]) => { calls.push(String(prop)); return fn.apply(target, args); };
    },
  }) as DashboardDataProvider;
  return { provider, calls };
}

async function latestFilters(provider: DashboardDataProvider): Promise<ReportFilters> {
  const months = await provider.getAvailableMonths();
  return { month: months[months.length - 1] ?? '', propertyId: null, platform: null };
}

const fixture = () => new FixtureDashboardDataProvider({ now: () => FIXED_NOW });

async function contextFor(
  role: Role, provider: DashboardDataProvider = fixture(),
): Promise<CopilotContext> {
  const payload = await buildCopilotContext(provider, await latestFilters(provider), {
    role, now: FIXED_NOW,
  });
  return payload.contents;
}

/* ================================================================== *
 * The seam is inert
 * ================================================================== */

describe('AI isolation · the seam is inert', () => {
  it('AI is not enabled', () => {
    expect(aiEnabled()).toBe(false);
  });

  it('the AI layer is exactly the modules this suite knows about', () => {
    // Every scan below runs over this set. A module the suite has never seen is a module
    // whose imports, credentials and network reach nobody checked, so it fails here first.
    expect(aiSources().map((s) => s.file).sort()).toEqual([...AI_MODULES].sort());
  });

  it('a real assembled context still cannot be dispatched', async () => {
    const provider = fixture();
    const payload = await buildCopilotContext(provider, await latestFilters(provider), {
      role: 'ADMIN', now: FIXED_NOW,
    });
    expect(() => dispatchToAi(payload)).toThrow(AiNotEnabledError);
  });

  it('exactly one AI module reads the environment, and it never holds the secret', () => {
    /*
     * The credential has to be read somewhere now that a real provider exists. That
     * somewhere is enumerated: `config.ts` and nothing else. Every other AI module is
     * handed what it needs, so none of them can pick a secret up by accident.
     */
    const readers = aiSources()
      .filter((s) => /process\.env|\benv\[/.test(s.text))
      .map((s) => s.file)
      .sort();
    expect(readers).toEqual([...MAY_READ_ENVIRONMENT].sort());

    // The sharper half: reading the environment to decide whether AI is on is not the
    // same as touching a secret. Exactly one module names the credential variable at
    // all, so there is one place to audit rather than a layer to trust.
    const namers = aiSources()
      .filter((s) => s.text.includes('OPENAI_API_KEY'))
      .map((s) => s.file)
      .sort();
    expect(namers).toEqual([...MAY_NAME_THE_CREDENTIAL].sort());
  });

  it('the resolved configuration cannot carry the key, however it is serialised', async () => {
    // The property that makes the reader safe: the object it returns has no field the
    // secret could live in, so logging or returning it cannot leak one.
    const { resolveAiConfig } = await import('@/lib/server/ai/config');
    const config = resolveAiConfig(
      { TEST_OPENAI_API_KEY: 'sk-proj-not-a-real-key', TEST_AI_PROVIDER: 'openai' },
      'TEST_',
    );

    expect(config.apiKeyPresent).toBe(true);
    expect(JSON.stringify(config)).not.toContain('sk-proj');
  });

  it('only the provider adapter can reach the network', () => {
    /*
     * This used to assert that NO AI module could call out. A real provider has to, so
     * the assertion narrows to name the one that may rather than disappearing. The
     * point was never "nothing calls out" — it was that nothing calls out carrying the
     * payload this boundary exists to restrict, and every other module still cannot.
     */
    const reachers = aiSources()
      .filter((s) => /\bfetch\s*\(|https?:\/\/|XMLHttpRequest|node:https?\b/.test(s.text))
      .map((s) => s.file)
      .sort();
    expect(reachers).toEqual([...MAY_REACH_NETWORK].sort());
  });

  it('the adapter reaches exactly one host, and it is the documented endpoint', () => {
    const source = aiSources().find((s) => s.file === 'openai-provider.ts')!;
    const urls = [...new Set(source.text.match(/https?:\/\/[^'"`\s]+/g) ?? [])];
    expect(urls).toEqual(['https://api.openai.com/v1/responses']);
  });

  it('no AI SDK is installed', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
    };
    const names = [...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.devDependencies ?? {})];
    expect(names.filter((n) => /openai|anthropic|langchain|llamaindex/i.test(n))).toEqual([]);
  });

  it('the declared AI surface is exactly the copilot ask, and it writes nothing', () => {
    /*
     * This test used to assert that NO /api/ai route existed, on the grounds that the
     * context builder should have nothing in front of it until the guardrails, the
     * budget gate and the usage seam were built. They are, so the route is declared —
     * and the tripwire narrows rather than disappears: a second AI route fails here
     * until someone writes it down, which is the part worth keeping.
     *
     * It is also where the non-mutating classification is checked from the AI side. The
     * governance suites check it from the registry side; this checks that the route the
     * AI layer is reached through has not quietly become a write.
     */
    const ai = API_ROUTES.filter((r) => r.path.startsWith('/api/ai'));
    expect(ai.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /api/ai/copilot']);
    expect(ai[0]!.capability).toBe('ai.operations');
    expect(ai[0]!.mutates).toBeUndefined();
    expect(ai[0]!.nonMutating).toBe(true);
  });
});

/* ================================================================== *
 * The whitelist
 * ================================================================== */

describe('AI isolation · the copilot tool whitelist', () => {
  it('the registry is §8.1s five tools plus the two forecast reads §8.2.4 requires', () => {
    expect(COPILOT_TOOLS.map((t) => t.name)).toEqual([
      'getKpis', 'getPropertyPerformance', 'getExpenseBreakdown', 'getPlatformMix',
      'getAlerts', 'getForecast', 'getCashFlowForecast',
    ]);
  });

  it('every tool inherits the capability of the endpoint it projects', () => {
    // One definition. A tool cannot become more permissive than the screen it mirrors,
    // and re-guarding a route in this file would create a second answer to drift from.
    for (const tool of COPILOT_TOOLS) {
      const route = findRoute('GET', tool.route);
      expect(route, tool.route).toBeDefined();
      expect(capabilityForTool(tool)).toBe(route!.capability);
    }
  });

  it('a tool naming a route that does not exist fails loudly rather than open', () => {
    expect(() => capabilityForTool({
      name: 'getKpis', route: '/api/nowhere', summary: 'invented',
    })).toThrow(/unregistered route/);
  });

  it('only the whitelisted reads are performed, even for the most privileged role', async () => {
    const { provider, calls } = recording(fixture());
    await buildCopilotContext(provider, await latestFilters(provider), {
      role: 'SUPER_ADMIN', now: FIXED_NOW,
    });
    // getAvailableMonths belongs to the caller resolving the period, not to a tool.
    const reads = new Set(calls.filter((c) => c !== 'getAvailableMonths'));
    expect([...reads].sort()).toEqual(
      ['getDashboard', 'getForecast', 'getOperations', 'getPnl', 'getProperties'],
    );
  });

  it('no raw-record or ledger read is ever performed', async () => {
    const { provider, calls } = recording(fixture());
    await buildCopilotContext(provider, await latestFilters(provider), {
      role: 'SUPER_ADMIN', now: FIXED_NOW,
    });
    const forbidden = [
      'getReservations', 'getRevenue', 'getExpenses', 'getCapex', 'getCashFlow',
      'getInvestorRegister', 'getInvestorPreview', 'refresh',
    ];
    expect(calls.filter((c) => forbidden.includes(c))).toEqual([]);
  });

  it('no AI module names a repository, the Sheets client, a guest source or a raw read', () => {
    // The read path is forbidden AnalyticsRepository by Decision D1 (see
    // tests/live-provider.test.ts); the copilot inherits that, and every other
    // repository with it. §8.1 draws its tools onto repositories — this is the line
    // where that half of the diagram is answered by the rest of the architecture.
    const banned = /Repository\b|@\/lib\/server\/sheets|@\/lib\/server\/demo|guest-journey|GuestSession|readAlerts|getReservations|getRevenue\b|getExpenses\b|getCapex\b|getCashFlow\b|getInvestorRegister/;
    expect(aiSources().filter((s) => banned.test(s.text)).map((s) => s.file)).toEqual([]);
  });

  it('no AI module imports a mutation path', () => {
    const banned = /mutation-services|@\/lib\/server\/mutations|assertWritable|appendRow|updateRow/;
    expect(aiSources().filter((s) => banned.test(s.text)).map((s) => s.file)).toEqual([]);
  });

  it('the assembled context cannot be edited on its way to a model', async () => {
    const context = await contextFor('ADMIN');
    expect(Object.isFrozen(context)).toBe(true);
    expect(() => { (context as { period: string }).period = 'tampered'; }).toThrow(TypeError);
    expect(() => { (context.kpis as unknown as unknown[]).push({}); }).toThrow(TypeError);
  });
});

/* ================================================================== *
 * Raw records and ledgers
 * ================================================================== */

describe('AI isolation · raw records and ledgers cannot be reached', () => {
  it('no reservation-level or guest-level field reaches the context', async () => {
    const keys = allKeys(await contextFor('SUPER_ADMIN'));
    const forbidden = [
      'bookingId', 'guestDisplayName', 'guestName', 'GuestName', 'guest', 'checkIn',
      'checkOut', 'grossValue', 'expectedPayout', 'actualPayout', 'payoutStatus',
      'PlatformResID', 'Adults', 'Children', 'arrivals', 'departures', 'reservations',
    ];
    expect([...keys].filter((k) => forbidden.includes(k))).toEqual([]);
  });

  it('no ledger row reaches the context', async () => {
    const keys = allKeys(await contextFor('SUPER_ADMIN'));
    // A LedgerRow is id + date + gross/deductions/net. None of those columns exists in
    // any projection, so there is no row-level financial detail to summarise.
    expect([...keys].filter((k) => ['gross', 'deductions', 'net', 'txnId', 'runningBalance', 'reconStatus', 'subCategory'].includes(k)))
      .toEqual([]);
  });

  it('no investor identity or capital figure reaches the context', async () => {
    const context = await contextFor('SUPER_ADMIN');
    const keys = allKeys(context);
    expect([...keys].filter((k) => /investor/i.test(k))).toEqual([]);
    expect(JSON.stringify(context)).not.toMatch(/INV-\d/);
  });

  it('expense detail is the contracts own P&L categorisation, not the ledger', async () => {
    const context = await contextFor('ADMIN');
    const allowed = [...Object.keys(PNL_CONTRACT.expenseLines), 'otherOperating'];
    expect(context.expenseBreakdown).not.toBeNull();
    expect(context.expenseBreakdown!.lines.length).toBeGreaterThan(0);
    for (const line of context.expenseBreakdown!.lines) {
      expect(allowed, line.key).toContain(line.key);
    }
  });

  it('the expense breakdown describes the period it says it describes', async () => {
    const context = await contextFor('ADMIN');
    expect(context.expenseBreakdown!.monthKey).toBe(context.period);
    // §8.2's second rule: a financial answer must state its source period. A total that
    // did not match the stated month would make every such citation wrong.
    expect(context.expenseBreakdown!.total).toBeGreaterThan(0);
  });

  it('every figure in context is an aggregate the caller could already read', async () => {
    const context = await contextFor('ADMIN');
    // Each populated section corresponds to a granted tool, and every granted tool
    // corresponds to an endpoint whose capability the role holds.
    const held = capabilitiesFor('ADMIN');
    for (const name of context.tools) {
      const tool = COPILOT_TOOLS.find((t) => t.name === name)!;
      expect(held, name).toContain(capabilityForTool(tool));
    }
  });
});

/* ================================================================== *
 * Guest data (§8.3)
 * ================================================================== */

describe('AI isolation · guest names are stripped from copilot context', () => {
  const demo = () => new DemoGridProvider();

  it('the alerts endpoint keeps its own contract — the guest name is still there', async () => {
    // The alert board is an operations screen for people who are meeting that guest.
    // §8.3 restricts the copilot, not the endpoint, so this must stay true.
    const provider = demo();
    const ops = await provider.getOperations(await latestFilters(provider));
    const named = ops.data.arrivals.map((a) => a.guestDisplayName).filter(Boolean);
    expect(named.length).toBeGreaterThan(0);
    const arrival = ops.data.urgent.find((u) => u.key.startsWith('arr-'));
    expect(arrival, 'the demo board must carry an arrival alert for this test to mean anything')
      .toBeDefined();
    expect(named.some((n) => arrival!.title.includes(n))).toBe(true);
  });

  it('the same alert reaches the copilot with the name removed', async () => {
    const provider = demo();
    const filters = await latestFilters(provider);
    const ops = await provider.getOperations(filters);
    const arrival = ops.data.urgent.find((u) => u.key.startsWith('arr-'))!;
    const context = (await buildCopilotContext(provider, filters, {
      role: 'ADMIN', now: FIXED_NOW,
    })).contents;

    const projected = context.alerts!.find((a) => a.reference === arrival.reference)!;
    expect(projected.summary).toContain('[guest]');
    expect(projected.summary).not.toContain(ops.data.arrivals[0]!.guestDisplayName);
    // Everything else about the alert survives — a redaction that also removed the
    // nights or the unit would leave an assistant unable to answer the question.
    expect(projected.severity).toBe(arrival.severity);
    expect(projected.propertyId).toBe(arrival.propertyId);
    expect(projected.action).toBe(arrival.action);
  });

  it('no guest the board names appears anywhere in the context', async () => {
    const provider = demo();
    const filters = await latestFilters(provider);
    const ops = await provider.getOperations(filters);
    const names = [...ops.data.arrivals, ...ops.data.departures].map((r) => r.guestDisplayName);
    expect(names.length).toBeGreaterThan(0);

    const serialised = JSON.stringify((await buildCopilotContext(provider, filters, {
      role: 'SUPER_ADMIN', now: FIXED_NOW,
    })).contents);
    for (const name of names) expect(serialised, name).not.toContain(name);
  });

  it('no contact detail of any kind reaches the context', async () => {
    // The repository's standing PII probe, applied to both data sources.
    for (const provider of [fixture(), demo()]) {
      const serialised = JSON.stringify((await buildCopilotContext(
        provider, await latestFilters(provider), { role: 'SUPER_ADMIN', now: FIXED_NOW },
      )).contents);
      expect(serialised).not.toMatch(/@|\+91|phone|email/i);
    }
  });

  it('stripGuestNames removes the longest match first', () => {
    // "Priya M." and a bare "Priya" both present: the short one must not fire first and
    // leave a dangling initial that still identifies the guest.
    expect(stripGuestNames('Arrival today — Priya M., 3 nights', ['Priya', 'Priya M.']))
      .toBe('Arrival today — [guest], 3 nights');
  });

  it('stripGuestNames removes every occurrence, and treats names as text not patterns', () => {
    expect(stripGuestNames('A. B. met A. B.', ['A. B.'])).toBe('[guest] met [guest]');
    // A regex metacharacter in a name must match literally, not compile.
    expect(stripGuestNames('R (K.) called', ['R (K.)'])).toBe('[guest] called');
    expect(stripGuestNames('nothing to remove', [])).toBe('nothing to remove');
    expect(stripGuestNames('blank names are ignored', ['', '  '])).toBe('blank names are ignored');
  });
});

/* ================================================================== *
 * Forecasts (§8.2 rule 4)
 * ================================================================== */

describe('AI isolation · forecasts are explained, never generated', () => {
  it('every forecast in context is labelled ESTIMATE and states its method', async () => {
    const context = await contextFor('ADMIN');
    expect(context.forecast!.length).toBe(3);
    for (const estimate of context.forecast!) {
      expect(estimate.label).toBe('ESTIMATE');
      expect(estimate.method.length).toBeGreaterThan(0);
      expect(['SUFFICIENT', 'INSUFFICIENT_DATA']).toContain(estimate.status);
    }
  });

  it('an insufficient forecast arrives as an absence, never as a zero', async () => {
    const context = await contextFor('ADMIN');
    for (const estimate of context.forecast!) {
      if (estimate.status === 'INSUFFICIENT_DATA') {
        expect(estimate.value).toBeNull();
        expect(estimate.reason).not.toBeNull();
      }
    }
  });

  it('the working is withheld, so no figure can be re-derived into a different one', async () => {
    // §9's inputs — trailing ADR, pickup averages, opening balances — stay out. A model
    // handed the terms of a calculation is a model that can perform a different one and
    // present it with the same confidence.
    expect([...allKeys(await contextFor('ADMIN'))]).not.toContain('inputs');
  });

  it('no AI module imports the forecast engine', () => {
    // The deterministic service is the sole producer. The copilot receives the result
    // through the provider, exactly as the screen does, and has no way to run it itself.
    const banned = /analytics\/forecast|forecastOccupancy|forecastRevenue|forecastCashFlow|assessConfidence/;
    expect(aiSources().filter((s) => banned.test(s.text)).map((s) => s.file)).toEqual([]);
  });

  it('no AI module imports a calculation engine of any kind', () => {
    const banned = /analytics\/kpi|analytics\/rent|computeMonthlySeries|computeInvestorWaterfall/;
    expect(aiSources().filter((s) => banned.test(s.text)).map((s) => s.file)).toEqual([]);
  });
});

/* ================================================================== *
 * Alerts
 * ================================================================== */

describe('AI isolation · alerts reach the copilot only as summaries', () => {
  it('the projection carries exactly the five permitted fields', async () => {
    const context = await contextFor('ADMIN', new DemoGridProvider());
    expect(context.alerts!.length).toBeGreaterThan(0);
    for (const alert of context.alerts!) {
      expect(Object.keys(alert).sort())
        .toEqual(['action', 'propertyId', 'reference', 'severity', 'summary']);
    }
  });

  it('it is the operations board, in the same order, and nothing else', async () => {
    const provider = new DemoGridProvider();
    const filters = await latestFilters(provider);
    const ops = await provider.getOperations(filters);
    const context = (await buildCopilotContext(provider, filters, {
      role: 'ADMIN', now: FIXED_NOW,
    })).contents;
    expect(context.alerts!.map((a) => a.reference))
      .toEqual(ops.data.urgent.map((u) => u.reference));
  });

  it('no alert carries an amount, a rate or a margin', async () => {
    const context = await contextFor('ADMIN', new DemoGridProvider());
    for (const alert of context.alerts!) {
      for (const value of Object.values(alert)) expect(typeof value).toBe('string');
    }
  });
});

/* ================================================================== *
 * RBAC
 * ================================================================== */

describe('AI isolation · existing capability boundaries still decide', () => {
  it('a role with no copilot capability gets no context at all', async () => {
    const provider = fixture();
    await expect(buildCopilotContext(provider, await latestFilters(provider), {
      role: 'INVESTOR', now: FIXED_NOW,
    })).rejects.toBeInstanceOf(CopilotNotPermittedError);
  });

  it('INVESTOR holds neither copilot capability', () => {
    const held = capabilitiesFor('INVESTOR');
    expect(COPILOT_CAPABILITIES.filter((c) => held.includes(c))).toEqual([]);
  });

  it('OPERATIONS gets the ops-scoped copilot §7 describes, and nothing financial', async () => {
    const context = await contextFor('OPERATIONS');
    expect(context.tools).toEqual(['getAlerts']);
    expect(context.kpis).toBeNull();
    expect(context.propertyPerformance).toBeNull();
    expect(context.expenseBreakdown).toBeNull();
    expect(context.platformMix).toBeNull();
    expect(context.forecast).toBeNull();
    expect(context.alerts).not.toBeNull();
  });

  it('an omitted tool is named with the capability that would grant it', async () => {
    const context = await contextFor('OPERATIONS');
    expect(context.omitted.map((o) => o.tool).sort()).toEqual([
      'getCashFlowForecast', 'getExpenseBreakdown', 'getForecast', 'getKpis',
      'getPlatformMix', 'getPropertyPerformance',
    ]);
    // §8.2's third rule again: the assistant must be able to say "you are not entitled
    // to that" rather than producing a plausible answer without the data.
    for (const omission of context.omitted) {
      expect(capabilitiesFor('OPERATIONS')).not.toContain(omission.capability);
      expect(omission.message).toContain(omission.capability);
    }
  });

  it('ADMIN and SUPER_ADMIN reach every tool', async () => {
    for (const role of ['ADMIN', 'SUPER_ADMIN'] as const) {
      const context = await contextFor(role);
      expect(context.tools.length).toBe(COPILOT_TOOLS.length);
      expect(context.omitted).toEqual([]);
    }
  });

  it('for every role, a granted tool is one the role could already have read', async () => {
    for (const role of ROLES) {
      const held = capabilitiesFor(role);
      if (!COPILOT_CAPABILITIES.some((c) => held.includes(c))) continue;
      const granted = (await contextFor(role)).tools as readonly CopilotToolName[];
      for (const name of granted) {
        const tool = COPILOT_TOOLS.find((t) => t.name === name)!;
        expect(held, `${role} → ${name}`).toContain(capabilityForTool(tool));
      }
    }
  });

  it('the context states its period and source, so an answer can cite them', async () => {
    const context = await contextFor('ADMIN');
    expect(context.period).toMatch(/^\d{4}-\d{2}$/);
    expect(['FIXTURE', 'GOOGLE_SHEETS']).toContain(context.source);
    expect(context.asOf).toBe(FIXED_NOW.toISOString());
  });
});

/* ================================================================== *
 * The guest assistant — not built, and not startable in silence
 * ================================================================== */

describe('AI isolation · the guest assistant does not exist yet', () => {
  const WHEN_IT_LANDS =
    'The guest assistant is a separate service with its own tool registry and repository '
    + 'facade (§8.1). When it lands, this test must be replaced by the assertions §8.1 '
    + 'requires of it: every guest tool returns only whitelisted fields, and no financial '
    + 'repository is reachable from the guest tool registry.';

  it('no guest tool registry has appeared without its whitelist tests', () => {
    const guestModules = aiSources()
      .filter((s) => /guest/i.test(s.file) || /GUEST_TOOLS|guestToolRegistry/.test(s.text))
      .map((s) => s.file);
    expect(guestModules, WHEN_IT_LANDS).toEqual([]);
  });

  it('no guest AI route has been declared', () => {
    expect(API_ROUTES.filter((r) => r.path.includes('/ai/guest')), WHEN_IT_LANDS).toEqual([]);
  });
});

/* ================================================================== *
 * Still off
 * ================================================================== */

describe('AI isolation · report', () => {
  it('AI is still disabled after everything above, and the matrix is written', () => {
    expect(aiEnabled()).toBe(false);

    const dir = path.resolve(ROOT, 'reports');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'ai-isolation.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      aiEnabled: aiEnabled(),
      aiRoutesDeclared: API_ROUTES.filter((r) => r.path.startsWith('/api/ai')).length,
      copilotTools: COPILOT_TOOLS.map((t) => ({
        tool: t.name, projects: t.route, capability: capabilityForTool(t),
      })),
      rolesWithCopilotAccess: ROLES.filter((role) =>
        COPILOT_CAPABILITIES.some((c) => capabilitiesFor(role).includes(c))),
      guestAssistant: 'NOT IMPLEMENTED',
    }, null, 2));
  });
});
