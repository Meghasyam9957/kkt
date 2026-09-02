import '@/lib/server/only';
/**
 * MAKE SURE THE DEMONSTRATION HAS PEOPLE IN IT — once per process, and only in demo.
 *
 * The operations surfaces all read the roster, so any of them can be the first to need it.
 * Rather than making each remember to seed, they await this: the work happens once, the
 * promise is shared, and a second caller arriving mid-seed waits for the same one instead of
 * starting a duplicate.
 *
 * IT REFUSES TO RUN ANYWHERE REAL. Seeding is attempted only when the environment resolves
 * to demo AND no Supabase client is configured, which is the same condition under which the
 * HR repository is the in-process one. A configured deployment gets a resolved, already-done
 * promise and never touches the roster.
 *
 * A failure here is swallowed on purpose. This is fixture convenience; a demonstration whose
 * staffing board is empty is a poorer demonstration, not a broken product, and taking the
 * Today board down over a seed would be the wrong trade.
 */
import { resolveEnvironment } from '@/lib/server/environment/config';
import { processSlot } from '@/lib/server/runtime/process-state';
import { hrRepositoryForDemoSeed } from '@/lib/server/api/service';
import { seedDemoWorkforce } from '@/lib/data/demo/workforce';
import { DEMO_TENANT_ID } from '@/lib/data/demo/dataset';

const slot = processSlot<Promise<void>>('operations.demoWorkforce');

export function ensureDemoWorkforce(): Promise<void> {
  const existing = slot.read();
  if (existing) return existing;

  const started = (async () => {
    const resolved = resolveEnvironment();
    if (resolved.env !== 'demo' || resolved.supabase) return;
    try {
      await seedDemoWorkforce(hrRepositoryForDemoSeed(), Object.freeze({
        tenantId: DEMO_TENANT_ID, userId: 'demo-seed', role: 'ADMIN' as const,
      }));
    } catch (error) {
      console.error('[operations] demo workforce seed failed:', error);
    }
  })();

  slot.write(started);
  return started;
}
