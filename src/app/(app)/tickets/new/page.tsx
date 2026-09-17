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

import { loadTicketPreset } from '@/lib/data/ticket-presets';
import { presetDraft } from '@/lib/domain/ticket-presets';
import { IntakeForm } from '@/components/ticket/IntakeForm';

export default async function NewTicketPage({
  searchParams,
}: {
  searchParams: Promise<{ preset?: string }>;
}) {
  const { preset: id } = await searchParams;
  const preset = typeof id === 'string' ? await loadTicketPreset(id) : null;

  return <IntakeForm preset={preset ? presetDraft(preset) : null} />;
}
