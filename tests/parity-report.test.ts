/**
 * The parity verdict.
 *
 * The verdict is the one line anyone will actually read, so it is computed from the
 * evidence and never asserted. The rule that matters most is the one a green tally hides:
 * **a metric family with zero comparisons can never produce a PASS.** A family nobody
 * compared is missing evidence, and missing evidence is not agreement.
 *
 * These run the real script against synthetic evidence, in a temporary directory, and
 * read the verdict it prints — rather than testing a re-implementation of the rule.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const SCRIPT = path.resolve(process.cwd(), 'scripts/parity-report.mjs');
let dir: string;

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'srivillu-parity-report-'));
  fs.mkdirSync(path.join(dir, 'reports'));
});
afterAll(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });

const FAMILIES = ['monthly revenue', 'rent', 'payout reconciliation'];

function offline({ failed = 0 } = {}) {
  return {
    generatedAt: '2026-08-23T00:00:00.000Z',
    total: 212, passed: 212 - failed, failed,
    byLayer: [{ layer: 'L1 contract', total: 62, failed }],
    rows: failed
      ? [{ layer: 'L1 contract', scenario: 'S1', metric: 'NetRevenue', sheet: 1, typescript: 2, difference: 1, pass: false }]
      : [],
  };
}

function liveRun(rows: Array<Record<string, unknown>>, byFamily: Array<{ family: string; checks: number; failed: number }>) {
  return {
    generatedAt: '2026-08-23T00:00:00.000Z',
    spreadsheetId: '…abc123', spreadsheetTitle: 'Ops — PARITY COPY',
    timeZone: 'Asia/Kolkata', sheetToday: '2026-08-23', reportMonth: '2026-06',
    months: ['2026-06'], total: rows.length, failed: rows.filter((r) => !r.pass).length,
    byFamily,
    bySection: [{ section: 'Monthly block', checks: rows.length, failed: rows.filter((r) => !r.pass).length }],
    scenarios: [{ name: 'cancellation', present: true, where: '2026-06', checks: 1, failed: 0 }],
    notCompared: [], rows,
  };
}

const row = (pass: boolean, family = 'monthly revenue') => ({
  family, section: 'Monthly block', subject: '2026-06', metric: 'NetRevenue',
  sheet: 100, typescript: pass ? 100 : 250, delta: pass ? 0 : 150,
  tolerance: 0.01, pass, source: '99_CALC!B17',
});

/** Runs the real report script over synthetic evidence. Returns stdout and exit code. */
function render(offlineJson: unknown, liveJson: unknown) {
  fs.writeFileSync(path.join(dir, 'reports/parity.json'), JSON.stringify(offlineJson));
  fs.writeFileSync(path.join(dir, 'reports/parity.live.json'), JSON.stringify(liveJson));
  const result = spawnSync(process.execPath, [SCRIPT], { cwd: dir, encoding: 'utf8', shell: false });
  return {
    stdout: result.stdout ?? '',
    code: result.status,
    markdown: fs.readFileSync(path.join(dir, 'reports/PARITY_REPORT.md'), 'utf8'),
  };
}

describe('verdict · exactly three strings', () => {
  it('LIVE PENDING when the suite has not run', () => {
    const { stdout, code, markdown } = render(offline(), {
      status: 'NOT RUN', reason: 'not configured', total: 0, failed: 0,
      families: FAMILIES, byFamily: [], bySection: [], scenarios: [], notCompared: [], rows: [],
    });
    expect(stdout).toContain('LIVE PENDING');
    expect(stdout).not.toContain('LIVE PASS');
    expect(markdown).toContain('**LIVE PENDING**');
    expect(code).toBe(0);   // a known state, not a broken build
  });

  it('LIVE PASS when every comparison agrees and every family was covered', () => {
    const { stdout, code, markdown } = render(offline(), liveRun(
      FAMILIES.map((f) => row(true, f)),
      FAMILIES.map((family) => ({ family, checks: 4, failed: 0 })),
    ));
    expect(stdout).toContain('LIVE PASS');
    expect(stdout).toContain('OVERALL PARITY GATE: PASS');
    expect(markdown).toContain('**LIVE PASS**');
    expect(code).toBe(0);
  });

  it('LIVE FAIL when a comparison disagrees', () => {
    const { stdout, code } = render(offline(), liveRun(
      [row(true), row(false, 'rent')],
      FAMILIES.map((family) => ({ family, checks: 2, failed: family === 'rent' ? 1 : 0 })),
    ));
    expect(stdout).toContain('LIVE FAIL');
    expect(stdout).not.toContain('LIVE PASS');
    expect(code).toBe(1);
  });
});

describe('verdict · coverage can never be assumed', () => {
  it('does NOT pass when a family has zero comparisons, even with nothing failing', () => {
    const { stdout, code, markdown } = render(offline(), liveRun(
      [row(true), row(true, 'rent')],
      [
        { family: 'monthly revenue', checks: 12, failed: 0 },
        { family: 'rent', checks: 4, failed: 0 },
        { family: 'payout reconciliation', checks: 0, failed: 0 },   // never compared
      ],
    ));
    expect(stdout).toContain('LIVE FAIL');
    expect(stdout).not.toContain('LIVE PASS');
    expect(stdout).toContain('NOT COVERED');
    expect(markdown).toContain('payout reconciliation');
    expect(markdown).toContain('**NOT COVERED**');
    expect(markdown).toContain('never compared: payout reconciliation');
    expect(code).toBe(1);
  });

  it('does NOT pass when the run recorded no coverage table at all', () => {
    const { stdout, code } = render(offline(), liveRun([row(true)], []));
    expect(stdout).toContain('LIVE FAIL');
    expect(code).toBe(1);
  });

  it('prints the coverage table before the verdict, not after it', () => {
    const { stdout } = render(offline(), liveRun(
      FAMILIES.map((f) => row(true, f)),
      FAMILIES.map((family) => ({ family, checks: 4, failed: 0 })),
    ));
    expect(stdout.indexOf('Coverage')).toBeLessThan(stdout.indexOf('LIVE PASS'));
  });

  it('names every family in the report even when the suite never ran', () => {
    const { markdown } = render(offline(), {
      status: 'NOT RUN', reason: 'not configured', total: 0, failed: 0,
      families: FAMILIES, byFamily: [], bySection: [], scenarios: [], notCompared: [], rows: [],
    });
    for (const family of FAMILIES) expect(markdown).toContain(family);
    expect(markdown).toContain('NOT RUN');
  });
});

describe('report · the evidence a reader needs', () => {
  const full = () => render(offline(), liveRun(
    [row(true), row(false, 'rent')],
    FAMILIES.map((family) => ({ family, checks: 2, failed: family === 'rent' ? 1 : 0 })),
  ));

  it('identifies the run: timestamp, workbook, timezone, report month', () => {
    const { markdown } = full();
    expect(markdown).toContain('## This run');
    expect(markdown).toContain('Ops — PARITY COPY');
    expect(markdown).toContain('Asia/Kolkata');
    expect(markdown).toContain('2026-06');
    expect(markdown).toMatch(/Run at \| \d{4}-\d{2}-\d{2}T/);
  });

  it('shows the failing comparison with both values, the delta and the tolerance', () => {
    const { markdown } = full();
    expect(markdown).toContain('| Metric | TypeScript | Google Sheets | Delta | Tolerance | Result |');
    expect(markdown).toContain('99_CALC!B17');   // where the sheet value came from
    expect(markdown).toContain('Failure triage');
  });

  it('states why each tolerance exists, so none reads as a fudge factor', () => {
    const { markdown } = full();
    expect(markdown).toContain('## Tolerances');
    expect(markdown).toContain('None of them is a business allowance');
    expect(markdown).toContain('IEEE-754');
    expect(markdown).toContain('A count off by one');
  });

  it('records scenario coverage', () => {
    const { markdown } = full();
    expect(markdown).toContain('## Scenario coverage');
    expect(markdown).toContain('cancellation');
  });

  it('fails overall when the offline layers fail, whatever LIVE says', () => {
    const { stdout, code } = render(offline({ failed: 3 }), liveRun(
      FAMILIES.map((f) => row(true, f)),
      FAMILIES.map((family) => ({ family, checks: 4, failed: 0 })),
    ));
    expect(stdout).toContain('OVERALL PARITY GATE: FAIL');
    expect(code).toBe(1);
  });

  it('never prints a full spreadsheet id', () => {
    const { markdown } = full();
    expect(markdown).toContain('…abc123');
    expect(markdown).toContain('last six characters only');
  });
});
