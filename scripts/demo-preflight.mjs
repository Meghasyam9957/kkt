/**
 * DEMO WORKBOOK PREFLIGHT — D1 verification of the real demo workbook.
 *
 *   node scripts/demo-preflight.mjs
 *
 * Verifies that the workbook `setupWorkbook()` + `seedTestData()` produced is the one
 * this application expects: every contract tab, every required named range, header rows
 * in the contract's positions, seeded fictional records, live calculated columns, and
 * sheet protections. It READS ONLY — write behaviour is proven separately by the six
 * spikes (scripts/sheets-write-spikes.mjs), and this preflight does not claim it.
 *
 * SAFETY: demo credentials only; refuses a workbook shared with production/parity ids
 * or whose title does not look like a demo/test copy.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

const MODEL = JSON.parse(
  fs.readFileSync(path.resolve(process.cwd(), 'lib/contract/contract.model.json'), 'utf8'),
);

const RESULTS = [];
const report = (status, check, detail = '') => {
  RESULTS.push({ status, check, detail });
  console.log(`  ${status.padEnd(6)} ${check}${detail ? ' — ' + detail : ''}`);
};

async function main() {
  console.log('DEMO WORKBOOK PREFLIGHT — read-only D1 verification\n');

  const sheetId = process.env.DEMO_GOOGLE_SHEET_ID?.trim();
  const credentials = process.env.DEMO_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64?.trim();
  if (!sheetId || !credentials) {
    console.log('DEMO_GOOGLE_SHEET_ID / DEMO_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 are not set.');
    console.log('VERDICT: PENDING — no demo workbook configured. See docs/DEMO_PROVISIONING.md.');
    process.exit(0);
  }
  for (const other of ['PRODUCTION_GOOGLE_SHEET_ID', 'PARITY_SHEET_ID']) {
    if (process.env[other]?.trim() === sheetId) {
      console.error(`Refusing to run: DEMO_GOOGLE_SHEET_ID equals ${other}.`);
      process.exit(2);
    }
  }

  const { google } = require('googleapis');
  const creds = JSON.parse(Buffer.from(credentials, 'base64').toString('utf8'));
  const auth = new google.auth.GoogleAuth({
    credentials: creds, scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });
  const api = google.sheets({ version: 'v4', auth: await auth.getClient() });

  /* 1 · reachable, and unmistakably a demo copy */
  const meta = await api.spreadsheets.get({
    spreadsheetId: sheetId,
    fields: 'properties(title,locale,timeZone),sheets(properties(title),protectedRanges(description)),namedRanges(name)',
  });
  const title = meta.data.properties?.title ?? '';
  const locale = meta.data.properties?.locale ?? '';
  console.log(`Workbook: "${title}" · locale ${locale} · timezone ${meta.data.properties?.timeZone}\n`);
  if (!/demo|test|copy|uat/i.test(title)) {
    console.error(`Refusing to run: the title "${title}" does not look like a demo/test copy.`);
    process.exit(2);
  }
  report('PASS', 'workbook reachable with demo credentials');
  report(locale === 'en_IN' ? 'PASS' : 'WARN', 'locale', locale === 'en_IN'
    ? 'en_IN as V1 expects' : `${locale} (V1 formats for en_IN; date spikes will judge)`);

  /* 2 · all contract tabs */
  const tabs = new Set((meta.data.sheets ?? []).map((s) => s.properties?.title));
  const expectedTabs = Object.values(MODEL.sheets).map((s) => s.name);
  const missingTabs = expectedTabs.filter((t) => !tabs.has(t));
  report(missingTabs.length ? 'FAIL' : 'PASS', `all ${expectedTabs.length} contract tabs`,
    missingTabs.length ? `missing: ${missingTabs.join(', ')}` : 'every generated-contract tab present');

  /* 3 · required named ranges */
  const named = new Set((meta.data.namedRanges ?? []).map((r) => r.name));
  const missingNamed = (MODEL.requiredNamedRanges ?? []).filter((n) => !named.has(n));
  report(missingNamed.length ? 'FAIL' : 'PASS',
    `all ${(MODEL.requiredNamedRanges ?? []).length} required named ranges`,
    missingNamed.length ? `missing: ${missingNamed.slice(0, 8).join(', ')}${missingNamed.length > 8 ? '…' : ''}` : '');

  /* 4 · protections exist (V1 protects calculated/reporting surfaces) */
  const protectedCount = (meta.data.sheets ?? [])
    .reduce((n, s) => n + (s.protectedRanges?.length ?? 0), 0);
  report(protectedCount > 0 ? 'PASS' : 'WARN', 'sheet protections',
    protectedCount > 0 ? `${protectedCount} protected range(s)` :
      'none found — calc columns rely on API-side refusal only');

  /* 5 · header rows + seeded records + live calc columns, one batchGet */
  const tableKeys = Object.keys(MODEL.columns);
  const ranges = [];
  for (const key of tableKeys) {
    const sheet = MODEL.sheets[key];
    const cols = MODEL.columns[key];
    const lastA1 = cols[cols.length - 1].a1;
    ranges.push(`'${sheet.name}'!A${sheet.headerRow}:${lastA1}${sheet.headerRow}`);   // headers
    ranges.push(`'${sheet.name}'!A${sheet.dataRow}:A${sheet.lastDataRow}`);           // ids
  }
  const values = await api.spreadsheets.values.batchGet({
    spreadsheetId: sheetId, ranges, valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const got = values.data.valueRanges ?? [];

  let headerFailures = 0;
  const seeded = {};
  tableKeys.forEach((key, i) => {
    const cols = MODEL.columns[key];
    const headers = (got[i * 2]?.values?.[0] ?? []).map((h) => String(h).trim());
    const wrong = cols.filter((c, idx) => headers[idx] !== c.header);
    if (wrong.length) {
      headerFailures++;
      report('FAIL', `${MODEL.sheets[key].name} header row`,
        `${wrong.length} mismatched (first: expected "${wrong[0].header}" at ${wrong[0].a1})`);
    }
    seeded[key] = (got[i * 2 + 1]?.values ?? []).filter((r) => String(r[0] ?? '').trim() !== '').length;
  });
  if (headerFailures === 0) {
    report('PASS', 'header rows match the contract', `${tableKeys.length} table sheets`);
  }

  const mustBeSeeded = ['PROPERTIES', 'RESERVATIONS', 'REVENUE', 'EXPENSES', 'INVESTORS',
    'HOUSEKEEPING', 'MAINTENANCE', 'INVENTORY'];
  const unseeded = mustBeSeeded.filter((k) => (seeded[k] ?? 0) === 0);
  report(unseeded.length ? 'FAIL' : 'PASS', 'seedTestData() records present',
    unseeded.length
      ? `empty: ${unseeded.join(', ')} — run the seeder`
      : mustBeSeeded.map((k) => `${k}:${seeded[k]}`).join(' '));

  /* 6 · calculated columns produce values (formulas are alive) */
  const calcProbes = [
    ['EXPENSES', 'TotalAmount'], ['RESERVATIONS', 'Nights'], ['INVENTORY', 'CurrentStock'],
  ];
  const calcRanges = calcProbes.map(([key, colKey]) => {
    const sheet = MODEL.sheets[key];
    const col = MODEL.columns[key].find((c) => c.key === colKey);
    return `'${sheet.name}'!${col.a1}${sheet.dataRow}`;
  });
  const calcValues = await api.spreadsheets.values.batchGet({
    spreadsheetId: sheetId, ranges: calcRanges, valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const deadCalc = calcProbes.filter((_, i) => {
    const v = calcValues.data.valueRanges?.[i]?.values?.[0]?.[0];
    return v === undefined || v === null || v === '';
  });
  report(deadCalc.length ? 'FAIL' : 'PASS', 'calculated columns are live',
    deadCalc.length
      ? `no value in: ${deadCalc.map(([k, c]) => `${k}.${c}`).join(', ')}`
      : calcProbes.map(([k, c]) => `${k}.${c}`).join(', '));

  /* verdict */
  const failed = RESULTS.filter((r) => r.status === 'FAIL');
  console.log('');
  if (failed.length) {
    console.log(`VERDICT: FAIL — ${failed.length} check(s) failed. Fix the workbook (usually by`);
    console.log('re-running setupWorkbook()/seedTestData()), not this preflight.');
    process.exit(1);
  }
  console.log('VERDICT: PASS — the demo workbook matches the contract and is seeded.');
  console.log('Write behaviour is NOT covered here: run node scripts/sheets-write-spikes.mjs next.');
}

main().catch((error) => {
  console.error(`\nFAILED: ${error.message}`);
  process.exit(1);
});
