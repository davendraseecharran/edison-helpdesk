/**
 * One change applied to a selection of devices, as `app_bulk_update_devices`
 * takes it and as the toast reports it. Pure, so both are unit-tested.
 *
 * Exactly one of the four: assign them all to `personId`, `return` them all
 * (in `status`, default in stock), set their `status`, or move them to
 * `location`. `reason` is kept by the database for a status change only; the
 * dialogs therefore do not offer a note for a bulk assign or return.
 */

export interface BulkDevicePatch {
  personId?: string;
  return?: boolean;
  status?: string;
  location?: string;
  reason?: string;
}

/** The RPC's `p_patch`: column names, and only the keys that carry a value. */
export function shapeBulkPatch(patch: BulkDevicePatch): Record<string, unknown> {
  const shaped: Record<string, unknown> = {};
  if (patch.personId) shaped.person_id = patch.personId;
  if (patch.return) shaped.return = true;
  if (patch.status) shaped.status = patch.status;
  if (patch.location !== undefined) shaped.location = patch.location;
  if (patch.reason && patch.reason.trim()) shaped.reason = patch.reason.trim();
  return shaped;
}

/**
 * What the toast says, from how many devices the database reports it changed.
 * A device already in the requested state is not counted, so "0 devices"
 * becomes a plain statement that nothing needed changing.
 */
export function bulkResultMessage(patch: BulkDevicePatch, changed: number): string {
  if (changed === 0) return 'Nothing changed: the selected devices were already as asked.';
  const noun = changed === 1 ? 'device' : 'devices';
  if (patch.personId) return `${changed} ${noun} assigned.`;
  if (patch.return) return `${changed} ${noun} returned.`;
  if (patch.status) return `Status updated on ${changed} ${noun}.`;
  return `${changed} ${noun} moved.`;
}
