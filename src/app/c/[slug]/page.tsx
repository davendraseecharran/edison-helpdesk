import type { Metadata } from 'next';
import { loadPublicCheckin } from '@/lib/data/checkin';
import { CHECKIN_STATE_LABELS, longDate } from '@/lib/domain/checkin';
import { PublicCheckin } from '@/components/checkin/PublicCheckin';
import '@/styles/forms.css';
import '@/styles/checkin.css';

/**
 * Self check-in: `/c/<slug>`, reached from a poster by somebody with no
 * account and a phone.
 *
 * Outside `(app)` like the public form, and rendered per request, because a
 * check-in closed a minute ago must not be served open from a cache.
 * Everything on it comes from `app_public_checkin` through a client that is
 * nobody, so an officer testing the poster on their own phone sees exactly
 * what a student sees.
 */

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const { slug } = await params;
  const checkin = await loadPublicCheckin(slug);
  return {
    title: checkin ? `Check in: ${checkin.eventName}` : 'Check-in not available',
    robots: { index: false, follow: false },
  };
}

export default async function PublicCheckinPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const checkin = await loadPublicCheckin(slug);
  const dateLabel = checkin ? longDate(checkin.heldOn) : '';

  return (
    <main className="pf ci">
      <div className="pf-column ci-column">
        <p className="pf-school">Thomas A. Edison CTE High School</p>
        {!checkin ? (
          <section className="pf-closed">
            <h1 className="pf-title">This check-in is not available</h1>
            <p className="pf-description">
              The link may be mistyped, or the event may have been deleted. Ask the officer running
              it.
            </p>
          </section>
        ) : checkin.state !== 'open' ? (
          <section className="pf-closed ci-closed">
            <span className="pf-state">{CHECKIN_STATE_LABELS[checkin.state]}</span>
            {checkin.groupName ? <p className="ci-group">{checkin.groupName}</p> : null}
            <h1 className="pf-title">{checkin.eventName}</h1>
            <p className="pf-description">
              {checkin.state === 'early'
                ? `Check-in opens on ${dateLabel}. Scan the code again that day.`
                : checkin.state === 'ended'
                  ? `This was ${dateLabel}. Check-in has ended.`
                  : 'Check-in is closed right now. Ask an officer to mark you present.'}
            </p>
          </section>
        ) : (
          <PublicCheckin
            slug={checkin.slug}
            eventName={checkin.eventName}
            groupName={checkin.groupName}
            dateLabel={dateLabel}
            identity={checkin.identity}
          />
        )}
      </div>
    </main>
  );
}
