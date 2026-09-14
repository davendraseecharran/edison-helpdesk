/**
 * One change applied to a selection of machines, as `app_bulk_update_inventory`
 * takes it and as the toast reports it. Pure, so both are unit-tested.
 *
 * Three fields, because those are the three the database accepts in bulk:
 * status, location and notes. Assignment is deliberately not one of them —
 * handing a machine to somebody is one machine and one person at a time, with
 * its own note and its own history, through `app_assign_inventory_device`.
 */

export interface BulkDevicePatch {
  status?: string;
  location?: string;
  notes?: string;
}

/** The RPC's `p_patch`: only the keys that are actually being changed. */
export function shapeBulkPatch(patch: BulkDevicePatch): Record<string, unknown> {
  const shaped: Record<string, unknown> = {};
  if (patch.status !== undefined) shaped.status = patch.status;
  if (patch.location !== undefined) shaped.location = patch.location;
  if (patch.notes !== undefined) shaped.notes = patch.notes;
  return shaped;
}

/**
 * What the toast says, from how many machines the database reports it changed.
 * An id that names no machine is skipped rather than failing the batch, so
 * "0 devices" is a plain statement that nothing was found to change.
 */
export function bulkResultMessage(patch: BulkDevicePatch, changed: number): string {
  if (changed === 0) return 'Nothing changed: none of the selected devices could be updated.';
  const noun = changed === 1 ? 'device' : 'devices';
  if (patch.status !== undefined) return `Status updated on ${changed} ${noun}.`;
  if (patch.location !== undefined) {
    return patch.location.trim() ? `${changed} ${noun} moved.` : `Location cleared on ${changed} ${noun}.`;
  }
  return `Notes updated on ${changed} ${noun}.`;
}
