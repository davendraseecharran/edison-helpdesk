'use client';

/**
 * Pages start loading when somebody means to go to them, not when they click.
 *
 * Every page here is dynamic, so a link in view prefetches only as far as the
 * page's skeleton; the data waits for the click. This fetches the whole page
 * the moment intent shows — the pointer resting on a link for a beat, a press
 * going down (a click lands ~100 ms later), a tab onto it — so by the time the
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
 */

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';

const PAGES =
  /^\/(today|queue|my-tickets|collaborating|resolved|all-tickets|analytics|people|groups|devices|workflows|forms|tickets|events|notifications|settings|admin)(\/|$|\?)/;
const NEVER = /\/(export|download|kiosk)(\/|$|\?)|\.(csv|json|png|pdf)(\?|$)/;
const DWELL_MS = 65;
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

  useEffect(() => {
    const fetchedAt = new Map<string, number>();
    let dwell: ReturnType<typeof setTimeout> | null = null;

    const prefetch = (href: string | null) => {
      if (!href) return;
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
      const href = internalHref(event.target);
      if (dwell) clearTimeout(dwell);
      if (href) dwell = setTimeout(() => prefetch(href), DWELL_MS);
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
      if (dwell) clearTimeout(dwell);
      document.removeEventListener('pointerover', onOver);
      document.removeEventListener('pointerdown', onDown);
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [router]);

  return null;
}
