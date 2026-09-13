/**
 * Every state change in the prototype goes through one of these functions.
 *
 * They are pure: `(data, context, input) => OperationResult`. Nothing here
 * touches React, the browser, or a clock — the caller supplies `now`/`today`.
 * That keeps the rules testable and gives M2 a one-to-one target list for
 * Supabase server actions / RPCs.
 *
 * What these functions are NOT: they are not a security boundary. They run in
 * the browser in M1. Identity comes from a labelled demo switcher, so a
 * permission failure here is a user-experience guard rail, not authorization.
 */

import {
  type Account,
  type AccountId,
  type AccountStatus,
  type ActivityEvent,
  type ActivityKind,
  type DeviceObservation,
  type HelpdeskData,
  type IntakeChannel,
  type OperationContext,
  type OperationResult,
  type Priority,
  type Requester,
  type RequesterId,
  type Ticket,
  type TicketCategory,
  type TicketId,
  CHANNEL_LABELS,
  PRIORITY_LABELS,
  isTicketCategory,
} from './types';
import {
  canAdministerAccounts,
  canAdministerTicket,
  canReturnToQueue,
  canClaimTicket,
  canContribute,
  canCreateTicket,
  canLogWork,
  canManageCollaborators,
  canResolveTicket,
  canSetPriority,
  canViewTicket,
  findAccount,
  isAdmin,
} from './permissions';
import { isValidDateKey } from '../format';

/** Shortest solution we accept. Blank is rejected outright. */
const MIN_SOLUTION_LENGTH = 5;
const MAX_WORK_LOG_MINUTES = 1440;

function fail(error: string, field?: string): OperationResult {
  return { ok: false, error, field };
}

function succeed(
  data: HelpdeskData,
  extra: { ticketId?: TicketId; message?: string } = {},
): OperationResult {
  return { ok: true, data, ...extra };
}

/** Shallow clone so React sees new references without deep-copying records. */
function draft(data: HelpdeskData): HelpdeskData {
  return {
    accounts: [...data.accounts],
    requesters: [...data.requesters],
    tickets: [...data.tickets],
    deviceObservations: [...data.deviceObservations],
    notes: [...data.notes],
    workLogs: [...data.workLogs],
    activity: [...data.activity],
    sequences: { ...data.sequences },
  };
}

function nextId(next: HelpdeskData, prefix: string): string {
  next.sequences.entity += 1;
  return `${prefix}_${next.sequences.entity}`;
}

export function nameOf(data: HelpdeskData, id: AccountId | null): string {
  return findAccount(data, id)?.displayName ?? 'Unknown user';
}

export function findTicket(data: HelpdeskData, ticketId: TicketId): Ticket | null {
  return data.tickets.find((ticket) => ticket.id === ticketId) ?? null;
}

export function findRequester(
  data: HelpdeskData,
  requesterId: RequesterId | null,
): Requester | null {
  if (!requesterId) return null;
  return data.requesters.find((requester) => requester.id === requesterId) ?? null;
}

function replaceTicket(next: HelpdeskData, ticketId: TicketId, patch: Partial<Ticket>): Ticket {
  let updated: Ticket | null = null;
  next.tickets = next.tickets.map((ticket) => {
    if (ticket.id !== ticketId) return ticket;
    updated = { ...ticket, ...patch };
    return updated;
  });
  if (!updated) throw new Error(`Ticket ${ticketId} disappeared during update`);
  return updated;
}

function logActivity(
  next: HelpdeskData,
  context: OperationContext,
  ticketId: TicketId,
  kind: ActivityKind,
  summary: string,
  detail?: string | null,
): void {
  const event: ActivityEvent = {
    id: nextId(next, 'evt'),
    ticketId,
    kind,
    actorId: context.actorId,
    at: context.now,
    summary,
    detail: detail ?? null,
  };
  next.activity = [...next.activity, event];
}

/** Resolves the acting account and rejects unusable ones up front. */
function requireActor(
  data: HelpdeskData,
  context: OperationContext,
): { account: Account } | { error: OperationResult } {
  const account = findAccount(data, context.actorId);
  if (!account) return { error: fail('That account no longer exists. Sign in again.') };
  // Checked on `status` directly rather than through the `isUsableAccount` type
  // guard, whose negation would narrow `account` to `never` here.
  if (account.status !== 'active') {
    return {
      error: fail(
        account.status === 'setup_pending'
          ? 'This account has not completed password setup, so it cannot access tickets.'
          : 'This account is inactive and cannot access tickets.',
      ),
    };
  }
  return { account };
}

function requireVisibleTicket(
  data: HelpdeskData,
  actor: Account,
  ticketId: TicketId,
): { ticket: Ticket } | { error: OperationResult } {
  const ticket = findTicket(data, ticketId);
  // A ticket the actor may not see must not be distinguishable from a missing one.
  if (!ticket || !canViewTicket(ticket, actor)) {
    return { error: fail('That ticket is not available to this account.') };
  }
  return { ticket };
}

function trimmed(value: string | undefined | null): string {
  return (value ?? '').trim();
}

function normaliseOptional(value: string | undefined | null): string | null {
  const text = trimmed(value);
  return text.length > 0 ? text : null;
}

// ---------------------------------------------------------------------------
// Intake
// ---------------------------------------------------------------------------

export interface DeviceObservationInput {
  deviceType: string;
  model?: string;
  osVersion?: string;
  serialNumber?: string;
  assetTag?: string;
  identifiersNotApplicable?: boolean;
}

export interface CreateTicketInput {
  title: string;
  issue: string;
  channel: IntakeChannel;
  priority: Priority;
  /** Defaults to `other`, which is what an uncategorised ticket honestly is. */
  category?: TicketCategory;
  /** School-local `YYYY-MM-DD`. Defaults to today in the UI; backdating allowed. */
  submittedOn: string;
  requesterId?: RequesterId | null;
  /** Used when the requester is not yet in the minimal directory. */
  requesterName?: string;
  requesterKind?: Requester['kind'];
  requesterDescriptor?: string;
  requesterUnknown?: boolean;
  location?: string;
  isRemote?: boolean;
  /** Admin only. `null`/omitted routes the ticket to the Open Queue. */
  ownerId?: AccountId | null;
  collaboratorIds?: AccountId[];
  devices?: DeviceObservationInput[];
}

function buildDeviceObservations(
  next: HelpdeskData,
  context: OperationContext,
  ticketId: TicketId,
  inputs: DeviceObservationInput[],
): DeviceObservation[] | { error: OperationResult } {
  const observations: DeviceObservation[] = [];
  for (const input of inputs) {
    const deviceType = trimmed(input.deviceType);
    if (!deviceType) {
      return { error: fail('Each device entry needs a device type.', 'deviceType') };
    }
    observations.push({
      id: nextId(next, 'dev'),
      ticketId,
      deviceType,
      model: normaliseOptional(input.model),
      osVersion: normaliseOptional(input.osVersion),
      // Unknown serials and asset tags stay null; they never block recording.
      serialNumber: normaliseOptional(input.serialNumber),
      assetTag: normaliseOptional(input.assetTag),
      identifiersNotApplicable: input.identifiersNotApplicable === true,
      recordedById: context.actorId,
      recordedAt: context.now,
    });
  }
  return observations;
}

export function createTicket(
  data: HelpdeskData,
  context: OperationContext,
  input: CreateTicketInput,
): OperationResult {
  const actorResult = requireActor(data, context);
  if ('error' in actorResult) return actorResult.error;
  const actor = actorResult.account;

  if (!canCreateTicket(actor)) {
    return fail('This account cannot create tickets.');
  }

  const title = trimmed(input.title);
  if (!title) return fail('A short title is required.', 'title');
  if (title.length > 120) return fail('Keep the title under 120 characters.', 'title');

  const issue = trimmed(input.issue);
  if (!issue) return fail('Describe the issue before saving.', 'issue');

  // Absent means 'other'; PRESENT AND WRONG is rejected rather than folded to
  // it, matching the database. Rewriting a category nobody recognises would
  // hide a broken caller and file the ticket where nobody is looking for it.
  if (input.category !== undefined && !isTicketCategory(input.category)) {
    return fail('Choose a category for this ticket.', 'category');
  }
  const category: TicketCategory = input.category ?? 'other';

  if (!isValidDateKey(input.submittedOn)) {
    return fail('Enter a valid submission date.', 'submittedOn');
  }
  if (input.submittedOn > context.today) {
    return fail('The submission date cannot be in the future.', 'submittedOn');
  }

  // Channel and initial owner are enforced, not silently corrected: a technician
  // attempting anything other than a self-assigned walk-in is a rejected request.
  const channel: IntakeChannel = input.channel;
  let ownerId: AccountId | null = input.ownerId ?? null;

  if (!isAdmin(actor)) {
    if (channel !== 'walk_in') {
      return fail('Technicians can only record walk-in tickets.', 'channel');
    }
    if (ownerId !== null && ownerId !== actor.id) {
      return fail('Technicians must assign their walk-in tickets to themselves.', 'ownerId');
    }
    ownerId = actor.id;
  }

  if (ownerId) {
    const owner = findAccount(data, ownerId);
    if (!owner || owner.status !== 'active') {
      return fail('Choose an active technician as the owner.', 'ownerId');
    }
  }

  const requesterUnknown = input.requesterUnknown === true;
  let requesterId: RequesterId | null = input.requesterId ?? null;
  const requesterName = trimmed(input.requesterName);

  if (!requesterUnknown && !requesterId && !requesterName) {
    return fail(
      'Name the requester, or mark the requester as unknown.',
      'requester',
    );
  }
  if (requesterUnknown) {
    requesterId = null;
  } else if (requesterId && !findRequester(data, requesterId)) {
    return fail('That requester record no longer exists.', 'requester');
  }

  const next = draft(data);

  if (!requesterUnknown && !requesterId) {
    const requester: Requester = {
      id: nextId(next, 'req'),
      displayName: requesterName,
      kind: input.requesterKind ?? 'staff',
      descriptor: normaliseOptional(input.requesterDescriptor),
    };
    next.requesters = [...next.requesters, requester];
    requesterId = requester.id;
  }

  const collaboratorIds: AccountId[] = [];
  for (const candidateId of input.collaboratorIds ?? []) {
    if (candidateId === ownerId) continue;
    const candidate = findAccount(data, candidateId);
    if (!candidate || candidate.status !== 'active') {
      return fail('Collaborators must be active accounts.', 'collaborators');
    }
    if (!collaboratorIds.includes(candidateId)) collaboratorIds.push(candidateId);
  }

  next.sequences.ticketNumber += 1;
  const ticketId = nextId(next, 'tkt');
  const isRemote = input.isRemote === true;

  const ticket: Ticket = {
    id: ticketId,
    number: `EDT-${next.sequences.ticketNumber}`,
    title,
    issue,
    requesterId,
    requesterUnknown,
    location: isRemote ? null : normaliseOptional(input.location),
    isRemote,
    channel,
    priority: input.priority,
    category,
    // The in-memory dataset has no inventory to link to.
    linkedDeviceCount: 0,
    status: ownerId ? 'assigned' : 'open',
    submittedOn: input.submittedOn,
    // The real creation instant is recorded separately so backdating the
    // submission date never rewrites the audit record.
    createdAt: context.now,
    createdById: actor.id,
    ownerId,
    collaboratorIds,
    assignedAt: ownerId ? context.now : null,
    waitingReason: null,
    solution: null,
    resolvedById: null,
    resolvedAt: null,
    cancelReason: null,
  };

  const devices = buildDeviceObservations(next, context, ticketId, input.devices ?? []);
  if ('error' in devices) return devices.error;

  next.tickets = [...next.tickets, ticket];

  logActivity(
    next,
    context,
    ticketId,
    'created',
    `${actor.displayName} recorded a ${CHANNEL_LABELS[channel].toLowerCase()} request`,
    input.submittedOn !== context.today
      ? `Submission date backdated to ${input.submittedOn}.`
      : null,
  );
  if (ownerId) {
    logActivity(
      next,
      context,
      ticketId,
      'assigned',
      ownerId === actor.id
        ? `${actor.displayName} took ownership at intake`
        : `${actor.displayName} assigned the ticket to ${nameOf(next, ownerId)}`,
    );
  }
  for (const collaboratorId of collaboratorIds) {
    logActivity(
      next,
      context,
      ticketId,
      'collaborator_added',
      `${actor.displayName} added ${nameOf(next, collaboratorId)} as a collaborator`,
    );
  }
  for (const device of devices) {
    logActivity(
      next,
      context,
      ticketId,
      'device_recorded',
      `${actor.displayName} recorded a device: ${device.deviceType}`,
    );
  }

  // Device rows live in a normalised array; they are attached via ticketId.
  next.deviceObservations = [...next.deviceObservations, ...devices];

  return succeed(next, { ticketId, message: `${ticket.number} created.` });
}

// ---------------------------------------------------------------------------
// Queue movement
// ---------------------------------------------------------------------------

export function claimTicket(
  data: HelpdeskData,
  context: OperationContext,
  ticketId: TicketId,
): OperationResult {
  const actorResult = requireActor(data, context);
  if ('error' in actorResult) return actorResult.error;
  const actor = actorResult.account;

  const ticket = findTicket(data, ticketId);
  if (!ticket) return fail('That ticket is not available to this account.');

  // Losing side of a simultaneous claim. The workflow in TICKETING-PLAN.md
  // requires the technician who lost the race to see the updated owner, so this
  // one message deliberately names someone on a ticket that is no longer in the
  // caller's queue. It is the only place that happens.
  //
  // M2 note: this disclosure must be scoped server-side — answer with the owner
  // only for a ticket the caller could actually see as claimable, and make the
  // claim itself a conditional UPDATE so exactly one writer wins. Nothing in this
  // browser-side store can guarantee either property.
  if (ticket.ownerId !== null) {
    return fail(`${ticket.number} was already claimed by ${nameOf(data, ticket.ownerId)}.`);
  }
  // Anything else unclaimable (cancelled, or resolved with no owner) stays
  // indistinguishable from a ticket that does not exist.
  if (!canClaimTicket(ticket, actor) || ticket.status !== 'open') {
    return fail('That ticket is not available to this account.');
  }

  const next = draft(data);
  replaceTicket(next, ticketId, {
    ownerId: actor.id,
    status: 'assigned',
    assignedAt: context.now,
    collaboratorIds: ticket.collaboratorIds.filter((id) => id !== actor.id),
  });
  logActivity(next, context, ticketId, 'claimed', `${actor.displayName} claimed the ticket`);

  return succeed(next, { ticketId, message: `You own ${ticket.number}.` });
}

export function reassignTicket(
  data: HelpdeskData,
  context: OperationContext,
  ticketId: TicketId,
  newOwnerId: AccountId | null,
): OperationResult {
  const actorResult = requireActor(data, context);
  if ('error' in actorResult) return actorResult.error;
  const actor = actorResult.account;

  const ticketResult = requireVisibleTicket(data, actor, ticketId);
  if ('error' in ticketResult) return ticketResult.error;
  const ticket = ticketResult.ticket;

  if (!canAdministerTicket(actor) &&
      !(newOwnerId === null && canReturnToQueue(ticket, actor))) {
    return fail('Only an administrator can reassign a ticket. The primary owner can return unfinished work to the Open Queue.');
  }

  if (ticket.status === 'resolved' || ticket.status === 'cancelled') {
    return fail('Reopen the ticket before reassigning it.');
  }
  if (ticket.ownerId === newOwnerId) {
    return fail(
      newOwnerId
        ? `${nameOf(data, newOwnerId)} already owns this ticket.`
        : 'This ticket is already in the Open Queue.',
    );
  }
  if (newOwnerId) {
    const owner = findAccount(data, newOwnerId);
    if (!owner || owner.status !== 'active') {
      return fail('Choose an active technician.', 'ownerId');
    }
  }

  const previousOwnerId = ticket.ownerId;
  const next = draft(data);

  if (newOwnerId === null) {
    replaceTicket(next, ticketId, {
      ownerId: null,
      status: 'open',
      assignedAt: null,
      waitingReason: null,
    });
    logActivity(
      next,
      context,
      ticketId,
      'returned_to_queue',
      previousOwnerId
        ? `${actor.displayName} returned the ticket to the Open Queue from ${nameOf(data, previousOwnerId)}`
        : `${actor.displayName} returned the ticket to the Open Queue`,
    );
  } else {
    replaceTicket(next, ticketId, {
      ownerId: newOwnerId,
      status: ticket.status === 'open' ? 'assigned' : ticket.status,
      assignedAt: context.now,
      // Someone cannot be both primary owner and collaborator.
      collaboratorIds: ticket.collaboratorIds.filter((id) => id !== newOwnerId),
    });
    logActivity(
      next,
      context,
      ticketId,
      'assigned',
      previousOwnerId
        ? `${actor.displayName} reassigned the ticket from ${nameOf(data, previousOwnerId)} to ${nameOf(data, newOwnerId)}`
        : `${actor.displayName} assigned the ticket to ${nameOf(data, newOwnerId)}`,
    );
  }

  return succeed(next, { ticketId, message: newOwnerId === null ? `${ticket.number} returned to the Open Queue. All contributions have been kept.` : 'Ownership updated.' });
}

// ---------------------------------------------------------------------------
// Collaboration
// ---------------------------------------------------------------------------

export function addCollaborator(
  data: HelpdeskData,
  context: OperationContext,
  ticketId: TicketId,
  collaboratorId: AccountId,
): OperationResult {
  const actorResult = requireActor(data, context);
  if ('error' in actorResult) return actorResult.error;
  const actor = actorResult.account;

  const ticketResult = requireVisibleTicket(data, actor, ticketId);
  if ('error' in ticketResult) return ticketResult.error;
  const ticket = ticketResult.ticket;

  if (!canManageCollaborators(ticket, actor)) {
    return fail('Only the primary owner or an administrator can change collaborators.');
  }
  const collaborator = findAccount(data, collaboratorId);
  if (!collaborator || collaborator.status !== 'active') {
    return fail('Choose an active account to collaborate.', 'collaboratorId');
  }
  if (ticket.ownerId === collaboratorId) {
    return fail(`${collaborator.displayName} is already the primary owner.`, 'collaboratorId');
  }
  if (ticket.collaboratorIds.includes(collaboratorId)) {
    return fail(`${collaborator.displayName} is already collaborating.`, 'collaboratorId');
  }

  const next = draft(data);
  replaceTicket(next, ticketId, {
    collaboratorIds: [...ticket.collaboratorIds, collaboratorId],
  });
  logActivity(
    next,
    context,
    ticketId,
    'collaborator_added',
    `${actor.displayName} added ${collaborator.displayName} as a collaborator`,
  );

  return succeed(next, { ticketId, message: `${collaborator.displayName} can now help.` });
}

export function removeCollaborator(
  data: HelpdeskData,
  context: OperationContext,
  ticketId: TicketId,
  collaboratorId: AccountId,
): OperationResult {
  const actorResult = requireActor(data, context);
  if ('error' in actorResult) return actorResult.error;
  const actor = actorResult.account;

  const ticketResult = requireVisibleTicket(data, actor, ticketId);
  if ('error' in ticketResult) return ticketResult.error;
  const ticket = ticketResult.ticket;

  if (!canManageCollaborators(ticket, actor)) {
    return fail('Only the primary owner or an administrator can change collaborators.');
  }
  if (!ticket.collaboratorIds.includes(collaboratorId)) {
    return fail('That account is not collaborating on this ticket.');
  }

  const next = draft(data);
  replaceTicket(next, ticketId, {
    collaboratorIds: ticket.collaboratorIds.filter((id) => id !== collaboratorId),
  });
  // Removal revokes further access; notes and events they already authored keep
  // their attribution.
  logActivity(
    next,
    context,
    ticketId,
    'collaborator_removed',
    `${actor.displayName} removed ${nameOf(data, collaboratorId)} from the ticket`,
  );

  return succeed(next, { ticketId, message: 'Collaborator removed.' });
}

// ---------------------------------------------------------------------------
// Work records
// ---------------------------------------------------------------------------

export function addNote(
  data: HelpdeskData,
  context: OperationContext,
  ticketId: TicketId,
  body: string,
): OperationResult {
  const actorResult = requireActor(data, context);
  if ('error' in actorResult) return actorResult.error;
  const actor = actorResult.account;

  const ticketResult = requireVisibleTicket(data, actor, ticketId);
  if ('error' in ticketResult) return ticketResult.error;
  const ticket = ticketResult.ticket;

  if (!canContribute(ticket, actor)) {
    return fail(
      ticket.status === 'resolved' || ticket.status === 'cancelled'
        ? 'This ticket is closed. An administrator must reopen it before new notes.'
        : 'Claim the ticket or ask to be added as a collaborator before adding notes.',
    );
  }
  const text = trimmed(body);
  if (!text) return fail('Write the note before saving.', 'body');

  const next = draft(data);
  next.notes = [
    ...next.notes,
    {
      id: nextId(next, 'note'),
      ticketId,
      authorId: actor.id,
      body: text,
      createdAt: context.now,
    },
  ];
  // Recording work moves an untouched assignment into In progress.
  if (ticket.status === 'assigned') {
    replaceTicket(next, ticketId, { status: 'in_progress' });
    logActivity(
      next,
      context,
      ticketId,
      'status_changed',
      `${actor.displayName} started work`,
    );
  }
  logActivity(next, context, ticketId, 'note_added', `${actor.displayName} added a work note`, text);

  return succeed(next, { ticketId, message: 'Note added.' });
}

export function recordDeviceObservation(
  data: HelpdeskData,
  context: OperationContext,
  ticketId: TicketId,
  input: DeviceObservationInput,
): OperationResult {
  const actorResult = requireActor(data, context);
  if ('error' in actorResult) return actorResult.error;
  const actor = actorResult.account;

  const ticketResult = requireVisibleTicket(data, actor, ticketId);
  if ('error' in ticketResult) return ticketResult.error;
  const ticket = ticketResult.ticket;

  if (!canContribute(ticket, actor)) {
    return fail('Only participants can record device details on this ticket.');
  }

  const next = draft(data);
  const devices = buildDeviceObservations(next, context, ticketId, [input]);
  if ('error' in devices) return devices.error;

  next.deviceObservations = [...next.deviceObservations, ...devices];
  if (ticket.status === 'assigned') {
    replaceTicket(next, ticketId, { status: 'in_progress' });
    logActivity(next, context, ticketId, 'status_changed', `${actor.displayName} started work`);
  }
  logActivity(
    next,
    context,
    ticketId,
    'device_recorded',
    `${actor.displayName} recorded a device: ${devices[0]?.deviceType ?? 'device'}`,
  );

  return succeed(next, { ticketId, message: 'Device recorded.' });
}

export interface WorkLogInput {
  /** School-local `YYYY-MM-DD`. */
  workDate: string;
  minutes: number;
  description?: string;
}

export function logWork(
  data: HelpdeskData,
  context: OperationContext,
  ticketId: TicketId,
  input: WorkLogInput,
): OperationResult {
  const actorResult = requireActor(data, context);
  if ('error' in actorResult) return actorResult.error;
  const actor = actorResult.account;

  const ticketResult = requireVisibleTicket(data, actor, ticketId);
  if ('error' in ticketResult) return ticketResult.error;
  const ticket = ticketResult.ticket;

  if (!canLogWork(ticket, actor)) {
    return fail('Only participants can record time on this ticket.');
  }
  if (!isValidDateKey(input.workDate)) {
    return fail('Enter a valid work date.', 'workDate');
  }
  if (input.workDate > context.today) {
    return fail('The work date cannot be in the future.', 'workDate');
  }
  if (!Number.isInteger(input.minutes) || input.minutes <= 0) {
    return fail('Enter whole minutes greater than zero.', 'minutes');
  }
  if (input.minutes > MAX_WORK_LOG_MINUTES) {
    return fail('Split entries longer than 24 hours.', 'minutes');
  }

  const next = draft(data);
  next.workLogs = [
    ...next.workLogs,
    {
      id: nextId(next, 'log'),
      ticketId,
      contributorId: actor.id,
      workDate: input.workDate,
      minutes: input.minutes,
      description: normaliseOptional(input.description),
      createdAt: context.now,
    },
  ];
  logActivity(
    next,
    context,
    ticketId,
    'time_logged',
    `${actor.displayName} logged ${input.minutes} minutes`,
    normaliseOptional(input.description),
  );

  return succeed(next, { ticketId, message: 'Time recorded.' });
}

export function setPriority(
  data: HelpdeskData,
  context: OperationContext,
  ticketId: TicketId,
  priority: Priority,
): OperationResult {
  const actorResult = requireActor(data, context);
  if ('error' in actorResult) return actorResult.error;
  const actor = actorResult.account;

  const ticketResult = requireVisibleTicket(data, actor, ticketId);
  if ('error' in ticketResult) return ticketResult.error;
  const ticket = ticketResult.ticket;

  if (!canSetPriority(ticket, actor)) {
    return fail('Only participants or an administrator can change priority.');
  }
  if (ticket.priority === priority) {
    return fail(`Priority is already ${PRIORITY_LABELS[priority]}.`);
  }

  const next = draft(data);
  replaceTicket(next, ticketId, { priority });
  logActivity(
    next,
    context,
    ticketId,
    'priority_changed',
    `${actor.displayName} changed priority from ${PRIORITY_LABELS[ticket.priority]} to ${PRIORITY_LABELS[priority]}`,
  );

  return succeed(next, { ticketId, message: `Priority set to ${PRIORITY_LABELS[priority]}.` });
}

export function setWaiting(
  data: HelpdeskData,
  context: OperationContext,
  ticketId: TicketId,
  reason: string,
): OperationResult {
  const actorResult = requireActor(data, context);
  if ('error' in actorResult) return actorResult.error;
  const actor = actorResult.account;

  const ticketResult = requireVisibleTicket(data, actor, ticketId);
  if ('error' in ticketResult) return ticketResult.error;
  const ticket = ticketResult.ticket;

  if (!canContribute(ticket, actor)) {
    return fail('Only participants can put this ticket on hold.');
  }
  const text = trimmed(reason);
  if (!text) return fail('Waiting needs a reason.', 'waitingReason');
  if (ticket.ownerId === null) {
    return fail('Claim the ticket before putting it on hold.');
  }

  const next = draft(data);
  replaceTicket(next, ticketId, { status: 'waiting', waitingReason: text });
  logActivity(
    next,
    context,
    ticketId,
    'status_changed',
    `${actor.displayName} set the ticket to Waiting`,
    text,
  );

  return succeed(next, { ticketId, message: 'Ticket is waiting.' });
}

export function resumeWork(
  data: HelpdeskData,
  context: OperationContext,
  ticketId: TicketId,
): OperationResult {
  const actorResult = requireActor(data, context);
  if ('error' in actorResult) return actorResult.error;
  const actor = actorResult.account;

  const ticketResult = requireVisibleTicket(data, actor, ticketId);
  if ('error' in ticketResult) return ticketResult.error;
  const ticket = ticketResult.ticket;

  if (!canContribute(ticket, actor)) {
    return fail('Only participants can resume this ticket.');
  }
  if (ticket.status !== 'waiting') {
    return fail('This ticket is not waiting.');
  }

  const next = draft(data);
  replaceTicket(next, ticketId, { status: 'in_progress', waitingReason: null });
  logActivity(
    next,
    context,
    ticketId,
    'status_changed',
    `${actor.displayName} resumed work`,
  );

  return succeed(next, { ticketId, message: 'Work resumed.' });
}

// ---------------------------------------------------------------------------
// Completion
// ---------------------------------------------------------------------------

export function resolveTicket(
  data: HelpdeskData,
  context: OperationContext,
  ticketId: TicketId,
  solution: string,
): OperationResult {
  const actorResult = requireActor(data, context);
  if ('error' in actorResult) return actorResult.error;
  const actor = actorResult.account;

  const ticketResult = requireVisibleTicket(data, actor, ticketId);
  if ('error' in ticketResult) return ticketResult.error;
  const ticket = ticketResult.ticket;

  // Guard a second transition so one resolution creates one completion event.
  if (ticket.status === 'resolved') {
    return fail(`${ticket.number} was already resolved by ${nameOf(data, ticket.resolvedById)}.`);
  }
  if (ticket.status === 'cancelled') {
    return fail('Cancelled tickets cannot be resolved. An administrator can reopen it.');
  }
  if (!canResolveTicket(ticket, actor)) {
    return fail('Only the primary owner, a collaborator, or an administrator can resolve this ticket.');
  }

  const text = trimmed(solution);
  if (!text) return fail('A solution is required to resolve a ticket.', 'solution');
  if (text.length < MIN_SOLUTION_LENGTH) {
    return fail('Describe the solution so the history stays useful.', 'solution');
  }

  const next = draft(data);
  replaceTicket(next, ticketId, {
    status: 'resolved',
    solution: text,
    // The primary owner is preserved; the resolver is recorded separately.
    resolvedById: actor.id,
    resolvedAt: context.now,
    waitingReason: null,
  });
  logActivity(
    next,
    context,
    ticketId,
    'resolved',
    ticket.ownerId && ticket.ownerId !== actor.id
      ? `${actor.displayName} resolved the ticket (owner ${nameOf(data, ticket.ownerId)})`
      : `${actor.displayName} resolved the ticket`,
    text,
  );

  // No time entry is required: an absent work log means "not recorded", which is
  // deliberately different from a recorded zero.
  return succeed(next, { ticketId, message: `${ticket.number} resolved.` });
}

export function reopenTicket(
  data: HelpdeskData,
  context: OperationContext,
  ticketId: TicketId,
  reason: string,
): OperationResult {
  const actorResult = requireActor(data, context);
  if ('error' in actorResult) return actorResult.error;
  const actor = actorResult.account;

  if (!canAdministerTicket(actor)) {
    return fail('Only an administrator can reopen a ticket.');
  }

  const ticketResult = requireVisibleTicket(data, actor, ticketId);
  if ('error' in ticketResult) return ticketResult.error;
  const ticket = ticketResult.ticket;

  if (ticket.status !== 'resolved' && ticket.status !== 'cancelled') {
    return fail('Only resolved or cancelled tickets can be reopened.');
  }
  const text = trimmed(reason);
  if (!text) return fail('Reopening needs a reason.', 'reason');

  const next = draft(data);
  replaceTicket(next, ticketId, {
    // Previous ownership, notes, time and events are all preserved. The stored
    // solution stays visible as the previous solution until a new one replaces it.
    status: ticket.ownerId ? 'assigned' : 'open',
    resolvedById: null,
    resolvedAt: null,
    cancelReason: null,
  });
  logActivity(
    next,
    context,
    ticketId,
    'reopened',
    `${actor.displayName} reopened the ticket`,
    text,
  );

  return succeed(next, { ticketId, message: `${ticket.number} reopened.` });
}

export function cancelTicket(
  data: HelpdeskData,
  context: OperationContext,
  ticketId: TicketId,
  reason: string,
): OperationResult {
  const actorResult = requireActor(data, context);
  if ('error' in actorResult) return actorResult.error;
  const actor = actorResult.account;

  if (!canAdministerTicket(actor)) {
    return fail('Only an administrator can cancel a ticket.');
  }

  const ticketResult = requireVisibleTicket(data, actor, ticketId);
  if ('error' in ticketResult) return ticketResult.error;
  const ticket = ticketResult.ticket;

  if (ticket.status === 'resolved' || ticket.status === 'cancelled') {
    return fail('This ticket is already closed.');
  }
  const text = trimmed(reason);
  if (!text) return fail('Cancelling needs a reason.', 'reason');

  const next = draft(data);
  // Cancelling is not a resolution: resolvedAt/resolvedById stay empty.
  replaceTicket(next, ticketId, {
    status: 'cancelled',
    cancelReason: text,
    waitingReason: null,
  });
  logActivity(next, context, ticketId, 'cancelled', `${actor.displayName} cancelled the ticket`, text);

  return succeed(next, { ticketId, message: `${ticket.number} cancelled.` });
}

// ---------------------------------------------------------------------------
// Account administration (simulated in M1)
// ---------------------------------------------------------------------------

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function createTechnicianAccount(
  data: HelpdeskData,
  context: OperationContext,
  input: { displayName: string; email: string },
): OperationResult {
  const actorResult = requireActor(data, context);
  if ('error' in actorResult) return actorResult.error;
  const actor = actorResult.account;

  if (!canAdministerAccounts(actor)) {
    return fail('Only an administrator can create accounts.');
  }
  const displayName = trimmed(input.displayName);
  if (!displayName) return fail('Enter the technician name.', 'displayName');
  const email = trimmed(input.email).toLowerCase();
  if (!EMAIL_PATTERN.test(email)) return fail('Enter a valid school email address.', 'email');
  if (data.accounts.some((account) => account.email.toLowerCase() === email)) {
    return fail('An account already uses that email address.', 'email');
  }

  const next = draft(data);
  const account: Account = {
    id: nextId(next, 'acct'),
    displayName,
    email,
    role: 'technician',
    // Enrollment accounts stay restricted until setup completes.
    status: 'setup_pending',
    createdAt: context.now,
    lastCredentialActionAt: null,
    lastCredentialActionKind: null,
  };
  next.accounts = [...next.accounts, account];

  return succeed(next, {
    message: `${displayName} added with setup pending. Issue a setup link next.`,
  });
}

/**
 * Simulated credential actions. No link, token, or password is generated,
 * stored, or displayed — M3 implements these with the auth provider's own
 * invitation/recovery primitives, and the link itself must never be logged.
 */
export function recordCredentialAction(
  data: HelpdeskData,
  context: OperationContext,
  accountId: AccountId,
  kind: 'setup_issued' | 'recovery_issued',
): OperationResult {
  const actorResult = requireActor(data, context);
  if ('error' in actorResult) return actorResult.error;
  const actor = actorResult.account;

  if (!canAdministerAccounts(actor)) {
    return fail('Only an administrator can issue setup or recovery links.');
  }
  const target = findAccount(data, accountId);
  if (!target) return fail('That account no longer exists.');
  if (kind === 'setup_issued' && target.status === 'active') {
    return fail(`${target.displayName} has already completed setup. Issue a recovery link instead.`);
  }
  if (target.status === 'inactive') {
    return fail('Reactivate the account before issuing credentials.');
  }

  const next = draft(data);
  next.accounts = next.accounts.map((account) =>
    account.id === accountId
      ? { ...account, lastCredentialActionAt: context.now, lastCredentialActionKind: kind }
      : account,
  );

  return succeed(next, {
    message:
      kind === 'setup_issued'
        ? `Setup link simulated for ${target.displayName}. Nothing was generated or sent.`
        : `Recovery link simulated for ${target.displayName}. Nothing was generated or sent.`,
  });
}

export function setAccountStatus(
  data: HelpdeskData,
  context: OperationContext,
  accountId: AccountId,
  status: AccountStatus,
): OperationResult {
  const actorResult = requireActor(data, context);
  if ('error' in actorResult) return actorResult.error;
  const actor = actorResult.account;

  if (!canAdministerAccounts(actor)) {
    return fail('Only an administrator can change account status.');
  }
  if (accountId === actor.id) {
    return fail('You cannot change your own account status.');
  }
  const target = findAccount(data, accountId);
  if (!target) return fail('That account no longer exists.');
  if (target.status === status) {
    return fail(`${target.displayName} is already ${status.replace('_', ' ')}.`);
  }

  const next = draft(data);
  next.accounts = next.accounts.map((account) =>
    account.id === accountId ? { ...account, status } : account,
  );

  // Contribution history is never rewritten when an account is deactivated; the
  // Administration view surfaces their live tickets for reassignment instead.
  const liveTickets = data.tickets.filter(
    (ticket) =>
      ticket.ownerId === accountId &&
      ticket.status !== 'resolved' &&
      ticket.status !== 'cancelled',
  );

  const message =
    status === 'inactive' && liveTickets.length > 0
      ? `${target.displayName} deactivated. ${liveTickets.length} active ticket(s) need reassignment.`
      : `${target.displayName} is now ${status.replace('_', ' ')}.`;

  return succeed(next, { message });
}
