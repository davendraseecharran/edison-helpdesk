import type { ReactNode } from 'react';

/**
 * The frame every public screen shares: a brand panel and a form column.
 *
 * From 1024px up they sit side by side; on phones the panel becomes a band
 * across the top. The column is the only place a page puts content, so the
 * sign-in, set-password and restricted screens cannot drift apart. Nothing
 * here reads the session; the pages decide what to show.
 */
export function AuthFrame({
  labelledBy,
  children,
}: {
  /** id of the page heading, so the form region is named for assistive technology. */
  labelledBy: string;
  children: ReactNode;
}) {
  return (
    <div className="auth">
      <header className="auth-panel">
        <div className="auth-brand">
          <span className="auth-mark" aria-hidden="true">
            E
          </span>
          <span>Edison Helpdesk</span>
        </div>
        <p className="auth-tagline">Tickets, people and devices for the NetRiders IT team.</p>
      </header>
      <main className="auth-column">
        <section className="auth-body" aria-labelledby={labelledBy}>
          {children}
        </section>
      </main>
    </div>
  );
}
