import { PageHeader, Section, Card, CardHeader, CardBody, Badge, EmptyState } from '@/components/ui/primitives';
import { checkPageAccess } from '@/lib/server/auth/page-guard';
import { AccessDenied } from '@/components/shell/AccessDenied';
import { SrivilluMark } from '@/components/shell/Logo';

export const metadata = { title: 'Srivillu Copilot — Srivillu Home Stays' };

/**
 * Copilot shell. Deliberately inert: no OpenAI call, no key, no fabricated answer.
 * A convincing-looking assistant that invents numbers would be worse than no assistant,
 * so the composer is disabled and says why.
 */
const EXAMPLE_PROMPTS = [
  'What needs attention today?',
  'Which property performed best this month?',
  'Why did revenue change compared with last month?',
  'What are our biggest expenses?',
  'Which channel brings the most profitable bookings?',
  'How many nights are already booked for next month?',
];

export const dynamic = 'force-dynamic';

export default async function CopilotPage() {
  const access = await checkPageAccess('ai.copilot');
  if (!access.allowed) return <AccessDenied role={access.session.role} />;

  return (
    <>
      <PageHeader
        title="Srivillu Copilot"
        description="A management assistant that answers from the operational data — never from memory, and never from invention."
      />
      <Section>
        <div className="sv-copilot">
          <Card>
            <CardHeader
              title="Conversation"
              action={<Badge tone="warn">AI integration coming in Phase 7</Badge>}
            />
            <CardBody className="sv-card__body--flush">
              <div className="sv-copilot__thread">
                <SrivilluMark size={44} />
                <p style={{ fontFamily: 'var(--font-display)', fontSize: '1.25rem', fontWeight: 600 }}>
                  Ask about the business
                </p>
                <p className="sv-muted" style={{ fontSize: '0.875rem', maxWidth: '48ch' }}>
                  When this is connected, every answer will cite the period and the sheet it came
                  from, and any figure it states will have come from a retrieved record rather
                  than the model.
                </p>
                <div className="sv-copilot__prompts">
                  {EXAMPLE_PROMPTS.map((prompt) => (
                    <div key={prompt} className="sv-copilot__prompt">{prompt}</div>
                  ))}
                </div>
              </div>
              <div className="sv-copilot__composer">
                <input
                  className="sv-copilot__input"
                  placeholder="Available in Phase 7"
                  disabled
                  aria-label="Ask the copilot (disabled until Phase 7)"
                />
                <button type="button" className="sv-btn sv-btn--primary" disabled>Send</button>
              </div>
            </CardBody>
          </Card>

          <div>
            <Card>
              <CardHeader title="History" as="h3" />
              <CardBody>
                <EmptyState title="No conversations yet" message="Past conversations will appear here once the copilot is live." />
              </CardBody>
            </Card>
            <div style={{ height: 'var(--space-3)' }} />
            <Card>
              <CardHeader title="Sources" as="h3" />
              <CardBody>
                <p className="sv-muted" style={{ fontSize: '0.8125rem' }}>
                  Answers will be grounded in the revenue, expense, reservation and operations
                  ledgers, retrieved through the same server layer this dashboard uses. Guest
                  personal data is excluded from the assistant&rsquo;s context.
                </p>
              </CardBody>
            </Card>
          </div>
        </div>
      </Section>
    </>
  );
}
