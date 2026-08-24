/**
 * DEMO DATA AUDIT.
 *
 * Prints what the demonstration dataset actually contains, so "the demo is realistic" can
 * be checked rather than taken on trust. It reads the same dataset the application serves
 * and runs the same KPI engine over it.
 *
 * Read-only: it touches no workbook, no Supabase project and no network.
 *
 *   npm run demo:audit
 */
import { buildDemoDataset, DEMO_ACTIVITY_BY_MONTH, DEMO_QUIET_MONTHS } from '@/lib/data/demo/dataset';
import { computeMonthlySeries, computeByProperty, computeByPlatform, monthPeriod, fyMonthKeysFor } from '@/lib/server/analytics/kpi';
import { isoToSerial } from '@/lib/shared/dates';
import { DEMO_SCENARIOS } from '@/lib/shared/environment';

const money = (v: number) => '₹' + Math.round(v).toLocaleString('en-IN');
const pct = (v: number) => (v * 100).toFixed(1) + '%';
const line = (s: string) => console.log(s);

const dataset = buildDemoDataset('NORMAL_DAY');
const wb = dataset.workbook;
const series = computeMonthlySeries(wb, fyMonthKeysFor(wb));
const trading = series.filter((m) => m.grossRevenue > 0 || m.operatingExpenses > 0);

line('SRIVILLU DEMO DATA AUDIT');
line('marker ' + dataset.marker + ' · presenting ' + dataset.today);
line('');

line('RECORD COUNTS');
const counts = {
  properties: wb.properties.length,
  reservations: wb.reservations.length,
  'revenue lines': wb.revenue.length,
  'expense lines': wb.expenses.length,
  capex: wb.capex.length,
  'cash movements': wb.cashflow.length,
  investors: wb.investors.length,
  distributions: wb.distributions.length,
  housekeeping: dataset.ops.housekeeping.length,
  maintenance: dataset.ops.maintenance.length,
  inventory: dataset.ops.inventory.length,
  'guest requests': dataset.ops.guestRequests.length,
  rent: dataset.registers.rent.length,
  assets: dataset.registers.assets.length,
  compliance: dataset.registers.compliance.length,
};
for (const [k, v] of Object.entries(counts)) line('  ' + k.padEnd(18) + String(v).padStart(5));
line('');

line('THE TRADING YEAR  (' + trading.length + ' of 12 months carry data)');
for (const [i, m] of series.entries()) {
  const empty = m.grossRevenue === 0 && m.operatingExpenses === 0;
  const note = i === DEMO_QUIET_MONTHS.rampUp ? 'ramp-up'
    : i === DEMO_QUIET_MONTHS.dormant ? 'DORMANT'
    : i === DEMO_QUIET_MONTHS.insufficientForForecast ? 'too thin to forecast'
    : i === DEMO_QUIET_MONTHS.notYetTraded ? 'not yet traded'
    : (DEMO_ACTIVITY_BY_MONTH[i] ?? 0) >= 1.05 ? 'peak' : '';
  line('  ' + m.monthKey + '  ' + (empty ? 'EMPTY'.padEnd(46)
    : ('net ' + money(m.netRevenue)).padEnd(18)
      + ('profit ' + money(m.operatingProfit)).padEnd(20)
      + ('occ ' + pct(m.occupancyPct)).padEnd(12)) + note);
}
line('');

line('PER PROPERTY  (busiest month)');
const busiest = [...trading].sort((a, b) => b.netRevenue - a.netRevenue)[0];
if (!busiest) throw new Error('The demo dataset has no trading month — the audit has nothing to report.');
const rows = computeByProperty(wb, monthPeriod(busiest.monthKey));
for (const r of rows) {
  line('  ' + r.propertyId + '  ' + ('net ' + money(r.netRevenue)).padEnd(18)
    + ('profit ' + money(r.profit)).padEnd(20)
    + ('occ ' + pct(r.occupancyPct)).padEnd(12)
    + ('ADR ' + money(r.adr)));
}
const revenues = rows.map((r) => r.netRevenue);
line('  spread best/worst: ' + (Math.max(...revenues) / Math.max(1, Math.min(...revenues))).toFixed(2) + 'x');
line('');

line('BY CHANNEL  (busiest month)');
for (const p of computeByPlatform(wb, monthPeriod(busiest.monthKey))) {
  line('  ' + p.platform.padEnd(14) + ('net ' + money(p.netRevenue)).padEnd(18) + p.bookings + ' bookings');
}
line('');

line('CONDITIONS PRESENT');
const today = isoToSerial(dataset.today);
const expected = (b: (typeof wb.reservations)[number]) => b.RoomRevenue + b.CleaningFee + b.ExtraGuestFee + b.OtherCharges
  - b.Discount - b.Taxes - b.PlatformFee - b.OtherDeductions;
const checks: Array<[string, number]> = [
  ['arrivals today', wb.reservations.filter((b) => b.CheckInDate === today).length],
  ['departures today', wb.reservations.filter((b) => b.CheckOutDate === today).length],
  ['cancellations', wb.reservations.filter((b) => b.BookingStatus === 'Cancelled' || b.BookingStatus === 'No Show').length],
  ['payout mismatches', wb.reservations.filter((b) => b.ActualPayout > 0 && expected(b) - b.ActualPayout > 1000).length],
  ['open maintenance', dataset.ops.maintenance.filter((t) => !['Resolved', 'Closed'].includes(t.status)).length],
  ['outstanding turnovers', dataset.ops.housekeeping.filter((t) => t.status !== 'Completed').length],
  ['low stock lines', dataset.ops.inventory.filter((i) => i.currentStock <= i.minStock).length],
  ['open guest requests', dataset.ops.guestRequests.filter((r) => r.status !== 'Resolved').length],
  ['unpaid bills', wb.expenses.filter((e) => e.PaymentStatus !== 'Paid').length],
  ['distributions paid', wb.distributions.length],
  ['months with a loss', trading.filter((m) => m.operatingProfit < 0).length],
  ['empty months', series.length - trading.length],
];
for (const [name, n] of checks) {
  line('  ' + (n > 0 ? 'OK  ' : 'NONE') + '  ' + name.padEnd(24) + n);
}
line('');

line('SCENARIOS');
for (const s of DEMO_SCENARIOS) {
  const d = buildDemoDataset(s);
  const occupied = new Set(d.workbook.reservations
    .filter((b) => b.CheckInDate !== null && b.CheckOutDate !== null)
    .filter((b) => b.BookingStatus === 'Checked In' || b.BookingStatus === 'Checked Out')
    .filter((b) => b.CheckInDate! <= isoToSerial(d.today) && isoToSerial(d.today) < b.CheckOutDate!)
    .map((b) => b.PropertyID)).size;
  line('  ' + s.padEnd(18) + d.today
    + '  occupied ' + occupied + '/4'
    + '  tickets ' + d.ops.maintenance.filter((t) => !['Resolved', 'Closed'].includes(t.status)).length
    + '  requests ' + d.ops.guestRequests.filter((r) => r.status !== 'Resolved').length);
}
line('');

line('INVESTORS');
for (const i of wb.investors) {
  const paid = wb.distributions.filter((d) => d.InvestorID === i.InvestorID)
    .reduce((t, d) => t + d.PaidAmount, 0);
  line('  ' + i.InvestorID + '  ' + i.InvestorName.padEnd(28)
    + ('capital ' + money(i.InvestmentAmount)).padEnd(22)
    + ('share ' + pct(i.ParticipationPct)).padEnd(14)
    + 'paid ' + money(paid));
}
