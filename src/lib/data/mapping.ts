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
  Device,
  DeviceAssignment,
  DeviceDetail,
  DeviceHolder,
  DeviceObservation,
  DeviceStatus,
  DeviceSummary,
  IntakeChannel,
  LinkedDevice,
  Person,
  PersonDetail,
  PersonDeviceLoan,
  PersonKind,
  PersonSummary,
  Priority,
  RecordEvent,
  RecordTicketRef,
  Requester,
  Ticket,
  TicketCategory,
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
  category?: string | null;
  submitted_on: string;
  created_at: string;
  created_by: string;
  owner_id: string | null;
  assigned_at: string | null;
  waiting_reason: string | null;
  solution: string | null;
  resolved_by: string | null;
  resolved_at: string | null;
  resolved_via?: string | null;
  resolved_ai_model?: string | null;
  cancel_reason: string | null;
  collaborator_ids?: string[] | null;
  /** Present on queue rows only; the detail payload carries the devices instead. */
  device_count?: number | null;
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
    // The column is NOT NULL with an 'other' default in the database; the
    // fallback covers a payload shaped before categories existed.
    category: (row.category ?? 'other') as TicketCategory,
    linkedDeviceCount: Number(row.device_count ?? 0),
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
    // The column is NOT NULL with a 'user' default in the database; the fallback
    // covers a payload shaped before attribution existed.
    resolvedVia: row.resolved_via === 'ai' ? 'ai' : 'user',
    resolvedAiModel: row.resolved_ai_model ?? null,
    cancelReason: row.cancel_reason,
  };
}

export function mapLinkedDevice(row: {
  id: string;
  device_id: string | null;
  serial_number: string | null;
  asset_tag: string | null;
  type: string;
  model: string | null;
  status: string;
  linked_at: string;
  linked_by: string;
}): LinkedDevice {
  return {
    id: row.id,
    deviceId: row.device_id,
    serialNumber: row.serial_number,
    assetTag: row.asset_tag,
    type: row.type,
    model: row.model,
    status: row.status,
    linkedAt: row.linked_at,
    linkedById: row.linked_by,
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
  model: string | null;
  os_version: string | null;
  serial_number: string | null;
  asset_tag: string | null;
  identifiers_not_applicable: boolean;
  recorded_by: string;
  recorded_at: string;
  performed_via?: string | null;
  ai_model?: string | null;
}): DeviceObservation {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    deviceType: row.device_type,
    model: row.model,
    osVersion: row.os_version,
    serialNumber: row.serial_number,
    assetTag: row.asset_tag,
    identifiersNotApplicable: row.identifiers_not_applicable,
    recordedById: row.recorded_by,
    recordedAt: row.recorded_at,
    // The column is NOT NULL with a 'user' default in the database; the fallback
    // covers a payload shaped before attribution existed.
    performedVia: row.performed_via === 'ai' ? 'ai' : 'user',
    aiModel: row.ai_model ?? null,
  };
}

export function mapNote(row: {
  id: string;
  ticket_id: string;
  author_id: string;
  body: string;
  created_at: string;
  performed_via?: string | null;
  ai_model?: string | null;
}): WorkNote {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    authorId: row.author_id,
    body: row.body,
    createdAt: row.created_at,
    // The column is NOT NULL with a 'user' default in the database; the fallback
    // covers a payload shaped before attribution existed.
    performedVia: row.performed_via === 'ai' ? 'ai' : 'user',
    aiModel: row.ai_model ?? null,
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
  performed_via?: string | null;
  ai_model?: string | null;
}): WorkLog {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    contributorId: row.contributor_id,
    workDate: row.work_date,
    minutes: row.minutes,
    description: row.description,
    createdAt: row.created_at,
    // The column is NOT NULL with a 'user' default in the database; the fallback
    // covers a payload shaped before attribution existed.
    performedVia: row.performed_via === 'ai' ? 'ai' : 'user',
    aiModel: row.ai_model ?? null,
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
  performed_via?: string | null;
  ai_model?: string | null;
}): ActivityEvent {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    kind: row.kind as ActivityEvent['kind'],
    actorId: row.actor_id,
    at: row.at,
    summary: row.summary,
    detail: row.detail,
    // The column is NOT NULL with a 'user' default in the database; the fallback
    // covers a payload shaped before attribution existed.
    performedVia: row.performed_via === 'ai' ? 'ai' : 'user',
    aiModel: row.ai_model ?? null,
  };
}

/* --- Directory ---------------------------------------------------------- */

/** One row of `app_list_people`. `total_count` arrives as a string over PostgREST. */
export interface PersonSummaryRow {
  id: string;
  kind: string;
  display_name: string;
  email: string | null;
  osis: string | null;
  staff_id: string | null;
  department: string | null;
  role_title: string | null;
  official_class: string | null;
  class_of: string | null;
  active: boolean;
  device_count: number | string;
  open_ticket_count: number | string;
  total_count: number | string;
}

function asKind(value: string): PersonKind {
  return value === 'student' ? 'student' : 'staff';
}

export function mapPersonSummary(row: PersonSummaryRow): PersonSummary {
  return {
    id: row.id,
    kind: asKind(row.kind),
    displayName: row.display_name,
    email: row.email,
    osis: row.osis,
    staffId: row.staff_id,
    department: row.department,
    roleTitle: row.role_title,
    officialClass: row.official_class,
    classOf: row.class_of,
    active: row.active,
    deviceCount: Number(row.device_count ?? 0),
    openTicketCount: Number(row.open_ticket_count ?? 0),
  };
}

/** `to_jsonb(people)`: the whole row, as `app_person_detail` returns it. */
export interface PersonRow {
  id: string;
  kind: string;
  first_name: string;
  last_name: string;
  display_name: string;
  email: string | null;
  osis: string | null;
  staff_id: string | null;
  school_dbn: string | null;
  department: string | null;
  role_title: string | null;
  official_class: string | null;
  class_of: string | null;
  parent_name: string | null;
  parent_phone: string | null;
  home_phone: string | null;
  address: string | null;
  notes: string | null;
  active: boolean;
  source: string;
  created_at: string;
  updated_at: string;
}

export function mapPerson(row: PersonRow): Person {
  return {
    id: row.id,
    kind: asKind(row.kind),
    firstName: row.first_name,
    lastName: row.last_name,
    displayName: row.display_name,
    email: row.email,
    osis: row.osis,
    staffId: row.staff_id,
    schoolDbn: row.school_dbn,
    department: row.department,
    roleTitle: row.role_title,
    officialClass: row.official_class,
    classOf: row.class_of,
    parentName: row.parent_name,
    parentPhone: row.parent_phone,
    homePhone: row.home_phone,
    address: row.address,
    notes: row.notes,
    active: row.active,
    source: row.source === 'import' ? 'import' : 'manual',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface RecordEventRow {
  id: string;
  entity_type: string;
  entity_id: string;
  kind: string;
  actor_id: string | null;
  performed_via?: string | null;
  ai_model?: string | null;
  at: string;
  summary: string;
  detail: string | null;
}

export function mapRecordEvent(row: RecordEventRow): RecordEvent {
  return {
    id: row.id,
    entityType: row.entity_type as RecordEvent['entityType'],
    entityId: row.entity_id,
    kind: row.kind,
    actorId: row.actor_id,
    performedVia: row.performed_via === 'ai' ? 'ai' : 'user',
    aiModel: row.ai_model ?? null,
    at: row.at,
    summary: row.summary,
    detail: row.detail,
  };
}

export interface RecordTicketRow {
  id: string;
  number: string;
  title: string;
  status: string;
  created_at: string;
}

export function mapRecordTicket(row: RecordTicketRow): RecordTicketRef {
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    status: row.status as TicketStatus,
    createdAt: row.created_at,
  };
}

/** Newest first, whatever order the database chose; ties broken by id so it is stable. */
function newestFirst<T extends { at: string; id: string }>(events: T[]): T[] {
  return [...events].sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
}

export interface PersonDetailPayload {
  person: PersonRow;
  devices: Array<{
    assignment_id: string;
    assigned_at: string;
    returned_at: string | null;
    device: {
      id: string;
      device_id: string | null;
      serial_number: string | null;
      asset_tag: string | null;
      type: string;
      model: string | null;
      status: string;
    };
  }>;
  tickets: RecordTicketRow[];
  events: RecordEventRow[];
}

export function mapPersonDetail(payload: PersonDetailPayload): PersonDetail {
  const loans: PersonDeviceLoan[] = (payload.devices ?? []).map((loan) => ({
    assignmentId: loan.assignment_id,
    assignedAt: loan.assigned_at,
    returnedAt: loan.returned_at,
    device: {
      id: loan.device.id,
      deviceId: loan.device.device_id,
      serialNumber: loan.device.serial_number,
      assetTag: loan.device.asset_tag,
      type: loan.device.type,
      model: loan.device.model,
      status: loan.device.status as DeviceStatus,
    },
  }));
  return {
    person: mapPerson(payload.person),
    devices: loans,
    tickets: (payload.tickets ?? []).map(mapRecordTicket),
    // The person function returns events oldest first and the device function
    // newest first; the pages read newest first, so the order is settled here.
    events: newestFirst((payload.events ?? []).map(mapRecordEvent)),
  };
}

/* --- Inventory ---------------------------------------------------------- */

/** One row of `app_list_devices`. */
export interface DeviceSummaryRow {
  id: string;
  device_id: string | null;
  serial_number: string | null;
  asset_tag: string | null;
  type: string;
  manufacturer: string | null;
  model: string | null;
  os: string | null;
  status: string;
  location: string | null;
  holder_id: string | null;
  holder_name: string | null;
  holder_kind: string | null;
  updated_at: string;
  total_count: number | string;
}

export function mapDeviceSummary(row: DeviceSummaryRow): DeviceSummary {
  return {
    id: row.id,
    deviceId: row.device_id,
    serialNumber: row.serial_number,
    assetTag: row.asset_tag,
    type: row.type,
    manufacturer: row.manufacturer,
    model: row.model,
    os: row.os,
    status: row.status as DeviceStatus,
    location: row.location,
    holderId: row.holder_id,
    holderName: row.holder_name,
    holderKind: row.holder_kind ? asKind(row.holder_kind) : null,
    updatedAt: row.updated_at,
  };
}

/** `to_jsonb(devices)`: the whole row, as `app_device_detail` returns it. */
export interface DeviceRow {
  id: string;
  device_id: string | null;
  serial_number: string | null;
  asset_tag: string | null;
  type: string;
  manufacturer: string | null;
  model: string | null;
  os: string | null;
  status: string;
  location: string | null;
  notes: string | null;
  source: string;
  created_at: string;
  updated_at: string;
}

export function mapInventoryDevice(row: DeviceRow): Device {
  return {
    id: row.id,
    deviceId: row.device_id,
    serialNumber: row.serial_number,
    assetTag: row.asset_tag,
    type: row.type,
    manufacturer: row.manufacturer,
    model: row.model,
    os: row.os,
    status: row.status as DeviceStatus,
    location: row.location,
    notes: row.notes,
    source: row.source === 'import' ? 'import' : 'manual',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export interface DeviceDetailPayload {
  device: DeviceRow;
  holder: {
    id: string;
    display_name: string;
    kind: string;
    assigned_at: string;
  } | null;
  assignments: Array<{
    id: string;
    person_id: string;
    person_name: string | null;
    person_kind: string | null;
    assigned_at: string;
    assigned_by_name: string | null;
    returned_at: string | null;
    returned_by_name: string | null;
    note: string | null;
  }>;
  tickets: RecordTicketRow[];
  events: RecordEventRow[];
}

export function mapDeviceDetail(payload: DeviceDetailPayload): DeviceDetail {
  const holder: DeviceHolder | null = payload.holder
    ? {
        id: payload.holder.id,
        displayName: payload.holder.display_name,
        kind: asKind(payload.holder.kind),
        assignedAt: payload.holder.assigned_at,
      }
    : null;
  const assignments: DeviceAssignment[] = (payload.assignments ?? []).map((loan) => ({
    id: loan.id,
    personId: loan.person_id,
    personName: loan.person_name ?? 'Unknown person',
    personKind: asKind(loan.person_kind ?? 'staff'),
    assignedAt: loan.assigned_at,
    assignedByName: loan.assigned_by_name,
    returnedAt: loan.returned_at,
    returnedByName: loan.returned_by_name,
    note: loan.note,
  }));
  return {
    device: mapInventoryDevice(payload.device),
    holder,
    assignments,
    tickets: (payload.tickets ?? []).map(mapRecordTicket),
    events: newestFirst((payload.events ?? []).map(mapRecordEvent)),
  };
}
