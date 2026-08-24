/**
 * DEMO SEED SNAPSHOT — CLI capture (Phase D7).
 *
 *   npx tsx scripts/demo-snapshot.ts
 *
 * Captures the demo workbook's input cells as the state every later "Reset demo
 * environment" restores. Run ONCE, immediately after `setupWorkbook()` + `seedTestData()`
 * have built and seeded the workbook — before any demonstration writes.
 *
 * Identical to the admin-page "Capture seed snapshot" button (both call
 * `captureSeedSnapshot`); this exists so provisioning can finish without starting the
 * web app. SAFETY mirrors the spike script: demo credentials only, and a workbook whose
 * title does not look like a demo/test copy is refused.
 */
import { GoogleSheetsApiClient } from '@/lib/server/sheets/client';
import {
  captureSeedSnapshot, saveSeedSnapshot, seedSnapshotPath,
} from '@/lib/server/demo/live-reset';
import { SHEETS, type SheetKey } from '@/lib/contract/contract.generated';

async function main(): Promise<void> {
  const sheetId = process.env.DEMO_GOOGLE_SHEET_ID?.trim();
  const credentials = process.env.DEMO_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64?.trim();
  if (!sheetId || !credentials) {
    console.error('DEMO_GOOGLE_SHEET_ID and DEMO_GOOGLE_SERVICE_ACCOUNT_JSON_BASE64 must be set.');
    console.error('See docs/DEMO_PROVISIONING.md.');
    process.exit(2);
  }
  if (process.env.PRODUCTION_GOOGLE_SHEET_ID?.trim() === sheetId) {
    console.error('Refusing to run: DEMO_GOOGLE_SHEET_ID equals PRODUCTION_GOOGLE_SHEET_ID.');
    process.exit(2);
  }

  const client = new GoogleSheetsApiClient({
    spreadsheetId: sheetId,
    serviceAccountJsonBase64: credentials,
  });

  const meta = await client.spreadsheetMetadata();
  console.log(`Workbook: "${meta.title}" · timezone ${meta.timeZone}`);
  if (!/demo|test|copy|uat/i.test(meta.title)) {
    console.error(`Refusing to run: the title "${meta.title}" does not look like a demo/test copy.`);
    process.exit(2);
  }

  console.log('Capturing input cells of every table sheet…');
  const snapshot = await captureSeedSnapshot(client);

  let total = 0;
  for (const [sheet, entry] of Object.entries(snapshot.sheets)) {
    if (!entry) continue;
    total += entry.rows.length;
    console.log(`  ${SHEETS[sheet as SheetKey].padEnd(24)} ${String(entry.rows.length).padStart(4)} seeded row(s)`);
  }

  const path = seedSnapshotPath();
  saveSeedSnapshot(snapshot, path);
  console.log(`\nSaved ${total} seeded rows to ${path}`);
  console.log('The admin "Reset demo environment" control now restores to exactly this state.');
}

main().catch((error: Error) => {
  console.error(`\nFAILED: ${error.message}`);
  process.exit(1);
});
