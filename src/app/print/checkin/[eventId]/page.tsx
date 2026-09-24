import type { Metadata } from 'next';
import Link from 'next/link';
import { ArrowLeft } from 'lucide-react';
import { createClient } from '@/lib/supabase/server';
import { checkinCode, loadEventCheckin } from '@/lib/data/checkin';
import { loadGroupEvent } from '@/lib/data/group-events';
import { longDate } from '@/lib/domain/checkin';
import { CheckinPoster } from '@/components/checkin/CheckinPoster';
import { PosterActions, PosterTurnOn } from '@/components/checkin/PosterActions';
import '@/styles/checkin.css';

export const metadata: Metadata = { title: 'Check-in poster — Edison Helpdesk' };

/**
 * The poster for an event's self check-in: one Letter page, printed and taped
 * to the door.
 *
 * Read from far away, so it says four things and says them big — what the
 * event is, when, the code, and what to do — and the link underneath for a
 * phone whose camera will not read it. Monochrome on purpose: it goes through
 * the school's printer, which is black and white, and a code printed in grey
 * is a code that does not scan.
 */
export default async function CheckinPosterPage({ params }: { params: Promise<{ eventId: string }> }) {
  const { eventId } = await params;
  const supabase = await createClient();
  const { data } = await supabase.from('group_events').select('group_id').eq('id', eventId).maybeSingle();
  const groupId = typeof data?.group_id === 'string' ? data.group_id : null;
  const detail = groupId ? await loadGroupEvent(groupId, eventId) : null;

  if (!detail) {
    return (
      <main className="poster-page">
        <div className="poster-bar">
          <Link href="/groups" className="poster-back">
            <ArrowLeft size={16} aria-hidden="true" />
            Groups
          </Link>
        </div>
        <p className="poster-note">There is no event at this address. It may have been deleted, or the link may be wrong.</p>
      </main>
    );
  }

  const eventHref = `/groups/${detail.groupId}/events/${detail.event.id}`;
  const back = (
    <Link href={eventHref} className="poster-back">
      <ArrowLeft size={16} aria-hidden="true" />
      {detail.event.name}
    </Link>
  );

  const settings = await loadEventCheckin(eventId);
  if (!settings) {
    return (
      <main className="poster-page">
        <div className="poster-bar">{back}</div>
        <PosterTurnOn eventId={eventId} />
      </main>
    );
  }

  const code = await checkinCode(settings.slug);
  const name = detail.event.name;

  return (
    <main className="poster-page">
      <div className="poster-bar">
        {back}
        <PosterActions png={code.png} fileName={`${name} check-in QR.png`} />
      </div>
      <p className="poster-note">
        {settings.state === 'open'
          ? 'Prints on one Letter page. Test it: scan the code with your phone.'
          : settings.state === 'early'
            ? `Check-in opens on ${longDate(settings.heldOn)}. The poster works from then.`
            : settings.state === 'ended'
              ? 'This event has passed, so the code shows a closed page.'
              : 'Self check-in is closed, so the code shows a closed page until you open it again.'}
      </p>

      <CheckinPoster
        eventName={detail.event.name}
        groupName={detail.groupName}
        heldOn={detail.event.heldOn}
        identity={settings.identity}
        svg={code.svg}
        url={code.url}
      />
    </main>
  );
}
