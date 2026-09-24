import { loadGroupEvent } from '@/lib/data/group-events';
import { createClient } from '@/lib/supabase/server';
import { formatDateKey } from '@/lib/format';
import { EventKiosk } from '@/components/forms/EventKiosk';
import { KioskUnavailable } from '@/components/forms/KioskUnavailable';

/**
 * Check-in for one event. The event's group is read first — the kiosk's URL
 * carries only the event, like a search hit does — and then the event with its
 * roll, through the same reads the event's own page uses.
 */
export default async function EventKioskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const supabase = await createClient();
  const { data } = await supabase.from('group_events').select('group_id').eq('id', id).maybeSingle();
  const groupId = typeof data?.group_id === 'string' ? data.group_id : null;
  const detail = groupId ? await loadGroupEvent(groupId, id) : null;

  if (!detail) {
    return <KioskUnavailable what="event" backHref="/groups" />;
  }

  return (
    <EventKiosk
      eventId={detail.event.id}
      eventName={detail.event.name}
      groupId={detail.groupId}
      groupName={detail.groupName}
      heldOnLabel={formatDateKey(detail.event.heldOn)}
      initialPresent={detail.roll.filter((entry) => entry.present).length}
      memberCount={detail.roll.length}
    />
  );
}
