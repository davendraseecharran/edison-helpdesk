import type { ReactNode } from 'react';
import Link from 'next/link';

/**
 * The mark: a bulb, drawn while you watch.
 *
 * Edison's, so the pun is the school's, not ours. Three strokes and nothing
 * else — the globe, the base, and a filament between two posts. On arrival
 * the outline draws itself, the filament follows, and then it lights: a soft
 * halo behind the globe swells up and settles into a slow breath. It is the
 * only animation on a screen that is otherwise a form, and it runs once, at
 * the one moment somebody is waiting for a page to be worth looking at. All
 * of it is CSS on `pathLength` strokes; under reduced motion every stroke is
 * already drawn and the halo holds still.
 */
function Bulb() {
  return (
    <span className="auth-bulb" aria-hidden="true">
      <span className="auth-bulb-halo" />
      <svg className="auth-bulb-mark" viewBox="0 0 48 48" width="44" height="44" focusable="false">
        <path
          className="auth-bulb-globe"
          pathLength={1}
          d="M15 28.2 A13.5 13.5 0 1 1 33 28.2 C31 30 29.5 31.6 29.5 34.5 L18.5 34.5 C18.5 31.6 17 30 15 28.2 Z"
        />
        <path className="auth-bulb-filament" pathLength={1} d="M20 34.5 V29 L22 25.5 L24 29 L26 25.5 L28 29 V34.5" />
        <path className="auth-bulb-base" pathLength={1} d="M18.5 38.5 H29.5 M20 42 H28" />
      </svg>
    </span>
  );
}

/**
 * The frame every public screen shares: the wordmark, then one column.
 *
 * Sign-in, set-password, pending and restricted all put their content in the
 * same 360px column under the same mark, so they cannot drift apart. Nothing
 * here reads the session or the database; the pages decide what to show, and
 * the page paints the moment it is requested.
 */
export function AuthFrame({
  labelledBy,
  children,
}: {
  /** id of the page heading, so the region is named for assistive technology. */
  labelledBy: string;
  children: ReactNode;
}) {
  return (
    <div className="auth">
      <main className="auth-column">
        <Link href="/" className="auth-wordmark" aria-label="Edison Helpdesk">
          <Bulb />
          <span className="auth-wordmark-text">
            <span className="auth-wordmark-strong">Edison</span> <span className="auth-wordmark-tail">Helpdesk</span>
          </span>
        </Link>
        <section className="auth-body" aria-labelledby={labelledBy}>
          {children}
        </section>
      </main>
    </div>
  );
}
