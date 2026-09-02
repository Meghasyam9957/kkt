import { checkPageAccess } from '@/lib/server/auth/page-guard';
import { operationsServiceFor } from '@/lib/server/api/service';
import { Card, CardHeader, CardBody, StatusPill } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { staffingView } from '@/lib/server/operations/projections';
import { ensureDemoWorkforce } from '@/lib/server/operations/demo-workforce';

/**
 * WHO IS WORKING TODAY — the staffing half of the command desk.
 *
 * Composed alongside `TodayBoard` rather than folded into it, because the two come from
 * different places: the board is the workbook's operational payload, and this is the
 * people domain. Keeping them separate means neither read waits on the other, and the
 * board renders unchanged for anybody without staffing access.
 *
 * NO FINANCIAL OR COMPENSATION FIGURE APPEARS HERE, and cannot: the payload is assembled
 * from `StaffDay`, which carries no pay field, no contact reference and no email. The
 * withholding is structural rather than a filter — see
 * `lib/server/operations/projections.ts`.
 *
 * The distinction this section exists to draw: a day nobody has recorded is NOT an absence.
 * It is a gap, it is counted as one, and it is named as one.
 */
type StaffRow = Awaited<ReturnType<typeof staffingView>>['staff'][number];

export async function TodayStaffing({ property }: { property?: string }) {
  const access = await checkPageAccess('operations.staff.read');
  // Not part of every role, and a board that silently omits the section is clearer than one
  // that explains an absence nobody asked about.
  if (!access.allowed) return null;

  await ensureDemoWorkforce();
  const service = operationsServiceFor();
  const today = new Date().toISOString().slice(0, 10);

  let board;
  try {
    board = staffingView(await service.staffingBoard(access.tenant, today, property));
  } catch {
    // A property this business does not operate, or a store that could not answer. The
    // board above is unaffected, so the honest thing is to say so and render nothing else.
    return (
      <Card>
        <CardHeader title="Today's staff" />
        <CardBody>
          <p className="sv-empty">Staffing could not be read for this selection.</p>
        </CardBody>
      </Card>
    );
  }

  if (board.staff.length === 0) {
    return (
      <Card>
        <CardHeader title="Today's staff" />
        <CardBody>
          <p className="sv-empty">
            {property
              ? 'Nobody is assigned to this property yet.'
              : 'Nobody is on the books yet. People are added under People.'}
          </p>
        </CardBody>
      </Card>
    );
  }

  const gaps = board.coverage.reduce((total, row) => total + row.gaps, 0);

  return (
    <Card>
      <CardHeader
        title="Today's staff"
        subtitle="Approved attendance only. A day nobody has recorded is a gap, not an absence — nobody has said the person is away."
      />
      <CardBody>
        <div className="sv-stack">
          {board.coverage.map((row) => (
            <section key={row.departmentId ?? 'none'}>
              <h3 className="sv-kpi__label">{row.departmentName}</h3>
              <p className="sv-kpi__note">
                {row.scheduled} on the books · {row.present} present
                {row.absent > 0 ? <> · {row.absent} absent</> : null}
                {row.onLeave > 0 ? <> · {row.onLeave} on leave</> : null}
                {row.weeklyOff > 0 ? <> · {row.weeklyOff} on their weekly off</> : null}
                {row.late > 0 ? <> · <StatusPill tone="warn">{row.late} late</StatusPill></> : null}
                {row.gaps > 0
                  ? <> · <StatusPill tone="warn">{row.gaps} not recorded</StatusPill></>
                  : null}
              </p>
            </section>
          ))}

          <DataTable
            caption="Staff working today"
            rows={[...board.staff]}
            getRowKey={(person) => person.employeeId}
            // A register read person-by-person on a phone, not a statement compared across
            // columns — so it stacks rather than scrolls.
            mobile="stack"
            density="compact"
            columns={STAFF_COLUMNS}
            emptyTitle="Nobody on today"
            emptyMessage="No one is on the books for this day."
          />

          {board.unassigned > 0 && !property ? (
            <p className="sv-kpi__note">
              {board.unassigned} {board.unassigned === 1 ? 'person is' : 'people are'} not
              assigned to a property. They are shown here rather than attributed to one.
            </p>
          ) : null}

          {gaps > 0 ? (
            <p className="sv-empty" role="status">
              {gaps} {gaps === 1 ? 'person has' : 'people have'} no attendance recorded for
              today. Recording it is what lets payroll be approved without an override.
            </p>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}

const STAFF_COLUMNS: Column<StaffRow>[] = [
  {
    key: 'who',
    header: 'Who',
    render: (person) => (
      <>
        {person.displayName}
        <span className="sv-kpi__note"> {person.employeeCode}</span>
      </>
    ),
  },
  { key: 'shift', header: 'Shift', render: shiftLabel },
  {
    key: 'today',
    header: 'Today',
    render: (person) => (
      <>
        <StatusPill tone={toneFor(person.status)}>{statusLabel(person.status)}</StatusPill>
        {person.late ? <> <StatusPill tone="warn">late</StatusPill></> : null}
        {person.earlyExit ? <> <StatusPill tone="warn">left early</StatusPill></> : null}
      </>
    ),
  },
  {
    key: 'tasks',
    header: 'Open tasks',
    numeric: true,
    // Nothing open is written in words, not as a bare zero, which reads as missing data.
    render: (person) => (person.openTasks === 0 ? '—' : person.openTasks),
  },
];

/** An overnight shift reads as what it is, not as a negative span. */
function shiftLabel(person: StaffRow): string {
  if (!person.shiftName) return '—';
  if (!person.shiftStart || !person.shiftEnd) return person.shiftName;
  const overnight = person.crossesMidnight ? ' (next day)' : '';
  return `${person.shiftName} · ${person.shiftStart}–${person.shiftEnd}${overnight}`;
}

function statusLabel(status: string): string {
  if (status === 'NOT_RECORDED') return 'not recorded';
  if (status === 'WEEKLY_OFF') return 'weekly off';
  if (status === 'HALF_DAY') return 'half day';
  return status.toLowerCase();
}

function toneFor(status: string): 'good' | 'warn' | 'bad' | 'neutral' {
  if (status === 'PRESENT' || status === 'HALF_DAY') return 'good';
  if (status === 'ABSENT') return 'bad';
  // Not recorded is neither good nor bad — nobody has said anything yet.
  if (status === 'NOT_RECORDED') return 'warn';
  return 'neutral';
}
