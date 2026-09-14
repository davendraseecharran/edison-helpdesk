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
 * The search is the ordinary one (`searchAction`, RLS applies), run against the
 * words of the title that actually name something. Debounced, because it runs
 * while somebody types, and cancelled by sequence number so a slow answer for
 * an old spelling cannot paint over a new one.
 */

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { TriangleAlert } from 'lucide-react';
import { Icon } from '@/components/ui/Icon';
import { searchAction } from '@/lib/data/search-actions';
import { splitTicketTitle, type SearchHit } from '@/lib/data/search';
import { duplicateTokens } from '@/lib/intake/suggest';
import '@/styles/lists.css';

/** Long enough that the title has settled, short enough to land before the next field. */
const DEBOUNCE_MS = 400;

export function DuplicateWarning({ title, location }: { title: string; location: string }) {
  const [hits, setHits] = useState<SearchHit[]>([]);
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
      let found: SearchHit[] = [];
      try {
        if (searchable) found = await searchAction(term);
      } catch {
        // The action itself never throws; a lost connection can. A warning that
        // could not be looked up is simply not shown.
      }
      if (id === sequence.current) setHits(found.filter((hit) => hit.kind === 'ticket').slice(0, 2));
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
            return (
              <li key={hit.id}>
                <Link href={hit.href} target="_blank" rel="noreferrer">
                  {number ? <span className="mono">{number}</span> : null} {rest || hit.title}
                </Link>
                {hit.subtitle ? <span className="duplicate-warning-sub">{hit.subtitle}</span> : null}
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
