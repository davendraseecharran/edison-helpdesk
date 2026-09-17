import { notFound, redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';

/**
 * Where a search hit for an event goes.
 *
 * An event's page lives under its group, at `/groups/{group}/events/{event}`,
 * and a lookup hit carries only the event's own id: `app_search` returns the
 * same six columns for every kind, and widening it for one link would widen
 * every screen that reads it. So the hit links here, and this page reads the
 * one missing fact and sends the browser on.
 *
 * The read goes through the signed-in client, so `group_events_select_active`
 * decides whether there is anything to redirect to. An account the policy
 * refuses sees the same 404 as a link to an event that was deleted; neither
 * learns that the id was ever real.
 */
export default async function EventRedirectPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const supabase = await createClient();
  // `maybeSingle`, so an id that matches nothing is a null row rather than an
  // error, and an id that is not a uuid at all — which the column type
  // refuses — is an error that reads as the same null.
  const { data } = await supabase
    .from('group_events')
    .select('group_id')
    .eq('id', id)
    .maybeSingle();
  const groupId = typeof data?.group_id === 'string' ? data.group_id : null;
  if (groupId === null) notFound();

  redirect(`/groups/${encodeURIComponent(groupId)}/events/${encodeURIComponent(id)}`);
}
