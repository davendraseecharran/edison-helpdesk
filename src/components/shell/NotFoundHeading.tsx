'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/**
 * The 404's heading, and the thing a screen reader is moved to.
 *
 * A client navigation into a not-found page leaves the reader's cursor wherever
 * the link was — in a rail that has just re-rendered around a page that is no
 * longer there — so the announcement is silence and the next Tab starts from
 * nowhere useful. Moving focus to the heading says what happened in the words
 * on screen, and leaves the rest of the page one Tab away in its natural order.
 *
 * `tabIndex={-1}` makes the heading focusable without adding it to the tab
 * order, and `preventScroll` keeps the page where the router put it. The
 * outline is suppressed because focus here is a cursor being placed rather than
 * a control being reached, and a ring around a heading nobody pressed reads as
 * an error of its own.
 */
export function NotFoundHeading({ children }: { children: ReactNode }) {
  const heading = useRef<HTMLHeadingElement>(null);

  useEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);

  return (
    <h1 ref={heading} tabIndex={-1} className="empty-title empty-title-heading">
      {children}
    </h1>
  );
}
