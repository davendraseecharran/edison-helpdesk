/**
 * A horizontal bar list: one row per category, longest first where the caller
 * sorted it that way.
 *
 * It is a real table. The label and the count are text in the row, so the bars
 * are drawn over data that already reads without them — which is why the SVG is
 * `aria-hidden`, why there is no second hidden copy of the numbers for a screen
 * reader to plough through, and why no value is ever left to a tooltip. Bars are
 * horizontal because the labels are words ("Projector or display", "Waiting"),
 * and words under a column chart either tilt or truncate.
 *
 * One hue for every bar. Length already encodes the count, so colouring each bar
 * by its own value would spend the identity channel restating it; where a row
 * means a state rather than a name, the state's own tone rides in the label as
 * the badge dot the rest of the application uses.
 */

import type { ReactNode } from 'react';

export interface BarRow {
  key: string;
  label: ReactNode;
  value: number;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

export function BarChart({ caption, rows }: { caption: string; rows: BarRow[] }) {
  const most = rows.reduce((max, row) => Math.max(max, row.value), 0);

  return (
    <table className="bars">
      <caption className="visually-hidden">{caption}</caption>
      <tbody>
        {rows.map((row) => {
          const share = most === 0 ? 0 : round2((row.value / most) * 100);
          return (
            <tr key={row.key}>
              <th scope="row" className="bars-label">
                {row.label}
              </th>
              <td className="bars-track">
                <svg className="bars-svg" width="100%" height="12" aria-hidden="true">
                  {row.value > 0 ? (
                    <>
                      <rect className="bars-fill" x="0" y="0" width={`${share}%`} height="12" rx="4" />
                      {/* The data end is rounded and the baseline end is square:
                          a pill floating off the axis reads as a range. */}
                      <rect className="bars-fill" x="0" y="0" width="4" height="12" />
                    </>
                  ) : null}
                </svg>
              </td>
              <td className="bars-value">{row.value}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
