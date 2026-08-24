/**
 * Renders the parity evidence into `reports/PARITY_REPORT.md`.
 *
 * Sources:
 *   reports/parity.json            offline layers (L1 contract, L2 cross-impl, L3 absolute)
 *   reports/parity.live.json       the LIVE comparison, or a NOT RUN record
 *   reports/parity.preflight.json  workbook identity and scenario coverage
 *
 * The verdict is one of exactly three strings — `LIVE PASS`, `LIVE FAIL`, `LIVE PENDING` —
 * and it is computed, never asserted. In particular a family with zero comparisons can
 * never produce a PASS: an uncompared metric is missing evidence, and missing evidence is
 * not agreement.
 *
 * Exit code 1 on FAIL. PENDING exits 0, because "not run yet" is a reported state rather
 * than a broken build.
 */
import fs from 'node:fs';
import path from 'node:path';

const REPORTS = path.resolve(process.cwd(), 'reports');
const OUT = path.join(REPORTS, 'PARITY_REPORT.md');
const read = (name) => {
  const file = path.join(REPORTS, name);
  return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : null;
};

const offline = read('parity.json');
if (!offline) {
  console.error('No reports/parity.json — run `npm run parity` (or `npx vitest run tests/parity.test.ts`).');
  process.exit(1);
}
const live = read('parity.live.json');
const preflight = read('parity.preflight.json');

/* ------------------------------------------------------------------ *
 * Formatting
 * ------------------------------------------------------------------ */
const fmt = (v) => {
  if (v === null || v === undefined) return '—';
  if (typeof v !== 'number') return String(v);
  if (Number.isInteger(v)) return v.toLocaleString('en-IN');
  return v.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 6 });
};
const mark = (pass) => (pass ? 'PASS' : '**FAIL**');

/* ------------------------------------------------------------------ *
 * Verdict
 *
 * Coverage is evaluated BEFORE the pass/fail arithmetic, because a family that was never
 * compared is the one failure mode a green tally hides.
 * ------------------------------------------------------------------ */
const liveRan = Boolean(live) && live.status !== 'NOT RUN';
const liveRows = live?.rows ?? [];
const liveFailures = liveRows.filter((r) => !r.pass);
const coverage = (live?.byFamily ?? []).map((f) => ({
  ...f, status: f.checks === 0 ? 'NOT COVERED' : f.failed === 0 ? 'PASS' : 'FAIL',
}));
const uncovered = coverage.filter((f) => f.status === 'NOT COVERED');

const offlinePass = offline.failed === 0;
let verdict;
let verdictReason;
if (!liveRan) {
  verdict = 'LIVE PENDING';
  verdictReason = live?.reason ?? 'The LIVE suite has not run against a Google Sheets workbook.';
} else if (liveFailures.length > 0) {
  verdict = 'LIVE FAIL';
  verdictReason = `${liveFailures.length} comparison(s) disagree with the workbook.`;
} else if (coverage.length === 0) {
  verdict = 'LIVE FAIL';
  verdictReason = 'The run recorded no coverage table, so nothing can be said about what it compared.';
} else if (uncovered.length > 0) {
  verdict = 'LIVE FAIL';
  verdictReason = `${uncovered.length} required metric famil${uncovered.length === 1 ? 'y was' : 'ies were'} `
    + `never compared: ${uncovered.map((f) => f.family).join(', ')}.`;
} else {
  verdict = 'LIVE PASS';
  verdictReason = `All ${liveRows.length} comparisons agree, across all ${coverage.length} required metric families.`;
}

const scenarioSource = live?.scenarios?.length ? live.scenarios : (preflight?.scenarios ?? []);
const missingScenarios = scenarioSource.filter((s) => !s.present);
const overallGate = !offlinePass ? 'FAIL' : verdict === 'LIVE PASS' ? 'PASS'
  : verdict === 'LIVE FAIL' ? 'FAIL' : 'PENDING';

/* ------------------------------------------------------------------ *
 * The document
 * ------------------------------------------------------------------ */
const L = [];
const push = (...lines) => L.push(...lines);

push('# Parity Report — Google Sheets ↔ TypeScript', '');
push(`**${verdict}** — ${verdictReason}`, '');

/* ---- Run identity ---- */
push('## This run', '');
push('| | |', '|---|---|');
push(`| Run at | ${new Date().toISOString()} |`);
push(`| Offline evidence generated | ${offline.generatedAt} |`);
if (liveRan) push(`| LIVE evidence generated | ${live.generatedAt} |`);
push(`| Environment | parity harness — \`LIVE_DATA_ENABLED\` is not involved, and no application environment is started |`);
if (preflight || liveRan) {
  const title = live?.spreadsheetTitle ?? preflight?.title ?? '(unknown)';
  const id = live?.spreadsheetId ?? preflight?.sheetId ?? '(unknown)';
  const tz = live?.timeZone ?? preflight?.timeZone ?? '(unknown)';
  push(`| Workbook | ${title} |`);
  push(`| Workbook id | \`${id}\` (last six characters only) |`);
  push(`| Workbook timezone | ${tz} |`);
  push(`| Report month | ${live?.reportMonth ?? preflight?.reportMonth ?? '(unknown)'} |`);
  if (preflight?.clientEmail) push(`| Service account | ${preflight.clientEmail} |`);
  if (preflight?.credentialFrom) push(`| Credential source | ${preflight.credentialFrom} |`);
  if (preflight?.businessRulesConfigured === false) {
    push('| Business rules | **TBD** — the distribution chain compares 0 against 0 |');
  }
  if (preflight?.titleOverridden) {
    push('| ⚠ Title check | **OVERRIDDEN** via `PARITY_TITLE_CONFIRMED_NOT_PRODUCTION=yes` |');
  }
}
push('', '> The workbook is never written to. `CFG_REPORT_MONTH` is read to learn which month');
push('> the report-month blocks describe, and is never set by anything in this repository.', '');

/* ---- Coverage matrix, before any verdict arithmetic ---- */
push('## Coverage matrix', '');
if (!liveRan) {
  push('The LIVE suite has not run, so **no family has been compared against Google\'s formula');
  push('engine**. The families it will cover:', '');
  push('| Family | Comparisons | Status |', '|---|---:|---|');
  for (const family of live?.families ?? []) push(`| ${family} | 0 | NOT RUN |`);
} else {
  push('| Family | Comparisons | Failed | Status |', '|---|---:|---:|---|');
  for (const f of coverage) {
    const status = f.status === 'NOT COVERED' ? '**NOT COVERED**' : f.status === 'FAIL' ? '**FAIL**' : 'PASS';
    push(`| ${f.family} | ${f.checks} | ${f.failed} | ${status} |`);
  }
  push('', `**${coverage.length} required families. ${uncovered.length} not covered.**`);
  if (uncovered.length) {
    push('', '> A family with zero comparisons cannot produce a PASS. The verdict above is FAIL');
    push('> because the run did not gather the evidence, not because the engines disagreed.');
  }
}
push('');

/* ---- Scenario coverage ---- */
if (scenarioSource.length) {
  push('## Scenario coverage', '');
  push('| Scenario | Present in the copy | Where |', '|---|---|---|');
  for (const s of scenarioSource) {
    push(`| ${s.name} | ${s.present ? 'yes' : '**NO**'} | ${s.where || s.detail || (s.present ? '' : 'not found')} |`);
  }
  if (missingScenarios.length) {
    push('', `> **${missingScenarios.length} scenario(s) missing.** An absent scenario is a preparation`);
    push('> gap in the parity copy, not a pass. Each one\'s fix is printed by');
    push('> `npm run parity:preflight`.');
  }
  push('');
}

/* ---- Layer summary ---- */
push('## Layers', '');
push('| Layer | What it proves | Checks | Failed |', '|---|---|---:|---:|');
const layerPurpose = {
  'L1 contract': 'generated TS contract matches the V1 registry exactly',
  'L2 cross-impl': 'TS engine agrees with V1’s own independent JS recomputation',
  'L3 absolute': 'both agree with hand-computed expected values',
};
for (const layer of offline.byLayer) {
  push(`| ${layer.layer} | ${layerPurpose[layer.layer] ?? ''} | ${layer.total} | ${layer.failed} |`);
}
push(`| LIVE | TS engine vs Google’s actual formula engine | ${liveRan ? liveRows.length : '— *not run*'} | ${liveRan ? liveFailures.length : '—'} |`);
push('');
push(`**OFFLINE: ${offlinePass ? 'PASS' : 'FAIL'}** — ${offline.passed}/${offline.total} checks passed.`);
push(`**${verdict}**`);
push(`**OVERALL PARITY GATE: ${overallGate}** — offline PASS *and* LIVE PASS.`, '');
push(overallGate === 'PASS'
  ? '> **Parity gate CLOSED.** Both layers pass.'
  : overallGate === 'PENDING'
    ? '> **Parity gate REMAINS OPEN.** Offline passes, but the gate does not close until the\n> LIVE suite passes against the actual Google Sheets formula engine.'
    : '> **Parity gate FAILED.** See the failures below.', '');

if (!liveRan) {
  push('> **LIVE parity: NOT RUN.** ' + (live?.reason ?? ''), '>');
  push('> ' + (live?.required ?? 'See docs/LIVE_PARITY_RUNBOOK.md.'), '>');
  push('> The offline layers compare against V1’s JavaScript implementation of the same');
  push('> definitions, not against Google’s formula engine. Until LIVE parity runs, that');
  push('> last gap is unverified.', '');
}

/* ---- Tolerances ---- */
push('## Tolerances', '');
push('These are floating-point allowances. **None of them is a business allowance** — no');
push('difference is excused because it is small in rupees.', '');
push('| Kind | Tolerance | Why |', '|---|---|---|');
push('| money | ₹0.01 | One paisa. Both engines do the same arithmetic in IEEE-754 doubles but accumulate sums in a different order, so the last bit can differ. Below a paisa nothing can be paid or owed, so it cannot represent a real discrepancy. |');
push('| ratios — occupancy, operating margin, cancellation rate | 1e-9 | A pure division on both sides. 1e-9 is roughly a ten-millionth of a percentage point: far below any representable business quantity, far above double-precision noise. |');
push('| ALOS | 1e-9 | Also a division (nights ÷ bookings), same reasoning. |');
push('| counts — bookings, nights, tickets, units | **0** | Integers on both sides. A count off by one is a booking counted twice or a night missed; there is no rounding to hide behind. |');
push('| dates and text — rent due dates, payment status | **0** | Exact string and date match. "Due soon" and "OVERDUE" are different answers, not nearby ones. |');
push('');

/* ---- Failures, first and complete ---- */
if (liveFailures.length) {
  push('## ❌ Failed comparisons', '');
  push('| Metric | TypeScript | Google Sheets | Delta | Tolerance | Result |');
  push('|---|---:|---:|---:|---:|---|');
  for (const r of liveFailures) {
    push(`| ${r.section} · ${r.subject} · ${r.metric} | ${fmt(r.typescript)} | ${fmt(r.sheet)} | ${fmt(r.delta)} | ${fmt(r.tolerance)} | ${mark(false)} |`);
  }
  push('', '### Failure triage', '');
  push('| Metric | Source formula / range | Delta | Clock-sensitive | Candidate cause |');
  push('|---|---|---:|---|---|');
  for (const r of liveFailures) {
    push(`| ${r.section} · ${r.subject} · ${r.metric} | \`${r.source}\` | ${fmt(r.delta)} | ${r.clockSensitive ? 'yes' : 'no'} | ${triage(r)} |`);
  }
  push('');
  push('> Candidate cause is a **starting point**, not a verdict. Confirm against the named');
  push('> range before changing anything, and remember the invariant: **if the V1 formula');
  push('> itself is wrong, STOP and report MANAGEMENT / BUSINESS LOGIC REVIEW REQUIRED.**');
  push('> Never change a V1 formula to match TypeScript, and never patch a single assertion');
  push('> to turn this report green.', '');
}

const offlineFailures = offline.rows.filter((r) => !r.pass);
if (offlineFailures.length) {
  push('## ❌ Failed offline checks', '');
  push('| Layer | Scenario | Metric | Sheet / V1 | TypeScript | Difference |');
  push('|---|---|---|---:|---:|---:|');
  for (const r of offlineFailures) {
    push(`| ${r.layer} | ${r.scenario} | ${r.metric} | ${fmt(r.sheet)} | ${fmt(r.typescript)} | ${fmt(r.difference)} |`);
  }
  push('');
}

/* ---- Not compared ---- */
if (live?.notCompared?.length) {
  push('## Not compared', '');
  push('Stated rather than omitted. Anything here is outside the coverage tally above.', '');
  push('| Family | Metric | Why |', '|---|---|---|');
  for (const n of live.notCompared) push(`| ${n.family} | ${n.metric} | ${n.reason} |`);
  push('');
}

/* ---- All comparisons ---- */
if (liveRan && liveRows.length) {
  push('## All LIVE comparisons', '');
  for (const sec of live.bySection ?? []) {
    const secRows = liveRows.filter((r) => r.section === sec.section);
    push(`<details><summary><strong>${sec.section}</strong> — ${sec.checks - sec.failed}/${sec.checks} passed</summary>`, '');
    push('| Metric | TypeScript | Google Sheets | Delta | Tolerance | Result |');
    push('|---|---:|---:|---:|---:|---|');
    for (const r of secRows) {
      push(`| ${r.subject} · ${r.metric} | ${fmt(r.typescript)} | ${fmt(r.sheet)} | ${fmt(r.delta)} | ${fmt(r.tolerance)} | ${mark(r.pass)} |`);
    }
    push('', '</details>', '');
  }
}

/* ---- Offline detail ---- */
for (const layerName of ['L2 cross-impl', 'L3 absolute', 'L1 contract']) {
  const rows = offline.rows.filter((r) => r.layer === layerName);
  if (!rows.length) continue;
  push(`## ${layerName} — ${layerPurpose[layerName] ?? ''}`, '');
  if (layerName === 'L1 contract') {
    push(`${rows.length} contract checks, ${rows.filter((r) => !r.pass).length} failed. `
      + 'Sheet names, all 261 columns (key, header, order, input/calculated role), 31 dropdown '
      + 'lists, every 99_CALC row address and the 12-month layout.', '');
    continue;
  }
  for (const scenario of [...new Set(rows.map((r) => r.scenario))]) {
    push(`### ${scenario}`, '');
    push('| Metric | Sheet / V1 | TypeScript | Difference | Result |', '|---|---:|---:|---:|---|');
    for (const r of rows.filter((x) => x.scenario === scenario)) {
      push(`| ${r.metric} | ${fmt(r.sheet)} | ${fmt(r.typescript)} | ${fmt(r.difference)} | ${mark(r.pass)} |`);
    }
    push('');
  }
}

/* ---- Method ---- */
push('---', '', '## Method', '');
push('- **L1** evaluates `homestay-ops/src/00_constants.gs` and compares it field by field with the generated TypeScript contract.');
push('- **L2** loads the real V1 Apps Script modules into a sandboxed Spreadsheet mock, writes the same fixture into that workbook, and asks V1’s own recomputation routines for their numbers. Those routines were written independently of this engine.');
push('- **L3** compares both against values computed by hand from the fixture, so two implementations agreeing on a wrong number is still caught.');
push('- **LIVE** reads a real spreadsheet through the service-account adapter and compares against what Google’s formula engine produced: the 99_CALC monthly block, the report-month KPI scalars, the per-property, per-platform and per-category blocks, the 08_RENT obligation columns, and every calculated column on 04_RESERVATIONS, 05_REVENUE and 06_EXPENSES. Read-only; `CFG_REPORT_MONTH` is read, never written.');
push('');
push('Fixtures use a fixed financial year (2026-04-01) so the offline report is reproducible on any machine on any day.', '');

fs.writeFileSync(OUT, L.join('\n'));

/* ------------------------------------------------------------------ *
 * Console summary — coverage table before the verdict, as the gate requires.
 * ------------------------------------------------------------------ */
console.log(`Parity report → ${path.relative(process.cwd(), OUT)}`);
console.log('');
console.log('Coverage');
console.log('  ' + 'Family'.padEnd(32) + 'Comparisons'.padStart(12) + '  Status');
if (!liveRan) {
  for (const family of live?.families ?? []) {
    console.log('  ' + String(family).padEnd(32) + String(0).padStart(12) + '  NOT RUN');
  }
} else {
  for (const f of coverage) {
    console.log('  ' + String(f.family).padEnd(32) + String(f.checks).padStart(12) + '  ' + f.status);
  }
}
console.log('');
if (missingScenarios.length) {
  console.log(`Scenarios missing from the copy: ${missingScenarios.map((s) => s.name).join(', ')}`);
  console.log('');
}
console.log(`  offline: ${offline.passed}/${offline.total} passed, ${offline.failed} failed`);
for (const layer of offline.byLayer) console.log(`    ${layer.layer.padEnd(15)} ${layer.total - layer.failed}/${layer.total}`);
console.log(`  live:    ${liveRan ? `${liveRows.length - liveFailures.length}/${liveRows.length} passed` : 'not run'}`);
console.log('');
console.log(`  OFFLINE: ${offlinePass ? 'PASS' : 'FAIL'}`);
console.log(`  ${verdict}`);
console.log(`  OVERALL PARITY GATE: ${overallGate}`);
console.log(`  ${verdictReason}`);

process.exit(overallGate === 'FAIL' ? 1 : 0);

/**
 * A first guess at where a live mismatch comes from, from the shape of the difference.
 * Deliberately conservative: it never claims the V1 formula is wrong, because that is a
 * management call, not a script's.
 */
function triage(r) {
  if (r.clockSensitive) return 'harness — clock/timezone, or a genuinely time-dependent formula. Re-run and see if it moves.';
  if (typeof r.sheet !== 'number' || typeof r.typescript !== 'number') return 'TypeScript port — text/date output differs from the workbook column.';
  if (r.sheet === 0 && r.typescript !== 0) return 'fixture — the workbook has no value here; check the copy is seeded and the range is right.';
  if (r.typescript === 0 && r.sheet !== 0) return 'TypeScript port — the engine produced nothing where the workbook produced a figure.';
  const ratio = Math.abs(r.delta) / Math.max(Math.abs(r.sheet), 1e-9);
  if (ratio < 1e-6) return 'Google Sheets semantics — last-bit floating point; consider whether the tolerance is right for this metric.';
  if (Math.abs(ratio - 1) < 1e-9) return 'TypeScript port — one side is double or half the other; check a sum being counted twice.';
  return 'TypeScript port — a real arithmetic difference. Compare the named range against the engine function.';
}
