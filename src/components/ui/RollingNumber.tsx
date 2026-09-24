'use client';

/**
 * A number that rolls when it changes while somebody is looking at it.
 *
 * Each place is its own column, like the wheels of an odometer: only the
 * digits that changed move, the ones place first and each place to its left
 * a beat behind it, and they all travel the way the count went — up when it
 * grew, down when it shrank. 12 → 13 turns one wheel; 19 → 20 turns two, the
 * tens a moment after the ones, which is what makes it read as a counter and
 * not as a figure being replaced.
 *
 * It is the one count component. The rail's and the bottom tabs' pills, the
 * bell, the selection bar, Today's ledger, the list summaries and the
 * analytics figures all use it, so every number in the application turns
 * over the same way.
 *
 * Rules it keeps:
 * - The first value is simply there. A page that arrives with a number has
 *   nothing to announce; only a change after the first paint moves.
 * - CSS only, `transform` and `opacity` (`components.css`, "Rolling
 *   numbers"), so thirty of them on a screen cost nothing between changes
 *   and nothing at all under reduced motion, where the leaving digit's
 *   resting style is already invisible and the arriving one's is in place.
 * - Formatted values work: pass a string ("42%", "1.5", "99+") and every
 *   digit in it rolls; anything that is not a digit swaps. The direction is
 *   read from the numbers in the two strings.
 * - The digits are `aria-hidden` beside one visually hidden copy of the
 *   value, so a reader hears the number once, never the two crossing.
 */

import { useState, type CSSProperties } from 'react';

interface Rolled {
  text: string;
  previous: string;
  direction: 1 | -1;
  /** Counts the changes, so a digit that changes twice remounts twice. */
  turn: number;
}

function numeric(value: number | string): number {
  if (typeof value === 'number') return value;
  const match = value.replace(/,/g, '').match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : Number.NaN;
}

const DIGIT = /\d/;

export function RollingNumber({
  value,
  className,
}: {
  /** A count, or a figure already formatted for the screen. */
  value: number | string;
  className?: string;
}) {
  const text = typeof value === 'number' ? String(value) : value;
  const [rolled, setRolled] = useState<Rolled>({ text, previous: text, direction: 1, turn: 0 });

  if (rolled.text !== text) {
    // Adjusted during render, so the arriving and leaving digits agree on the
    // direction in the same frame.
    const before = numeric(rolled.text);
    const after = numeric(text);
    const direction: 1 | -1 =
      Number.isFinite(before) && Number.isFinite(after) && after < before ? -1 : 1;
    setRolled({ text, previous: rolled.text, direction, turn: rolled.turn + 1 });
  }

  const { previous, direction, turn } = rolled;
  // Aligned from the right: the ones place is always the last column, so
  // 9 → 10 turns the ones wheel and brings a tens wheel in beside it.
  const width = Math.max(text.length, turn === 0 ? 0 : previous.length);
  const columns = [];
  let moving = 0;
  for (let place = width - 1; place >= 0; place -= 1) {
    const now = text[text.length - 1 - place] ?? '';
    const was = turn === 0 ? now : (previous[previous.length - 1 - place] ?? '');
    const changed = now !== was;
    // Places are counted from the right for the stagger: the ones first.
    const order = changed ? moving++ : 0;
    columns.push({ place, now, was, changed, order });
  }
  // The columns were built left to right, so `order` counts from the left;
  // flipped below, so the rightmost changed column leads.
  const changedCount = moving;

  return (
    <span className={className ? `roll ${className}` : 'roll'} data-dir={direction > 0 ? 'up' : 'down'}>
      <span className="visually-hidden">{text}</span>
      <span className="roll-digits" aria-hidden="true">
        {columns.map(({ place, now, was, changed, order }) => {
          if (!changed) {
            return (
              <span key={place} className="roll-col">
                <span>{now}</span>
              </span>
            );
          }
          const style = { '--roll-i': changedCount - 1 - order } as CSSProperties;
          const rolls = DIGIT.test(now) || DIGIT.test(was);
          return (
            <span key={place} className="roll-col" data-roll={rolls ? '' : undefined} style={style}>
              {now !== '' ? (
                <span key={`in-${turn}`} className="roll-in">
                  {now}
                </span>
              ) : null}
              {was !== '' ? (
                <span key={`out-${turn}`} className="roll-out">
                  {was}
                </span>
              ) : null}
            </span>
          );
        })}
      </span>
    </span>
  );
}
