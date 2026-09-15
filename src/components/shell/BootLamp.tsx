'use client';

import { useEffect } from 'react';

import { BOOT_LAMP_SEEN_KEY } from './boot-lamp-script';
import '@/styles/voice.css';

/**
 * The application arriving.
 *
 * One signature moment per session: the wordmark on the page's ground with the
 * lamp warming up behind it, one second, then gone. It is rendered by the
 * authenticated layout, which mounts on a real document load — a first visit,
 * a reload, the navigation that follows signing in — and stays mounted while
 * you move between screens, so moving from the queue to Today never replays it.
 *
 * Per session means per session. The layout mounting is not the test, because a
 * reload mounts it again and nobody wants the arrival ceremony three times
 * while they are chasing one bug; `sessionStorage` is, and a tab opened fresh
 * tomorrow morning gets it back.
 *
 * The removal is still pure CSS. `animation-fill-mode: forwards` takes the
 * sheet away with no script involved, so the one line of JavaScript above
 * decides only whether the moment happens at all, and never whether it ends.
 * `aria-hidden` because it says nothing a reader needs: the page behind it is
 * already being announced.
 *
 * Marking the session is an effect rather than a second inline script: React
 * warns on every `<script>` a component renders, which put a browser error on
 * every page for a line that only ever had to run once a document loaded. By
 * the time this effect runs the lamp has already been painted, which is the
 * only timing the mark has to beat — the reading half is in the `<head>`.
 */
export function BootLamp() {
  useEffect(() => {
    try {
      window.sessionStorage.setItem(BOOT_LAMP_SEEN_KEY, '1');
    } catch {
      // Storage refused. The moment plays again next time, which is the
      // failure worth having.
    }
  }, []);

  return (
    <div className="boot-lamp" aria-hidden="true">
      <span className="boot-lamp-mark">
        <b>Edison</b>
        <span>Helpdesk</span>
      </span>
    </div>
  );
}
