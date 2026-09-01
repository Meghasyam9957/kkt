/**
 * Date handling in *spreadsheet serial space*.
 *
 * The engine deliberately works in the same units Google Sheets does — integer day
 * serials where 0 = 1899-12-30 — because every V1 formula is written in that space
 * (`co - ci`, `>= monthStart`, `< EDATE(monthStart,1)`). Doing the arithmetic in the
 * same units removes a whole class of timezone/DST parity bugs before it can exist.
 *
 * ISO strings are used only at the API boundary.
 */

/** Days since the spreadsheet epoch (1899-12-30). Whole days for date-only values. */
export type Serial = number;

const EPOCH_MS = Date.UTC(1899, 11, 30);
const DAY_MS = 86_400_000;

export function serialToDate(serial: Serial): Date {
  return new Date(EPOCH_MS + Math.round(serial * DAY_MS));
}

/** Civil (Y/M/D) parts of a serial, in UTC — never affected by the server's timezone. */
export function serialParts(serial: Serial): { year: number; month: number; day: number } {
  const d = serialToDate(Math.floor(serial));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

export function ymdToSerial(year: number, month: number, day: number): Serial {
  return Math.round((Date.UTC(year, month - 1, day) - EPOCH_MS) / DAY_MS);
}

/** "2026-03-14" → serial. Also accepts "2026-03" (day 1). */
export function isoToSerial(iso: string): Serial {
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?/.exec(iso);
  if (!m || !m[1] || !m[2]) throw new Error(`Not an ISO date: ${iso}`);
  return ymdToSerial(Number(m[1]), Number(m[2]), m[3] ? Number(m[3]) : 1);
}

export function serialToIso(serial: Serial): string {
  const { year, month, day } = serialParts(serial);
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** "YYYY-MM" key for a serial. */
export function monthKeyOf(serial: Serial): string {
  const { year, month } = serialParts(serial);
  return `${year}-${String(month).padStart(2, '0')}`;
}

/** First day of the month containing `serial` — the EOMONTH(x,-1)+1 idiom in V1. */
export function monthStart(serial: Serial): Serial {
  const { year, month } = serialParts(serial);
  return ymdToSerial(year, month, 1);
}

/** Sheets EDATE(): same day-of-month `n` months on, clamped to the month's last day. */
export function edate(serial: Serial, months: number): Serial {
  const { year, month, day } = serialParts(serial);
  const target = new Date(Date.UTC(year, month - 1 + months, 1));
  const ty = target.getUTCFullYear();
  const tm = target.getUTCMonth() + 1;
  const lastDay = new Date(Date.UTC(ty, tm, 0)).getUTCDate();
  return ymdToSerial(ty, tm, Math.min(day, lastDay));
}

/** "YYYY-MM" → serial of the 1st. */
export function monthKeyToSerial(monthKey: string): Serial {
  return isoToSerial(monthKey);
}

/** The 12 FY month keys starting at `fyStart`, matching 99_CALC columns B..M. */
export function fyMonthKeys(fyStart: Serial, count = 12): string[] {
  const first = monthStart(fyStart);
  return Array.from({ length: count }, (_, i) => monthKeyOf(edate(first, i)));
}

/**
 * Coerce a cell value to a serial. Accepts serial numbers (what the API returns with
 * `SERIAL_NUMBER` rendering), Date objects (the in-memory fixture backend) and ISO
 * strings. Returns null for blanks and unparseable text — never throws, never NaN,
 * mirroring the V1 `N()` guards that keep one bad cell from poisoning a column.
 */
export function toSerial(value: unknown): Serial | null {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (value instanceof Date) {
    return Math.round((Date.UTC(value.getFullYear(), value.getMonth(), value.getDate()) - EPOCH_MS) / DAY_MS);
  }
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (/^\d{4}-\d{2}(-\d{2})?$/.test(trimmed)) return isoToSerial(trimmed);
    const parsed = Number(trimmed);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

/** Sheets `N()`: numbers pass through, everything else becomes 0. */
export function n(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.trim());
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

/** Sheets `ISNUMBER()` — used for the config gates (`blank rule` ⇒ engine stays idle). */
export function isNum(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Days in the month containing `serial` (= EDATE(ms,1) - ms in V1). */
export function daysInMonth(serial: Serial): number {
  const ms = monthStart(serial);
  return edate(ms, 1) - ms;
}

/**
 * A calendar day the Today board may be asked for, or the fallback.
 *
 * The value arrives from a query string, so it is untrusted twice over: it may be
 * malformed, and it may be a date that does not exist ("2027-02-31"). Round-tripping
 * through the serial arithmetic rejects both — an input that does not survive the trip
 * is not a day, and the caller gets the operational day instead of a bad query.
 */
export function resolveBoardDate(input: string | null | undefined, fallbackIso: string): string {
  return parseIsoDay(input) ?? fallbackIso;
}

/**
 * An ISO day that survives the serial round-trip, or null.
 *
 * THE canonical day parser. `resolveBoardDate` is this with a fallback; the availability
 * search needs the same judgement without one, because a front office asking for
 * "2027-02-31" must be told the day does not exist rather than quietly shown a different
 * one. Round-tripping rejects both the malformed ("12 Sep") and the impossible
 * ("2027-02-31" → 2027-03-03 ≠ input). Never throws.
 */
export function parseIsoDay(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  try {
    return serialToIso(isoToSerial(trimmed)) === trimmed ? trimmed : null;
  } catch {
    return null;
  }
}

/** The day `offset` days from an ISO day, as ISO. The date control's only arithmetic. */
export function shiftIsoDay(iso: string, offset: number): string {
  return serialToIso(isoToSerial(iso) + offset);
}

/**
 * A reporting month a URL may ask for, or the fallback.
 *
 * The sibling of `resolveBoardDate`, and untrusted for the same reasons: the value comes
 * from a query string and may be malformed or impossible ("2027-13"). Round-tripping
 * through the month arithmetic rejects both.
 *
 * Deliberately NOT clamped to months that carry revenue. `WorkbookViews.resolveMonth`
 * does clamp, which is right for a P&L — there is nothing to report on an empty month —
 * and wrong for a calendar, where looking at a month with no bookings yet is the entire
 * point of looking.
 */
export function resolveMonthKey(input: string | null | undefined, fallback: string): string {
  if (typeof input !== 'string') return fallback;
  const trimmed = input.trim();
  if (!/^\d{4}-\d{2}$/.test(trimmed)) return fallback;
  try {
    return monthKeyOf(monthKeyToSerial(trimmed)) === trimmed ? trimmed : fallback;
  } catch {
    return fallback;
  }
}

/** The month `offset` months from a 'YYYY-MM' key. Uses V1's own EDATE arithmetic. */
export function shiftMonthKey(monthKey: string, offset: number): string {
  return monthKeyOf(edate(monthKeyToSerial(monthKey), offset));
}

/** Every ISO day in a 'YYYY-MM', in order. */
export function daysOfMonth(monthKey: string): string[] {
  const start = monthKeyToSerial(monthKey);
  const count = daysInMonth(start);
  return Array.from({ length: count }, (_, i) => serialToIso(start + i));
}

/**
 * 0 = Sunday .. 6 = Saturday.
 *
 * Taken from this module's own serial conversion rather than from `serial % 7`: the
 * modulo is off by one against the sheet epoch, and a calendar whose weekday headers are
 * one column out is wrong in a way nobody notices until they place a weekend booking.
 * UTC, so the answer does not change with the reader's timezone.
 */
export function weekdayOf(iso: string): number {
  return serialToDate(isoToSerial(iso)).getUTCDay();
}
