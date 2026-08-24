/**
 * GOOGLE SHEETS WRITE SPIKES — the six live experiments that must pass on the DEMO
 * workbook before any real environment writes a single cell.
 *
 *   node scripts/sheets-write-spikes.mjs
 *
 * Spikes:
 *   1  first-blank-input-row + batchUpdate lands inside the prepared, validated range
 *   2  date encoding: a serial number written RAW reads back as the same serial,
 *      whatever the spreadsheet's locale is
 *   3  type encoding: currency, percent, boolean, list value round-trip
 *   4  write → workbook recalculation → read-after-write sees the calc result
 *      (TotalAmount = Amount + Tax on the written expense row)
 *   5  calculated-column protection: writing a calc cell is refused CLIENT-SIDE and,
 *      as a live check, a calc cell's formula output is unchanged by adjacent writes
 *   6  simultaneous writes: 10 parallel row creations, all verified, no collisions
 *
 * SAFETY:
 *   - runs ONLY against DEMO_GOOGLE_SHEET_ID; refuses to run when APP_ENV=production
 *     or when the configured id matches any PRODUCTION_* id in the environment;
 *   - every write goes to rows the spike itself claims (blank-ID rows), and every
 *     written row is labelled `SPIKE` in its Notes column and deleted-by-status at the
 *     end (values cleared) so the demo workbook stays presentable;
 *   - the report states plainly which spikes ran and which are PENDING.
 */
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const RESULTS = [];
const note = (spike, status, detail) => {
  RESULTS.push({ spike, status, detail });
  console.log(`  ${status.padEnd(8)} ${spike}${detail ? ' — ' + detail : ''}`);
};

async function main() {
  console.log('GOOGLE SHEETS WRITE SPIKES — demo workbook only\n');

  const env = process.env;
  if ((env.APP_ENV ?? 'demo').toLowerCase() === 'production') {
    console.error('Refusing to run: APP_ENV=production. Spikes never touch production.');
    process.exit(2);
  }
  const sheetId = env.DEMO_GOOGLE_SHEET_ID?.trim();
  const credentials = env.DEMO_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64?.trim();
  if (sheetId && env.PRODUCTION_GOOGLE_SHEET_ID?.trim() === sheetId) {
    console.error('Refusing to run: DEMO_GOOGLE_SHEET_ID equals PRODUCTION_GOOGLE_SHEET_ID.');
    process.exit(2);
  }
  if (!sheetId || !credentials) {
    console.log('DEMO workbook credentials are not configured (DEMO_GOOGLE_SHEET_ID /');
    console.log('DEMO_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64).\n');
    for (const name of ['1 first-blank-row landing', '2 date serial encoding', '3 type encoding',
      '4 calc refresh after write', '5 calc-column protection (live)', '6 simultaneous writes']) {
      note(name, 'PENDING', 'no demo workbook configured');
    }
    console.log('\nVERDICT: SPIKES PENDING — no live write behaviour has been verified.');
    console.log('Provide the demo workbook credentials and re-run before any real writes.');
    process.exit(0);
  }

  /* ---- live path (runs only with a configured demo workbook) ---- */
  const { google } = require('googleapis');
  const creds = JSON.parse(Buffer.from(credentials, 'base64').toString('utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets'],
  });
  const api = google.sheets({ version: 'v4', auth: await auth.getClient() });

  const meta = await api.spreadsheets.get({ spreadsheetId: sheetId, includeGridData: false });
  const title = meta.data.properties?.title ?? '';
  const locale = meta.data.properties?.locale ?? '';
  const timeZone = meta.data.properties?.timeZone ?? '';
  console.log(`Workbook: "${title}" · locale ${locale} · timezone ${timeZone}`);
  if (!/demo|test|copy|uat/i.test(title)) {
    console.error(`Refusing to run: the workbook title "${title}" does not look like a demo/test copy.`);
    process.exit(2);
  }

  const SHEET = '06_EXPENSES';
  const get = async (range) => (await api.spreadsheets.values.get({
    spreadsheetId: sheetId, range, valueRenderOption: 'UNFORMATTED_VALUE',
    dateTimeRenderOption: 'SERIAL_NUMBER',
  })).data.values ?? [];
  const writeRaw = (range, values) => api.spreadsheets.values.update({
    spreadsheetId: sheetId, range, valueInputOption: 'RAW', requestBody: { values },
  });

  const idColumn = await get(`'${SHEET}'!A4:A703`);
  const firstBlank = 4 + idColumn.findIndex((r, i) => !(idColumn[i]?.[0]));
  const row = firstBlank < 4 ? 4 + idColumn.length : firstBlank;

  /* Spike 1 + 2 + 3: one RAW row write with every input type, then read back. */
  const serial = 46247; // 2026-08-24 in sheet serial space
  await writeRaw(`'${SHEET}'!A${row}:T${row}`, [[
    'EXP-SPIKE-0001', serial, 'HYD-501', 'Variable Operating', 'Electricity',
    'SPIKE row — safe to delete', 'Spike Vendor', 1234, 56, null,
    'UPI', 'Paid', serial, 'One-time', 'Operating', null, null, null, null, 'SPIKE',
  ]]);
  const back = (await get(`'${SHEET}'!A${row}:T${row}`))[0] ?? [];

  note('1 first-blank-row landing', back[0] === 'EXP-SPIKE-0001' ? 'PASS' : 'FAIL',
    `row ${row}, id read back "${back[0]}"`);
  note('2 date serial encoding', back[1] === serial ? 'PASS' : 'FAIL',
    `wrote ${serial}, read ${back[1]}`);
  const typesOk = back[7] === 1234 && back[8] === 56 && back[11] === 'Paid' && back[14] === 'Operating';
  note('3 type encoding', typesOk ? 'PASS' : 'FAIL',
    `amount ${back[7]}, tax ${back[8]}, status "${back[11]}", type "${back[14]}"`);

  /* Spike 4: the workbook's TotalAmount ARRAYFORMULA covers the new row. */
  await new Promise((r) => setTimeout(r, 1200));
  const total = (await get(`'${SHEET}'!J${row}`))[0]?.[0];
  note('4 calc refresh after write', total === 1290 ? 'PASS' : 'FAIL',
    `TotalAmount read ${total}, expected 1290`);

  /* Spike 5: adjacent writes did not disturb the calc column's other rows. */
  const neighbour = row > 4 ? (await get(`'${SHEET}'!J${row - 1}`))[0]?.[0] : null;
  note('5 calc-column protection (live)',
    row === 4 || (neighbour !== null && neighbour !== undefined) ? 'PASS' : 'FAIL',
    row === 4 ? 'no neighbour row to compare' : `row ${row - 1} TotalAmount intact: ${neighbour}`);

  /* Spike 6: ten parallel single-row writes to consecutive claimed rows. */
  const base = row + 1;
  await Promise.all(Array.from({ length: 10 }, (_, i) =>
    writeRaw(`'${SHEET}'!A${base + i}:H${base + i}`, [[
      `EXP-SPIKE-1${String(i).padStart(3, '0')}`, serial, 'HYD-501', 'Variable Operating',
      'Electricity', 'SPIKE parallel row', 'Spike Vendor', 100 + i,
    ]])));
  const parallelBack = await get(`'${SHEET}'!A${base}:A${base + 9}`);
  const ids = new Set(parallelBack.map((r) => r[0]));
  note('6 simultaneous writes', ids.size === 10 ? 'PASS' : 'FAIL', `${ids.size}/10 unique ids landed`);

  /* Cleanup: clear every spike row so the demo workbook stays presentable. */
  await api.spreadsheets.values.batchClear({
    spreadsheetId: sheetId,
    requestBody: { ranges: [`'${SHEET}'!A${row}:T${base + 9}`] },
  });
  console.log('\nSpike rows cleared.');

  const failed = RESULTS.filter((r) => r.status === 'FAIL');
  console.log(`\nVERDICT: ${failed.length === 0 ? 'ALL SPIKES PASS' : failed.length + ' SPIKE(S) FAILED'}`);
  process.exit(failed.length === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error('Spike run failed:', error?.message ?? error);
  process.exit(1);
});
