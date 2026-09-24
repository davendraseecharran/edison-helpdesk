'use client';

import { useEffect, useState } from 'react';

/**
 * Tickets resolved from this tab whose outcome has not been drawn yet.
 *
 * Module state rather than storage: the moment belongs to the press that
 * caused it, in the tab it was pressed in. `ResolvePanel` adds the id when the
 * server says yes; the `ResolvedMark` that mounts on the refreshed page reads
 * it once and clears it, so the same ticket opened again later is simply
 * resolved, with nothing to announce.
 */
const justResolved = new Set<string>();

export function markJustResolved(ticketId: string): void {
  justResolved.add(ticketId);
}

/**
 * The check beside a resolved ticket's solution.
 *
 * At rest it is the resolved badge's own glyph, in the same quiet ink: finished
 * work is out of the way, not celebrated. Resolved a moment ago from this tab,
 * it draws itself once — the stroke runs from the short arm to the long one —
 * and the solution under it settles in (`tickets.css`), which is the
 * confirmation the press was waiting for. Reduced motion: the check is simply
 * there.
 */
export function ResolvedMark({ ticketId }: { ticketId: string }) {
  // Read in the initializer, cleared in an effect: a StrictMode double render
  // must see the same answer twice.
  const [draw] = useState(() => justResolved.has(ticketId));
  useEffect(() => {
    justResolved.delete(ticketId);
  }, [ticketId]);

  return (
    <svg
      className="resolved-mark"
      data-draw={draw || undefined}
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      aria-hidden="true"
    >
      <path d="M4 12.5 9 17.5 20 6.5" pathLength={1} />
    </svg>
  );
}
