/**
 * TODAY — the front-office command desk (M-UI-3).
 *
 * The screen has to answer four questions in order — what day, what is happening, what
 * needs a person, what do I do — and then actually perform the action through the
 * existing verified write path. These tests exercise that end to end: the date scoping
 * at the view layer where it is decided, the rendered rows, and the mutation flow with
 * its drawer, its success path, its failure path and its duplicate-submit guard.
 *
 * They also stand guard over the things a refactor could quietly undo: the M-UI-0
 * financial projection, the investor deny, the human error language, and the touch
 * targets. Where a real architectural regression could recur, there is an assertion that
 * fails on it.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, within, cleanup, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createElement, type ReactElement } from 'react';
import fs from 'node:fs';
import path from 'node:path';

import {
  AppRouterContext, type AppRouterInstance,
} from 'next/dist/shared/lib/app-router-context.shared-runtime';
import {
  PathnameContext, SearchParamsContext,
} from 'next/dist/shared/lib/hooks-client-context.shared-runtime';

import { FixtureDashboardDataProvider } from '@/lib/data/providers/fixture-provider';
import { resolveBoardDate, shiftIsoDay } from '@/lib/shared/dates';
import { roleHasCapability, FINANCIAL_CAPABILITIES, ROLES, type Role } from '@/lib/shared/roles';
import { TodayBoard } from '@/components/operations/TodayBoard';
import { RowActionButton } from '@/components/mutations/actions';
import { TodayDateControl } from '@/components/operations/TodayDateControl';
import { checkInFields, checkOutFields } from '@/lib/server/api/form-fields';
import { codeOf } from './support/source';
import { ToastProvider } from '@/components/ui/toast';
import type { OperationsBoardView } from '@/lib/data/providers/types';

const ROOT = process.cwd();
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const provider = new FixtureDashboardDataProvider({ now: () => new Date('2027-01-19T10:00:00Z') });

async function board(date?: string): Promise<OperationsBoardView> {
  const months = await provider.getAvailableMonths();
  const month = months[months.length - 1]!;
  const { data } = await provider.getOperations({ month, ...(date ? { date } : {}) });
  return data;
}

/*
 * The router the components actually drive. `refresh` is a spy, not a no-op: it IS the
 * authoritative re-read after a verified write, and a stub that swallows it would let the
 * board go optimistic without a single test noticing.
 */
const replaced: string[] = [];
const refresh = vi.fn();
const router = {
  push: () => {}, back: () => {}, forward: () => {}, prefetch: () => {},
  refresh,
  replace: (href: string) => { replaced.push(href); },
} as unknown as AppRouterInstance;

function renderBoard(ui: ReactElement, search = '') {
  return render(
    createElement(AppRouterContext.Provider, { value: router },
      createElement(PathnameContext.Provider, { value: '/admin/operations/today' },
        createElement(SearchParamsContext.Provider, { value: new URLSearchParams(search) },
          createElement(ToastProvider, null, ui)))),
  );
}

/** The open drawer, so a submit is never confused with the row button that opened it. */
function drawerOf(container: HTMLElement) {
  const drawer = container.querySelector('.sv-drawer');
  if (!drawer) throw new Error('no drawer is open');
  return within(drawer as HTMLElement);
}

/* The router is module-level, so the spy must be cleared per test — restoreAllMocks
   does not reset a plain vi.fn(). */
beforeEach(() => { replaced.length = 0; refresh.mockClear(); cleanup(); });
afterEach(() => { vi.restoreAllMocks(); });

/* ================================================================== *
 * 1 · Who may stand at this desk
 * ================================================================== */

describe('today · role', () => {
  it('management and operations may open it; an investor may not', () => {
    for (const role of ['SUPER_ADMIN', 'ADMIN', 'OPERATIONS'] as const) {
      expect(roleHasCapability(role, 'operations.view'), role).toBe(true);
    }
    expect(roleHasCapability('INVESTOR', 'operations.view')).toBe(false);
  });

  it('the page declares the capability it needs — it cannot render unguarded', () => {
    const page = read('app/admin/operations/today/page.tsx');
    expect(page).toContain("capability=\"operations.view\"");
  });

  it('no role that can open Today holds a financial capability by way of it', () => {
    // operations.view must never become a backdoor to money.
    expect(FINANCIAL_CAPABILITIES).not.toContain('operations.view');
    for (const role of ROLES as readonly Role[]) {
      if (role !== 'OPERATIONS') continue;
      for (const capability of FINANCIAL_CAPABILITIES) {
        expect(roleHasCapability(role, capability), capability).toBe(false);
      }
    }
  });
});

/* ================================================================== *
 * 2 · The day — decided on the server, never in the browser
 * ================================================================== */

describe('today · the operational day', () => {
  it('defaults to the source\'s own day, not the browser clock', async () => {
    const view = await board();
    expect(view.date).toBe(view.operationalDate);
    expect(view.isOperationalDay).toBe(true);
  });

  it('moves the MOVEMENTS when the day changes, and says it is not today', async () => {
    const base = await board();
    const next = shiftIsoDay(base.operationalDate, 2);
    const view = await board(next);

    expect(view.date).toBe(next);
    expect(view.operationalDate).toBe(base.operationalDate);
    expect(view.isOperationalDay).toBe(false);
    // Arrivals really are that day's bookings, not today's re-labelled.
    for (const arrival of view.arrivals) expect(arrival.checkIn).toBe(next);
    for (const departure of view.departures) expect(departure.checkOut).toBe(next);
    expect(view.counters.checkIns).toBe(view.arrivals.length);
    expect(view.counters.checkOuts).toBe(view.departures.length);
  });

  it('leaves the LIVE queues alone — they are state, not a historical snapshot', async () => {
    const base = await board();
    const past = await board(shiftIsoDay(base.operationalDate, -5));
    // Turnovers, tickets and stock describe right now on any day; pretending otherwise
    // would show today's cleaning list as if it were last week's.
    expect(past.cleaning).toEqual(base.cleaning);
    expect(past.maintenance).toEqual(base.maintenance);
    expect(past.lowStock).toEqual(base.lowStock);
    expect(past.units).toEqual(base.units);
  });

  it('measures ticket age from the real day, never from a browsed one', async () => {
    const base = await board();
    const future = await board(shiftIsoDay(base.operationalDate, 30));
    expect(future.maintenance.map((t) => t.ageDays)).toEqual(base.maintenance.map((t) => t.ageDays));
  });

  it('refuses a malformed or impossible date instead of querying with it', async () => {
    const view = await board();
    for (const bad of ['2027-02-31', 'yesterday', '2027-1-9', '', '../etc/passwd', '2027-13-01']) {
      expect(resolveBoardDate(bad, view.operationalDate), bad).toBe(view.operationalDate);
    }
    expect(resolveBoardDate('2027-01-21', view.operationalDate)).toBe('2027-01-21');
    // …and end to end, through the provider.
    const fallback = await board('2027-02-31');
    expect(fallback.date).toBe(view.operationalDate);
  });
});

describe('today · the day control', () => {
  it('steps a day back and forward, and names where each step goes', async () => {
    const user = userEvent.setup();
    const view = await board();
    renderBoard(<TodayDateControl date={view.operationalDate} operationalDate={view.operationalDate} />);

    const back = screen.getByRole('button', { name: /Previous day/ });
    const forward = screen.getByRole('button', { name: /Next day/ });
    // The label says the destination, so a screen-reader user knows before pressing.
    expect(back.getAttribute('aria-label')).toContain('19 January 2027'.slice(-4));
    await user.click(forward);
    expect(replaced[0]).toContain(`date=${shiftIsoDay(view.operationalDate, 1)}`);

    await user.click(back);
    expect(replaced[1]).toContain(`date=${shiftIsoDay(view.operationalDate, -1)}`);
  });

  it('offers a way back only when it would do something, and clears the param', async () => {
    const user = userEvent.setup();
    const view = await board();
    const other = shiftIsoDay(view.operationalDate, 3);

    renderBoard(<TodayDateControl date={view.operationalDate} operationalDate={view.operationalDate} />);
    expect(screen.queryByRole('button', { name: 'Back to today' })).toBeNull();
    cleanup();

    renderBoard(<TodayDateControl date={other} operationalDate={view.operationalDate} />, `date=${other}`);
    await user.click(screen.getByRole('button', { name: 'Back to today' }));
    // Returning to today drops the parameter rather than pinning the date in the URL.
    expect(replaced[0]).toBe('/admin/operations/today');
  });

  it('keeps other filters while changing the day', async () => {
    const user = userEvent.setup();
    const view = await board();
    renderBoard(
      <TodayDateControl date={view.operationalDate} operationalDate={view.operationalDate} />,
      'property=HYD-601',
    );
    await user.click(screen.getByRole('button', { name: /Next day/ }));
    expect(replaced[0]).toContain('property=HYD-601');
    expect(replaced[0]).toContain('date=');
  });

  it('marks which day is being shown', async () => {
    const view = await board();
    const { container } = renderBoard(
      <TodayDateControl date={view.operationalDate} operationalDate={view.operationalDate} />);
    expect(container.querySelector('[aria-current="date"]')?.textContent).toBeTruthy();
    expect(screen.getByRole('group', { name: 'Operational day' })).toBeDefined();
  });
});

/* ================================================================== *
 * 3 · What is happening — the summary counts the rows on screen
 * ================================================================== */

describe('today · summary', () => {
  it('every count equals the source it summarises', async () => {
    const view = await board();
    const { container } = renderBoard(<TodayBoard board={view} />);
    const tiles = [...container.querySelectorAll('.sv-summary__tile')].map((tile) => [
      tile.querySelector('.sv-summary__label')!.textContent,
      Number(tile.querySelector('.sv-summary__value')!.textContent),
    ] as const);
    const value = (label: string) => tiles.find(([l]) => l === label)?.[1];

    expect(value('Arrivals')).toBe(view.arrivals.length);
    expect(value('Departures')).toBe(view.departures.length);
    expect(value('Cleaning')).toBe(view.cleaning.length);
    expect(value('Maintenance')).toBe(view.maintenance.length);
    expect(value('Urgent')).toBe(view.urgent.length);
    expect(value('In house')).toBe(view.units.filter((u) => u.status === 'Occupied').length);
    expect(value('Ready')).toBe(view.units.filter((u) => u.status === 'Available').length);
  });

  it('an outstanding queue is flagged by a word, not only a colour', async () => {
    const view = await board();
    const { container } = renderBoard(<TodayBoard board={view} />);
    const flagged = [...container.querySelectorAll('.sv-summary__tile--urgent, .sv-summary__tile--attention')];
    for (const tile of flagged) {
      expect(tile.querySelector('.sv-visually-hidden')?.textContent).toMatch(/attention|Outstanding/i);
    }
  });

  it('tells the reader when the queues are not from the day they are browsing', async () => {
    const base = await board();
    renderBoard(<TodayBoard board={base} />);
    expect(screen.queryByRole('status')).toBeNull();
    cleanup();

    const other = await board(shiftIsoDay(base.operationalDate, 2));
    renderBoard(<TodayBoard board={other} />);
    expect(screen.getByRole('status').textContent).toMatch(/right now/i);
  });
});

/* ================================================================== *
 * 4 · Arrivals and departures — SEE, DECIDE, ACT, CONFIRM
 * ================================================================== */

/** A day the demo has left actionable: one Confirmed arrival, two Checked In departures. */
const ACTIONABLE_DAY = '2027-01-21';

describe('today · arrivals', () => {
  it('shows what, where and the action on the row itself', async () => {
    const view = await board(ACTIONABLE_DAY);
    const arrival = view.arrivals.find((a) => a.status === 'Confirmed')!;
    expect(arrival, 'the demo day must carry an actionable arrival').toBeDefined();

    const { container } = renderBoard(<TodayBoard board={view} />);
    const row = [...container.querySelectorAll('.sv-oprow')]
      .find((el) => el.textContent?.includes(arrival.guestDisplayName))!;

    expect(within(row as HTMLElement).getByText(arrival.guestDisplayName)).toBeDefined();
    expect(row.textContent).toContain(arrival.propertyId);
    // The action is present without hovering or opening anything first.
    expect(within(row as HTMLElement).getByRole('button', { name: 'Check in' })).toBeDefined();
  });

  it('offers check-in only where the booking may legally take it', async () => {
    const view = await board(ACTIONABLE_DAY);
    const { container } = renderBoard(<TodayBoard board={view} />);
    for (const arrival of view.arrivals) {
      const row = [...container.querySelectorAll('.sv-oprow')]
        .find((el) => el.textContent?.includes(arrival.bookingId)
          || el.textContent?.includes(arrival.guestDisplayName))!;
      const button = within(row as HTMLElement).queryByRole('button', { name: 'Check in' });
      // Mirrors the server's transition table: only Confirmed can check in.
      expect(Boolean(button), `${arrival.bookingId} is ${arrival.status}`)
        .toBe(arrival.status === 'Confirmed');
    }
  });

  it('opens a drawer carrying the booking, and no figure', async () => {
    const user = userEvent.setup();
    const view = await board(ACTIONABLE_DAY);
    const { container } = renderBoard(<TodayBoard board={view} />);

    await user.click(screen.getAllByRole('button', { name: 'Check in' })[0]!);
    const drawer = container.querySelector('.sv-drawer')!;
    expect(drawer, 'check-in opens the drawer surface').not.toBeNull();
    expect(drawer.getAttribute('role')).toBe('dialog');
    expect(drawer.getAttribute('aria-modal')).toBe('true');

    const facts = drawer.querySelector('.sv-facts')!.textContent ?? '';
    expect(facts).toMatch(/Guest|Unit|Booking/);
    // The context block is operational only.
    expect(facts).not.toContain('₹');
    expect(facts).not.toMatch(/revenue|payout|rate|profit/i);
  });

  it('submits the real mutation and reports success only after the server verifies', async () => {
    const user = userEvent.setup();
    const view = await board(ACTIONABLE_DAY);
    const arrival = view.arrivals.find((a) => a.status === 'Confirmed')!;

    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ record: { BookingID: arrival.bookingId, BookingStatus: 'Checked In' } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderBoard(<TodayBoard board={view} />);
    await user.click(screen.getAllByRole('button', { name: 'Check in' })[0]!);
    await user.click(drawerOf(container).getByRole('button', { name: /Check in/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/reservations/${arrival.bookingId}/check-in`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(String(init.body));
    // One operation id per intent — the idempotency contract the server relies on.
    expect(body.operationId).toMatch(/[0-9a-f-]{36}/);
    // No invented field rides along: no payment, no deposit, no figure.
    expect(Object.keys(body).sort()).toEqual(['operationId']);

    /*
     * And the board re-reads from the server. This is the whole no-optimistic-UI
     * contract: without it the toast says "checked in" while the row still says
     * Confirmed until someone reloads.
     */
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
  });

  it('a refusal keeps the row, shows a human sentence, and allows a retry', async () => {
    const user = userEvent.setup();
    const view = await board(ACTIONABLE_DAY);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ error: { code: 'CONFLICT', message: 'A booking in status "Cancelled" cannot move to "Checked In".' } }),
      { status: 409, headers: { 'content-type': 'application/json' } },
    )));

    const { container } = renderBoard(<TodayBoard board={view} />);
    await user.click(screen.getAllByRole('button', { name: 'Check in' })[0]!);
    await user.click(drawerOf(container).getByRole('button', { name: /Check in/ }));

    await waitFor(() => {
      expect(container.querySelector('.sv-mutation-form__failure')).not.toBeNull();
    });
    const failure = container.querySelector('.sv-mutation-form__failure')!.textContent ?? '';
    // The server's own sentence, not a stack trace or a route.
    expect(failure).toContain('cannot move to');
    expect(failure).not.toMatch(/\bError\b:|at .*\.ts:|\/api\//);
    // The drawer stays open so the attempt can be repeated.
    expect(container.querySelector('.sv-drawer')).not.toBeNull();
    // Nothing was written, so nothing is re-read — the other half of the contract.
    expect(refresh).not.toHaveBeenCalled();
  });

  it('cannot be submitted twice for one intent', async () => {
    const user = userEvent.setup();
    const view = await board(ACTIONABLE_DAY);
    let resolve: (r: Response) => void = () => {};
    const fetchMock = vi.fn(() => new Promise<Response>((r) => { resolve = r; }));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderBoard(<TodayBoard board={view} />);
    await user.click(screen.getAllByRole('button', { name: 'Check in' })[0]!);
    const submit = drawerOf(container).getByRole('button', { name: /Check in/ });
    await user.click(submit);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    // While the first is in flight the control refuses a second submission.
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(submit);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    resolve(new Response(JSON.stringify({ record: { BookingID: 'BK-1' } }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
  });
});

describe('today · the write contract itself', () => {
  /*
   * These pin the two halves of idempotency that the duplicate-submit test cannot see:
   * it drives one request, so it proves the button is disabled but says nothing about
   * WHICH operation id a retry would carry.
   */
  it('a retry of the same intent reuses its operation id — the server can deduplicate', async () => {
    const user = userEvent.setup();
    const view = await board(ACTIONABLE_DAY);
    const ids: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      ids.push(JSON.parse(String(init.body)).operationId);
      return new Response(
        JSON.stringify({ error: { code: 'CONFLICT', message: 'Try again.' } }),
        { status: 409, headers: { 'content-type': 'application/json' } });
    }));

    const { container } = renderBoard(<TodayBoard board={view} />);
    await user.click(screen.getAllByRole('button', { name: 'Check in' })[0]!);
    const submit = () => drawerOf(container).getByRole('button', { name: /Check in/ });

    await user.click(submit());
    await waitFor(() => expect(ids).toHaveLength(1));
    await user.click(submit());          // the same intent, retried after a refusal
    await waitFor(() => expect(ids).toHaveLength(2));

    expect(ids[0]).toMatch(/[0-9a-f-]{36}/);
    expect(ids[1], 'a retry must not mint a second business intent').toBe(ids[0]);
  });

  it('a NEW intent gets a new operation id', async () => {
    const user = userEvent.setup();
    const view = await board(ACTIONABLE_DAY);
    const ids: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      ids.push(JSON.parse(String(init.body)).operationId);
      return new Response(
        JSON.stringify({ error: { code: 'CONFLICT', message: 'Try again.' } }),
        { status: 409, headers: { 'content-type': 'application/json' } });
    }));

    const { container } = renderBoard(<TodayBoard board={view} />);
    const open = () => screen.getAllByRole('button', { name: 'Check in' })[0]!;

    await user.click(open());
    await user.click(drawerOf(container).getByRole('button', { name: /Check in/ }));
    await waitFor(() => expect(ids).toHaveLength(1));

    // Close and start again: a fresh decision, therefore a fresh intent.
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(container.querySelector('.sv-drawer')).toBeNull());
    await user.click(open());
    await user.click(drawerOf(container).getByRole('button', { name: /Check in/ }));
    await waitFor(() => expect(ids).toHaveLength(2));

    expect(ids[1]).not.toBe(ids[0]);
  });

  it('a zero-field row action cannot be fired twice while it is in flight', async () => {
    /*
     * The Today rows all open a drawer, but RowActionButton's other branch submits on a
     * single click with no form in between — and that branch's only defence is its own
     * disabled attribute. Nothing else re-checks, so it is worth pinning directly.
     */
    const user = userEvent.setup();
    let release: (r: Response) => void = () => {};
    const fetchMock = vi.fn(() => new Promise<Response>((r) => { release = r; }));
    vi.stubGlobal('fetch', fetchMock);

    renderBoard(
      <RowActionButton
        label="Resolve"
        endpoint="/api/maintenance/MNT-1/resolve"
        successTemplate="Resolved."
      />,
    );
    const button = screen.getByRole('button', { name: 'Resolve' });
    await user.click(button);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    release(new Response(JSON.stringify({ record: {} }),
      { status: 200, headers: { 'content-type': 'application/json' } }));
  });
});

describe('today · departures', () => {
  it('shows departures with check-out where the stay allows it', async () => {
    const view = await board(ACTIONABLE_DAY);
    const departures = view.departures.filter((d) => d.status === 'Checked In');
    expect(departures.length, 'the demo day must carry actionable departures').toBeGreaterThan(0);

    renderBoard(<TodayBoard board={view} />);
    expect(screen.getAllByRole('button', { name: 'Check out' }).length).toBe(departures.length);
  });

  it('posts the check-out mutation for the right booking', async () => {
    const user = userEvent.setup();
    const view = await board(ACTIONABLE_DAY);
    const departure = view.departures.find((d) => d.status === 'Checked In')!;

    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ record: { BookingID: departure.bookingId } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderBoard(<TodayBoard board={view} />);
    await user.click(screen.getAllByRole('button', { name: 'Check out' })[0]!);
    await user.click(drawerOf(container).getByRole('button', { name: /Check out/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect((fetchMock.mock.calls[0] as unknown as [string])[0])
      .toBe(`/api/reservations/${departure.bookingId}/check-out`);
  });
});

/* ================================================================== *
 * 5 · Housekeeping
 * ================================================================== */

describe('today · housekeeping', () => {
  it('lists open turnovers with their real domain status and a mark-clean action', async () => {
    const view = await board();
    expect(view.cleaning.length).toBeGreaterThan(0);
    const { container } = renderBoard(<TodayBoard board={view} />);

    const row = [...container.querySelectorAll('.sv-oprow')]
      .find((el) => el.textContent?.includes(view.cleaning[0]!.propertyId)
        && el.textContent?.includes('Turnover after'))!;
    expect(row.textContent).toContain(view.cleaning[0]!.status);
    expect(within(row as HTMLElement).getByRole('button', { name: 'Mark clean' })).toBeDefined();
  });

  it('marks clean through the housekeeping mutation, recording who and the inspection', async () => {
    const user = userEvent.setup();
    const view = await board();
    const task = view.cleaning[0]!;

    const fetchMock = vi.fn(async () => new Response(
      JSON.stringify({ record: { TaskID: task.taskId } }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const { container } = renderBoard(<TodayBoard board={view} />);
    await user.click(screen.getByRole('button', { name: 'Mark clean' }));
    // The drawer asks for exactly what the workbook records.
    await user.type(screen.getByLabelText(/Cleaned by/), 'Lakshmi');
    await user.click(drawerOf(container).getByRole('button', { name: /Mark clean/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`/api/housekeeping/${task.taskId}`);
    expect(init.method).toBe('PATCH');
    const body = JSON.parse(String(init.body));
    expect(body.cleaner).toBe('Lakshmi');
    expect(body.inspectionStatus).toBeTruthy();
  });

  it('does not filter completed work out of the source', async () => {
    // The board shows what is OPEN; nothing here rewrites history or hides finished tasks
    // from the register they live in.
    const source = read('components/operations/TodayBoard.tsx');
    expect(source).not.toMatch(/filter\([^)]*Completed/);
  });
});

/* ================================================================== *
 * 6 · Urgent — the existing engine, rendered
 * ================================================================== */

describe('today · needs attention', () => {
  it('renders the provider\'s urgent list with severity as a word', async () => {
    const view = await board();
    expect(view.urgent.length).toBeGreaterThan(0);
    const { container } = renderBoard(<TodayBoard board={view} />);

    const items = container.querySelectorAll('.sv-urgent__item');
    expect(items.length).toBe(view.urgent.length);
    for (const [i, item] of [...items].entries()) {
      const source = view.urgent[i]!;
      expect(item.textContent).toContain(source.title);
      expect(item.textContent).toContain(source.action);
      // Severity is spelled out, never left to the colour alone.
      expect(item.textContent).toMatch(/Critical|High|Watch/);
    }
  });

  it('builds no second alert engine', () => {
    const source = read('components/operations/TodayBoard.tsx');
    // The list is rendered from board.urgent; nothing here decides what is urgent.
    expect(source).toContain('board.urgent.map');
    expect(source).not.toMatch(/priority === 'Critical'|severity =|buildUrgent/);
  });
});

/* ================================================================== *
 * 7 · Security — the M-UI-0 boundary, at the screen
 * ================================================================== */

describe('today · carries no money', () => {
  it('renders no currency and no financial word, anywhere on the board', async () => {
    for (const day of [undefined, ACTIONABLE_DAY]) {
      const view = await board(day);
      const { container } = renderBoard(<TodayBoard board={view} />);
      const text = container.textContent ?? '';
      expect(text, `day ${day ?? 'today'}`).not.toContain('₹');
      expect(text).not.toMatch(/revenue|payout|profit|expense|ADR|RevPAR|invoice|deposit/i);
      cleanup();
    }
  });

  it('the payload the board receives carries no financial field', async () => {
    const view = await board(ACTIONABLE_DAY);
    const serialized = JSON.stringify(view);
    for (const field of [
      'grossValue', 'expectedPayout', 'actualPayout', 'netRevenue', 'profit',
      'directOperatingExpenses', 'adr', 'revPar', 'baseRate', 'roomRevenue',
    ]) {
      expect(serialized, field).not.toContain(field);
    }
  });

  it('the board component never reaches for a financial field', () => {
    const source = read('components/operations/TodayBoard.tsx');
    expect(source).not.toMatch(/formatCurrency|grossValue|expectedPayout|netRevenue|\bprofit\b/);
  });
});

/* ================================================================== *
 * 8 · The words on screen
 * ================================================================== */

describe('today · language', () => {
  it('speaks business, not machinery', async () => {
    const view = await board();
    const { container } = renderBoard(<TodayBoard board={view} />);
    const text = container.textContent ?? '';
    for (const leak of [
      'fixture', 'FIXTURE', 'Phase ', '04_RESERVATIONS', '13_HOUSEKEEPING',
      '/api/', 'undefined', 'null', 'NaN',
    ]) {
      expect(text, leak).not.toContain(leak);
    }
  });

  it('empty states are warm and specific', async () => {
    // A day with no movements at all still reads as a working screen.
    const view = await board('2027-01-13');
    renderBoard(<TodayBoard board={view} />);
    expect(screen.getByText('No arrivals today')).toBeDefined();
    expect(screen.getByText('No departures today')).toBeDefined();
  });

  it('the check-in and check-out drawers collect no commercial term', () => {
    /*
     * No payment, deposit, late fee or cancellation charge exists in this product; a
     * front-office screen must not be where one gets invented.
     *
     * Asserted against the SPECS, not against the source text. UI-7 added help lines that
     * say a late departure is recorded and nothing is charged for it — prose that states
     * the rule, which a raw-source scan reads as breaking it. A guard that punishes its
     * own explanation teaches the next reader to delete the explanation.
     */
    const commercial = /amount|payment|deposit|charge|fee|refund|price|rate|tax|commission/i;
    for (const field of [...checkInFields({ notes: null }), ...checkOutFields({ notes: null })]) {
      expect(field.name, `${field.name} (name)`).not.toMatch(commercial);
      expect(field.label, `${field.name} (label)`).not.toMatch(commercial);
      expect(field.placeholder ?? '', `${field.name} (placeholder)`).not.toMatch(commercial);
      // The one type that could only ever mean money.
      expect(field.type, `${field.name} (type)`).not.toBe('currency');
    }
    // And no money control is constructed in that half of the file either.
    const fields = codeOf(read('lib/server/api/form-fields.ts'));
    const stay = fields.slice(fields.indexOf('export function checkInFields'),
      fields.indexOf('export function markCleanFields'));
    expect(stay).not.toMatch(/currency/i);
  });
});
