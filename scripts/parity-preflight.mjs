/**
 * LIVE PARITY PREFLIGHT — the nine checks that must hold before comparing anything.
 *
 *   1. required environment variables
 *   2. credentials decode and carry a private key
 *   3. the workbook is reachable
 *   4. the workbook is NOT the production workbook
 *   5. all 22 V1 tabs exist
 *   6. all required named ranges exist
 *   7. the workbook contains fixture/test records
 *   8. all eleven required test scenarios exist
 *   9. CFG_REPORT_MONTH names a month that has data
 *
 * plus the data-hygiene checks the preparation checklist asks for: no real guest,
 * investor or landlord contact data, and no stored production secrets.
 *
 * READ-ONLY. Nothing here writes to the spreadsheet, and the service account only ever
 * needs Viewer.
 *
 * Scenario detection reads the WORKBOOK'S OWN numbers — the 99_CALC monthly block and the
 * raw sheet rows — not the TypeScript engine. That separation is deliberate: the preflight
 * answers "does this workbook contain the condition?", and the suite then answers "do the
 * two engines agree under it?". Using the engine for both would let one bug hide the other.
 */
import fs from 'node:fs';
import path from 'node:path';
import { resolveParityEnv, forbiddenMatches, maskSheetId, ENV_NAMES } from './parity-env.mjs';
import { findContactData, findSecrets, mask, looksFictional, titleLooksLikeCopy } from './parity-scan.mjs';

/* ------------------------------------------------------------------ *
 * The contract, read from disk.
 *
 * Not through an import assertion: Node 20.8 rejects `with { type: 'json' }` and Node 22
 * rejects `assert`. The preflight must never be the thing that fails on the operator's
 * Node version.
 * ------------------------------------------------------------------ */
function loadModel(cwd) {
  return JSON.parse(fs.readFileSync(path.resolve(cwd, 'lib/contract/contract.model.json'), 'utf8'));
}

const colA1 = (index) => {
  let out = '';
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) {
    out = String.fromCharCode(65 + ((n - 1) % 26)) + out;
  }
  return out;
};

/** Line feed, written without an escape so no tooling can mangle it. */
const NEWLINE = String.fromCharCode(10);

const num = (v) => (typeof v === 'number' ? v : Number(v) || 0);
const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/** Spreadsheet serial → "YYYY-MM". Sheets' epoch is 1899-12-30. */
function monthKeyOfSerial(serial) {
  if (!Number.isFinite(serial) || serial <= 0) return '';
  const ms = Math.round(serial) * 86_400_000 + Date.UTC(1899, 11, 30);
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

/** The eleven scenarios, in the order the gate lists them. */
export const REQUIRED_SCENARIOS = [
  'zero revenue period', 'empty month', 'cancellation', 'partial payout',
  'expense spike', 'misfiled CAPEX', 'negative month', 'loss recovery',
  'multiple investors', 'property filtering', 'platform filtering',
];

/** How to produce a scenario the copy is missing. Printed verbatim on failure. */
const SCENARIO_FIX = {
  'zero revenue period': 'Delete every 05_REVENUE row for one month, or seed a month with no trading.',
  'empty month': 'Leave one FY month with no reservations and no expenses at all.',
  'cancellation': 'Set one 04_RESERVATIONS row\'s BookingStatus to "Cancelled" or "No Show".',
  'partial payout': 'On one booking, set ActualPayout below ExpectedPayout by more than CFG_PAYOUT_TOLERANCE.',
  'expense spike': 'Add one large 06_EXPENSES row — above 1.5x the median month — e.g. a structural repair.',
  'misfiled CAPEX': 'Set one 06_EXPENSES row\'s ExpenseType to "CAPEX". The seeder creates this deliberately.',
  'negative month': 'Ensure one month\'s operating expenses exceed its net revenue.',
  'loss recovery': 'Needs a loss month AND the business rules set (runbook step 7). With the rules TBD a carry-forward has nothing to be applied against, so this scenario cannot occur.',
  'multiple investors': 'Add at least two 11_INVESTORS rows with Status = "Active".',
  'property filtering': 'Add at least two 03_PROPERTIES rows.',
  'platform filtering': 'Ensure the report month has revenue on at least two different platforms.',
};

/**
 * Does this workbook contain each of the eleven required conditions?
 *
 * Judged from the WORKBOOK'S OWN figures — the 99_CALC monthly block and the raw sheet
 * rows — never from the TypeScript engine. The preflight asks "is the condition here?";
 * the suite then asks "do the two engines agree under it?". If both used the same engine,
 * a bug in it could hide itself by making a condition look absent.
 *
 * Pure, so every branch is testable without a spreadsheet.
 */
export function detectScenarios({
  monthKeys = [],
  grossRevenue = [], operatingExpenses = [], operatingProfit = [],
  bookingsCount = [], cancelledCount = [], carryForwardApplied = [],
  bookings = [], expenses = [],
  activeInvestors = 0, propertyCount = 0, platformsInReportMonth = [],
  payoutTolerance = 0, reportMonth = '',
} = {}) {
  const at = (i) => monthKeys[i] ?? '';
  const round = (v) => Math.round(v).toLocaleString('en-IN');

  const active = operatingExpenses.filter((v) => v > 0).slice().sort((a, b) => a - b);
  const median = active.length ? active[Math.floor(active.length / 2)] : 0;

  const zeroRevenue = grossRevenue.findIndex((v) => v === 0);
  const empty = monthKeys.findIndex((_, i) => bookingsCount[i] === 0 && operatingExpenses[i] === 0);
  const cancelled = cancelledCount.findIndex((v) => v > 0);
  const spike = operatingExpenses.findIndex((v) => median > 0 && v > median * 1.5);
  const negative = operatingProfit.findIndex((v) => v < 0);
  // Month 0 has nothing before it to carry forward FROM, so a value there is not recovery.
  const recovery = carryForwardApplied.findIndex((v, i) => i > 0 && v !== 0);

  const shortPaid = bookings.find(
    (b) => b.actualPayout > 0 && b.expectedPayout - b.actualPayout > payoutTolerance);
  const misfiled = expenses.filter((e) => e.type === 'CAPEX');

  return {
    'zero revenue period': {
      present: zeroRevenue >= 0,
      where: zeroRevenue >= 0 ? at(zeroRevenue) : '',
    },
    'empty month': {
      present: empty >= 0,
      where: empty >= 0 ? at(empty) : '',
    },
    'cancellation': {
      present: cancelled >= 0,
      where: cancelled >= 0 ? `${at(cancelled)}, ${cancelledCount[cancelled]} cancelled` : '',
    },
    'partial payout': {
      present: Boolean(shortPaid),
      where: shortPaid
        ? `${shortPaid.id}: expected ${round(shortPaid.expectedPayout)}, actual ${round(shortPaid.actualPayout)}`
        : '',
    },
    'expense spike': {
      present: spike >= 0,
      where: spike >= 0 ? `${at(spike)}: ${round(operatingExpenses[spike])} vs median ${round(median)}` : '',
    },
    'misfiled CAPEX': {
      present: misfiled.length > 0,
      where: misfiled.length ? `${misfiled.length} row(s), e.g. ${misfiled[0].id}` : '',
    },
    'negative month': {
      present: negative >= 0,
      where: negative >= 0 ? `${at(negative)}: ${round(operatingProfit[negative])}` : '',
    },
    'loss recovery': {
      present: recovery >= 0,
      where: recovery >= 0 ? `${at(recovery)}: ${round(carryForwardApplied[recovery])} applied` : '',
    },
    'multiple investors': {
      present: activeInvestors >= 2,
      where: `${activeInvestors} active`,
    },
    'property filtering': {
      present: propertyCount > 1,
      where: `${propertyCount} propert${propertyCount === 1 ? 'y' : 'ies'}`,
    },
    'platform filtering': {
      present: platformsInReportMonth.length > 1,
      where: `${platformsInReportMonth.length} platform(s) with revenue in ${reportMonth || 'the report month'}`,
    },
  };
}

/* ================================================================== *
 * Check recording
 * ================================================================== */
class Checks {
  constructor() { this.items = []; }
  /** A check that must hold. */
  add(name, ok, detail, fix) { this.items.push({ name, ok, detail, fix }); return ok; }
  /** A check that reports but does not block — the call belongs to the operator. */
  warn(name, ok, detail) { this.items.push({ name, ok, detail, advisory: true }); return ok; }
  /** Context, not a verdict. */
  note(name, detail) { this.items.push({ name, detail, informational: true }); }
  get failed() { return this.items.filter((c) => !c.ok && !c.advisory && !c.informational); }
}

export function printChecks(checks, log = console.log) {
  for (const c of checks) {
    const badge = c.informational ? '··  ' : c.ok ? 'OK  ' : c.advisory ? 'WARN' : 'FAIL';
    log(`  ${badge}  ${c.name}${c.detail ? `  — ${c.detail}` : ''}`);
  }
}

/* ================================================================== *
 * The preflight
 * ================================================================== */

/**
 * @returns {Promise<{status:'READY'|'NOT CONFIGURED'|'NOT READY', checks:Array, context:Object}>}
 */
export async function runPreflight({ env = process.env, cwd = process.cwd(), log = console.log } = {}) {
  const checks = new Checks();
  const resolved = resolveParityEnv(env, { cwd });

  /* ---- 1 & 2. Environment and credentials ------------------------------ */
  checks.add(`workbook id is set (${ENV_NAMES.sheetId[0]})`, Boolean(resolved.sheetId),
    resolved.sheetId ? `${maskSheetId(resolved.sheetId)} from ${resolved.sheetIdFrom}` : 'not set');
  checks.add('service-account credential is set and valid', Boolean(resolved.credentials),
    resolved.credentials ? `${resolved.clientEmail} — via ${resolved.credentialFrom}`
      : (resolved.problems[0] ?? 'not set'));

  for (const note of resolved.notes) checks.note('note', note);

  if (!resolved.configured) {
    return {
      status: resolved.problems.length ? 'NOT READY' : 'NOT CONFIGURED',
      checks: checks.items,
      context: { missing: resolved.missing, problems: resolved.problems },
    };
  }

  /* ---- 4a. Refuse a known environment workbook, before connecting ------- */
  const forbidden = forbiddenMatches(resolved.sheetId, env);
  checks.add('workbook is not a configured environment workbook', forbidden.length === 0,
    forbidden.length
      ? `REFUSING — this id is also ${forbidden.join(' and ')}`
      : `checked against ${ENV_NAMES.forbiddenSheetIds.join(', ')}`,
    'Point PARITY_SHEET_ID at a COPY of the workbook (File ▸ Make a copy), never at a live environment workbook.');
  if (forbidden.length) {
    return { status: 'NOT READY', checks: checks.items, context: {} };
  }

  /* ---- 3. Reachability -------------------------------------------------- */
  const { google } = await import('googleapis');

  let meta;
  let sheets;
  try {
    const auth = new google.auth.GoogleAuth({
      credentials: resolved.credentials,
      // Read-only at Google's end as well as ours. A write cannot be attempted, let alone
      // succeed, even if some future code path tried.
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    sheets = google.sheets({ version: 'v4', auth: await auth.getClient() });
    meta = await sheets.spreadsheets.get({ spreadsheetId: resolved.sheetId, includeGridData: false });
    checks.add('workbook is reachable', true, meta.data.properties?.title ?? '(untitled)');
  } catch (error) {
    const { summary, fix } = explainConnectionError(error, resolved);
    checks.add('workbook is reachable', false, summary, fix);
    return { status: 'NOT READY', checks: checks.items, context: {} };
  }

  const title = meta.data.properties?.title ?? '';
  const timeZone = meta.data.properties?.timeZone ?? '';
  checks.note('workbook timezone', timeZone || 'unknown');

  /* ---- 4b. Does it identify itself as a copy? --------------------------- */
  const overridden = str(env[ENV_NAMES.titleOverride]).toLowerCase() === 'yes';
  const looksLikeCopy = titleLooksLikeCopy(title);
  if (overridden && !looksLikeCopy) {
    checks.warn('title identifies this as a parity copy', false,
      `"${title}" — OVERRIDDEN by ${ENV_NAMES.titleOverride}=yes. Recorded in the report.`);
  } else {
    checks.add('title identifies this as a parity copy', looksLikeCopy, `"${title}"`,
      'Rename the copy so its title contains PARITY, COPY, TEST or SANDBOX — e.g.\n'
      + '      "MAKAM Ops — PARITY COPY (do not use for business)".\n'
      + `      If the title genuinely cannot be changed, set ${ENV_NAMES.titleOverride}=yes\n`
      + '      and the override will be recorded in the parity report.');
  }

  /* ---- 5. All 22 tabs --------------------------------------------------- */
  const MODEL = loadModel(cwd);
  const SHEETS = Object.fromEntries(Object.entries(MODEL.sheets).map(([k, v]) => [k, v.name]));
  const CALC = MODEL.calc;
  const COLUMNS = MODEL.columns;
  const DATA_ROW = MODEL.dataRow;

  const presentTabs = new Set((meta.data.sheets ?? []).map((s) => s.properties?.title));
  const expectedTabs = Object.values(SHEETS);
  const missingTabs = expectedTabs.filter((t) => !presentTabs.has(t));
  checks.add(`all ${expectedTabs.length} V1 tabs exist`, missingTabs.length === 0,
    missingTabs.length ? `missing: ${missingTabs.join(', ')}` : 'from the generated contract',
    'Re-run setupWorkbook in the copy: Extensions ▸ Apps Script ▸ run setupWorkbook, then reload.');

  /* ---- 6. Named ranges -------------------------------------------------- */
  const presentNames = new Set((meta.data.namedRanges ?? []).map((r) => r.name));
  const missingNames = MODEL.requiredNamedRanges.filter((n) => !presentNames.has(n));
  checks.add(`all ${MODEL.requiredNamedRanges.length} named ranges exist`, missingNames.length === 0,
    missingNames.length ? `missing: ${missingNames.slice(0, 6).join(', ')}${missingNames.length > 6 ? '…' : ''}` : '',
    'A missing name reads as EMPTY rather than as an error, which would silently turn a\n'
    + '      configured business rule into "not configured". Re-run setupWorkbook in the copy.');

  if (missingTabs.length) {
    return { status: 'NOT READY', checks: checks.items, context: { title, timeZone } };
  }

  /* ---- Read everything the remaining checks need, in one call ----------- */
  const sheetRange = (key) => {
    const cols = COLUMNS[key] ?? [];
    // 02_SETTINGS is a labelled key/value page, not a table: it has no column registry,
    // and an A1 range with no end column is rejected by the API.
    if (cols.length === 0) return `'${SHEETS[key]}'`;
    return `'${SHEETS[key]}'!A${DATA_ROW}:${colA1(cols.length)}${MODEL.sheets[key]?.lastDataRow ?? ''}`;
  };
  const idx = (key, column) => (COLUMNS[key] ?? []).findIndex((c) => c.key === column);
  const cell = (key, row, column) => row[idx(key, column)];

  const monthlyFirstRow = Math.min(...Object.values(CALC.monthlyRows));
  const monthlyLastRow = Math.max(...Object.values(CALC.monthlyRows));
  const RM = CALC.reportMonthDependent;

  const ranges = [
    `'${CALC.sheet}'!A${monthlyFirstRow}:${CALC.totalColA1}${monthlyLastRow}`,
    `'${CALC.sheet}'!${RM.kpiValueColA1}${RM.kpiRows.ReportMonthStart}`,
    'CFG_FY_START', 'CFG_INVESTOR_POOL_PCT', 'CFG_PAYOUT_TOLERANCE',
    sheetRange('PROPERTIES'), sheetRange('RESERVATIONS'), sheetRange('REVENUE'),
    sheetRange('EXPENSES'), sheetRange('INVESTORS'), sheetRange('RENT'), sheetRange('SETTINGS'),
  ];
  const probe = await sheets.spreadsheets.values.batchGet({
    spreadsheetId: resolved.sheetId, ranges, valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const values = (probe.data.valueRanges ?? []).map((r) => r?.values ?? []);
  const [monthlyGrid, reportMonthCell, fyStart, poolPct, payoutTolerance,
    properties, reservations, revenue, expenses, investors, rent, settings] = values;

  /** A 99_CALC monthly row as 12 numbers. */
  const monthly = (metric) => {
    const row = monthlyGrid[CALC.monthlyRows[metric] - monthlyFirstRow] ?? [];
    return Array.from({ length: CALC.months }, (_, i) => num(row[CALC.firstMonthCol - 1 + i]));
  };
  const monthKeys = monthly('MonthStart').map(monthKeyOfSerial);

  /* ---- 7. Fixture records ----------------------------------------------- */
  const rowsWithId = (key, idColumn) =>
    (key === 'PROPERTIES' ? properties : key === 'RESERVATIONS' ? reservations
      : key === 'REVENUE' ? revenue : key === 'EXPENSES' ? expenses
        : key === 'INVESTORS' ? investors : rent)
      .filter((r) => str(cell(key, r, idColumn)) !== '');

  const propertyRows = rowsWithId('PROPERTIES', 'PropertyID');
  const bookingRows = rowsWithId('RESERVATIONS', 'BookingID');
  const revenueRows = rowsWithId('REVENUE', 'RevenueID');
  const expenseRows = rowsWithId('EXPENSES', 'ExpenseID');
  const investorRows = rowsWithId('INVESTORS', 'InvestorID');

  const netRevenue = monthly('NetRevenue');
  const monthsWithRevenue = netRevenue.filter((v) => v !== 0).length;
  const hasData = monthsWithRevenue > 0 && bookingRows.length > 0 && expenseRows.length > 0;
  checks.add('workbook contains fixture/test records', hasData,
    `${propertyRows.length} propert${propertyRows.length === 1 ? 'y' : 'ies'}, `
    + `${bookingRows.length} reservation(s), ${revenueRows.length} revenue row(s), `
    + `${expenseRows.length} expense(s), ${monthsWithRevenue} month(s) with revenue`,
    'In the COPY: 🏠 Homestay Ops ▸ Seed FICTIONAL test data.\n'
    + '      Without it every comparison is 0 against 0 and the gate passes having\n'
    + '      verified nothing at all.');

  checks.add('CFG_FY_START is set', Boolean(fyStart?.[0]?.[0]), '',
    'Set CFG_FY_START in 02_SETTINGS of the copy. Without it the 12-month block has no anchor.');

  /* ---- 9. CFG_REPORT_MONTH ---------------------------------------------- */
  const reportMonthSerial = num(reportMonthCell?.[0]?.[0]);
  const reportMonth = monthKeyOfSerial(reportMonthSerial);
  const reportIndex = monthKeys.indexOf(reportMonth);
  const bookingsCount = monthly('BookingsCount');
  const monthsWithActivity = monthKeys
    .map((key, i) => ({ key, active: netRevenue[i] !== 0 || bookingsCount[i] > 0 }))
    .filter((m) => m.active).map((m) => m.key);

  const reportMonthValid = reportIndex >= 0 && monthsWithActivity.includes(reportMonth);
  checks.add('CFG_REPORT_MONTH is a month with data', reportMonthValid,
    reportMonth
      ? (reportIndex < 0
        ? `${reportMonth} is outside the financial year (${monthKeys[0]} … ${monthKeys[monthKeys.length - 1]})`
        : reportMonthValid ? reportMonth : `${reportMonth} has no revenue and no bookings`)
      : 'not set, or not a date',
    'In the COPY: 02_SETTINGS ▸ CFG_REPORT_MONTH. Set it to the first of a month that has\n'
    + `      data, then reload so 99_CALC finishes recalculating.\n`
    + `      Months with data in this workbook: ${monthsWithActivity.join(', ') || '(none)'}\n`
    + '      The application NEVER writes this cell. Changing it by hand in a parity copy\n'
    + '      is a person editing a test workbook, which is a different thing entirely.');

  /* ---- 8. The eleven scenarios ------------------------------------------ */
  const detected = detectScenarios({
    monthKeys,
    grossRevenue: monthly('GrossRevenue'),
    operatingExpenses: monthly('OperatingExpenses'),
    operatingProfit: monthly('OperatingProfit'),
    bookingsCount,
    cancelledCount: monthly('CancelledCount'),
    carryForwardApplied: monthly('CarryForwardApplied'),
    bookings: bookingRows.map((r) => ({
      id: str(cell('RESERVATIONS', r, 'BookingID')),
      expectedPayout: num(cell('RESERVATIONS', r, 'ExpectedPayout')),
      actualPayout: num(cell('RESERVATIONS', r, 'ActualPayout')),
    })),
    expenses: expenseRows.map((r) => ({
      id: str(cell('EXPENSES', r, 'ExpenseID')),
      type: str(cell('EXPENSES', r, 'ExpenseType')),
    })),
    activeInvestors: investorRows.filter((r) => str(cell('INVESTORS', r, 'Status')) === 'Active').length,
    propertyCount: propertyRows.length,
    platformsInReportMonth: [...new Set(revenueRows
      .filter((r) => monthKeyOfSerial(num(cell('REVENUE', r, 'Date'))) === reportMonth)
      .map((r) => str(cell('REVENUE', r, 'Platform')))
      .filter(Boolean))],
    payoutTolerance: num(payoutTolerance?.[0]?.[0]),
    reportMonth,
  });
  const missingScenarios = REQUIRED_SCENARIOS.filter((name) => !detected[name].present);
  checks.add(`all ${REQUIRED_SCENARIOS.length} required test scenarios exist`, missingScenarios.length === 0,
    missingScenarios.length
      ? `MISSING: ${missingScenarios.join(', ')}`
      : REQUIRED_SCENARIOS.map((n) => detected[n].where).filter(Boolean).length + ' located',
    missingScenarios.length
      ? missingScenarios.map((n) => `• ${n}\n        ${SCENARIO_FIX[n]}`).join('\n      ')
      : undefined);

  /* ---- Business rules --------------------------------------------------- */
  const poolConfigured = typeof poolPct?.[0]?.[0] === 'number';
  checks.warn('business rules configured (parity-test values)', poolConfigured,
    poolConfigured
      ? 'set — the distribution chain will be exercised'
      : 'TBD — reserve, management fee, carry-forward, distributable profit and investor '
        + 'pool will all compare 0 against 0. See runbook step 7.');

  /* ---- Data hygiene ----------------------------------------------------- */
  const personal = (label, rows) => {
    const hits = findContactData(rows);
    checks.add(`no real ${label} contact data`, hits.length === 0,
      hits.length ? `found ${hits.length}: ${hits.slice(0, 3).map(mask).join(', ')}…`
        : `${rows.length} row(s) scanned, nothing contact-shaped`,
      'A parity copy must contain fictional records only. Remove the real contact details, '
      + 'or re-seed the copy from scratch.');
  };
  personal('guest', reservations);
  personal('investor', investors);
  personal('landlord', rent);

  const guestNames = bookingRows.map((r) => str(cell('RESERVATIONS', r, 'GuestName'))).filter(Boolean);
  const marked = guestNames.filter(looksFictional);
  checks.warn('guest records are visibly fictional', guestNames.length > 0 && marked.length === guestNames.length,
    `${marked.length}/${guestNames.length} names carry a test marker`);

  const secretsFound = findSecrets([...settings, ...reservations, ...expenses, ...investors, ...rent]);
  checks.add('no production secrets stored in the workbook', secretsFound.length === 0,
    secretsFound.length ? `found: ${secretsFound.join(', ')}` : 'none of the known key formats appear',
    'Remove the credential from the workbook and rotate it. A key in a spreadsheet is a key '
    + 'shared with everyone the spreadsheet is shared with.');

  const failed = checks.failed;
  return {
    status: failed.length === 0 ? 'READY' : 'NOT READY',
    checks: checks.items,
    context: {
      sheetId: maskSheetId(resolved.sheetId),
      title,
      timeZone,
      titleOverridden: overridden && !looksLikeCopy,
      clientEmail: resolved.clientEmail,
      credentialFrom: resolved.credentialFrom,
      reportMonth,
      monthsWithActivity,
      businessRulesConfigured: poolConfigured,
      counts: {
        properties: propertyRows.length,
        reservations: bookingRows.length,
        revenue: revenueRows.length,
        expenses: expenseRows.length,
        investors: investorRows.length,
        rent: rent.filter((r) => str(cell('RENT', r, 'RecordID')) !== '').length,
      },
      scenarios: REQUIRED_SCENARIOS.map((name) => ({
        name, present: detected[name].present, where: detected[name].where,
        fix: detected[name].present ? undefined : SCENARIO_FIX[name],
      })),
    },
  };
}

/**
 * Turn a Google or OpenSSL failure into something an operator can act on.
 *
 * The raw messages are useless at the moment they matter: a corrupted key file reports
 * "DECODER routines::unsupported", and nobody guesses what to do from that.
 */
export function explainConnectionError(error, resolved) {
  const message = String(error?.message ?? error);
  const lines = (...parts) => parts.join(NEWLINE + '      ');

  if (/DECODER|PEM|routines|private key|1E08010C/i.test(message)) {
    return {
      summary: 'the credential file is not a usable service-account key',
      fix: lines(
        'The file was found and is valid JSON, but its private key cannot be read.',
        'Download it again: Cloud Console > Service Accounts > your account > Keys >',
        'Add key > Create new key > JSON. Use the file exactly as downloaded — opening',
        'it in an editor and re-saving it is what usually breaks it.',
      ),
    };
  }
  if (/invalid_grant|JWT|clock|token/i.test(message)) {
    return {
      summary: 'Google rejected the credential',
      fix: lines(
        'Usually one of two things:',
        '• this machine’s clock is wrong — check the date and time; or',
        '• the key has been deleted in the Cloud Console. Create a new one.',
      ),
    };
  }
  if (/permission|403|caller does not have/i.test(message)) {
    return {
      summary: 'access denied',
      fix: lines(
        `Open the parity copy > Share > add ${resolved.clientEmail} > set the role to`,
        'Viewer > untick "Notify people" > Share.',
      ),
    };
  }
  if (/not found|404/i.test(message)) {
    return {
      summary: 'no workbook with that id',
      fix: lines(
        'Check PARITY_SHEET_ID. It is the part of the spreadsheet URL between /d/ and',
        '/edit — not the whole address, and not the sheet name.',
      ),
    };
  }
  if (/ENOTFOUND|EAI_AGAIN|ETIMEDOUT|ECONNRESET|network/i.test(message)) {
    return { summary: 'could not reach Google', fix: 'Check the internet connection and try again.' };
  }
  if (/has not been used|disabled|SERVICE_DISABLED/i.test(message)) {
    return {
      summary: 'the Google Sheets API is not enabled for this project',
      fix: lines(
        'Cloud Console > APIs & Services > Library > Google Sheets API > Enable.',
        'It can take a minute to take effect.',
      ),
    };
  }
  return {
    summary: message,
    fix: `Check PARITY_SHEET_ID, and that the copy is shared with ${resolved.clientEmail} as Viewer.`,
  };
}

/** Everything an operator needs to do next, when the preflight did not pass. */
export function printFailures(checks, log = console.log) {
  const failed = checks.filter((c) => !c.ok && !c.advisory && !c.informational);
  if (failed.length === 0) return;
  log('');
  log('What to do:');
  for (const c of failed) {
    log('');
    log(`  ✗ ${c.name}`);
    if (c.detail) log(`      ${c.detail}`);
    if (c.fix) log(`      ${c.fix}`);
  }
}
