/**
 * Intake, and the quick ticket it may have started from.
 *
 * The form itself is a client component (`IntakeForm`); this page exists to do
 * the one thing a browser must not: read the preset. `?preset=<id>` is looked
 * up in the caller's own session, so the row policy on `ticket_presets`
 * decides — an account that does not work tickets could not have listed it and
 * cannot fetch it by guessing an id either.
 *
 * An id that names nothing is ignored rather than refused. The link may have
 * been bookmarked and the preset deleted since, and the right answer to that is
 * the ordinary empty form, not a page that will not load.
 */

import { loadDeviceRef } from '@/lib/data/devices';
import { loadTicketPreset } from '@/lib/data/ticket-presets';
import { presetDraft } from '@/lib/domain/ticket-presets';
import { IntakeForm } from '@/components/ticket/IntakeForm';

export default async function NewTicketPage({
  searchParams,
}: {
  searchParams: Promise<{ preset?: string; device?: string }>;
}) {
  const { preset: id, device: deviceId } = await searchParams;
  // `?device=` links the machine a ticket was started from (Check a device),
  // read in the caller's own session like the preset; an id that names
  // nothing is the ordinary empty form.
  const [preset, device] = await Promise.all([
    typeof id === 'string' ? loadTicketPreset(id) : null,
    typeof deviceId === 'string' ? loadDeviceRef(deviceId) : null,
  ]);

  return <IntakeForm preset={preset ? presetDraft(preset) : null} device={device} />;
}
