/**
 * ENVIRONMENT — the vocabulary, shared by server and client.
 *
 * Types and labels only. The *resolution* lives in `lib/server/environment/config.ts` and
 * reads server-side configuration exclusively, because a browser must never be able to
 * choose which environment it is talking to. The client receives the resolved answer as a
 * prop and renders it; it never computes it.
 *
 * Two environments, and the boundary between them is enforced by the variable names
 * themselves: DEMO reads only `DEMO_*`, PRODUCTION reads only `PRODUCTION_*`. Neither can
 * reach the other's credentials, so the isolation is a property of the configuration
 * shape rather than of anyone remembering to be careful.
 */

export const APP_ENVIRONMENTS = ['demo', 'production'] as const;
export type AppEnv = (typeof APP_ENVIRONMENTS)[number];

export function isAppEnv(value: unknown): value is AppEnv {
  return typeof value === 'string' && (APP_ENVIRONMENTS as readonly string[]).includes(value);
}

/**
 * What the UI says about where it is.
 *
 * `banner` is non-null ONLY for demo. Production must never display a demo badge, and the
 * way that is guaranteed is that production has no banner text to display.
 */
export interface EnvironmentDescriptor {
  env: AppEnv;
  /** Short label for the status strip: 'DEMO' / 'PRODUCTION'. */
  name: string;
  /** Prominent badge text, or null in production. */
  banner: string | null;
  /** What the numbers are read from, in words an operator recognises. */
  dataSourceLabel: string;
  /** Whether demo-only controls (scenario switching, reset) may be offered. */
  demoControls: boolean;
}

export const ENVIRONMENT_DESCRIPTORS: Record<AppEnv, EnvironmentDescriptor> = {
  demo: {
    env: 'demo',
    name: 'DEMO',
    banner: 'DEMO / UAT',
    dataSourceLabel: 'Demo Workbook',
    demoControls: true,
  },
  production: {
    env: 'production',
    name: 'PRODUCTION',
    banner: null,
    dataSourceLabel: 'MAKAM Operations Workbook',
    demoControls: false,
  },
};

export function describeEnvironment(env: AppEnv): EnvironmentDescriptor {
  return ENVIRONMENT_DESCRIPTORS[env];
}


/**
 * The environment facts that are safe to send to a browser.
 *
 * Deliberately narrow: no credential, no variable value, no spreadsheet id, no project
 * URL. Everything here is something the interface has to state out loud anyway.
 */
export interface PublicEnvironmentInfo {
  env: AppEnv;
  name: string;
  banner: string | null;
  dataSourceLabel: string;
  demoControls: boolean;
  /** Whether this deployment is serving generated fixtures rather than a workbook. */
  fixtures: boolean;
}

/* ------------------------------------------------------------------ *
 * Demo scenarios
 * ------------------------------------------------------------------ */

export const DEMO_SCENARIOS = [
  'NORMAL_DAY',
  'HIGH_OCCUPANCY',
  'OPERATIONS_ISSUE',
  'FINANCIAL_REVIEW',
  'INVESTOR_REVIEW',
  'GUEST_SUPPORT',
] as const;
export type DemoScenario = (typeof DEMO_SCENARIOS)[number];

export const DEFAULT_DEMO_SCENARIO: DemoScenario = 'NORMAL_DAY';

export function isDemoScenario(value: unknown): value is DemoScenario {
  return typeof value === 'string' && (DEMO_SCENARIOS as readonly string[]).includes(value);
}

export interface DemoScenarioDescriptor {
  key: DemoScenario;
  title: string;
  /** What a viewer should look at while this scenario is active. */
  summary: string;
}

export const DEMO_SCENARIO_DESCRIPTORS: Record<DemoScenario, DemoScenarioDescriptor> = {
  NORMAL_DAY: {
    key: 'NORMAL_DAY',
    title: 'Normal day',
    summary: 'Typical mid-month trading: mixed occupancy, a routine turnover, nothing urgent.',
  },
  HIGH_OCCUPANCY: {
    key: 'HIGH_OCCUPANCY',
    title: 'High occupancy',
    summary: 'All four units occupied, with staggered departures over the next few days.',
  },
  OPERATIONS_ISSUE: {
    key: 'OPERATIONS_ISSUE',
    title: 'Operations issue',
    summary: 'A critical maintenance ticket, a failed housekeeping inspection and low stock.',
  },
  FINANCIAL_REVIEW: {
    key: 'FINANCIAL_REVIEW',
    title: 'Financial review',
    summary: 'Month to date with last month’s expense spike still in the P&L, plus cash flow and unpaid bills.',
  },
  INVESTOR_REVIEW: {
    key: 'INVESTOR_REVIEW',
    title: 'Investor review',
    summary: 'Distribution period with illustrative commercial rules applied — demo only.',
  },
  GUEST_SUPPORT: {
    key: 'GUEST_SUPPORT',
    title: 'Guest support',
    summary: 'Open guest requests, an arrival today and a departure today.',
  },
};
