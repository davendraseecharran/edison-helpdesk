'use client';

/**
 * Everything intake does not need to ask.
 *
 * A phone call about a projector is a title, a requester and a sentence. The
 * form asked for nine more things first — a room, machines from the inventory,
 * a device's serial and asset tag, a submission date, a list of collaborators —
 * and every one of them is legitimately needed by some ticket and by almost no
 * walk-in. Asking them all, every time, is why recording a call took a minute
 * instead of fifteen seconds, and a desk with a queue behind it pays that
 * minute out of the queue.
 *
 * So they are here, behind one press, under the three fields that are always
 * the answer. Nothing is removed and nothing is harder to reach than one
 * control; what changes is that the form no longer opens with its exceptions.
 *
 * Open or closed is remembered per account in this browser. The NetRider who
 * records every machine's serial opens it once and finds it open tomorrow; the
 * one taking calls never sees it. It is read through `useSyncExternalStore`
 * with a server snapshot of "closed", so the first paint is the same on both
 * sides of hydration and a section never opens and shuts itself on load.
 *
 * It does not animate. MOTION.md's rule is that a moment not in its table does
 * not move, and this one is deliberately not in it: the region is as tall as
 * the page, opened rarely, and remembered — so the transition is a
 * several-hundred-pixel reflow that almost nobody sees twice. The chevron turns,
 * which is the same 200ms the select's chevron takes, and that is the whole
 * animation.
 */

import { useCallback, useId, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ChevronDown } from 'lucide-react';
import { Icon } from '@/components/ui/Icon';

/** Per browser, per account: whether this person works with the extra fields open. */
function storageKey(accountId: string): string {
  return `edison.intake.more.${accountId}`;
}

/** No store to subscribe to: the value only changes through this component. */
function subscribeToNothing(): () => void {
  return () => {};
}

export function MoreDetails({
  accountId,
  summary,
  children,
}: {
  accountId: string;
  /**
   * What is already filled in behind the press, named when it is closed. A
   * section that hides a device somebody typed and then submits it anyway is a
   * trap; saying "1 device" on the control that hides it is the whole fix.
   */
  summary?: string;
  children: ReactNode;
}) {
  const regionId = useId();
  const remembered = useSyncExternalStore(
    subscribeToNothing,
    () => {
      try {
        return window.localStorage.getItem(storageKey(accountId)) === 'open';
      } catch {
        // Storage refused: closed, which is the state the fast path wants.
        return false;
      }
    },
    () => false,
  );
  // The remembered value seeds it; every press afterwards is this state, so the
  // section never fights the store it just wrote to.
  const [pressed, setPressed] = useState<boolean | null>(null);
  const open = pressed ?? remembered;

  const toggle = useCallback(() => {
    const next = !open;
    setPressed(next);
    try {
      window.localStorage.setItem(storageKey(accountId), next ? 'open' : 'closed');
    } catch {
      // Then it is remembered for this page only, which changes nothing here.
    }
  }, [accountId, open]);

  return (
    <div className="intake-more" data-open={open || undefined}>
      <button
        type="button"
        className="intake-more-toggle"
        aria-expanded={open}
        aria-controls={regionId}
        onClick={toggle}
      >
        <Icon icon={ChevronDown} size={15} className="intake-more-chevron" />
        <span className="intake-more-label">More details</span>
        <span className="intake-more-hint">
          {!open && summary ? summary : 'Location, inventory, device, date, collaborators'}
        </span>
      </button>
      {/* Unmounted rather than hidden: a closed section holding eleven form
          controls is eleven controls a screen reader's cursor can still walk
          into. What was typed into them lives in the form's own state, so
          nothing is lost by closing it and nothing is silently dropped on
          submit — which is why the toggle says what is in there. */}
      {open ? <div id={regionId} className="intake-more-body">{children}</div> : null}
    </div>
  );
}
