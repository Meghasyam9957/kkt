import '@/lib/server/only';
/**
 * SHARED DEMO STORE — one in-memory workbook per process, read AND written.
 *
 * Phase B2 gave demo writes a grid-backed `InMemorySheetsClient`; reads still came from
 * the generated dataset — two stores, so a demonstrated write never appeared on the
 * dashboard. This module closes that gap: the mutation pipeline and the read provider
 * share THE SAME client instance, so "add an expense → the P&L moves" is real behaviour,
 * not staging.
 *
 * Lifecycle: the instance lives for the process; its CONTENTS are reseeded from the
 * demo dataset whenever the demonstration state changes (scenario switch or reset —
 * keyed by scenario|seededAt). The instance identity never changes, so the API router's
 * repositories, built once, always address current data. Web writes bump
 * `writeLog.length`, which readers use as their cache version.
 *
 * This module is fixtures-demo only. When a real demo workbook is configured the live
 * client takes over on both paths, and none of this is constructed.
 */
import { InMemorySheetsClient } from '@/lib/server/sheets/client';
import { demoStatus } from './store';
import { buildDemoSeed } from './workbook-grids';

let client: InMemorySheetsClient | null = null;
let seedKey: string | null = null;

/** Scenario or reset — the states whose change discards web writes (by design: a demo
 *  reset is a return to the seeded fiction, web-entered rows included). */
function currentSeedKey(): string {
  const status = demoStatus();
  return `${status.scenario}|${status.seededAt}`;
}

export function getSharedDemoClient(): InMemorySheetsClient {
  const key = currentSeedKey();
  if (!client) client = new InMemorySheetsClient();
  if (seedKey !== key) {
    const seed = buildDemoSeed();
    for (const [sheetName, rows] of Object.entries(seed.grids)) {
      client.setSheet(sheetName, rows);
    }
    for (const [name, values] of seed.named) {
      client.setNamedRange(name, values);
    }
    seedKey = key;
  }
  return client;
}

/**
 * Read-provider cache key: reseed identity plus how many writes have landed. Any web
 * write invalidates every derived view — which is correct, because the KPI engine
 * recomputes the whole picture from records.
 */
export function demoStoreVersion(): string {
  const c = getSharedDemoClient();
  return `${seedKey}|w${c.writeLog.length}`;
}

/** Tests only: drop the instance so a fresh test process state can be constructed. */
export function __resetSharedDemoClient(): void {
  client = null;
  seedKey = null;
}
