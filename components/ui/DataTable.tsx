/**
 * DataTable — one table implementation for every list view.
 *
 * Wide tables scroll inside their own container rather than breaking the page layout, the
 * scroller is focusable so keyboard users can reach it, and numeric columns are right
 * aligned with tabular figures so digits line up down the column.
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

export function DataTable<T>({
  columns, rows, caption, getRowKey, emptyTitle = 'Nothing to show',
  emptyMessage = 'There is no data for this period or filter.', footer = false,
}: {
  columns: Column<T>[];
  rows: T[];
  caption: string;
  getRowKey: (row: T, index: number) => string;
  emptyTitle?: string;
  emptyMessage?: string;
  footer?: boolean;
}) {
  if (rows.length === 0) {
    return <EmptyState title={emptyTitle} message={emptyMessage} />;
  }

  return (
    <TableScroller label={caption}>
      <table className="sv-table">
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
          {rows.map((row, index) => (
            <tr key={getRowKey(row, index)}>
              {columns.map((column) => (
                <td key={column.key} className={column.numeric ? 'sv-num' : ''}>
                  {column.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
        {footer ? (
          <tfoot>
            <tr>
              {columns.map((column) => (
                <td key={column.key} className={column.numeric ? 'sv-num' : ''}>
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
