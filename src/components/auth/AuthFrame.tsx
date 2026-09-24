import type { ReactNode } from 'react';
import Link from 'next/link';
import { SealCoin } from './SealCoin';

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
        <Link href="/" className="auth-wordmark" aria-label="Edison Helpdesk, Thomas A. Edison CTE High School">
          <SealCoin />
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
