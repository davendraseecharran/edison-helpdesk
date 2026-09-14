import type { ReactNode } from 'react';
import { loadPublicTotals } from '@/lib/data/totals';

/** 4278 becomes "4,278". The counts are quantities, so they get separators. */
const count = new Intl.NumberFormat('en-US');

/**
 * The frame every public screen shares: a brand panel and a form column.
 *
 * From 1024px up they sit side by side; on phones the panel becomes a band
 * across the top. The column is the only place a page puts content, so the
 * sign-in, set-password and restricted screens cannot drift apart. Nothing
 * here reads the session; the pages decide what to show.
 *
 * The panel used to be six hundred pixels of empty navy with a wordmark at the
 * top and a tagline at the bottom. It is now the hero, and what it says is
 * true and current: how many machines this school's IT programme looks after,
 * how many people it looks after them for, and that all of it arrives through
 * one queue. Three integers from `app_public_totals()`, the one function
 * `anon` may call; no row and no name ever leaves the database. When there is
 * no count to show — an empty database, an unreachable one — the panel says
 * what the team does instead, and the sign-in form beside it is unaffected
 * either way.
 */
export async function AuthFrame({
  labelledBy,
  children,
}: {
  /** id of the page heading, so the form region is named for assistive technology. */
  labelledBy: string;
  children: ReactNode;
}) {
  const totals = await loadPublicTotals();

  /*
   * "0 devices." is not a headline, it is an admission. A count the database
   * does not have yet drops out of the sentence and the rest still reads; if
   * both drop out there is nothing to lead with and the tagline takes over.
   */
  const lines = totals
    ? [
        totals.devices > 0 ? `${count.format(totals.devices)} devices.` : null,
        totals.people > 0 ? `${count.format(totals.people)} people.` : null,
        'One queue.',
      ].filter((line): line is string => line !== null)
    : [];
  const hero = lines.length > 1 ? lines : null;

  return (
    <div className="auth">
      <header className="auth-panel">
        <div className="auth-brand">
          <span className="auth-mark" aria-hidden="true">
            E
          </span>
          <span>Edison Helpdesk</span>
        </div>

        {hero ? (
          <div className="auth-hero">
            <p className="auth-headline">
              {hero.map((line, index) => (
                <span key={line}>
                  {index > 0 ? ' ' : null}
                  {line}
                </span>
              ))}
            </p>
            {totals && totals.ticketsResolved > 0 ? (
              <p className="auth-ledger">
                {count.format(totals.ticketsResolved)}{' '}
                {totals.ticketsResolved === 1 ? 'ticket' : 'tickets'} resolved so far
              </p>
            ) : null}
          </div>
        ) : (
          <p className="auth-tagline">Tickets, people and devices for the NetRiders IT team.</p>
        )}

        {/* Two lines, written as two, so the name of the school never breaks across one. */}
        <p className="auth-credit">
          <span>Run by the NetRiders IT team</span>
          <span>Thomas A. Edison CTE High School</span>
        </p>
      </header>
      <main className="auth-column">
        <section className="auth-body" aria-labelledby={labelledBy}>
          {children}
        </section>
      </main>
    </div>
  );
}
