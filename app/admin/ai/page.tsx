import { PageHeader, Section, Card, CardHeader, CardBody, EmptyState } from '@/components/ui/primitives';
import { checkPageAccess } from '@/lib/server/auth/page-guard';
import { AccessDenied } from '@/components/shell/AccessDenied';
import { CopilotConsole } from '@/components/copilot/CopilotConsole';

export const metadata = { title: 'MAKAM Copilot — MAKAM Home Stays' };

/**
 * Copilot shell.
 *
 * The page is a server component and stays one: it checks access, lays out the shell, and
 * mounts the console. It makes no AI call itself and holds no AI configuration, so nothing
 * about a provider, a model or a credential is ever serialised into the page payload.
 *
 * Everything the console shows comes from `POST /api/ai/copilot` — one server-mediated
 * request, answered by the same guarded router every other read goes through. The browser
 * has no route to a model, and no key exists in this bundle to give it one.
 */
export const dynamic = 'force-dynamic';

export default async function CopilotPage() {
  const access = await checkPageAccess('ai.copilot');
  if (!access.allowed) return <AccessDenied role={access.session.role} />;

  return (
    <>
      <PageHeader
        title="MAKAM Copilot"
        description="A management assistant that answers from the operational data — never from memory, and never from invention."
      />
      <Section>
        <div className="sv-copilot">
          <Card>
            <CardHeader title="Conversation" />
            <CardBody className="sv-card__body--flush">
              <CopilotConsole />
            </CardBody>
          </Card>

          <div>
            <Card>
              <CardHeader title="History" as="h3" />
              <CardBody>
                <EmptyState
                  title="Conversations are not kept"
                  message="Nothing asked here is stored. No conversation log exists in this deployment."
                />
              </CardBody>
            </Card>
            <div style={{ height: 'var(--space-3)' }} />
            <Card>
              <CardHeader title="Sources" as="h3" />
              <CardBody>
                <p className="sv-muted" style={{ fontSize: '0.8125rem' }}>
                  Answers are grounded in the revenue, expense, reservation and operations
                  ledgers, retrieved through the same server layer this dashboard uses. Each
                  answer states the period it describes and which reads produced it. Guest
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
