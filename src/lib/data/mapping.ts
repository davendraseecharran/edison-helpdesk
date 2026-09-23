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
  DeviceCatalogEntry,
  DeviceDetail,
  DeviceObservation,
  IntakeChannel,
  LinkedDevice,
  Person,
  PersonDetail,
  PersonKind,
  StudentStatus,
  Priority,
  RecordEvent,
  RecordTicketRef,
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
  logged_at?: string | null;
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
    loggedAt: row.logged_at ?? null,
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
  external_id?: string | null;
  device_id?: string | null;
  serial_number: string | null;
  asset_tag: string | null;
  type: string;
  manufacturer?: string | null;
  model: string | null;
  status: string;
  location?: string | null;
  linked_at: string;
  linked_by: string;
}): LinkedDevice {
  return {
    id: row.id,
    externalId: row.external_id ?? row.device_id ?? null,
    serialNumber: row.serial_number,
    assetTag: row.asset_tag,
    type: row.type,
    manufacturer: row.manufacturer ?? null,
    model: row.model,
    status: row.status,
    location: row.location ?? null,
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
  performed_via?: string | null;
  ai_model?: string | null;
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

/* --- Directory and inventory -------------------------------------------- */

/**
 * The owner's projections are already camelCase JSON, so these are guards
 * rather than translations: they pin the shape the database promised and give
 * every optional text field the empty string the projection guarantees, so no
 * screen has to write `?? ''` around a value that is never null.
 */

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asKind(value: unknown): PersonKind {
  return value === 'student' ? 'student' : 'staff';
}

function asStudentStatus(value: unknown): StudentStatus {
  return value === 'graduated' || value === 'other' ? value : 'current';
}

/** `app_person_json`: one row of `app_list_people`, and all of `app_get_person`. */
export type PersonJson = Record<string, unknown>;

export function mapPerson(row: PersonJson): Person {
  return {
    id: String(row.id),
    kind: asKind(row.kind),
    displayName: text(row.displayName),
    externalId: text(row.externalId),
    firstName: text(row.firstName),
    lastName: text(row.lastName),
    email: text(row.email),
    schoolDbn: text(row.schoolDbn),
    department: text(row.department),
    staffRole: text(row.staffRole),
    classOf: text(row.classOf),
    studentStatus: asStudentStatus(row.studentStatus),
    officialClass: text(row.officialClass),
    guardianName: text(row.guardianName),
    guardianPhone: text(row.guardianPhone),
    homePhone: text(row.homePhone),
    address: text(row.address),
    notes: text(row.notes),
    archivedAt: typeof row.archivedAt === 'string' && row.archivedAt !== '' ? row.archivedAt : null,
    version: Number(row.version ?? 1),
    updatedAt: text(row.updatedAt),
    deviceCount: Number(row.deviceCount ?? 0),
  };
}

/** `app_inventory_device_json`: one machine, listed or on its own page. */
export type DeviceJson = Record<string, unknown>;

export function mapInventoryDevice(row: DeviceJson): Device {
  const assignedKind = row.assignedKind;
  return {
    id: String(row.id),
    externalId: text(row.externalId),
    deviceType: text(row.deviceType),
    manufacturer: text(row.manufacturer),
    model: text(row.model),
    osVersion: text(row.osVersion),
    serialNumber: text(row.serialNumber),
    assetTag: text(row.assetTag),
    status: text(row.status),
    location: text(row.location),
    notes: text(row.notes),
    assignedRequesterId: typeof row.assignedRequesterId === 'string' ? row.assignedRequesterId : null,
    assignedName: typeof row.assignedName === 'string' ? row.assignedName : null,
    assignedKind: typeof assignedKind === 'string' ? asKind(assignedKind) : null,
    version: Number(row.version ?? 1),
    updatedAt: text(row.updatedAt),
  };
}

/** One page of either list RPC: both answer with the same envelope. */
export interface InventoryPageJson {
  rows?: unknown;
  total?: unknown;
  page?: unknown;
  pageSize?: unknown;
}

export interface MappedPage<T> {
  rows: T[];
  total: number;
  page: number;
  pageSize: number;
}

export function mapInventoryPage<T>(
  payload: InventoryPageJson | null | undefined,
  map: (row: Record<string, unknown>) => T,
): MappedPage<T> {
  const rows = Array.isArray(payload?.rows) ? (payload.rows as Record<string, unknown>[]) : [];
  const pageSize = Number(payload?.pageSize ?? 50) || 50;
  return {
    rows: rows.map(map),
    total: Number(payload?.total ?? 0),
    page: Number(payload?.page ?? 1) || 1,
    pageSize,
  };
}

export function mapDeviceCatalogEntry(row: {
  device_type: string;
  manufacturer: string;
  model: string;
}): DeviceCatalogEntry {
  return { deviceType: row.device_type, manufacturer: row.manufacturer, model: row.model };
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
  person: PersonJson;
  devices: DeviceJson[];
  tickets: RecordTicketRow[];
  events: RecordEventRow[];
}

export function mapPersonDetail(payload: PersonDetailPayload): PersonDetail {
  return {
    person: mapPerson(payload.person),
    devices: (payload.devices ?? []).map(mapInventoryDevice),
    tickets: (payload.tickets ?? []).map(mapRecordTicket),
    events: newestFirst((payload.events ?? []).map(mapRecordEvent)),
  };
}

export interface DeviceDetailPayload {
  device: DeviceJson;
  tickets: RecordTicketRow[];
  events: RecordEventRow[];
}

export function mapDeviceDetail(payload: DeviceDetailPayload): DeviceDetail {
  return {
    device: mapInventoryDevice(payload.device),
    tickets: (payload.tickets ?? []).map(mapRecordTicket),
    events: newestFirst((payload.events ?? []).map(mapRecordEvent)),
  };
}

