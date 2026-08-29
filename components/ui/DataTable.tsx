/**
 * DataTable — one table implementation for every list view.
 *
 * Wide tables scroll inside their own container rather than breaking the page layout, the
 * scroller is focusable so keyboard users can reach it, and numeric columns are right
 * aligned with tabular figures so digits line up down the column.
 *
 * Foundation modes (§13) — every mode is opt-in, so no existing screen changes shape
 * until it chooses to:
 *   density="compact"      36px ledger rows instead of the 44px default.
 *   mobile="stack"         below 640px each row becomes a stacked record with its column
 *                          labels (via data-label). For registers read record-by-record;
 *                          never for statements, where horizontal comparison IS the
 *                          content — those keep the scroll container.
 *   stickyFirstColumn      the row's identity column stays put on horizontal scroll.
 *   getRowEmphasis         statement arithmetic carried by rules, not inline styles:
 *                          'section' | 'subtotal' (ink rule above) | 'total' (double rule).
 */
import type { ReactNode } from 'react';
import { TableScroller, EmptyState } from './primitives';

export interface Column<T> {
  key: string;
  header: string;
  /** Right-aligned, tabular numerals. */
  numeric?: boolean;
  render: (row: T) => ReactNode;
  /** Footer cell, for totals. */
  footer?: ReactNode;
}

export type RowEmphasis = 'section' | 'subtotal' | 'total';

export function DataTable<T>({
  columns, rows, caption, getRowKey, emptyTitle = 'Nothing to show',
  emptyMessage = 'There is no data for this period or filter.', footer = false,
  density = 'comfortable', mobile = 'scroll', stickyFirstColumn = false,
  getRowEmphasis,
}: {
  columns: Column<T>[];
  rows: T[];
  caption: string;
  getRowKey: (row: T, index: number) => string;
  emptyTitle?: string;
  emptyMessage?: string;
  footer?: boolean;
  density?: 'comfortable' | 'compact';
  mobile?: 'scroll' | 'stack';
  stickyFirstColumn?: boolean;
  getRowEmphasis?: (row: T) => RowEmphasis | undefined;
}) {
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} message={emptyMessage} />;
  }

  const tableClass = [
    'sv-table',
    density === 'compact' ? 'sv-table--compact' : '',
    mobile === 'stack' ? 'sv-table--stack' : '',
    stickyFirstColumn ? 'sv-table--sticky-first' : '',
  ].filter(Boolean).join(' ');

  return (
    <TableScroller label={caption}>
      <table className={tableClass}>
        <caption className="sv-visually-hidden">{caption}</caption>
        <thead>
          <tr>
            {columns.map((column) => (
              <th key={column.key} scope="col" className={column.numeric ? 'sv-num' : ''}>
                {column.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, index) => {
            const emphasis = getRowEmphasis?.(row);
            return (
              <tr key={getRowKey(row, index)} className={emphasis ? `sv-table__row--${emphasis}` : ''}>
                {columns.map((column) => (
                  <td
                    key={column.key}
                    className={column.numeric ? 'sv-num' : ''}
                    data-label={column.header}
                  >
                    {column.render(row)}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
        {footer ? (
          <tfoot>
            <tr>
              {columns.map((column) => (
                <td key={column.key} className={column.numeric ? 'sv-num' : ''} data-label={column.header}>
                  {column.footer ?? null}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </TableScroller>
  );
}
