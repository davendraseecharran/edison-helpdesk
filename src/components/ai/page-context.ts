'use client';

/**
 * What the current page is about, for the assistant.
 *
 * A record page marks its root with `data-page-kind`, `data-page-id` and
 * `data-page-label`; the panel reads them when a message is sent and passes
 * them along, so "resolve this one" means the ticket on screen. Reading the
 * DOM rather than a context keeps the pages server components: they render
 * three attributes and know nothing about the panel.
 *
 * Marked so far: the ticket detail page. The people and devices detail pages
 * (Tasks 17 and 18) should add the same three attributes to their root
 * element when they land; nothing else is needed.
 */

import { useEffect, useState } from 'react';
import { usePathname } from 'next/navigation';

export type PageKind = 'ticket' | 'person' | 'device';

export interface PageContext {
  kind: PageKind;
  id: string;
  label: string;
}

function isKind(value: string | undefined): value is PageKind {
  return value === 'ticket' || value === 'person' || value === 'device';
}

/** The page's record, or null when the page is not about one. */
export function readPageContext(): PageContext | null {
  if (typeof document === 'undefined') return null;
  const root = document.querySelector<HTMLElement>('[data-page-kind]');
  if (!root) return null;
  const kind = root.dataset.pageKind;
  const id = root.dataset.pageId?.trim() ?? '';
  const label = root.dataset.pageLabel?.trim() ?? '';
  if (!isKind(kind) || id === '' || label === '') return null;
  return { kind, id, label };
}

/** The page's record, kept current across client-side navigation. */
export function usePageContext(): PageContext | null {
  const pathname = usePathname();
  const [context, setContext] = useState<PageContext | null>(null);

  // Read after the new page has painted: the attributes belong to the page
  // the navigation just committed, not the one being left.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => setContext(readPageContext()));
    return () => window.cancelAnimationFrame(frame);
  }, [pathname]);

  return context;
}
