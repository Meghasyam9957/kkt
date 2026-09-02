import { checkPageAccess } from '@/lib/server/auth/page-guard';
import { hrServiceFor } from '@/lib/server/api/service';
import { Card, CardHeader, CardBody, StatusPill } from '@/components/ui/primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { formatCurrency, formatDateShort } from '@/lib/shared/format';
import { roleHasCapability } from '@/lib/shared/roles';
import {
  employeeView, workforceView, type EmployeeView,
} from '@/lib/server/hr/projections';

export const metadata = { title: 'People — MAKAM Home Stays' };

/**
 * THE PEOPLE OVERVIEW — headcount, the month's attendance, and where payroll has got to.
 *
 * Role-aware on the SERVER, not in the markup. The compensation figures are built only for
 * a caller who holds `hr.compensation.read`; for anybody else they are not rendered
 * because they were never assembled. A page that receives a salary and then declines to
 * display it has already received the salary.
 *
 * The gap count is shown deliberately, and prominently when it is not zero. Attendance is
 * permitted to be incomplete — a day with no record is not an absence — so a payroll total
 * over a month with gaps rests on an assumption, and the screen says which and how many
 * rather than presenting a confident number.
 */
export default async function PeoplePage({
  searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const access = await checkPageAccess('hr.read');
  if (!access.allowed) {
    return (
      <Card>
        <CardHeader title="People" />
        <CardBody>
          <p className="sv-empty">
            The people register is not part of the {access.session.role.toLowerCase().replace('_', ' ')} role.
            Employees, attendance and payroll are held by the HR roles.
          </p>
        </CardBody>
      </Card>
    );
  }

  const params = await searchParams;
  const requested = typeof params.period === 'string' ? params.period : undefined;
  const period = requested && /^\d{4}-\d{2}-01$/.test(requested)
    ? requested
    : `${new Date().toISOString().slice(0, 7)}-01`;

  const service = hrServiceFor();
  const canSeePay = roleHasCapability(access.session.role, 'hr.compensation.read');
  const [summary, employees] = await Promise.all([
    service.workforceSummary(access.tenant, period),
    service.listEmployees(access.tenant),
  ]);
  const view = workforceView(summary, { includeCompensation: canSeePay });
  const people = employees.map(employeeView);

  return (
    <div className="sv-stack">
      <Card>
        <CardHeader
          title="People"
          subtitle={`Headcount, attendance and payroll for ${monthLabel(period)}. Attendance approved by a person is the only attendance payroll consumes.`}
        />
        <CardBody>
          <dl className="sv-kpi-row">
            <Figure label="On the books" value={String(view.headcount)} note={`${view.onLeave} on leave · ${view.exited} left`} />
            <Figure label="Days worked" value={String(view.presentDays)} note="Approved attendance" />
            <Figure label="Days absent" value={String(view.absentDays)} note={`${view.leaveDays} on leave`} />
            <Figure
              label="Overtime"
              value={`${Math.floor(view.overtimeMinutes / 60)}h ${view.overtimeMinutes % 60}m`}
              note="Approved only"
            />
            {view.payrollNet ? (
              <Figure
                label="Payroll (net)"
                value={formatCurrency(view.payrollNet.minor / 100, true)}
                note={view.payrollStatus ? `Run is ${view.payrollStatus.toLowerCase()}` : 'No run opened'}
              />
            ) : null}
          </dl>

          {view.linesWithGaps > 0 ? (
            <p className="sv-empty" role="status">
              <StatusPill tone="warn">Attendance incomplete</StatusPill>{' '}
              {view.linesWithGaps} payroll {view.linesWithGaps === 1 ? 'line covers' : 'lines cover'} days
              with no attendance recorded at all. A day nobody recorded is not a day somebody
              was absent, so these figures rest on an assumption — approval will refuse until
              the gaps are filled or explicitly acknowledged.
            </p>
          ) : null}
        </CardBody>
      </Card>

      {view.salaryCostByProperty && view.salaryCostByProperty.length > 0 ? (
        <Card>
          <CardHeader
            title="Salary cost by property"
            subtitle="A person's cost sits with their primary property. Somebody working across several has no defined split, so their cost is shown as unattributed rather than assigned to one."
          />
          <CardBody>
            <DataTable
              caption="Salary cost by property"
              rows={[...view.salaryCostByProperty]}
              getRowKey={(row) => row.propertyId}
              columns={[
                {
                  key: 'propertyId',
                  header: 'Property',
                  render: (r) => (r.propertyId === 'UNATTRIBUTED' ? 'Unattributed' : r.propertyId),
                },
                {
                  key: 'cost',
                  header: 'Net cost',
                  numeric: true,
                  render: (r) => formatCurrency(r.cost.minor / 100, true),
                },
              ]}
            />
          </CardBody>
        </Card>
      ) : null}

      <Card>
        <CardHeader title="The team" subtitle="Everyone on the books, including those who have left." />
        <CardBody>
          {people.length === 0 ? (
            <p className="sv-empty">
              Nobody is on the books yet. An employee comes before attendance, and attendance
              before payroll.
            </p>
          ) : (
            <DataTable
              caption="Employees"
              rows={people}
              getRowKey={(row) => row.id}
              columns={employeeColumns}
            />
          )}
        </CardBody>
      </Card>
    </div>
  );
}

function Figure({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="sv-kpi">
      <dt className="sv-kpi__label">{label}</dt>
      <dd className="sv-kpi__value">{value}</dd>
      <p className="sv-kpi__note">{note}</p>
    </div>
  );
}

const employeeColumns: Column<EmployeeView>[] = [
  { key: 'employeeCode', header: 'Code', render: (r) => r.employeeCode },
  { key: 'fullName', header: 'Name', render: (r) => r.preferredName || r.fullName },
  { key: 'employmentType', header: 'Type', render: (r) => r.employmentType.replace('_', ' ').toLowerCase() },
  { key: 'joiningDate', header: 'Joined', render: (r) => formatDateShort(r.joiningDate) },
  {
    key: 'primaryPropertyId',
    header: 'Based at',
    // Null is "not assigned", which is not the same as a property nobody named.
    render: (r) => r.primaryPropertyId ?? 'Not assigned',
  },
  {
    key: 'status',
    header: 'Status',
    render: (r) => (
      <StatusPill tone={toneFor(r.status)}>{r.status.replace('_', ' ').toLowerCase()}</StatusPill>
    ),
  },
];

function toneFor(status: string): 'good' | 'warn' | 'neutral' {
  if (status === 'ACTIVE') return 'good';
  if (status === 'EXITED') return 'neutral';
  return 'warn';
}

function monthLabel(period: string): string {
  return new Date(`${period}T00:00:00.000Z`).toLocaleDateString('en-IN', {
    month: 'long', year: 'numeric', timeZone: 'UTC',
  });
}
