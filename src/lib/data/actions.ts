'use server';

/**
 * Ticket mutations.
 *
 * Every action calls one of the reviewed M2 RPCs with the signed-in user's own
 * JWT, so the database re-derives identity from auth.uid() and applies the same
 * authorization, locking and audit rules it applies to any other caller.
 * Nothing here trusts an actor id, role, timestamp or author from the browser,
 * and no action sends a client-side dataset to the backend — only the fields
 * for the one change being made.
 *
 * Server Actions are POST-only by construction and are protected by Next.js's
 * built-in action-id/origin checks, so there is no state-changing GET here.
 */

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';

export interface ActionResult {
  ok: boolean;
  error?: string;
  /** Set when a new record was created and the caller needs its id. */
  id?: string;
  message?: string;
}

/**
 * Runs an RPC as the signed-in user.
 *
 * The actor check here is a fast fail for a clearly unusable session; it is NOT
 * the security boundary. The database performs its own identity, status,
 * credential and session-currency checks inside every RPC.
 */
async function runRpc(
  fn: string,
  args: Record<string, unknown>,
  message?: string,
): Promise<ActionResult> {
  const actor = await loadActor();
  if (actor.kind !== 'active') {
    return { ok: false, error: 'Your session is not able to make changes. Sign in again.' };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    return { ok: false, error: error.message };
  }

  // Queues, counts and detail pages are all server-rendered, so one refresh
  // keeps every view and badge consistent after a change.
  revalidatePath('/', 'layout');
  return { ok: true, id: typeof data === 'string' ? data : undefined, message };
}

export interface CreateTicketFields {
  title: string;
  issue: string;
  channel: string;
  priority: string;
  submittedOn?: string | null;
  /** A staff or student row in the district directory. */
  requesterId?: string | null;
  /** True when there is nobody to name. Exclusive with requesterId. */
  requesterUnknown?: boolean;
  location?: string | null;
  ownerId?: string | null;
  collaboratorIds?: string[];
  devices?: Array<Record<string, unknown>>;
  /** One of TicketCategory. The database refuses anything else. */
  category?: string | null;
  /** Inventory machines to name on the ticket at intake. */
  deviceIds?: string[];
}

export async function createTicketAction(fields: CreateTicketFields): Promise<ActionResult> {
  return runRpc(
    'app_create_ticket',
    {
      p_title: fields.title,
      p_issue: fields.issue,
      // The server never "corrects" channel or owner for a technician: the
      // database rejects a forged combination outright.
      p_channel: fields.channel,
      p_priority: fields.priority,
      p_submitted_on: fields.submittedOn ?? null,
      // The requester is somebody already in the district directory, or
      // nobody. p_requester_name and p_is_remote still exist on the function
      // and are still refused by it, so a caller that sends either is told
      // rather than having its value quietly dropped; this one sends neither.
      p_requester_id: fields.requesterId ?? null,
      p_requester_unknown: fields.requesterUnknown ?? false,
      p_location: fields.location ?? null,
      p_owner_id: fields.ownerId ?? null,
      p_collaborator_ids: fields.collaboratorIds ?? [],
      p_devices: fields.devices ?? [],
      p_category: fields.category ?? 'other',
      p_device_ids: fields.deviceIds ?? [],
    },
    'Ticket created.',
  );
}

export async function claimTicketAction(ticketId: string): Promise<ActionResult> {
  return runRpc('app_claim_ticket', { p_ticket: ticketId }, 'You own this ticket.');
}

/**
 * Claims several tickets that are the same problem.
 *
 * One projector dies and five people report it. Claiming five tickets one at a
 * time is five presses and five page refreshes, so the grouped row does it in
 * one — but it is still five calls to `app_claim_ticket`, not a new bulk path,
 * because that function holds the locking order, the participation rules and
 * the audit entry, and a bulk write that skipped any of those would be a
 * different set of rules for the same action.
 *
 * Sequential rather than parallel: the RPC takes an advisory lock and five
 * concurrent claims would queue behind each other anyway, with the difference
 * that a failure halfway through parallel calls is harder to describe. A
 * failure here stops and reports how many committed, because "claimed three of
 * five, the fourth was taken by somebody else" is the sentence a NetRider needs
 * — not a silent partial success.
 */
export async function claimTicketsAction(ticketIds: string[]): Promise<ActionResult> {
  const ids = [...new Set(ticketIds.filter((id) => typeof id === 'string' && id !== ''))];
  if (ids.length === 0) return { ok: false, error: 'There was nothing to claim.' };
  if (ids.length === 1) return claimTicketAction(ids[0]);

  const actor = await loadActor();
  if (actor.kind !== 'active') {
    return { ok: false, error: 'Your session is not able to make changes. Sign in again.' };
  }

  const supabase = await createClient();
  let claimed = 0;
  let failure: string | null = null;

  for (const id of ids) {
    const { error } = await supabase.rpc('app_claim_ticket', { p_ticket: id });
    if (error) {
      failure = error.message;
      break;
    }
    claimed += 1;
  }

  revalidatePath('/', 'layout');

  if (failure !== null) {
    if (claimed === 0) return { ok: false, error: failure };
    return {
      ok: false,
      error: `Claimed ${claimed} of ${ids.length}. The next one could not be claimed: ${failure}`,
    };
  }
  return { ok: true, message: `You own ${claimed} tickets.` };
}

export async function returnTicketAction(ticketId: string): Promise<ActionResult> {
  return runRpc(
    'app_return_ticket_to_queue',
    { p_ticket: ticketId },
    'Ticket returned to the Open Queue.',
  );
}

export async function reassignTicketAction(
  ticketId: string,
  newOwnerId: string,
): Promise<ActionResult> {
  return runRpc(
    'app_reassign_ticket',
    { p_ticket: ticketId, p_new_owner: newOwnerId },
    'Ownership updated.',
  );
}

export async function addCollaboratorAction(
  ticketId: string,
  accountId: string,
): Promise<ActionResult> {
  return runRpc(
    'app_add_collaborator',
    { p_ticket: ticketId, p_account: accountId },
    'Collaborator added.',
  );
}

export async function removeCollaboratorAction(
  ticketId: string,
  accountId: string,
): Promise<ActionResult> {
  return runRpc(
    'app_remove_collaborator',
    { p_ticket: ticketId, p_account: accountId },
    'Collaborator removed.',
  );
}

export async function addNoteAction(ticketId: string, body: string): Promise<ActionResult> {
  return runRpc('app_add_note', { p_ticket: ticketId, p_body: body }, 'Note added.');
}

export async function recordDeviceAction(
  ticketId: string,
  device: {
    deviceType: string;
    model?: string;
    osVersion?: string;
    serialNumber?: string;
    assetTag?: string;
    identifiersNotApplicable?: boolean;
    /**
     * The inventory record this observation was made about, when the machine
     * was chosen from the picker rather than described from scratch. Null for
     * a machine the district does not own, which the desk still has to be able
     * to write down.
     */
    inventoryDeviceId?: string | null;
  },
): Promise<ActionResult> {
  return runRpc(
    'app_record_device',
    {
      p_ticket: ticketId,
      p_device_type: device.deviceType,
      p_model: device.model ?? null,
      p_os_version: device.osVersion ?? null,
      p_serial_number: device.serialNumber ?? null,
      p_asset_tag: device.assetTag ?? null,
      p_identifiers_not_applicable: device.identifiersNotApplicable ?? false,
      p_inventory_device_id: device.inventoryDeviceId ?? null,
    },
    'Device recorded.',
  );
}

export async function setCategoryAction(
  ticketId: string,
  category: string,
): Promise<ActionResult> {
  return runRpc(
    'app_set_category',
    { p_ticket: ticketId, p_category: category },
    'Category updated.',
  );
}

export async function linkDeviceAction(
  ticketId: string,
  deviceId: string,
): Promise<ActionResult> {
  return runRpc(
    'app_link_ticket_device',
    { p_ticket: ticketId, p_device: deviceId },
    'Device linked.',
  );
}

export async function unlinkDeviceAction(
  ticketId: string,
  deviceId: string,
): Promise<ActionResult> {
  return runRpc(
    'app_unlink_ticket_device',
    { p_ticket: ticketId, p_device: deviceId },
    'Device unlinked.',
  );
}

export async function setPriorityAction(
  ticketId: string,
  priority: string,
): Promise<ActionResult> {
  return runRpc('app_set_priority', { p_ticket: ticketId, p_priority: priority }, 'Priority updated.');
}

export async function setWaitingAction(ticketId: string, reason: string): Promise<ActionResult> {
  return runRpc('app_set_waiting', { p_ticket: ticketId, p_reason: reason }, 'Ticket is waiting.');
}

export async function resumeWorkAction(ticketId: string): Promise<ActionResult> {
  return runRpc('app_resume_work', { p_ticket: ticketId }, 'Work resumed.');
}

export async function logWorkAction(
  ticketId: string,
  minutes: number,
  workDate?: string | null,
  description?: string | null,
): Promise<ActionResult> {
  return runRpc(
    'app_log_work',
    {
      p_ticket: ticketId,
      p_minutes: minutes,
      p_work_date: workDate ?? null,
      p_description: description ?? null,
    },
    'Time recorded.',
  );
}

export async function resolveTicketAction(
  ticketId: string,
  solution: string,
): Promise<ActionResult> {
  return runRpc(
    'app_resolve_ticket',
    { p_ticket: ticketId, p_solution: solution },
    'Ticket resolved.',
  );
}

export async function reopenTicketAction(ticketId: string, reason: string): Promise<ActionResult> {
  return runRpc('app_reopen_ticket', { p_ticket: ticketId, p_reason: reason }, 'Ticket reopened.');
}

export async function cancelTicketAction(ticketId: string, reason: string): Promise<ActionResult> {
  return runRpc('app_cancel_ticket', { p_ticket: ticketId, p_reason: reason }, 'Ticket cancelled.');
}
