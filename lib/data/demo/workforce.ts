import '@/lib/server/only';
/**
 * THE DEMONSTRATION WORKFORCE.
 *
 * The people domain arrived in M-HR-1 with no way to populate it outside a real deployment,
 * so every operational screen built on top of it — the staffing board, the assign control,
 * reconciliation — rendered "nobody is on the books yet" in the one environment anybody
 * actually looks at. Demonstrating an assignment workflow with no one to assign is not a
 * demonstration.
 *
 * DEMO ONLY. Seeded into the in-process HR store, which exists exactly when no Supabase
 * client does. A configured deployment reaches `SupabaseHrRepository` and never touches a
 * line of this file.
 *
 * EVERY NAME HERE IS FICTIONAL, and deliberately so: no contact detail, no email, no salary,
 * no bank field, no identity document. `EmployeeInput` can carry a contact reference and an
 * address; none is supplied, because demonstration data that looks like real personal data
 * is how real personal data eventually ends up in a fixture.
 *
 * The names are chosen to match the cleaner names the demonstration workbook already
 * carries, so the reconciliation screen has something true to say: `Lakshmi` and `Sunita`
 * appear on turnovers and resolve to exactly one person each, which is what makes those rows
 * bindable rather than merely broken.
 */
import type { HrRepository } from '@/lib/server/hr/repository';
import type { TenantContext } from '@/lib/server/tenant/context';

/** A fixed roster: the same people, in the same order, on every run. */
const ROSTER = [
  {
    employeeCode: 'HK-001', fullName: 'Lakshmi Narayanan', preferredName: 'Lakshmi',
    joiningDate: '2024-01-15', primaryPropertyId: 'HYD-501', weeklyOffDay: 2,
  },
  {
    employeeCode: 'HK-002', fullName: 'Sunita Prasad', preferredName: 'Sunita',
    joiningDate: '2024-03-01', primaryPropertyId: 'HYD-501', weeklyOffDay: 3,
  },
  {
    employeeCode: 'HK-003', fullName: 'Meena Iyer', preferredName: 'Meena',
    joiningDate: '2025-06-01', primaryPropertyId: 'HYD-502', weeklyOffDay: 4,
  },
  {
    employeeCode: 'MT-001', fullName: 'Ravi Shankar', preferredName: 'Ravi',
    joiningDate: '2024-02-01', primaryPropertyId: null, weeklyOffDay: 0,
  },
  {
    employeeCode: 'MT-002', fullName: 'Suresh Kumar', preferredName: 'Suresh',
    joiningDate: '2025-01-10', primaryPropertyId: null, weeklyOffDay: 6,
  },
  /*
   * TWO PEOPLE, ONE NAME — the case the whole as-of design exists for.
   *
   * Both answer to "Ramesh" and both are employed today, so a sheet cell reading `Ramesh`
   * resolves to neither: it is AMBIGUOUS, and reconciliation refuses to pick. Their joining
   * dates differ by two years, so a task dated between them resolves to exactly one — which
   * is the behaviour that stops a 2024 turnover being attributed to somebody hired in 2026.
   */
  {
    employeeCode: 'HK-004', fullName: 'Ramesh Babu', preferredName: 'Ramesh',
    joiningDate: '2024-04-01', primaryPropertyId: 'HYD-502', weeklyOffDay: 1,
  },
  {
    employeeCode: 'HK-005', fullName: 'Ramesh Gupta', preferredName: 'Ramesh',
    joiningDate: '2026-04-01', primaryPropertyId: 'HYD-501', weeklyOffDay: 5,
  },
] as const;

/**
 * Seed the roster once.
 *
 * Idempotent by inspection rather than by a flag: if anybody is on the books, this has
 * already run — or a developer has added somebody, and overwriting their work would be
 * worse than doing nothing.
 */
export async function seedDemoWorkforce(
  repo: HrRepository, tenant: TenantContext,
): Promise<void> {
  const existing = await repo.listEmployees(tenant);
  if (existing.length > 0) return;

  for (const person of ROSTER) {
    await repo.createEmployee(tenant, {
      employeeCode: person.employeeCode,
      fullName: person.fullName,
      preferredName: person.preferredName,
      joiningDate: person.joiningDate,
      primaryPropertyId: person.primaryPropertyId,
      weeklyOffDay: person.weeklyOffDay,
      // No contact reference, no email. A staffing board never needs to reach anybody, and
      // a demonstration fixture is the last place to start pretending otherwise.
    }, 'demo-seed');
  }
}
