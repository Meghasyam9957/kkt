/**
 * DEMONSTRATION CONTROLS.
 *
 * Two controls, both demo-only and both management-only. The page itself refuses to render
 * outside demo — the navigation entry is absent in production, and so is the route.
 *
 * The reset is the one destructive-looking control in the product. It is safe because what
 * it destroys is generated: the dataset is rebuilt from seed, so "reset" genuinely returns
 * to a known state rather than approximating one. There is no production equivalent and
 * there will not be one.
 */
import { notFound } from 'next/navigation';
import { resolveEnvironment } from '@/lib/server/environment/config';
import { checkPageAccess } from '@/lib/server/auth/page-guard';
import { AccessDenied } from '@/components/shell/AccessDenied';
import { isLiveDataEnabled } from '@/lib/data/providers';
import { seedSnapshotStatus } from '@/lib/server/demo/live-reset';
import { demoStatus, resetAvailable } from '@/lib/server/demo/store';
import { DEMO_SCENARIOS, DEMO_SCENARIO_DESCRIPTORS } from '@/lib/shared/environment';
import { DEMO_ACTIVITY_BY_MONTH, DEMO_QUIET_MONTHS } from '@/lib/data/demo/dataset';
import { PageHeader, Section, Card, CardHeader, CardBody } from '@/components/ui/primitives';
import { ConfirmedAction } from '@/components/demo/ConfirmedAction';

/**
 * Never statically generated. Every page in this tree depends on the signed-in session and,
 * in demo, on mutable server state — prerendering one would bake in a stranger's view of
 * the application at build time.
 */
export const dynamic = 'force-dynamic';

export default async function DemoControlsPage() {
  const resolved = resolveEnvironment();
  // Not "hidden in production" — absent. A production build has no such page.
  if (!resolved.demoControlsPermitted) notFound();

  // Environment first (above), then capability. A production build has no such page at
  // all; a signed-in operations manager is told plainly that it is not part of their role.
  const access = await checkPageAccess('demo.control', { resolved });
  if (!access.allowed) return <AccessDenied role={access.session.role} />;

  const status = demoStatus();
  const canReset = resetAvailable();
  // The demo workbook is the data source: scenario switching and the guest journey drive
  // the in-memory dataset, which is not what the screen shows — so they are not offered.
  const live = resolved.sheets !== null && isLiveDataEnabled();
  const snapshot = live ? seedSnapshotStatus() : null;

  return (
    <>
      <PageHeader
        title="Demonstration controls"
        description={live
          ? 'Capture the demo workbook’s seeded state, or restore it. Demo environment only.'
          : 'Switch the scenario being shown, or restore the demonstration dataset to its seeded state. Demo environment only.'}
      />

      {live ? (
        <Section>
          <Card>
            <CardHeader
              title="Live demo workbook"
              subtitle="Reads and writes go to the real demo Google workbook. The reset restores it to the seed snapshot captured below — capture once, immediately after seeding."
            />
            <CardBody>
              {snapshot?.exists ? (
                <p className="sv-demo__meta">
                  Seed snapshot captured {new Date(snapshot.capturedAt).toLocaleString('en-IN')} ·{' '}
                  {snapshot.seededRows} seeded row{snapshot.seededRows === 1 ? '' : 's'} ·{' '}
                  {snapshot.contractMatches
                    ? 'matches this build’s contract.'
                    : 'DOES NOT match this build’s contract — re-capture before any reset.'}
                </p>
              ) : (
                <p className="sv-demo__meta" role="alert">
                  No seed snapshot has been captured yet. Until one exists, the reset has
                  nothing trusted to restore to and will refuse to run.
                </p>
              )}
              <form method="post" action="/api/demo" style={{ marginTop: 'var(--space-3)' }}>
                <input type="hidden" name="action" value="capture-seed" />
                <button type="submit" className="sv-btn sv-btn--secondary">
                  {snapshot?.exists ? 'Re-capture seed snapshot' : 'Capture seed snapshot'}
                </button>
              </form>
              <p className="sv-demo__meta" style={{ marginTop: 'var(--space-3)' }}>
                Capturing records the input cells of every table sheet as the state a reset
                returns to. Re-capture only when the seeded story itself is deliberately
                changed — never mid-demonstration.
              </p>
            </CardBody>
          </Card>
        </Section>
      ) : null}

      {live ? null : (
      <Section>
        <Card>
          <CardHeader
            title="Current scenario"
            subtitle={`${DEMO_SCENARIO_DESCRIPTORS[status.scenario].title} · presenting ${status.today}`}
          />
          <CardBody>
            <p className="sv-demo__summary">{DEMO_SCENARIO_DESCRIPTORS[status.scenario].summary}</p>
            <ul className="sv-demo__highlights">
              {status.highlights.map((highlight) => <li key={highlight}>{highlight}</li>)}
            </ul>
            <p className="sv-demo__meta">
              Dataset seeded {new Date(status.seededAt).toLocaleString('en-IN')} ·{' '}
              {status.mutations} change{status.mutations === 1 ? '' : 's'} since ·{' '}
              marker {status.marker}
            </p>
          </CardBody>
        </Card>
      </Section>
      )}

      {live ? null : (
      <Section>
        <Card>
          <CardHeader
            title="Switch scenario"
            subtitle="Every scenario presents the same day, with different records seeded around it — so the trading year behind it stays intact. Nothing is faked; the engine computes the consequences."
          />
          <CardBody>
            <ul className="sv-demo__scenarios">
              {DEMO_SCENARIOS.map((key) => {
                const descriptor = DEMO_SCENARIO_DESCRIPTORS[key];
                const active = key === status.scenario;
                return (
                  <li key={key}>
                    <form method="post" action="/api/demo">
                      <input type="hidden" name="action" value="scenario" />
                      <input type="hidden" name="scenario" value={key} />
                      <button
                        type="submit"
                        className={`sv-demo__scenario ${active ? 'sv-demo__scenario--active' : ''}`}
                        aria-current={active ? 'true' : undefined}
                      >
                        <span className="sv-demo__scenario-title">{descriptor.title}</span>
                        <span className="sv-demo__scenario-summary">{descriptor.summary}</span>
                        {active ? <span className="sv-demo__scenario-flag">Showing now</span> : null}
                      </button>
                    </form>
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>
      </Section>
      )}

      <Section>
        <Card>
          <CardHeader
            title="Presentation mode"
            subtitle="For demonstrating on a shared screen: hides the reset so it cannot be pressed by accident mid-demonstration."
          />
          <CardBody>
            <div className="sv-presentation">
              <form method="post" action="/api/demo">
                <input type="hidden" name="action" value="presentation" />
                <input type="hidden" name="active" value={status.presentation.active ? 'off' : 'on'} />
                <input type="hidden" name="resetEnabled" value={status.presentation.active ? 'on' : 'off'} />
                <button type="submit" className="sv-btn sv-btn--secondary">
                  {status.presentation.active ? 'Leave presentation mode' : 'Enter presentation mode'}
                </button>
              </form>

              <p className="sv-presentation__state">
                {status.presentation.active ? (
                  <span className="sv-presentation__on">Presentation mode is ON</span>
                ) : (
                  <span className="sv-presentation__off">Presentation mode is off</span>
                )}
                {status.presentation.active
                  ? status.presentation.resetEnabled
                    ? ' — the reset has been explicitly re-enabled.'
                    : ' — the reset is hidden, and refused if requested anyway.'
                  : ' — every demonstration control is available.'}
              </p>

              {status.presentation.active && !status.presentation.resetEnabled ? (
                <form method="post" action="/api/demo">
                  <input type="hidden" name="action" value="presentation" />
                  <input type="hidden" name="active" value="on" />
                  <input type="hidden" name="resetEnabled" value="on" />
                  <button type="submit" className="sv-btn sv-btn--secondary">Re-enable the reset</button>
                </form>
              ) : null}
            </div>
            <p className="sv-demo__meta" style={{ marginTop: 'var(--space-3)' }}>
              This is a convenience for whoever is presenting, not a security control. Role
              permissions and the demo-only environment guard are unchanged and are still
              what actually decides who may do what.
            </p>
          </CardBody>
        </Card>
      </Section>

      <Section>
        <Card>
          <CardHeader
            title="Reset demo environment"
            subtitle={live
              ? 'Restores the demo workbook to its captured seed snapshot, clears demo operation and ID state, and discards anything a demonstration created. Verified by read-back.'
              : 'Restores the seeded dataset, returns the scenario to Normal day, and discards anything a demonstration created.'}
          />
          <CardBody>
            {canReset ? (
              <ConfirmedAction
                action="/api/demo"
                name="action"
                value="reset"
                label="Reset demo environment"
                confirmTitle="Reset the demonstration environment?"
                confirmBody="This resets fictional demonstration data only. No business workbook, no guest record and no investor figure is touched — there is no production equivalent of this control."
                confirmLabel="Yes, reset the demo"
              />
            ) : (
              <p className="sv-demo__meta">
                Hidden while presentation mode is active. Re-enable it above, or leave
                presentation mode.
              </p>
            )}
          </CardBody>
        </Card>
      </Section>

      {live ? null : (
      <Section>
        <Card>
          <CardHeader
            title="What the demo year contains"
            subtitle="Twelve months, deliberately uneven — the empty and insufficient-data states have to be reachable from real records."
          />
          <CardBody>
            <ul className="sv-demo__year">
              {DEMO_ACTIVITY_BY_MONTH.map((activity, index) => (
                <li key={index} className={activity === 0 ? 'sv-demo__month--empty' : ''}>
                  <span className="sv-demo__month-index">M{index + 1}</span>
                  <span className="sv-demo__month-state">
                    {index === DEMO_QUIET_MONTHS.rampUp ? 'Ramp-up'
                      : index === DEMO_QUIET_MONTHS.dormant ? 'Dormant — off-market'
                        : index === DEMO_QUIET_MONTHS.insufficientForForecast ? 'Too thin to forecast'
                          : index === DEMO_QUIET_MONTHS.notYetTraded ? 'Not yet traded'
                            : activity >= 1.05 ? 'Peak' : 'Normal'}
                  </span>
                </li>
              ))}
            </ul>
          </CardBody>
        </Card>
      </Section>
      )}
    </>
  );
}
