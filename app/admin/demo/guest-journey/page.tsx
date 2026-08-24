/**
 * DEMO GUEST JOURNEY.
 *
 * Five scripted steps ending in a real record: the guest raises a request, and it appears
 * in the operations queue on the next screen. That last step is the point — it is the same
 * guest-request record the operations board counts, not an illustration of one.
 *
 * Every response shown is a fixed fixture. No AI is configured in this phase and none is
 * called, so the demonstration says the same thing every time it is run.
 */
import { notFound } from 'next/navigation';
import Link from 'next/link';
import { resolveEnvironment } from '@/lib/server/environment/config';
import { checkPageAccess } from '@/lib/server/auth/page-guard';
import { AccessDenied } from '@/components/shell/AccessDenied';
import { buildGuestJourney } from '@/lib/server/demo/guest-journey';
import { currentDataset } from '@/lib/server/demo/store';
import { PageHeader, Section, Card, CardHeader, CardBody } from '@/components/ui/primitives';

/**
 * Never statically generated. Every page in this tree depends on the signed-in session and,
 * in demo, on mutable server state — prerendering one would bake in a stranger's view of
 * the application at build time.
 */
export const dynamic = 'force-dynamic';

export default async function GuestJourneyPage() {
  const resolved = resolveEnvironment();
  if (!resolved.demoControlsPermitted) notFound();

  // Environment first (above), then capability. A production build has no such page at
  // all; a signed-in operations manager is told plainly that it is not part of their role.
  const access = await checkPageAccess('demo.control', { resolved });
  if (!access.allowed) return <AccessDenied role={access.session.role} />;

  const journey = buildGuestJourney();
  const dataset = currentDataset();
  const alreadyRaised = dataset.ops.guestRequests.some((r) => r.requestId === journey.requestId);

  return (
    <>
      <PageHeader
        title="Guest journey"
        description="A fictional guest checks in, asks a question and raises a request — which then appears in the operations queue."
      />

      <Section>
        <Card>
          <CardHeader
            title={journey.session
              ? `${journey.session.guestDisplayName} · ${journey.session.propertyId}`
              : 'Demo guest session'}
            subtitle={journey.session
              ? `${journey.session.checkIn} → ${journey.session.checkOut} · ${journey.session.status}`
              : 'No in-house guest in the current scenario'}
          />
          <CardBody>
            <ol className="sv-journey">
              {journey.steps.map((step) => (
                <li key={step.key} className="sv-journey__step">
                  <div className="sv-journey__head">
                    <span className="sv-journey__order">{step.order}</span>
                    <span className="sv-journey__actor">{step.actor}</span>
                    <span className="sv-journey__title">{step.title}</span>
                  </div>
                  <p className="sv-journey__detail">{step.detail}</p>
                  {step.response ? (
                    <p className="sv-journey__response">
                      <span className="sv-journey__response-label">Fixed response</span>
                      {step.response}
                    </p>
                  ) : null}
                  {step.watchFor ? (
                    <p className="sv-journey__watch">{step.watchFor}</p>
                  ) : null}
                </li>
              ))}
            </ol>
          </CardBody>
        </Card>
      </Section>

      <Section>
        <Card>
          <CardHeader
            title="Run the journey"
            subtitle="Raises the guest request in the demonstration dataset. Running it twice does not create a duplicate."
          />
          <CardBody>
            {alreadyRaised ? (
              <p className="sv-journey__done">
                Request <strong>{journey.requestId}</strong> is in the queue.{' '}
                <Link href="/admin/operations/today">Open Operations → Today</Link> to see it,
                or reset the demo environment to clear it.
              </p>
            ) : (
              <form method="post" action="/api/demo">
                <input type="hidden" name="action" value="guest-journey" />
                <input type="hidden" name="returnTo" value="/admin/demo/guest-journey" />
                <button type="submit" className="sv-btn sv-btn--primary">
                  Raise the guest request
                </button>
              </form>
            )}
          </CardBody>
        </Card>
      </Section>
    </>
  );
}
