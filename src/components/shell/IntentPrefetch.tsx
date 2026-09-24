'use client';

/**
 * Pages start loading when somebody means to go to them, not when they click.
 *
 * Every page here is dynamic, so a link in view prefetches only as far as the
 * page's skeleton; the data waits for the click. This fetches the whole page
 * the moment intent shows — the pointer reaching a link (at once; hover may
 * start at most ten loads in ten seconds, none on a data-saver or 2G
 * connection), a press going down
 * (a click lands ~100 ms later), a tab onto it — so by the time the
 * click arrives the answer is usually already here and the page swaps in.
 * `staleTimes` in next.config keeps what was fetched for a short while, which
 * also makes Back and a second visit instant; any change made through the app
 * clears it (every action revalidates the layout).
 *
 * Only this application's own pages are fetched this way. A route handler
 * answers a prefetch like any GET, and the exports RECORD that they happened,
 * so anything that is a file (an export, a download) or leaves the signed-in
 * app (kiosks, public links, auth) is never prefetched.
 *
 * And a tab that comes back after a minute away refreshes itself, so the
 * queue somebody left open over lunch is not the queue they act on.
 *
 * It also reads the session's search index (people and machines, held in
 * memory) once the first page has settled, so the palette's first keystroke
 * already has something to answer from.
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useRuntime } from '@/components/AppRuntime';
import { warmSearchIndex } from '@/lib/lookup/local-store';

const PAGES =
  /^\/(today|queue|my-tickets|collaborating|resolved|all-tickets|analytics|people|groups|devices|workflows|forms|tickets|events|notifications|settings|admin)(\/|$|\?)/;
const NEVER = /\/(export|download|kiosk)(\/|$|\?)|\.(csv|json|png|pdf)(\?|$)/;
/** Hover alone may start at most this many page loads in any window below. */
const HOVER_BUDGET = 10;
const HOVER_WINDOW_MS = 10_000;
const REFETCH_AFTER_MS = 30_000;
const REFRESH_AFTER_HIDDEN_MS = 60_000;

function internalHref(target: EventTarget | null): string | null {
  const anchor = target instanceof Element ? target.closest('a[href]') : null;
  if (!(anchor instanceof HTMLAnchorElement)) return null;
  if (anchor.target === '_blank' || anchor.hasAttribute('download')) return null;
  if (anchor.origin !== window.location.origin) return null;
  const href = anchor.pathname + anchor.search;
  if (!PAGES.test(href) || NEVER.test(href)) return null;
  if (href === window.location.pathname + window.location.search) return null;
  return href;
}

export function IntentPrefetch() {
  const router = useRouter();
  const { actor } = useRuntime();

  useEffect(() => {
    const idle =
      'requestIdleCallback' in window
        ? (fn: () => void) => window.requestIdleCallback(fn, { timeout: 4000 })
        : (fn: () => void) => window.setTimeout(fn, 1500);
    const timer = window.setTimeout(() => idle(() => void warmSearchIndex(actor.id)), 1200);
    return () => window.clearTimeout(timer);
  }, [actor.id]);

  useEffect(() => {
    const fetchedAt = new Map<string, number>();
    // When hover last started a load. Hover loads at once — no wait — so the
    // page is on its way the instant the pointer reaches the link; a sweep
    // across a column of links is capped by this budget, so it never queues
    // a pile of server renders.
    const hoverStarts: number[] = [];
    const connection = (navigator as Navigator & {
      connection?: { saveData?: boolean; effectiveType?: string };
    }).connection;
    const frugal = connection?.saveData === true || /(^|-)2g$/.test(connection?.effectiveType ?? '');

    const prefetch = (href: string | null, viaHover = false) => {
      if (!href) return;
      if (viaHover) {
        if (frugal) return;
        const now = Date.now();
        while (hoverStarts.length > 0 && now - hoverStarts[0] > HOVER_WINDOW_MS) hoverStarts.shift();
        const last = fetchedAt.get(href) ?? 0;
        if (now - last < REFETCH_AFTER_MS) return;
        if (hoverStarts.length >= HOVER_BUDGET) return;
        hoverStarts.push(now);
      }
      const last = fetchedAt.get(href) ?? 0;
      if (Date.now() - last < REFETCH_AFTER_MS) return;
      fetchedAt.set(href, Date.now());
      // `kind: 'full'` fetches the page's data, not only its skeleton. It is the
      // router's own option (PrefetchKind.FULL, what <Link prefetch> uses),
      // left out of the public type; an unknown value falls back to the
      // default prefetch, so this degrades rather than breaks.
      router.prefetch(href, { kind: 'full' } as Parameters<typeof router.prefetch>[1]);
    };

    const onOver = (event: PointerEvent) => {
      if (event.pointerType !== 'mouse') return;
      prefetch(internalHref(event.target), true);
    };
    const onDown = (event: PointerEvent) => prefetch(internalHref(event.target));
    const onFocus = (event: FocusEvent) => prefetch(internalHref(event.target));

    let hiddenAt = 0;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
      } else if (hiddenAt && Date.now() - hiddenAt > REFRESH_AFTER_HIDDEN_MS) {
        fetchedAt.clear();
        router.refresh();
      }
    };

    document.addEventListener('pointerover', onOver, { passive: true });
    document.addEventListener('pointerdown', onDown, { passive: true });
    document.addEventListener('focusin', onFocus);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [router]);

  return null;
}
