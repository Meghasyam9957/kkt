/**
 * Preflight only — the same nine checks `npm run parity` runs first, without comparing
 * anything. Useful while getting the workbook ready.
 *
 *   npm run parity:preflight
 *
 * READ-ONLY. Exits 0 when ready or when parity is simply not configured yet; exits 1 only
 * when something IS configured and IS wrong.
 */
import process from 'node:process';
import { runPreflight, printChecks, printFailures } from './parity-preflight.mjs';

console.log('LIVE parity preflight\n');

const { status, checks } = await runPreflight({ log: console.log });
printChecks(checks);

if (status === 'NOT READY') {
  printFailures(checks);
  console.log('\nPREFLIGHT: NOT READY — fix the items above, then run `npm run parity`.');
  process.exit(1);
}

if (status === 'NOT CONFIGURED') {
  console.log('\nPREFLIGHT: NOT CONFIGURED — see docs/LIVE_PARITY_RUNBOOK.md.');
  console.log('`npm run parity` still runs the offline layers and reports LIVE PENDING.');
  process.exit(0);
}

console.log('\nPREFLIGHT: READY — run `npm run parity`.');
console.log('');
console.log('Note: the personal-data and secret checks look for EVIDENCE — contact-shaped');
console.log('      strings and known key formats. Passing means nothing was detected. It is');
console.log('      not proof the copy is free of real data. Confirm by eye as well.');
process.exit(0);
