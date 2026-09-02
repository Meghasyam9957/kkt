/**
 * RECONCILIATION — where the workbook and the assignment record disagree.
 *
 * The moment MAKAM echoes a name into the customer's spreadsheet, that cell becomes a
 * mutable copy of a fact held elsewhere. It is their file: they edit it, V1's own menu edits
 * it, and a supervisor typing over a name leaves both halves internally consistent while
 * saying different things. Nothing fails. Nothing looks wrong. This screen is the only place
 * that difference becomes visible.
 *
 * IT RESOLVES NOTHING BY ITSELF, and prefers neither store. It states what each says and
 * what a person could do about it. Deciding which of two records is right about a human being
 * is not a decision an application should make on its own — and the AMBIGUOUS case, where two
 * people answer to one name, is precisely the one where guessing would be confident and wrong.
 *
 * NOT AN AUDIT SCREEN. Four counts and a table of the rows that need a person. A page that
 * listed every matched task would bury the eight that do not.
 */
import { checkPageAccess } from '@/lib/server/auth/page-guard';
import { operationsServiceFor } from '@/lib/server/api/service';
import { reconciliationView } from '@/lib/server/operations/projections';
import { assignmentContextForPage } from '@/lib/server/operations/page-assignment';
import { AccessDenied } from '@/components/shell/AccessDenied';
import {
  PageHeader, Section, Card, CardHeader, CardBody, StatusPill, ErrorState, type Tone,
} from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { AssignTaskButton } from '@/components/operations/AssignTaskButton';
import { formatDateShort } from '@/lib/shared/format';
import { ensureDemoWorkforce } from '@/lib/server/operations/demo-workforce';

export const metadata = { title: 'Reconciliation — MAKAM Home Stays' };

type Row = ReturnType<typeof reconciliationView>['rows'][number];

/** Each status in the words a supervisor would use, and the tone it deserves. */
const STATUS: Record<string, { label: string; tone: Tone; meaning: string }> = {
  MATCHED: { label: 'linked', tone: 'good', meaning: 'The sheet and the record agree.' },
  ECHO_MISMATCH: {
    label: 'sheet edited', tone: 'warn',
    meaning: 'Somebody changed the name in the sheet after this was assigned.',
  },
  ECHO_MISSING: {
    label: 'echo missing', tone: 'warn',
    meaning: 'We hold an assignment, but the sheet cell is empty.',
  },
  UNLINKED: {
    label: 'unlinked', tone: 'neutral',
    meaning: 'A name in the sheet with no assignment behind it. Ordinary for older rows.',
  },
  AMBIGUOUS: {
    label: 'ambiguous', tone: 'warn',
    meaning: 'More than one person answers to this name. Nobody can be bound automatically.',
  },
  HISTORICAL: {
    label: 'historical', tone: 'neutral',
    meaning: 'The only match was not employed on the day this work happened.',
  },
  MISSING_RELATION: {
    label: 'unknown name', tone: 'warn',
    meaning: 'Nobody on the books answers to this name.',
  },
  TASK_NOT_FOUND: {
    label: 'task gone', tone: 'bad',
    meaning: 'We hold an assignment for a task that is no longer in the workbook.',
  },
};

export default async function ReconciliationPage() {
  const access = await checkPageAccess('operations.staff.read');
  if (!access.allowed) return <AccessDenied role={access.session.role} />;

  await ensureDemoWorkforce();

  let report;
  try {
    report = reconciliationView(await operationsServiceFor().reconciliationReport(access.tenant));
  } catch (error) {
    console.error('[operations] reconciliation failed:', error);
    return (
      <>
        <PageHeader title="Reconciliation" description="Names in the workbook, and the people behind them." />
        <Section>
          <ErrorState message="We couldn't compare the workbook with the assignment record just now. Try again in a moment." />
        </Section>
      </>
    );
  }

  const assignment = await assignmentContextForPage('HOUSEKEEPING');
  const maintenanceAssignment = await assignmentContextForPage('MAINTENANCE');

  // Only what needs a person. A list of everything that already agrees is a list nobody reads.
  const needsAttention = report.rows.filter((row) => row.status !== 'MATCHED');

  const columns: Column<Row>[] = [
    {
      key: 'task', header: 'Task',
      render: (r) => (
        <span>
          <code className="numeric">{r.taskRef}</code>
          {r.title ? <span className="sv-muted"> · {r.title}</span> : null}
        </span>
      ),
    },
    { key: 'property', header: 'Property', render: (r) => r.propertyId ?? '—' },
    {
      key: 'when', header: 'Task date',
      render: (r) => formatDateShort(r.occurredOn),
    },
    {
      key: 'sheet', header: 'Workbook says',
      render: (r) => (r.sheetName ? r.sheetName : <span className="sv-muted">nobody</span>),
    },
    {
      key: 'record', header: 'Record says',
      render: (r) => {
        if (r.employee) {
          return (
            <span className="sv-assigned">
              <span className="sv-assigned__name">{r.employee.displayName}</span>
              <span className="sv-muted">{r.employee.employeeCode}</span>
            </span>
          );
        }
        if (r.candidates.length > 0) {
          // Every person the name could mean, named. A screen that showed one of them would
          // be making the choice this whole design refuses to make.
          return (
            <span className="sv-muted">
              {r.candidates.map((c) => `${c.displayName} (${c.employeeCode})`).join(' or ')}
            </span>
          );
        }
        return <span className="sv-muted">nobody</span>;
      },
    },
    {
      key: 'status', header: 'Status',
      render: (r) => {
        const meta = STATUS[r.status] ?? { label: r.status, tone: 'neutral' as Tone, meaning: '' };
        return (
          <span className="sv-assigned">
            <StatusPill tone={meta.tone}>{meta.label}</StatusPill>
          </span>
        );
      },
    },
    {
      key: 'action', header: 'What to do',
      render: (r) => {
        const context = r.taskType === 'MAINTENANCE' ? maintenanceAssignment : assignment;
        /*
         * BIND is offered only where exactly one person, employed on the task's own date,
         * answers to the name — and even then it is the ordinary assignment action, posting
         * to the one endpoint that owns this concept. There is no separate repair route:
         * binding a name IS assigning, with every check that word already carries.
         */
        if (r.recommendation === 'BIND' && context) {
          return (
            <AssignTaskButton
              taskType={r.taskType as 'HOUSEKEEPING' | 'MAINTENANCE'}
              taskRef={r.taskRef}
              context={context}
            />
          );
        }
        const meta = STATUS[r.status];
        return <span className="sv-muted">{meta?.meaning ?? 'Review.'}</span>;
      },
    },
  ];

  return (
    <>
      <PageHeader
        title="Reconciliation"
        description="The workbook holds a name; this holds the person. Where they differ, a human decides."
      />

      <Section>
        <Card>
          <CardHeader title="Across every turnover and ticket" />
          <CardBody>
            <div className="sv-kpi-grid">
              <Count label="Linked" value={report.summary.matched} />
              <Count label="Needs review" value={report.summary.needsReview} tone="warn" />
              <Count label="Unlinked" value={report.summary.unlinked} />
              <Count label="Ambiguous" value={report.summary.ambiguous} tone="warn" />
            </div>
            <p className="sv-kpi__note">
              Compared when this page was opened. Nothing runs on a schedule — see the
              runbook for how this will be scheduled later.
            </p>
          </CardBody>
        </Card>
      </Section>

      <Section>
        <Card>
          <CardHeader
            title="Rows that need a person"
            subtitle="A name is matched against who was employed on the task's own date, never against today's staff."
          />
          <CardBody className="sv-card__body--flush">
            <DataTable
              columns={columns}
              rows={[...needsAttention]}
              caption="Reconciliation exceptions"
              getRowKey={(r) => `${r.taskType}-${r.taskRef}`}
              mobile="stack"
              density="compact"
              emptyTitle="Everything agrees"
              emptyMessage="Every task's name matches the person recorded against it."
            />
          </CardBody>
        </Card>
      </Section>
    </>
  );
}

function Count({ label, value, tone }: { label: string; value: number; tone?: Tone }) {
  return (
    <div className="sv-kpi">
      <span className="sv-kpi__label">{label}</span>
      <span className="sv-kpi__value numeric">{value}</span>
      {tone && value > 0 ? <StatusPill tone={tone}>needs a look</StatusPill> : null}
    </div>
  );
}
