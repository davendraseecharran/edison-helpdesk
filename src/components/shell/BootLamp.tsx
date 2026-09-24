'use client';

import { useEffect, useState } from 'react';

import { BOOT_LAMP_SEEN_KEY } from './boot-lamp-script';
import '@/styles/voice.css';

/** Never longer than this, whatever the first page is doing. */
const BOOT_CAP_MS = 8000;
/** How long after the first page is in before the sheets leave the tree. */
const BOOT_CLEAR_MS = 900;

/** The sign-in screen's bulb, at the size the arrival draws it. */
function Bulb() {
  return (
    <span className="boot-bulb">
      <span className="boot-bulb-halo" />
      <svg className="boot-bulb-mark" viewBox="0 0 48 48" width="56" height="56" focusable="false">
        <path
          className="boot-bulb-globe"
          pathLength={1}
          d="M15 28.2 A13.5 13.5 0 1 1 33 28.2 C31 30 29.5 31.6 29.5 34.5 L18.5 34.5 C18.5 31.6 17 30 15 28.2 Z"
        />
        <path className="boot-bulb-filament" pathLength={1} d="M20 34.5 V29 L22 25.5 L24 29 L26 25.5 L28 29 V34.5" />
        <path className="boot-bulb-base" pathLength={1} d="M18.5 38.5 H29.5 M20 42 H28" />
      </svg>
    </span>
  );
}

function Sheet({ kind }: { kind: 'hold' | 'wait' }) {
  return (
    <div className={`boot-sheet boot-sheet-${kind}`}>
      <span className="boot-mark">
        <Bulb />
        <span className="boot-word">
          <b>Edison</b> <span>Helpdesk</span>
        </span>
      </span>
    </div>
  );
}

/**
 * The application arriving.
 *
 * Once per session, the first time an authenticated page loads — a fresh
 * tab, or the navigation that follows signing in — the page is the wordmark:
 * the sign-in screen's bulb, lit, and "Edison Helpdesk" with the light
 * passing across it, centred on the page's own ground. It is there only
 * while the first page is actually loading, and it leaves the instant that
 * page's content is in.
 *
 * All of it is CSS and inline SVG, so it paints with the first HTML and
 * needs no script to arrive or to leave:
 *
 * - The waiting sheet is shown while `<main>` holds a route's loading
 *   skeleton (`.loading-region[data-scope='route']`, a `:has()` rule) and
 *   fades out when the skeleton is replaced by the page.
 * - A second, identical sheet lies over it on a fixed clock of about half a
 *   second, so a first page that is ready at once still gets a beat of the
 *   mark rather than a flash of it. Whichever is longer wins; the two are
 *   the same picture on the same clocks, so the hand-over is invisible.
 * - A cap takes both away after eight seconds, whatever is still loading.
 *
 * The one line of JavaScript in the `<head>` (`boot-lamp-script.ts`) only
 * ever suppresses it, for a reload later in the same session. This
 * component's effect records the session and, once the first page is in,
 * disarms the sheets so a later skeleton (an in-app navigation) never brings
 * them back; a little after that it leaves the tree.
 *
 * `aria-hidden` because it says nothing a reader needs: the page behind it
 * is already being announced. It takes no pointer events at any point.
 * Under reduced motion the mark is static and there is no fixed beat: the
 * waiting sheet shows while the page loads and is gone when it is in.
 */
export function BootLamp() {
  const [done, setDone] = useState(false);
  const [gone, setGone] = useState(false);

  useEffect(() => {
    try {
      window.sessionStorage.setItem(BOOT_LAMP_SEEN_KEY, '1');
    } catch {
      // Storage refused. The moment plays again next time, which is the
      // failure worth having.
    }
    // A reload later in the session: the head script already hid it.
    const seen = document.documentElement.hasAttribute('data-boot-seen');

    // Disarm once the first page is in: a later skeleton is an in-app
    // navigation, not the application arriving.
    const loading = () => document.querySelector("main .loading-region[data-scope='route']") !== null;
    const observer = new MutationObserver(() => check());
    const cap = window.setTimeout(() => finish(), BOOT_CAP_MS);
    function finish() {
      observer.disconnect();
      window.clearTimeout(cap);
      if (seen) setGone(true);
      else setDone(true);
    }
    function check() {
      if (seen || !loading()) finish();
    }
    const main = document.querySelector('main');
    if (main) observer.observe(main, { childList: true, subtree: true });
    queueMicrotask(check);
    return () => {
      observer.disconnect();
      window.clearTimeout(cap);
    };
  }, []);

  useEffect(() => {
    if (!done) return;
    const timer = window.setTimeout(() => setGone(true), BOOT_CLEAR_MS);
    return () => window.clearTimeout(timer);
  }, [done]);

  if (gone) return null;

  return (
    <div className="boot-lamp" data-done={done ? '' : undefined} aria-hidden="true">
      <Sheet kind="wait" />
      <Sheet kind="hold" />
    </div>
  );
}
