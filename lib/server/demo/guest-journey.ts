import '@/lib/server/only';
/**
 * DEMO GUEST JOURNEY.
 *
 * Five steps, scripted end to end, so a client can watch a guest raise a request and see
 * it arrive in the operations queue on the next screen. The last step is the point of the
 * whole thing: it is the same guest-request record the operations board counts, not a
 * mock-up of one.
 *
 * Answers are **deterministic fixtures**, not generated. No AI is involved in this phase
 * and none is configured — every reply below is a fixed string chosen so the demonstration
 * is repeatable and cannot say something unexpected in front of a client.
 *
 * Demo-only. Every mutating step goes through the demo store, which refuses in production.
 */
import {
  currentDataset, recordDemoGuestRequest,
} from './store';
import { assertDemoOnly, resolveEnvironment, type ResolvedEnvironment } from '@/lib/server/environment/config';
import type { GuestSession } from '@/lib/shared/domain';

export type GuestJourneyActor = 'Guest' | 'Platform' | 'Operations';

export interface GuestJourneyStep {
  key: string;
  order: number;
  actor: GuestJourneyActor;
  title: string;
  /** What happens, in the words a demonstrator would use. */
  detail: string;
  /** The fixed response shown for this step, where one is displayed. */
  response?: string;
  /** What a viewer should notice on screen at this point. */
  watchFor?: string;
}

export interface GuestJourney {
  session: GuestSession | null;
  steps: GuestJourneyStep[];
  /** The request id this journey raises; it appears in the operations queue. */
  requestId: string;
  propertyId: string;
}

export const DEMO_GUEST_REQUEST_ID = 'GR-D-JOURNEY-01';

/**
 * Build the scripted journey for the demo's first guest session.
 *
 * Read-only: it describes the journey. `runGuestJourney` is what actually raises the
 * request, so a demonstrator can show the script before performing it.
 */
export function buildGuestJourney(now: Date = new Date()): GuestJourney {
  const dataset = currentDataset(now);
  const session = dataset.guestSessions[0] ?? null;
  const propertyId = session?.propertyId ?? 'HYD-501';
  const guest = session?.guestDisplayName ?? 'Demo Guest';

  const steps: GuestJourneyStep[] = [
    {
      key: 'check-in',
      order: 1,
      actor: 'Guest',
      title: `${guest} checks in`,
      detail: `Arrival confirmed for ${propertyId}. The booking moves from Confirmed to `
        + 'Checked In, and the unit board shows the unit as occupied.',
      watchFor: 'Dashboard → the unit status board flips this unit to Occupied.',
    },
    {
      key: 'stay-info',
      order: 2,
      actor: 'Guest',
      title: 'Guest views their stay information',
      detail: 'Check-in and check-out dates, the unit, house rules and the Wi-Fi details.',
      response: `${propertyId} · check-out ${session?.checkOut ?? '—'} at 11:00. `
        + 'Wi-Fi: MAKAM-GUEST. House rules: no smoking indoors, quiet hours after 10 PM.',
      watchFor: 'Nothing internal is shown — no rates, no payouts, no other guests.',
    },
    {
      key: 'question',
      order: 3,
      actor: 'Guest',
      title: 'Guest asks a question',
      detail: '"Is late checkout possible on my last day?"',
      // Fixed reply. No model, no generation, nothing that could vary between runs.
      response: 'Late checkout until 2 PM is usually possible when the unit is not turning '
        + 'over the same day. The team will confirm shortly.',
      watchFor: 'The answer is a fixed fixture — AI is not enabled in this phase.',
    },
    {
      key: 'help-request',
      order: 4,
      actor: 'Guest',
      title: 'Guest submits a help request',
      detail: `A request is raised against ${propertyId} and enters the operations queue.`,
      response: `Request ${DEMO_GUEST_REQUEST_ID} received.`,
      watchFor: 'This creates a real record in the demo dataset, not a message on screen.',
    },
    {
      key: 'operations',
      order: 5,
      actor: 'Operations',
      title: 'Operations sees the request',
      detail: 'The request appears in the guest-request count on the operations board and '
        + 'in the Today screen, exactly as a live one would.',
      watchFor: 'Operations → Today: the guest-request counter increases by one.',
    },
  ];

  return { session, steps, requestId: DEMO_GUEST_REQUEST_ID, propertyId };
}

/**
 * Perform the journey: raise the guest request so operations can see it.
 *
 * Idempotent — running it twice does not create two requests, so a demonstration can be
 * repeated without the queue filling up with duplicates.
 */
export function runGuestJourney(
  options: { resolved?: ResolvedEnvironment; now?: Date } = {},
): GuestJourney {
  const resolved = options.resolved ?? resolveEnvironment();
  assertDemoOnly('Run demo guest journey', resolved);

  const now = options.now ?? new Date();
  const journey = buildGuestJourney(now);

  recordDemoGuestRequest({
    requestId: journey.requestId,
    propertyId: journey.propertyId,
    summary: 'Late checkout requested on the final day (demo guest journey)',
  }, { resolved, now });

  return journey;
}
