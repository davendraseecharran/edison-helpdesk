import type { ReactNode } from 'react';
import { StaggerItem, StaggerList } from './Motion';

export interface Column<Row> {
  key: string;
  header: ReactNode;
  cell: (row: Row) => ReactNode;
  /** Numbers and dates right-align; everything else stays left. */
  align?: 'right';
  /** Identifier column: ticket numbers, asset tags, serials. */
  mono?: boolean;
  /**
   * Leave the column out of the phone row card. Mark the columns whose value
   * already appears in `cardTitle` or `cardMeta`, and anything that is not one
   * of the three facts a technician needs at a glance.
   */
  hideOnPhone?: boolean;
  /** Column width hint on the wide layout. */
  width?: number | string;
}

export interface DataTableProps<Row> {
  columns: Column<Row>[];
  rows: Row[];
  rowKey: (row: Row) => string;
  /** The row's headline on phones, usually the same link as the main column. */
  cardTitle: (row: Row) => ReactNode;
  /** One quiet line under the phone headline. */
  cardMeta?: (row: Row) => ReactNode;
  /** Rendered instead of the table when there are no rows. */
  empty?: ReactNode;
  /** Screen-reader description of the table. */
  caption?: string;
  /**
   * Let the rows settle into place with a short stagger when the table first
   * appears on a client-side navigation. Later rows (another page, a filter,
   * a refresh) appear in place. Off under `prefers-reduced-motion`.
   */
  settle?: boolean;
}

/**
 * The one list layout.
 *
 * From 720px up it is a real `<table>`: sticky header, 44px rows, right-aligned
 * numerics, mono identifiers, no shadows. Below 720px the same rows render as
 * cards with a headline, a meta line and the columns not marked
 * `hideOnPhone`. Both layouts are in the markup and the stylesheet decides
 * which one shows, so server rendering never has to guess the viewport and
 * nothing re-flows after hydration. With `settle`, both sets of rows are
 * `StaggerItem`s keyed to the same sequence, so whichever layout is visible
 * settles in the same way.
 */
export function DataTable<Row>({
  columns,
  rows,
  rowKey,
  cardTitle,
  cardMeta,
  empty,
  caption,
  settle = false,
}: DataTableProps<Row>) {
  if (rows.length === 0) {
    return <div className="data-table-empty">{empty ?? <p className="muted">Nothing to show.</p>}</div>;
  }

  const phoneColumns = columns.filter((column) => !column.hideOnPhone);

  function cellClass(column: Column<Row>): string | undefined {
    const parts: string[] = [];
    if (column.align === 'right') parts.push('num');
    if (column.mono) parts.push('mono');
    return parts.length ? parts.join(' ') : undefined;
  }

  return (
    <StaggerList generation={rows} enabled={settle}>
      <div className="data-table">
        <table className="table">
          {caption ? <caption className="visually-hidden">{caption}</caption> : null}
          <thead>
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={column.align === 'right' ? 'num' : undefined}
                  style={column.width !== undefined ? { width: column.width } : undefined}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <StaggerItem as="tr" key={rowKey(row)} index={index}>
                {columns.map((column) => (
                  <td key={column.key} className={cellClass(column)}>
                    {column.cell(row)}
                  </td>
                ))}
              </StaggerItem>
            ))}
          </tbody>
        </table>

        <ul className="row-cards">
          {rows.map((row, index) => {
            const meta = cardMeta?.(row);
            return (
              <StaggerItem as="li" key={rowKey(row)} index={index} className="row-card">
                <div className="row-card-title">{cardTitle(row)}</div>
                {meta ? <div className="row-card-meta">{meta}</div> : null}
                {phoneColumns.length > 0 ? (
                  <dl className="row-card-facts">
                    {phoneColumns.map((column) => (
                      <div key={column.key} className="row-card-fact">
                        <dt>{column.header}</dt>
                        <dd className={column.mono ? 'mono' : undefined}>{column.cell(row)}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
              </StaggerItem>
            );
          })}
        </ul>
      </div>
    </StaggerList>
  );
}
