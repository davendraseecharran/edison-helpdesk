'use client';

/**
 * "Somebody already reported this."
 *
 * The projector in 118 dies and five people walk to the desk about it. Without
 * this the desk records five tickets, and somebody spends an afternoon closing
 * four of them. With it, the second person's ticket is caught while it is being
 * typed, which is the only moment it costs nothing.
 *
 * It is a WARNING, never a block. The NetRider at the desk can see the person
 * in front of them and the interface cannot; "this looks like the same thing"
 * is information, and "you may not record this" would be the form overruling
 * somebody who knows more than it does. Submitting is never touched.
 *
 * What it shows is only what is still true: a ticket that is still somebody's
 * problem and was opened within the grouping window. A ticket closed in
 * November matches the same words as this morning's, and printing it under
 * "already open" is how a desk learns to stop reading the warning.
 *
 * The search is the ordinary one (`app_search` through `duplicateTicketsAction`,
 * RLS applies), run against the words of the title that actually name
 * something. Debounced, because it runs while somebody types, and cancelled by
 * sequence number so a slow answer for an old spelling cannot paint over a new
 * one.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { TriangleAlert } from 'lucide-react';
import { Icon } from '@/components/ui/Icon';
import { duplicateTicketsAction } from '@/lib/data/search-actions';
import { splitTicketTitle } from '@/lib/data/search';
import type { DuplicateHit } from '@/lib/intake/duplicates';
import { duplicateTokens } from '@/lib/intake/suggest';
import '@/styles/lists.css';

/** Long enough that the title has settled, short enough to land before the next field. */
const DEBOUNCE_MS = 400;

export function DuplicateWarning({
  title,
  location,
  related,
  onRelate,
}: {
  title: string;
  location: string;
  /** Ticket numbers already marked as the same issue, from the form above. */
  related: string[];
  /** Mark one, to be written as a note the moment this ticket exists. */
  onRelate: (number: string) => void;
}) {
  const [hits, setHits] = useState<DuplicateHit[]>([]);
  const [dismissed, setDismissed] = useState(false);
  const sequence = useRef(0);

  /*
   * The words worth searching for: the longest few of the title, plus the room
   * when one has been typed. "Projector" and "signal" find the other reports;
   * "the", "in" and "is" find the whole queue.
   */
  const tokens = duplicateTokens(title);
  const room = location.trim();
  const term = [...tokens, room].filter((part) => part !== '').join(' ');

  const searchable = tokens.length > 0;

  useEffect(() => {
    // Every path through here is asynchronous, so nothing sets state in the
    // body of the effect: an empty term simply lets the timer expire without a
    // request, and the answer that arrives is the one that clears the warning.
    const id = (sequence.current += 1);
    const timer = window.setTimeout(async () => {
      let found: DuplicateHit[] = [];
      try {
        if (searchable) found = await duplicateTicketsAction(term);
      } catch {
        // The action itself never throws; a lost connection can. A warning that
        // could not be looked up is simply not shown.
      }
      if (id === sequence.current) setHits(found);
    }, DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [term, searchable]);

  if (dismissed || hits.length === 0) return null;

  return (
    <div className="duplicate-warning" role="status">
      <Icon icon={TriangleAlert} size={15} className="duplicate-warning-glyph" />
      <div className="duplicate-warning-text">
        <p>
          {hits.length === 1
            ? 'This looks like a ticket that is already open.'
            : 'This looks like tickets that are already open.'}
        </p>
        <ul>
          {hits.map((hit) => {
            const { number, rest } = splitTicketTitle(hit.title);
            const linked = number !== null && related.includes(number);
            return (
              <li key={hit.id}>
                <Link href={hit.href} target="_blank" rel="noreferrer">
                  {number ? <span className="mono">{number}</span> : null} {rest || hit.title}
                </Link>
                {hit.subtitle ? <span className="duplicate-warning-sub">{hit.subtitle}</span> : null}
                {/* Without a number there is nothing a note could name, so the
                    offer is simply not made. */}
                {number === null ? null : linked ? (
                  <span className="duplicate-warning-linked">Related</span>
                ) : (
                  <button
                    type="button"
                    className="duplicate-warning-relate"
                    onClick={() => onRelate(number)}
                  >
                    Link as related
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      <button type="button" className="duplicate-warning-no" onClick={() => setDismissed(true)}>
        Not the same
      </button>
    </div>
  );
}
