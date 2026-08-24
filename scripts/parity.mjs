/**
 * `npm run parity` — the one command.
 *
 *   1. validate environment variables      6. validate named ranges
 *   2. validate credentials                7. validate fixture data exists
 *   3. validate workbook reachable         8. validate all 11 test scenarios exist
 *   4. validate it is not production       9. validate CFG_REPORT_MONTH has data
 *   5. validate all 22 tabs               10. run the LIVE suite
 *                                         11. generate the report
 *
 * Everything is orchestrated in Node. There is no shell chaining, no `&&`, no `;`, no
 * `$(...)` — the previous version used a POSIX `;` and died on the operator's first
 * command because cmd.exe read it as part of a filename. Child processes are spawned as
 * `process.execPath <script>` with `shell: false`, which behaves identically on Windows,
 * macOS and Linux.
 *
 * READ-ONLY throughout. Nothing writes to the workbook.
 */
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { runPreflight, printChecks, printFailures } from './parity-preflight.mjs';
import { resolveParityEnv, childEnv, ENV_NAMES } from './parity-env.mjs';

const CWD = process.cwd();
const REPORTS = path.resolve(CWD, 'reports');
const rule = (label = '') => console.log(`\n${label}\n${'─'.repeat(72)}`);

/** Run a Node script as a child process. No shell — the same call works on every OS. */
function runNode(args, env) {
  const result = spawnSync(process.execPath, args, { stdio: 'inherit', env, cwd: CWD, shell: false });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

/* ================================================================== *
 * 1–9 · Preflight
 * ================================================================== */
rule('LIVE PARITY');
console.log('Step 1 of 3 — checking the workbook before comparing anything.\n');

const preflight = await runPreflight({ log: console.log });
printChecks(preflight.checks);

fs.mkdirSync(REPORTS, { recursive: true });
fs.writeFileSync(path.join(REPORTS, 'parity.preflight.json'), JSON.stringify({
  generatedAt: new Date().toISOString(),
  status: preflight.status,
  checks: preflight.checks,
  ...preflight.context,
}, null, 2));

if (preflight.status === 'NOT READY') {
  printFailures(preflight.checks);
  rule();
  console.log('PREFLIGHT: NOT READY — nothing was compared.');
  console.log('Fix the items above and run `npm run parity` again.');
  console.log('Full instructions: docs/LIVE_PARITY_RUNBOOK.md');
  process.exit(1);
}

if (preflight.status === 'NOT CONFIGURED') {
  const resolved = resolveParityEnv();
  console.log('');
  console.log('PREFLIGHT: NOT CONFIGURED — LIVE parity has not been set up on this machine.');
  console.log(`Still needed: ${resolved.missing.join(', ')}`);
  for (const problem of resolved.problems) console.log(`  ! ${problem}`);
  console.log('');
  console.log('The offline layers will still run, and the report will say LIVE PENDING.');
  console.log('To set LIVE parity up, follow docs/LIVE_PARITY_RUNBOOK.md — about 20 minutes.');
  console.log('');
  console.log('  Windows PowerShell:');
  console.log(`    $env:${ENV_NAMES.sheetId[0]} = "<id of the parity copy>"`);
  console.log(`    $env:${ENV_NAMES.keyFile[0]} = "C:\\keys\\parity-key.json"`);
  console.log('');
  console.log('  macOS / Linux:');
  console.log(`    export ${ENV_NAMES.sheetId[0]}="<id of the parity copy>"`);
  console.log(`    export ${ENV_NAMES.keyFile[0]}="$HOME/keys/parity-key.json"`);
} else {
  const { title, reportMonth, timeZone, businessRulesConfigured } = preflight.context;
  console.log('');
  console.log(`PREFLIGHT: READY — "${title}", report month ${reportMonth}, timezone ${timeZone}.`);
  if (!businessRulesConfigured) {
    console.log('Note: business rules are TBD, so the distribution chain compares 0 against 0.');
  }
}

/* ================================================================== *
 * 10 · The suites
 * ================================================================== */
rule('Step 2 of 3 — comparing');
const env = preflight.status === 'READY' ? childEnv(resolveParityEnv()) : { ...process.env };

const suiteStatus = runNode(
  [path.join('node_modules', 'vitest', 'vitest.mjs'), 'run',
    'tests/parity.test.ts', 'tests/parity.live.test.ts'],
  env,
);

// A failing comparison is a result, not a crash: the report still has to be written, and
// it is the thing that says WHICH comparison failed and where the value came from.
if (suiteStatus !== 0) {
  console.log('\nComparisons failed. Writing the report anyway — it names each one.');
}

/* ================================================================== *
 * 11 · The report
 * ================================================================== */
rule('Step 3 of 3 — report');
const reportStatus = runNode([path.join('scripts', 'parity-report.mjs')], env);

rule();
console.log('Report: reports/PARITY_REPORT.md   (machine-readable: reports/parity.live.json)');
process.exit(reportStatus === 0 && suiteStatus === 0 ? 0 : 1);
