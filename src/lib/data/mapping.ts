/**
 * SQL row → TypeScript domain mapping.
 *
 * The database is snake_case and the approved UI types in src/lib/domain/types.ts
 * are camelCase; docs/M2-DATABASE.md carries the column-by-column table. Keeping
 * the translation in one place is what let the M1 components survive M3 without
 * being rewritten around a new shape.
 */

import type {
  Account,
  ActivityEvent,
  DeviceObservation,
  IntakeChannel,
  Priority,
  Requester,
  Ticket,
  TicketStatus,
  WorkLog,
  WorkNote,
} from '@/lib/domain/types';

export interface TicketRow {
  id: string;
  number: string;
  title: string;
  issue: string;
  requester_id: string | null;
  requester_unknown: boolean;
  location: string | null;
  is_remote: boolean;
  channel: string;
  priority: string;
  status: string;
  submitted_on: string;
  created_at: string;
  created_by: string;
  owner_id: string | null;
  assigned_at: string | null;
  waiting_reason: string | null;
  solution: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  cancel_reason: string | null;
  collaborator_ids?: string[] | null;
}

export function mapTicket(row: TicketRow): Ticket {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    issue: row.issue,
    requesterId: row.requester_id,
    requesterUnknown: row.requester_unknown,
    location: row.location,
    isRemote: row.is_remote,
    channel: row.channel as IntakeChannel,
    priority: row.priority as Priority,
    status: row.status as TicketStatus,
    submittedOn: row.submitted_on,
    createdAt: row.created_at,
    createdById: row.created_by,
    ownerId: row.owner_id,
    collaboratorIds: row.collaborator_ids ?? [],
    assignedAt: row.assigned_at,
    waitingReason: row.waiting_reason,
    solution: row.solution,
    resolvedById: row.resolved_by,
    resolvedAt: row.resolved_at,
    cancelReason: row.cancel_reason,
  };
}

export interface DirectoryRow {
  id: string;
  display_name: string;
  role: string;
  status: string;
}

/**
 * Directory entries carry labels only. `email` is deliberately absent: the
 * directory lookup never exposes another account's email or credential
 * metadata, so the Account shape is filled with a blank email here.
 */
export function mapDirectoryAccount(row: DirectoryRow): Account {
  return {
    id: row.id,
    displayName: row.display_name,
    email: '',
    role: row.role as Account['role'],
    status: row.status as Account['status'],
    createdAt: '',
    lastCredentialActionAt: null,
    lastCredentialActionKind: null,
  };
}

export function mapRequester(row: {
  id: string;
  display_name: string;
  kind: string;
  descriptor: string | null;
}): Requester {
  return {
    id: row.id,
    displayName: row.display_name,
    kind: row.kind as Requester['kind'],
    descriptor: row.descriptor,
  };
}

export function mapDevice(row: {
  id: string;
  ticket_id: string;
  device_type: string;
  manufacturer?: string | null;
  inventory_device_id?: string | null;
  model: string | null;
  os_version: string | null;
  serial_number: string | null;
  asset_tag: string | null;
  identifiers_not_applicable: boolean;
  recorded_by: string;
  recorded_at: string;
}): DeviceObservation {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    deviceType: row.device_type,
    manufacturer: row.manufacturer,
    inventoryDeviceId: row.inventory_device_id,
    model: row.model,
    osVersion: row.os_version,
    serialNumber: row.serial_number,
    assetTag: row.asset_tag,
    identifiersNotApplicable: row.identifiers_not_applicable,
    recordedById: row.recorded_by,
    recordedAt: row.recorded_at,
  };
}

export function mapNote(row: {
  id: string;
  ticket_id: string;
  author_id: string;
  body: string;
  created_at: string;
}): WorkNote {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    authorId: row.author_id,
    body: row.body,
    createdAt: row.created_at,
  };
}

export function mapWorkLog(row: {
  id: string;
  ticket_id: string;
  contributor_id: string;
  work_date: string;
  minutes: number;
  description: string | null;
  created_at: string;
}): WorkLog {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    contributorId: row.contributor_id,
    workDate: row.work_date,
    minutes: row.minutes,
    description: row.description,
    createdAt: row.created_at,
  };
}

export function mapActivity(row: {
  id: string;
  ticket_id: string;
  kind: string;
  actor_id: string;
  at: string;
  summary: string;
  detail: string | null;
}): ActivityEvent {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    kind: row.kind as ActivityEvent['kind'],
    actorId: row.actor_id,
    at: row.at,
    summary: row.summary,
    detail: row.detail,
  };
}
