/**
 * OPERATIONS FINANCIAL BOUNDARY (M-UI-0).
 *
 * The RBAC suite proves the capability TABLE; this suite proves the COLUMNS — the gap the
 * leak lived in. /admin/properties and /admin/reservations sit behind capabilities
 * OPERATIONS legitimately holds, and until this milestone they rendered net revenue,
 * profit, gross booking value and expected payout to that role anyway.
 *
 * The fix is a server-side projection (lib/data/views/role-projections.ts), so the tests
 * check three layers: the projection itself (fields never exist), the rendered tables
 * (nothing financial in the output), and the wiring (the pages actually apply it — a
 * revert to the unprojected render fails here, not in review).
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { render, cleanup } from '@testing-library/react';
import { createElement } from 'react';
import fs from 'node:fs';
import path from 'node:path';

import { FixtureDashboardDataProvider } from '@/lib/data/providers/fixture-provider';
import type { PropertyBoardRow, ReservationRow } from '@/lib/data/providers/types';
import {
  operationalPropertyRows, operationalReservationRows,
  PROPERTY_FIELDS_WITHHELD_FROM_OPERATIONS, RESERVATION_FIELDS_WITHHELD_FROM_OPERATIONS,
} from '@/lib/data/views/role-projections';
import { ROLES, roleSeesFinancialFigures, type Role } from '@/lib/shared/roles';
import {
  FinancialPropertyTable, OperationalPropertyTable, FinancialReservationsTable,
} from '@/components/pages/RegisterTables';
import { OpsReservationsTable } from '@/components/pages/OpsTables';
import { ToastProvider } from '@/components/ui/toast';
import {
  AppRouterContext, type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import { createHarness, USERS } from './support/harness';

const ROOT = process.cwd();
const provider = new FixtureDashboardDataProvider({ now: () => new Date('2027-01-19T10:00:00Z') });

async function fullPropertyRows(): Promise<{ rows: PropertyBoardRow[]; period: string }> {
  const months = await provider.getAvailableMonths();
  const { data, meta } = await provider.getProperties({ month: months[months.length - 1]! });
  return { rows: data, period: meta.period };
}

/** The demo year has two deliberately empty months; walk back to one with bookings. */
async function fullReservationRows(): Promise<{ rows: ReservationRow[]; period: string }> {
  const months = await provider.getAvailableMonths();
  for (const month of [...months].reverse()) {
    const { data, meta } = await provider.getReservations({ month });
    if (data.length > 0) return { rows: data, period: meta.period };
  }
  throw new Error('No demo month carries reservations — the fixture dataset changed.');
}

/**
 * RowActionButton reads the toast context and (via useMutation) the app router, so the
 * table renders need both. The router is inert — no navigation happens in these tests.
 */
const inertRouter = {
  push: () => {}, replace: () => {}, refresh: () => {},
  back: () => {}, forward: () => {}, prefetch: () => {},
} as unknown as AppRouterInstance;

function renderWithToasts(ui: Parameters<typeof render>[0]) {
  return render(createElement(
    AppRouterContext.Provider, { value: inertRouter },
    createElement(ToastProvider, null, ui),
  ));
}

function codeOnly(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

function pageSource(rel: string): string {
  return codeOnly(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}

beforeEach(() => cleanup());

/* ================================================================== *
 * 1 · The gate — derived from the grants table, never a hand-kept list
 * ================================================================== */

describe('role gate · who sees financial columns', () => {
  it('management sees figures; operations and investors do not', () => {
    const expected: Record<Role, boolean> = {
      SUPER_ADMIN: true, ADMIN: true, OPERATIONS: false, INVESTOR: false,
    };
    for (const role of ROLES) {
      expect(roleSeesFinancialFigures(role), role).toBe(expected[role]);
    }
  });
});

/* ================================================================== *
 * 2 · The projections — forbidden fields never exist on the output
 * ================================================================== */

describe('property projection', () => {
  it('carries exactly the operational allowlist, nothing else', async () => {
    const { rows } = await fullPropertyRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const projected of operationalPropertyRows(rows)) {
      expect(Object.keys(projected).sort()).toEqual([
        'bedrooms', 'bhkType', 'floor', 'listingStatus', 'maxGuests',
        'occupancyPct', 'propertyId', 'status', 'statusDetail', 'unit',
      ]);
    }
  });

  it('names real engine fields in its ban list — a rename cannot make it vacuous', async () => {
    const { rows } = await fullPropertyRows();
    for (const field of PROPERTY_FIELDS_WITHHELD_FROM_OPERATIONS) {
      expect(rows[0], field).toHaveProperty(field);
    }
  });

  it('drops fields it was never told about — allowlist, not omit-list', () => {
    const smuggled = {
      propertyId: 'HYD-999', unit: 'Test Unit', bhkType: '2 BHK', floor: 9, bedrooms: 2,
      maxGuests: 4, listingStatus: 'Live', status: 'Available', statusDetail: null,
      occupancyPct: 50, netRevenue: 80825, directOperatingExpenses: 12345, profit: 47965,
      occupiedNights: 15, availableNights: 30, adr: 4200, revPar: 2100, bookings: 5,
      // A column that does not exist yet. An omit-based projection would pass it through.
      confidentialMargin: 0.42,
    } as unknown as PropertyBoardRow;

    const [projected] = operationalPropertyRows([smuggled]);
    expect(projected).not.toHaveProperty('confidentialMargin');
    for (const field of PROPERTY_FIELDS_WITHHELD_FROM_OPERATIONS) {
      expect(projected, field).not.toHaveProperty(field);
    }
  });
});

describe('reservation projection', () => {
  it('carries exactly the operational allowlist, nothing else', async () => {
    const { rows } = await fullReservationRows();
    for (const projected of operationalReservationRows(rows)) {
      expect(Object.keys(projected).sort()).toEqual([
        'bookingId', 'bookingStatus', 'checkIn', 'checkOut',
        'guestDisplayName', 'nights', 'platform', 'propertyId',
      ]);
    }
  });

  it('names real engine fields in its ban list', async () => {
    const { rows } = await fullReservationRows();
    for (const field of RESERVATION_FIELDS_WITHHELD_FROM_OPERATIONS) {
      expect(rows[0], field).toHaveProperty(field);
    }
  });

  it('builds fresh literals — never a spread that would carry future columns', () => {
    const source = codeOnly(fs.readFileSync(
      path.join(ROOT, 'lib/data/views/role-projections.ts'), 'utf8'));
    expect(source).not.toMatch(/\.\.\./);
  });
});

/* ================================================================== *
 * 3 · The rendered tables — the leak was in the HTML, so prove the HTML
 * ================================================================== */

describe('rendered columns · properties', () => {
  it('the operational table renders no financial column and no rupee anywhere', async () => {
    const { rows, period } = await fullPropertyRows();
    const { container } = renderWithToasts(
      createElement(OperationalPropertyTable, { rows: operationalPropertyRows(rows), period }));
    const text = container.textContent ?? '';
    expect(text).not.toContain('₹');
    expect(text).not.toContain('Net revenue');
    expect(text).not.toContain('Profit');
    expect(text).toContain('Status');
    // The operational columns survive: identity and state, per row.
    expect(text).toContain(rows[0]!.propertyId);
  });

  it('the financial table keeps its figures for the roles entitled to them', async () => {
    const { rows, period } = await fullPropertyRows();
    const { container } = renderWithToasts(
      createElement(FinancialPropertyTable, { rows, period }));
    const text = container.textContent ?? '';
    expect(text).toContain('Net revenue');
    expect(text).toContain('Profit');
    expect(text).toContain('₹');
  });
});

describe('rendered columns · reservations', () => {
  it('the operational table renders no value, payout or rupee', async () => {
    const { rows } = await fullReservationRows();
    const { container } = renderWithToasts(
      createElement(OpsReservationsTable, { rows: operationalReservationRows(rows) }));
    const text = container.textContent ?? '';
    expect(text).not.toContain('₹');
    expect(text).not.toContain('Gross value');
    expect(text).not.toContain('Expected payout');
    expect(text).not.toContain('Payout');
    expect(text).toContain(rows[0]!.bookingId);
  });

  it('the financial table keeps gross value and expected payout', async () => {
    const { rows, period } = await fullReservationRows();
    const { container } = renderWithToasts(
      createElement(FinancialReservationsTable, { rows, period }));
    const text = container.textContent ?? '';
    expect(text).toContain('Gross value');
    expect(text).toContain('Expected payout');
    expect(text).toContain('₹');
  });
});

/* ================================================================== *
 * 4 · The wiring — the pages must actually apply the projection
 * ================================================================== */

describe('page wiring · a revert to the unprojected render fails here', () => {
  it('/admin/properties branches on the role gate and projects', () => {
    const source = pageSource('app/admin/properties/page.tsx');
    expect(source).toContain('roleSeesFinancialFigures');
    expect(source).toContain('operationalPropertyRows');
    expect(source).toContain('OperationalPropertyTable');
  });

  it('/admin/reservations branches on the role gate and projects', () => {
    const source = pageSource('app/admin/reservations/page.tsx');
    expect(source).toContain('roleSeesFinancialFigures');
    expect(source).toContain('operationalReservationRows');
    expect(source).toContain('OpsReservationsTable');
  });

  it('the operations reservations screen projects for every role', () => {
    const source = pageSource('app/admin/operations/reservations/page.tsx');
    expect(source).toContain('operationalReservationRows');
  });

  it('the operations table takes the projected type, so a financial cell cannot typecheck', () => {
    const source = fs.readFileSync(
      path.join(ROOT, 'components/pages/OpsTables.tsx'), 'utf8');
    expect(source).toContain('rows: OperationalReservationRow[]');
    expect(codeOnly(source)).not.toMatch(/grossValue|expectedPayout|actualPayout|payoutStatus/);
  });
});

/* ================================================================== *
 * 5 · The HTTP surface — nothing serves these rows over the API today
 * ================================================================== */

describe('HTTP surface', () => {
  it('GET /api/reservations is unimplemented — whoever builds it inherits this suite', async () => {
    /*
     * The production service registers no GET handler for the register reads, so the
     * router answers 501 for every role. If this test ever fails because the endpoint
     * became real, the implementation must apply the same role projection before this
     * assertion is loosened — a 200 here with financial fields for OPERATIONS is the
     * same leak this milestone closed, moved one layer down.
     */
    const h = createHarness();
    const res = await h.request(USERS.operations!, 'GET', '/api/reservations');
    expect(res.status).toBe(501);
    expect(JSON.stringify(res.body)).not.toMatch(/grossValue|expectedPayout|actualPayout/);
  });
});
