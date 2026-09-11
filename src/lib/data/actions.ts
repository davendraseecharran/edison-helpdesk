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
  requesterId?: string | null;
  requesterName?: string | null;
  requesterKind?: string | null;
  requesterDescriptor?: string | null;
  requesterUnknown?: boolean;
  location?: string | null;
  isRemote?: boolean;
  ownerId?: string | null;
  collaboratorIds?: string[];
  devices?: Array<Record<string, unknown>>;
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
      p_requester_id: fields.requesterId ?? null,
      p_requester_name: fields.requesterName ?? null,
      p_requester_kind: fields.requesterKind ?? 'staff',
      p_requester_descriptor: fields.requesterDescriptor ?? null,
      p_requester_unknown: fields.requesterUnknown ?? false,
      p_location: fields.location ?? null,
      p_is_remote: fields.isRemote ?? false,
      p_owner_id: fields.ownerId ?? null,
      p_collaborator_ids: fields.collaboratorIds ?? [],
      p_devices: fields.devices ?? [],
    },
    'Ticket created.',
  );
}

export async function claimTicketAction(ticketId: string): Promise<ActionResult> {
  return runRpc('app_claim_ticket', { p_ticket: ticketId }, 'You own this ticket.');
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
    },
    'Device recorded.',
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
