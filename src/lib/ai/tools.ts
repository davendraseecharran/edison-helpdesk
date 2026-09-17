/**
 * What the assistant can actually do, and the only way it does anything.
 *
 * Three rules hold this together, and none of them is enforced by the model:
 *
 *   1. EVERY tool runs the same SECURITY DEFINER RPC the screens run, through
 *      the technician's OWN Supabase client (Ruling 18). The database re-derives
 *      the actor from `auth.uid()` inside each function, so row-level security,
 *      the participation rules, the locking order and the audit trail apply
 *      exactly as they do to a click. The assistant cannot reach a record its
 *      operator could not reach, and cannot make a change its operator could not
 *      make.
 *   2. Arguments are checked HERE, by hand, before anything is sent. The checker
 *      refuses a field it does not know, a type it did not ask for and a value
 *      outside a fixed vocabulary, so a hallucinated `force: true` is an error
 *      rather than a silently ignored key.
 *   3. The three classification lists are exhaustive and are unit-tested to be
 *      exhaustive. "Is this a change?" is answered from a list, not from a name
 *      that happens to start with `get_`, because that question decides whether
 *      the operator is asked first.
 *
 * Names, not ids. The model is given ticket numbers, device identifiers and
 * people's names because that is what a technician says out loud, and the
 * resolvers below turn those into the primary keys the RPCs want — refusing an
 * ambiguous match rather than picking one. That is also why a hallucinated
 * ticket number fails at resolution instead of silently claiming somebody
 * else's work.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import { isRecord, isUuid, textOf } from '@/lib/guards';
import { draftFromText } from '@/lib/intake/draft';
import { ATTACHMENT_MIME_TYPES, formatBytes } from '@/lib/attachments';
import { readDataUrl } from '@/lib/ai/images';
import {
  ASSISTANT_NOTES_MAX,
  displayNameError,
  preferencePatch,
  REASONING_CHOICES,
  THEME_CHOICES,
  WELCOME_STATE_LABELS,
  WELCOME_STATES,
  WELCOME_STATES_UNKNOWN,
  welcomeStateFromLabel,
  type PreferencePatch,
} from '@/lib/domain/preferences';
import {
  movePreset,
  orderPresets,
  presetError,
  presetFromRow,
  TICKET_PRESET_CAP,
  type TicketPreset,
} from '@/lib/domain/ticket-presets';
import { DEVICE_CSV_COLUMNS, deviceCsvRow } from '@/lib/data/device-csv';
import { mapInventoryDevice } from '@/lib/data/mapping';
import {
  addSavedView,
  normaliseQuery,
  parseSavedViews,
  removeSavedView,
  savedViewError,
  type SavedView,
} from '@/lib/domain/saved-views';
import {
  BACKUP_TABLES,
  BACKUP_TABLE_NAMES,
  readBackupTable,
  type BackupTableName,
} from '@/lib/data/backup-tables';
import { AUDIT_ENTITIES } from '@/lib/domain/audit-entities';
import {
  bucketFor,
  HONOUR_TITLES,
  percentOf,
  periodBounds,
  type HonourKey,
} from '@/lib/domain/analytics';
import { PERIOD_PHRASES, STATS_PERIODS, toStatsPeriod } from '@/lib/domain/resolved-stats';
import { CHANNEL_LABELS, PRIORITY_LABELS, TICKET_CATEGORY_LABELS } from '@/lib/domain/types';
import { cappedExportMessage, csvFileName, csvHeaders, CSV_ROW_CAP, encodeCsv, toCsv } from '@/lib/csv';
import { schoolDayEnd, schoolDayStart, schoolToday } from '@/lib/format';
import { DEVICE_TYPES, deviceTypeLabel } from '@/lib/domain/device-types';
import {
  canExportDirectory,
  canWorkTickets,
  normalizeRoles,
  roleLabel,
  rolesLabel,
  type AccountRole,
} from '@/lib/auth/roles';
import { clipboardFor, gmailLink, type CopyKind, type PersonAddressee } from '@/lib/people/clipboard';
import { isGmailMode, type GmailMode } from '@/lib/domain/preferences';

// ---------------------------------------------------------------------------
// Schema and validation vocabulary
// ---------------------------------------------------------------------------

export interface JsonSchemaProperty {
  type: string | string[];
  description?: string;
  enum?: (string | null)[];
  /**
   * What a list holds. A list of text says so in one word; a list of ROWS
   * carries a whole object schema, which strict mode requires to be closed and
   * fully required exactly like the top level.
   */
  items?: { type: 'string' } | JsonSchema;
}

export interface JsonSchema {
  type: 'object';
  properties: Record<string, JsonSchemaProperty>;
  required: string[];
  additionalProperties: false;
}

export interface ToolDef {
  type: 'function';
  name: string;
  description: string;
  parameters: JsonSchema;
  strict: true;
}

type FieldType = 'string' | 'integer' | 'number' | 'boolean' | 'string[]' | 'object[]';

interface Field {
  type: FieldType;
  description: string;
  /** Absent means optional, which is expressed to the model as nullable. */
  required?: boolean;
  choices?: readonly string[];
  /** A plain calendar date, `YYYY-MM-DD`. */
  date?: boolean;
  /**
   * A moment in history: `YYYY-MM-DD`, or a full ISO instant. Checked and
   * normalised by `historicInstant`, so what reaches an RPC is always one
   * spelling of one instant.
   */
  instant?: boolean;
  /** Longest text accepted. Defaults to MAX_TEXT; only pasted files need more. */
  maxLength?: number;
  /** Most entries a list accepts. Absent means the tool sets no ceiling of its own. */
  maxItems?: number;
  /**
   * For `object[]`: the fields ONE row takes, checked by the same checker that
   * checks a tool's own arguments. A batch is a list of small calls, and a row
   * that is wrong should be named by its number and its field rather than
   * arriving at the database as a whole bad batch.
   */
  items?: Record<string, Field>;
}

/**
 * A ceiling on every text argument, so a model that loops cannot post a
 * megabyte into a note field and have the database be the thing that says no.
 * The one field that legitimately carries a file overrides it.
 */
const MAX_TEXT = 4000;

const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
const CATEGORIES = [
  'chromebook',
  'laptop_desktop',
  'projector_display',
  'network',
  'printer',
  'account',
  'software',
  'phone',
  'other',
] as const;
const CHANNELS = ['walk_in', 'email', 'phone_call'] as const;
const TICKET_SCOPES = ['open_queue', 'mine', 'collaborating', 'closed', 'all'] as const;
const TICKET_STATUSES = ['open', 'assigned', 'in_progress', 'waiting', 'resolved', 'cancelled'] as const;
const PERSON_KINDS = ['student', 'staff'] as const;
const ROLES = ['admin', 'netrider', 'skills_officer'] as const;

/**
 * Not a vocabulary. `inventory_devices.status` is free text with no CHECK, and
 * app_inventory_statuses() is the authority on what the district actually
 * uses; these are the five it seeds, offered as a hint in a description rather
 * than as `choices`, so the assistant can write "Awaiting parts" when that is
 * what somebody asked for.
 */
const SEEDED_STATUSES = 'Available, Assigned, In repair, Retired or Lost';

/**
 * How much of a table comes back through the model. Enough to see the shape
 * of it, never enough to be the export: an `ai_messages` row is refused over
 * 256 KiB, every character of a tool result is also sent to the model, which
 * pays for it and can do nothing useful with a whole table anyway, and the
 * route that carries a result back to the panel forwards only `{ok, summary}`
 * — so a `data:` href in here would never even reach a place that could use
 * it. The file itself is downloaded from Administration → Backups.
 */
const EXPORT_PREVIEW_ROWS = 20;

// ---------------------------------------------------------------------------
// Errors and context
// ---------------------------------------------------------------------------

/**
 * A refusal the operator can act on, rather than a stack trace.
 *
 * `code` and `raw` are the driver's own, kept for the two callers that have to
 * tell one failure from another. They are never what `message` says: see
 * `safeRpcMessage`.
 */
export class ToolError extends Error {
  readonly code: string | null;
  readonly raw: string;

  constructor(message: string, code: string | null = null, raw = '') {
    super(message);
    this.name = 'ToolError';
    this.code = code;
    this.raw = raw;
  }
}

/**
 * The role vocabulary, from the one module that owns it. `roles.ts` is a pure
 * module with no server-only import, so this does not drag a request context
 * into the unit suite.
 */
export type ToolRole = AccountRole;

export interface ToolActor {
  id: string;
  displayName: string;
  /** What this person may do. Never empty. */
  roles: AccountRole[];
}

/** A picture the person attached to the turn the assistant is answering. */
export interface ToolImage {
  /** What the file was called. The name the model and the chip both show. */
  name: string;
  /** `data:image/jpeg;base64,...` — the same value the model was sent. */
  dataUrl: string;
}

export interface AttachInput {
  /** The verified account. Never a value that came out of the model. */
  actorId: string;
  ticketId: string;
  filename: string;
  mime: string;
  base64: string;
}

export type AttachOutcome =
  | { ok: true; id: string; filename: string; bytes: number }
  | { ok: false; error: string };

/**
 * The storage plumbing an attachment needs, injected rather than imported.
 *
 * Both halves live behind `server-only` modules — the bucket carries no storage
 * policies and the registry function is granted to the service role alone — and
 * this file is imported by the unit suite. So the route hands the tools a port
 * (`src/lib/ai/attach.ts`) and a test hands them a fake. Authorization is NOT in
 * here: `app_can_attach` and `app_delete_attachment` are asked on the person's
 * own client, as every other tool asks.
 */
export interface AttachmentPort {
  attach(input: AttachInput): Promise<AttachOutcome>;
  /** Deletes the stored object, after the registry row has already gone. */
  removeObject(path: string): Promise<void>;
}

export interface ToolContext {
  /** The signed-in technician's client, already carrying `x-edison-via: ai`. */
  supabase: SupabaseClient;
  actor: ToolActor;
  /**
   * The pictures this turn carried. They are not kept after the turn — see
   * `images.ts` — so a tool that wants one has to be called in the same turn it
   * arrived in, and says so plainly when the list is empty.
   */
  images?: readonly ToolImage[];
  /** Absent wherever files cannot be uploaded, which `attach_to_ticket` reports. */
  attachments?: AttachmentPort;
}

export interface ToolOutcome {
  ok: boolean;
  result: unknown;
  /** One line, in the operator's words: "Claimed EDT-1042". */
  summary: string;
}

export type ValidationResult =
  | { ok: true; value: Record<string, unknown>; error?: undefined }
  | { ok: false; error: string; value?: undefined };

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

/**
 * "EDT-1042", "edt1042" and "1042" are the same ticket to a technician, so they
 * are the same ticket here. Anything else returns null and is treated as a
 * search term instead of a number.
 */
export function normaliseTicketNumber(value: string): string | null {
  const text = value.trim().toUpperCase().replace(/\s+/g, '');
  const match = /^(?:EDT-?)?(\d{1,12})$/.exec(text);
  return match === null ? null : `EDT-${match[1]}`;
}

/** A date with no time, and a time with no zone: the two shapes a sheet holds. */
const PLAIN_DATE = /^(\d{4}-\d{2}-\d{2})$/;
const NAIVE_DATE_TIME = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,3})?)?$/;
const ZONED_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:?\d{2})$/;

/**
 * One moment, from what a spreadsheet actually says.
 *
 * The desk's sheet holds dates, not instants: "3 Oct". A column like that is
 * read here as the SCHOOL day it names, taken at its start, because the one
 * thing that must not happen is a row landing on the wrong day — and that is
 * exactly what `2025-10-03` sent as a timestamp would do, since the database
 * session is UTC and midnight UTC is still the second of October in New York.
 *
 * A full instant carrying a zone is respected as written. A time with no zone
 * is read as school-local: the day's own offset, taken from the start of that
 * day, plus the wall clock. Anything else is null, and the checker says so.
 */
export function historicInstant(value: string): string | null {
  const text = value.trim().replace(/\s+/g, ' ');

  const plain = PLAIN_DATE.exec(text);
  if (plain !== null) return schoolDayStart(plain[1]);

  const naive = NAIVE_DATE_TIME.exec(text);
  if (naive !== null) {
    const midnight = schoolDayStart(naive[1]);
    if (midnight === null) return null;
    const hours = Number(naive[2]);
    const minutes = Number(naive[3]);
    const seconds = Number(naive[4] ?? '0');
    if (hours > 23 || minutes > 59 || seconds > 59) return null;
    const offset = ((hours * 60 + minutes) * 60 + seconds) * 1000;
    return new Date(Date.parse(midnight) + offset).toISOString();
  }

  if (!ZONED_DATE_TIME.test(text)) return null;
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : new Date(parsed).toISOString();
}

/**
 * How many rows one import carries, and how many names one lookup takes.
 *
 * Both are the database's own ceilings, said here as well so an oversized call
 * costs one sentence rather than fifty round trips or a refusal from Postgres.
 */
const IMPORT_ROW_LIMIT = 50;
const FIND_PEOPLE_LIMIT = 200;

function rows(data: unknown): Record<string, unknown>[] {
  return Array.isArray(data) ? data.filter(isRecord) : [];
}

/**
 * SQLSTATEs our own RPCs raise deliberately, whose messages are WRITTEN to be
 * read: 'Only an administrator can do that', 'Choose a theme', and so on.
 *
 *   P0001  a bare `raise exception`
 *   23514  `using errcode = 'check_violation'`, the argument-refusal spelling
 *   42501  `insufficient_privilege`, the authorization spelling
 *
 * Anything else is the driver talking — a unique-index name, a column that does
 * not exist, a syntax error — and naming a constraint at somebody mid-repair
 * tells them nothing and tells an attacker the schema.
 */
const AUTHORED_CODES = new Set(['P0001', '23514', '42501']);

const GENERIC_RPC_FAILURE =
  'That did not go through. Try it from the screen if it keeps failing.';

function safeRpcMessage(error: { code?: string | null; message?: string | null }): string {
  const code = error.code ?? '';
  const message = (error.message ?? '').trim();
  if (AUTHORED_CODES.has(code) && message !== '') return message;
  return GENERIC_RPC_FAILURE;
}

/**
 * Runs one RPC as the signed-in technician.
 *
 * The raw failure goes to the server log and the safe sentence goes to the
 * operator and the model, so a stack of Postgres detail never reaches a chat
 * bubble the person might paste somewhere.
 */
async function rpc(ctx: ToolContext, fn: string, args: Record<string, unknown>): Promise<unknown> {
  const { data, error } = await ctx.supabase.rpc(fn, args);
  if (error) {
    console.error('[ai] rpc failed', { fn, code: error.code, message: error.message });
    throw new ToolError(safeRpcMessage(error), error.code ?? null, error.message ?? '');
  }
  return data;
}

/** Sentence-cases a stored vocabulary value for a summary line. */
function label(value: string): string {
  const spaced = value.replace(/_/g, ' ');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1);
}

// ---------------------------------------------------------------------------
// Resolvers: what a technician says, turned into what an RPC needs
// ---------------------------------------------------------------------------

interface TicketRef {
  id: string;
  number: string;
  title: string;
}

async function resolveTicket(ctx: ToolContext, value: string): Promise<TicketRef> {
  const trimmed = value.trim();
  if (isUuid(trimmed)) {
    const detail = await rpc(ctx, 'app_ticket_detail', { p_ticket: trimmed });
    const ticket = isRecord(detail) && isRecord(detail.ticket) ? detail.ticket : null;
    if (ticket === null) throw new ToolError('There is no ticket with that id, or you cannot see it.');
    return { id: trimmed, number: textOf(ticket.number), title: textOf(ticket.title) };
  }

  const number = normaliseTicketNumber(value);
  const query = number ?? trimmed;
  if (query === '') throw new ToolError('Name the ticket by its number, such as EDT-1042.');

  const hits = rows(await rpc(ctx, 'app_search', { p_query: query, p_limit: 8 })).filter(
    (row) => textOf(row.kind) === 'ticket',
  );
  if (hits.length === 0) {
    throw new ToolError(`No ticket matches "${value.trim()}". Search first rather than guessing a number.`);
  }

  // `title` arrives as "EDT-1042 Projector will not wake". An exact number match
  // wins outright; otherwise a single hit is accepted and a tie is refused.
  const exact = number === null ? undefined : hits.find((row) => textOf(row.title).startsWith(`${number} `));
  const chosen = exact ?? (hits.length === 1 ? hits[0] : undefined);
  if (chosen === undefined) {
    const options = hits.slice(0, 5).map((row) => textOf(row.title)).join('; ');
    throw new ToolError(`"${value.trim()}" matches more than one ticket: ${options}. Say which one.`);
  }

  const combined = textOf(chosen.title);
  const space = combined.indexOf(' ');
  return {
    id: textOf(chosen.id),
    number: space === -1 ? combined : combined.slice(0, space),
    title: space === -1 ? '' : combined.slice(space + 1),
  };
}

/**
 * The readable number of a ticket that already exists, or an empty string.
 *
 * Only ever used to make a sentence nicer, so a failure here is not a failure:
 * the caller has already written something, and "Imported 12 resolved tickets"
 * with no range is a better answer than an error about a ticket that landed.
 */
async function ticketNumberOf(ctx: ToolContext, id: string): Promise<string> {
  try {
    const detail = await rpc(ctx, 'app_ticket_detail', { p_ticket: id });
    const ticket = isRecord(detail) && isRecord(detail.ticket) ? detail.ticket : {};
    return textOf(ticket.number);
  } catch {
    return '';
  }
}

interface DeviceRef {
  id: string;
  label: string;
}

function deviceLabel(row: Record<string, unknown>): string {
  return (
    textOf(row.assetTag) || textOf(row.serialNumber) || textOf(row.externalId) || 'that device'
  );
}

/** The `{rows, total, page, pageSize}` envelope both list RPCs answer with. */
function pageRows(data: unknown): Record<string, unknown>[] {
  return isRecord(data) ? rows(data.rows) : [];
}

async function resolveDevice(ctx: ToolContext, value: string): Promise<DeviceRef> {
  const query = value.trim();
  if (query === '') throw new ToolError('Name the device by its asset tag, serial number or id.');

  if (isUuid(query)) {
    const device = await rpc(ctx, 'app_get_inventory_device', { p_id: query });
    if (!isRecord(device)) throw new ToolError('There is no device with that id.');
    return { id: query, label: deviceLabel(device) };
  }

  // A code printed on a machine resolves exactly, and refuses to guess between
  // two machines that share one. That is the scanner's own lookup.
  const scanned = rows(await rpc(ctx, 'app_lookup_inventory_code', { p_code: query }));
  if (scanned.length === 1) {
    return { id: textOf(scanned[0].id), label: textOf(scanned[0].label) || 'that device' };
  }

  const found = pageRows(
    await rpc(ctx, 'app_list_inventory', { p_query: query, p_page: 1, p_requester: null }),
  ).slice(0, 5);
  if (found.length === 0) throw new ToolError(`No device matches "${query}".`);

  const folded = query.toUpperCase();
  const exact = found.find((row) =>
    [textOf(row.externalId), textOf(row.serialNumber), textOf(row.assetTag)]
      .map((candidate) => candidate.toUpperCase())
      .includes(folded),
  );
  const chosen = exact ?? (found.length === 1 ? found[0] : undefined);
  if (chosen === undefined) {
    const options = found.map(deviceLabel).join(', ');
    throw new ToolError(`"${query}" matches more than one device: ${options}. Say which one.`);
  }
  return { id: textOf(chosen.id), label: deviceLabel(chosen) };
}

interface PersonRef {
  id: string;
  name: string;
}

async function resolvePerson(ctx: ToolContext, value: string): Promise<PersonRef> {
  const query = value.trim();
  if (query === '') throw new ToolError('Name the person, or give their OSIS or staff id.');

  if (isUuid(query)) {
    const person = await rpc(ctx, 'app_get_person', { p_id: query });
    if (!isRecord(person)) throw new ToolError('There is no directory record with that id.');
    return { id: query, name: textOf(person.displayName) };
  }

  // The directory is two lists, so both are asked. A name that is in only one
  // of them resolves; a name in both is ambiguous and says so, which is the
  // right answer when a student and a member of staff share it.
  const found: Record<string, unknown>[] = [];
  for (const kind of PERSON_KINDS) {
    found.push(
      ...pageRows(await rpc(ctx, 'app_list_people', { p_kind: kind, p_query: query, p_page: 1 })).slice(
        0,
        5,
      ),
    );
  }
  if (found.length === 0) throw new ToolError(`Nobody in the directory matches "${query}".`);

  const folded = query.toLowerCase();
  const exact = found.find((row) =>
    [textOf(row.displayName), textOf(row.email), textOf(row.externalId)]
      .map((candidate) => candidate.toLowerCase())
      .includes(folded),
  );
  const chosen = exact ?? (found.length === 1 ? found[0] : undefined);
  if (chosen === undefined) {
    const options = found.map((row) => textOf(row.displayName)).join(', ');
    throw new ToolError(`"${query}" matches more than one person: ${options}. Say which one.`);
  }
  return { id: textOf(chosen.id), name: textOf(chosen.displayName) };
}

interface GroupRef {
  id: string;
  name: string;
  description: string;
  members: number;
}

/**
 * The roster somebody said out loud, turned into the one it is.
 *
 * Groups are named things a person types from memory — "officers", "the
 * regionals team" — and there are tens of them, so the whole list is read and
 * matched here rather than searched in the database: an exact name wins, a
 * single partial is accepted, and a tie is refused with the names in it. That
 * is the same contract `resolveAccount` holds, for the same reason: adding
 * thirty people to the wrong roster is not a mistake anybody notices quickly.
 */
/** The addressee rows a directory read returns, in the shape the clipboard formats. */
function addresseesFrom(answer: unknown): PersonAddressee[] {
  if (!isRecord(answer) || !Array.isArray(answer.rows)) return [];
  return answer.rows.filter(isRecord).map((row) => ({
    id: textOf(row.id),
    displayName: textOf(row.displayName),
    email: typeof row.email === 'string' && row.email !== '' ? row.email : null,
    externalId: typeof row.externalId === 'string' && row.externalId !== '' ? row.externalId : null,
    kind: textOf(row.kind) === 'staff' ? 'staff' : 'student',
    guardianName: typeof row.guardianName === 'string' && row.guardianName !== '' ? row.guardianName : null,
    guardianPhone: typeof row.guardianPhone === 'string' && row.guardianPhone !== '' ? row.guardianPhone : null,
  }));
}

/** This person's own Gmail setting, so a link the assistant hands over addresses people the way their button would. */
async function gmailModeFor(ctx: ToolContext): Promise<GmailMode> {
  const stored = await rpc(ctx, 'app_my_preferences', {});
  const row = Array.isArray(stored) ? stored[0] : stored;
  const mode = isRecord(row) ? row.gmail_mode : undefined;
  return isGmailMode(mode) ? mode : 'to';
}

async function resolveGroup(ctx: ToolContext, value: string): Promise<GroupRef> {
  const query = value.trim();
  if (query === '') throw new ToolError('Name the group.');

  const groups = rows(await rpc(ctx, 'app_list_groups', {}));
  const asRef = (row: Record<string, unknown>): GroupRef => ({
    id: textOf(row.id),
    name: textOf(row.name),
    description: textOf(row.description),
    members: Number(row.member_count ?? 0),
  });
  if (isUuid(query)) {
    const row = groups.find((entry) => textOf(entry.id) === query);
    if (row === undefined) throw new ToolError('There is no group with that id.');
    return asRef(row);
  }

  const folded = query.toLowerCase();
  const exact = groups.filter((entry) => textOf(entry.name).toLowerCase() === folded);
  const partial = groups.filter((entry) => textOf(entry.name).toLowerCase().includes(folded));
  const candidates = exact.length > 0 ? exact : partial;
  if (candidates.length === 0) {
    throw new ToolError(`There is no group called "${query}". List the groups rather than guessing.`);
  }
  if (candidates.length > 1) {
    const options = candidates.map((entry) => textOf(entry.name)).join(', ');
    throw new ToolError(`"${query}" matches more than one group: ${options}. Say which one.`);
  }
  return asRef(candidates[0]);
}

interface EventRef {
  id: string;
  name: string;
  heldOn: string;
}

/**
 * Which of a group's events somebody meant.
 *
 * Unlike every other resolver here, an exact name that matches SEVERAL is not
 * a tie: "the weekly meeting" is a name a group uses every week, and the list
 * comes back newest first, so the newest one is what the words mean. A
 * PARTIAL match that hits more than one is still refused, because that is
 * somebody being vague rather than somebody using a standing name.
 */
async function resolveGroupEvent(
  ctx: ToolContext,
  group: GroupRef,
  value: string,
): Promise<EventRef> {
  const query = value.trim();
  if (query === '') throw new ToolError('Name the event.');

  const events = rows(await rpc(ctx, 'app_list_group_events', { p_group: group.id }));
  if (events.length === 0) throw new ToolError(`${group.name} has no events yet.`);

  const asRef = (row: Record<string, unknown>): EventRef => ({
    id: textOf(row.id),
    name: textOf(row.name),
    heldOn: textOf(row.held_on),
  });

  if (isUuid(query)) {
    const row = events.find((entry) => textOf(entry.id) === query);
    if (row === undefined) throw new ToolError(`${group.name} has no event with that id.`);
    return asRef(row);
  }

  const folded = query.toLowerCase();
  const exact = events.filter((entry) => textOf(entry.name).toLowerCase() === folded);
  if (exact.length > 0) return asRef(exact[0]);

  const partial = events.filter((entry) => textOf(entry.name).toLowerCase().includes(folded));
  if (partial.length === 0) {
    throw new ToolError(`${group.name} has no event called "${query}".`);
  }
  if (partial.length > 1) {
    const options = partial
      .slice(0, 5)
      .map((entry) => `${textOf(entry.name)} (${textOf(entry.held_on)})`)
      .join('; ');
    throw new ToolError(`"${query}" matches more than one event: ${options}. Say which one.`);
  }
  return asRef(partial[0]);
}

interface FieldRef {
  id: string;
  name: string;
}

/** One of a group's six checklist columns, by name or id. */
async function resolveGroupField(
  ctx: ToolContext,
  group: GroupRef,
  value: string,
): Promise<FieldRef> {
  const query = value.trim();
  if (query === '') throw new ToolError('Name the checklist column.');

  const fields = rows(await rpc(ctx, 'app_list_group_fields', { p_group: group.id }));
  if (fields.length === 0) throw new ToolError(`${group.name} has no checklist columns.`);

  if (isUuid(query)) {
    const row = fields.find((entry) => textOf(entry.id) === query);
    if (row === undefined) throw new ToolError(`${group.name} has no column with that id.`);
    return { id: query, name: textOf(row.name) };
  }

  const folded = query.toLowerCase();
  const exact = fields.filter((entry) => textOf(entry.name).toLowerCase() === folded);
  const partial = fields.filter((entry) => textOf(entry.name).toLowerCase().includes(folded));
  const candidates = exact.length > 0 ? exact : partial;
  if (candidates.length === 0) {
    const options = fields.map((entry) => textOf(entry.name)).join(', ');
    throw new ToolError(`${group.name} has no column called "${query}". It has: ${options}.`);
  }
  if (candidates.length > 1) {
    const options = candidates.map((entry) => textOf(entry.name)).join(', ');
    throw new ToolError(`"${query}" matches more than one column: ${options}. Say which one.`);
  }
  return { id: textOf(candidates[0].id), name: textOf(candidates[0].name) };
}

interface AccountRef {
  id: string;
  name: string;
}

async function resolveAccount(ctx: ToolContext, value: string): Promise<AccountRef> {
  const query = value.trim();
  if (query === '') throw new ToolError('Name the colleague whose account you mean.');

  const directory = rows(await rpc(ctx, 'app_directory', {}));
  if (isUuid(query)) {
    const row = directory.find((entry) => textOf(entry.id) === query);
    if (row === undefined) throw new ToolError('There is no helpdesk account with that id.');
    return { id: query, name: textOf(row.display_name) };
  }

  const folded = query.toLowerCase();
  const exact = directory.filter((entry) => textOf(entry.display_name).toLowerCase() === folded);
  const partial = directory.filter((entry) => textOf(entry.display_name).toLowerCase().includes(folded));
  const candidates = exact.length > 0 ? exact : partial;
  if (candidates.length === 0) throw new ToolError(`No helpdesk account matches "${query}".`);
  if (candidates.length > 1) {
    const options = candidates.map((entry) => textOf(entry.display_name)).join(', ');
    throw new ToolError(`"${query}" matches more than one colleague: ${options}. Say which one.`);
  }
  return { id: textOf(candidates[0].id), name: textOf(candidates[0].display_name) };
}

/**
 * Somebody waiting for a decision, which `resolveAccount` cannot find.
 *
 * `app_directory` leaves out an account that is `pending_approval`, and says
 * why: listing somebody who has only tried to sign in would tell every
 * technician in the building that a named person did. So the waiting list is
 * read the way the Access screen reads it — the `app_accounts` table itself,
 * under the administrator's own row policies, which show the full table to an
 * active administrator and one row to anybody else. A name or an address is
 * matched whole, ignoring capitals; a tie is refused with the names in it.
 */
async function resolveWaitingAccount(ctx: ToolContext, value: string): Promise<AccountRef> {
  const query = value.trim();
  if (query === '') throw new ToolError('Name the person waiting for access.');

  const waiting = await waitingAccounts(ctx);
  if (waiting.length === 0) throw new ToolError('Nobody is waiting for access.');

  if (isUuid(query)) {
    const row = waiting.find((entry) => entry.id === query);
    if (row === undefined) throw new ToolError('Nobody with that id is waiting for access.');
    return row;
  }

  const folded = query.toLowerCase();
  const exact = waiting.filter(
    (entry) => entry.name.toLowerCase() === folded || entry.email.toLowerCase() === folded,
  );
  const partial = waiting.filter(
    (entry) => entry.name.toLowerCase().includes(folded) || entry.email.toLowerCase().includes(folded),
  );
  const candidates = exact.length > 0 ? exact : partial;
  if (candidates.length === 0) {
    const names = waiting.map((entry) => entry.name).join(', ');
    throw new ToolError(`Nobody waiting for access matches "${query}". Waiting: ${names}.`);
  }
  if (candidates.length > 1) {
    const options = candidates.map((entry) => `${entry.name} (${entry.email})`).join(', ');
    throw new ToolError(`"${query}" matches more than one waiting account: ${options}. Say which one.`);
  }
  return candidates[0];
}

interface WaitingAccount extends AccountRef {
  email: string;
  createdAt: string;
}

/** The accounts waiting on an administrator, oldest first, as the Access screen lists them. */
async function waitingAccounts(ctx: ToolContext): Promise<WaitingAccount[]> {
  const { data, error } = await ctx.supabase
    .from('app_accounts')
    .select('id, display_name, email, created_at')
    .eq('status', 'pending_approval')
    .order('created_at', { ascending: true });
  if (error) {
    console.error('[ai] waiting accounts read failed', { code: error.code, message: error.message });
    throw new ToolError(GENERIC_RPC_FAILURE, error.code ?? null, error.message ?? '');
  }
  return rows(data).map((row) => ({
    id: textOf(row.id),
    name: textOf(row.display_name),
    email: textOf(row.email),
    createdAt: textOf(row.created_at),
  }));
}

interface InviteRef {
  id: string;
  email: string;
  state: string;
}

/**
 * One invite, by id or by the address it was sent to.
 *
 * An address may have been invited more than once — revoked, then invited
 * again — so the PENDING one is what the address means; only when none is
 * pending does a name resolve to whichever came last, so the refusal can say
 * "that one was already accepted" rather than "no such invite".
 */
async function resolveInvite(ctx: ToolContext, value: string): Promise<InviteRef> {
  const query = value.trim();
  if (query === '') throw new ToolError('Name the invite by the email address it went to.');

  const invites = rows(await rpc(ctx, 'app_admin_list_invites', {}));
  const asRef = (row: Record<string, unknown>): InviteRef => ({
    id: textOf(row.id),
    email: textOf(row.email),
    state: textOf(row.state),
  });

  if (isUuid(query)) {
    const row = invites.find((entry) => textOf(entry.id) === query);
    if (row === undefined) throw new ToolError('There is no invite with that id.');
    return asRef(row);
  }

  const folded = query.toLowerCase();
  const matching = invites.filter((entry) => textOf(entry.email).toLowerCase() === folded);
  if (matching.length === 0) throw new ToolError(`No invite went to "${query}".`);
  // Newest first is the list's own order, so the first pending one is the
  // live one and the first of any is the latest.
  return asRef(matching.find((entry) => textOf(entry.state) === 'pending') ?? matching[0]);
}

/**
 * One quick ticket, by name or by id: an exact name wins, a single partial is
 * accepted, a tie is refused with the names in it. The list is a dozen at most,
 * so it is read whole rather than searched.
 */
async function resolvePreset(ctx: ToolContext, value: string): Promise<TicketPreset> {
  const query = value.trim();
  if (query === '') throw new ToolError('Name the quick ticket.');

  const presets = orderPresets(
    rows(await rpc(ctx, 'app_list_ticket_presets', {}))
      .map(presetFromRow)
      .filter((preset): preset is TicketPreset => preset !== null),
  );
  if (presets.length === 0) throw new ToolError('There are no quick tickets yet.');

  if (isUuid(query)) {
    const row = presets.find((preset) => preset.id === query);
    if (row === undefined) throw new ToolError('There is no quick ticket with that id.');
    return row;
  }

  const folded = query.toLowerCase();
  const exact = presets.filter((preset) => preset.name.toLowerCase() === folded);
  const partial = presets.filter((preset) => preset.name.toLowerCase().includes(folded));
  const candidates = exact.length > 0 ? exact : partial;
  if (candidates.length === 0) {
    const names = presets.map((preset) => preset.name).join(', ');
    throw new ToolError(`No quick ticket is called "${query}". There is: ${names}.`);
  }
  if (candidates.length > 1) {
    const options = candidates.map((preset) => preset.name).join(', ');
    throw new ToolError(`"${query}" matches more than one quick ticket: ${options}. Say which one.`);
  }
  return candidates[0];
}

/**
 * A pasted list of people, sorted into the three answers the directory gives.
 *
 * The same reader the paste box on a group's page uses, so the assistant and
 * the screen agree about what a line means. Only the ids it matched are ever
 * written anywhere; the other two lists are named back, so somebody can fix
 * them, and are never quietly folded into a count.
 */
async function lookupPeople(
  ctx: ToolContext,
  keys: readonly string[],
): Promise<{ matched: (PersonRef & { key: string })[]; unmatched: string[]; ambiguous: string[] }> {
  const found = rows(await rpc(ctx, 'app_find_people', { p_keys: [...keys] }));
  const matched: (PersonRef & { key: string })[] = [];
  const unmatched: string[] = [];
  const ambiguous: string[] = [];
  for (const row of found) {
    const key = textOf(row.key);
    if (textOf(row.found) === 'match') {
      matched.push({ key, id: textOf(row.id), name: textOf(row.display_name) });
    } else if (Number(row.matches ?? 0) > 1) {
      ambiguous.push(key);
    } else {
      unmatched.push(key);
    }
  }
  return { matched, unmatched, ambiguous };
}

/** A refusal without its full stop, for a sentence that supplies its own. */
function unstopped(message: string): string {
  return message.trim().replace(/\.$/, '');
}

/** The tail of a batch summary: "3 not found, 1 ambiguous", or nothing. */
function lookupTail(unmatched: readonly string[], ambiguous: readonly string[]): string[] {
  const parts: string[] = [];
  if (unmatched.length > 0) parts.push(`${unmatched.length} not found`);
  if (ambiguous.length > 0) parts.push(`${ambiguous.length} ambiguous`);
  return parts;
}

/**
 * The one record an attachment call is about.
 *
 * `app_list_attachments` takes a ticket or a device and treats both or neither
 * as a malformed question, so the tool asks for exactly one and says so in the
 * words a person would use rather than letting the database answer with an
 * empty list — which is also what "you cannot see that ticket" looks like.
 */
async function resolveAttachmentTarget(
  ctx: ToolContext,
  args: Record<string, unknown>,
): Promise<{ ticketId: string | null; deviceId: string | null; label: string }> {
  const hasTicket = args.ticket !== undefined;
  const hasDevice = args.device !== undefined;
  if (hasTicket === hasDevice) {
    throw new ToolError('Name either a ticket or a device, not both and not neither.');
  }
  if (hasTicket) {
    const ticket = await resolveTicket(ctx, String(args.ticket));
    return { ticketId: ticket.id, deviceId: null, label: ticket.number };
  }
  const device = await resolveDevice(ctx, String(args.device));
  return { ticketId: null, deviceId: device.id, label: device.label };
}

/**
 * The saved views this account has right now.
 *
 * `app_set_saved_views` REPLACES the whole list, so adding or removing one
 * means reading the list first. It is read through the same projection the
 * screens read — a stored entry this build cannot understand is dropped rather
 * than carried forward — so a save never writes back something it could not
 * itself show.
 */
async function currentSavedViews(ctx: ToolContext): Promise<SavedView[]> {
  const data = await rpc(ctx, 'app_my_preferences', {});
  const row = Array.isArray(data) ? data[0] : data;
  return parseSavedViews(isRecord(row) ? row.saved_views : null);
}

/**
 * Which picture from this turn somebody meant.
 *
 * A person says "attach that one", "the second photo" or "the cracked-screen
 * one", so all three resolve: nothing said and exactly one picture is that
 * picture, a bare number is a position starting at one, and anything else is
 * matched against the file names. A tie is refused with the names in it rather
 * than guessed at, the same way every other resolver here refuses one.
 */
function resolvePicture(ctx: ToolContext, value: string | undefined): ToolImage {
  const images = ctx.images ?? [];
  if (images.length === 0) {
    throw new ToolError(
      'There are no pictures in this message. Pictures are only available in the turn they were sent, so ask them to send it again with what it should go on.',
    );
  }

  const names = images.map((image, at) => `${at + 1}. ${image.name}`).join('; ');
  const query = (value ?? '').trim();
  if (query === '') {
    if (images.length === 1) return images[0];
    throw new ToolError(`Say which picture: ${names}.`);
  }

  if (/^\d{1,3}$/.test(query)) {
    const index = Number(query) - 1;
    if (index < 0 || index >= images.length) {
      throw new ToolError(`There is no picture ${query} in this message. There is ${names}.`);
    }
    return images[index];
  }

  const folded = query.toLowerCase();
  const exact = images.filter((image) => image.name.toLowerCase() === folded);
  const partial = images.filter((image) => image.name.toLowerCase().includes(folded));
  const candidates = exact.length > 0 ? exact : partial;
  if (candidates.length === 0) {
    throw new ToolError(`No picture in this message is called "${query}". There is ${names}.`);
  }
  if (candidates.length > 1) throw new ToolError(`"${query}" matches more than one picture: ${names}.`);
  return candidates[0];
}

// ---------------------------------------------------------------------------
// Tool table
// ---------------------------------------------------------------------------

type ToolGroup = 'read' | 'write' | 'admin';

interface ToolSpec {
  group: ToolGroup;
  description: string;
  fields: Record<string, Field>;
  /**
   * An administrator-only READ.
   *
   * The group answers "is this a change?", and that question decides whether
   * the operator is asked first. The audit log is not a change, so it must not
   * be in the `admin` group — every tool in that group asks, and asking before
   * a read would be a confirmation card for nothing. But it is administration,
   * and `app_audit_log` refuses anybody else, so it must not be offered to a
   * NetRider either. Two orthogonal facts, said separately rather than folded
   * into one list that would get one of them wrong.
   */
  adminOnly?: true;
  /**
   * A directory EXPORT: offered to an administrator or a skills officer, and
   * to nobody else.
   *
   * The third gating shape, and the only tool that has it. A NetRider reads
   * the roster to work a ticket; carrying it out of the building is the
   * roster's own people's job (`canExportDirectory`), and the export route
   * refuses everybody else independently. Neither `adminOnly` nor the
   * directory allow-list says "these two roles and not the third", so this
   * flag does.
   */
  directoryExport?: true;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutcome>;
}

/** Every optional string field a directory record accepts. */
const STUDENT_STATUSES = ['current', 'graduated', 'other'] as const;

const PERSON_FIELDS: Record<string, Field> = {
  display_name: { type: 'string', description: 'The name the helpdesk shows. Required for a new record.' },
  external_id: { type: 'string', description: "A student's OSIS, numbers only. Staff have theirs derived from their email." },
  first_name: { type: 'string', description: 'Given name.' },
  last_name: { type: 'string', description: 'Family name.' },
  email: { type: 'string', description: 'School email address. Required for staff.' },
  school_dbn: { type: 'string', description: 'School DBN, for staff.' },
  department: { type: 'string', description: 'Department, for staff.' },
  staff_role: { type: 'string', description: 'Job title, for staff.' },
  official_class: { type: 'string', description: 'Official class, for students.' },
  class_of: { type: 'string', description: 'Graduating year, four digits, for students.' },
  student_status: { type: 'string', description: 'current, graduated or other.', choices: STUDENT_STATUSES },
  guardian_name: { type: 'string', description: 'Parent or guardian name.' },
  guardian_phone: { type: 'string', description: 'Parent or guardian phone number.' },
  home_phone: { type: 'string', description: 'Home phone number.' },
  address: { type: 'string', description: 'Home address.' },
  notes: { type: 'string', description: 'Anything else worth recording.' },
};

/** snake_case as the assistant writes it, camelCase as app_save_person takes it. */
const PERSON_JSON_KEYS: Record<string, string> = {
  display_name: 'displayName',
  external_id: 'externalId',
  first_name: 'firstName',
  last_name: 'lastName',
  email: 'email',
  school_dbn: 'schoolDbn',
  department: 'department',
  staff_role: 'staffRole',
  official_class: 'officialClass',
  class_of: 'classOf',
  student_status: 'studentStatus',
  guardian_name: 'guardianName',
  guardian_phone: 'guardianPhone',
  home_phone: 'homePhone',
  address: 'address',
  notes: 'notes',
};

/**
 * The settings an account may change about itself, in the words the tool takes
 * and the names the domain module knows them by.
 *
 * `app_update_preferences` whitelists these columns and `preferencePatch`
 * narrows to the same set, so this table is the third statement of one list
 * rather than a new rule. Its real job is the FIRST one: a key outside it is
 * refused by the argument checker, by name, with the allowed keys in the
 * message, before any round trip.
 */
const PREFERENCE_KEYS = {
  theme: 'theme',
  ai_reasoning: 'aiReasoning',
  gmail_mode: 'gmailMode',
  ai_welcome_states: 'aiWelcomeStates',
  ai_confirm_changes: 'aiConfirmChanges',
  ai_speak_replies: 'aiSpeakReplies',
  notify_in_app: 'notifyInApp',
  assistant_notes: 'assistantNotes',
} as const satisfies Record<string, keyof PreferencePatch>;

/**
 * The words that take a personal note back off.
 *
 * `value` is required, and the checker reads an empty string as "not given",
 * so there has to be a word for "nothing". These are the ones a person says.
 */
const CLEAR_WORDS = ['clear', 'none', 'nothing', 'remove', 'delete'];

type PreferenceKey = keyof typeof PREFERENCE_KEYS;

/** The settings that take true or false rather than a word. */
const PREFERENCE_FLAGS: readonly PreferenceKey[] = [
  'ai_confirm_changes',
  'ai_speak_replies',
  'notify_in_app',
];

/** The welcome effects by the names people use for them, for the tool's hint. */
const WELCOME_EFFECT_HINT = WELCOME_STATES.map((state) => WELCOME_STATE_LABELS[state].label).join(
  ', ',
);

/**
 * "Diamond and wave", "diamond, wave", "Diamond" — a list of effects as a
 * person says it, back to the states the column holds. Empty entries are
 * skipped so a trailing comma is not an error; an unknown name is refused by
 * naming the seven, in the settings screen's own words.
 */
function readWelcomeStates(value: string): PreferencePatch['aiWelcomeStates'] {
  const states: NonNullable<PreferencePatch['aiWelcomeStates']> = [];
  for (const word of value.split(/,|\band\b|\n/)) {
    if (word.trim() === '') continue;
    const state = welcomeStateFromLabel(word);
    if (state === null) throw new ToolError(WELCOME_STATES_UNKNOWN);
    if (!states.includes(state)) states.push(state);
  }
  return states;
}

/**
 * True, false, and the words people say instead.
 *
 * "Turn confirmations off" reaches the model as `value: "off"` about as often as
 * `"false"`, and refusing that would be this tool being pedantic about a
 * question it understood perfectly well. Anything else is still an error.
 */
function readFlag(key: string, value: string): boolean {
  const folded = value.trim().toLowerCase();
  if (['true', 'yes', 'on'].includes(folded)) return true;
  if (['false', 'no', 'off'].includes(folded)) return false;
  throw new ToolError(`${key} takes true or false, not "${value}".`);
}

/** One sentence naming the vocabulary, so both device tools offer the same words. */
const DEVICE_TYPE_HINT = `One of ${DEVICE_TYPES.join(', ')}, or the district's own word for it.`;

const DEVICE_JSON_KEYS: Record<string, string> = {
  device_type: 'deviceType',
  manufacturer: 'manufacturer',
  model: 'model',
  os_version: 'osVersion',
  serial_number: 'serialNumber',
  asset_tag: 'assetTag',
  status: 'status',
  location: 'location',
  notes: 'notes',
};

/** Renames the keys of a patch, dropping anything the map does not know. */
function toJsonKeys(patch: Record<string, unknown>, map: Record<string, string>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [name, value] of Object.entries(patch)) {
    const key = map[name];
    if (key !== undefined) out[key] = value;
  }
  return out;
}

const DEVICE_FIELDS: Record<string, Field> = {
  device_type: { type: 'string', description: `${DEVICE_TYPE_HINT} Required.` },
  manufacturer: { type: 'string', description: 'Who made it. Required.' },
  model: { type: 'string', description: 'Model name. Required.' },
  serial_number: { type: 'string', description: 'Manufacturer serial number. Required, and unique in the inventory.' },
  asset_tag: { type: 'string', description: 'School asset tag.' },
  os_version: { type: 'string', description: 'Operating system and version.' },
  status: { type: 'string', description: `Free text. Usually one of ${SEEDED_STATUSES}.` },
  location: { type: 'string', description: 'Room or store it lives in.' },
  notes: { type: 'string', description: 'Anything else worth recording.' },
};

function pick(args: Record<string, unknown>, names: readonly string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const name of names) {
    if (args[name] !== undefined) out[name] = args[name];
  }
  return out;
}

function outcome(result: unknown, summary: string): ToolOutcome {
  return { ok: true, result, summary };
}

/** Counts rows for a summary without pretending a page is the whole set. */
function countOf(data: unknown): number {
  return Array.isArray(data) ? data.length : 0;
}

/** The `total` a paged list RPC reports, which is the whole set rather than the page. */
function totalOf(data: unknown): number {
  return isRecord(data) ? Number(data.total ?? 0) : 0;
}

// ---------------------------------------------------------------------------
// The analytics document, trimmed
// ---------------------------------------------------------------------------

/*
 * `app_analytics` answers with a chart's worth of detail: a bar for every day
 * of the period, a heat cell for every hour of every weekday, a row for every
 * resolver. The page at /analytics draws all of it.
 *
 * A model cannot draw, and every character of a tool result is sent to it,
 * read back into the next turn and stored in the conversation. So the tool
 * keeps the numbers somebody would say out loud — counts, medians, shares,
 * the honours, the hardest tickets — and drops the ones only a chart can use:
 * the throughput series becomes its totals and its two ends, and the
 * hour-by-weekday matrix goes entirely. The per-person table goes too, because
 * it is the ranking the owner reserved for administrators on the page; the
 * reader's own row comes back whoever they are.
 *
 * Fields keep the document's own spelling (snake_case), so a number the
 * assistant quotes is findable under the same name on the page and in the SQL.
 */

/** A number the document really sent, or null. `0` is a number; "3" is not. */
function analyticsNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** Text that is really there, or null — so "nobody yet" stays distinguishable from "". */
function analyticsText(value: unknown): string | null {
  const text = textOf(value).trim();
  return text === '' ? null : text;
}

function analyticsRecord(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function numberList(value: unknown): number[] {
  return Array.isArray(value) ? value.map((entry) => analyticsNumber(entry) ?? 0) : [];
}

/**
 * A stored vocabulary word as the screens print it, falling back to the plain
 * sentence-case of whatever arrived. `Object.hasOwn` rather than a lookup, so a
 * document naming `constructor` as a category gets the fallback and not a
 * function's source.
 */
function labelFrom<T extends string>(labels: Record<T, string>, value: unknown): string {
  const key = textOf(value);
  return Object.hasOwn(labels, key) ? labels[key as T] : label(key);
}

/** The throughput series as its totals and its two ends. */
function throughputSummary(points: Record<string, unknown>[]): Record<string, unknown> {
  const total = (key: string): number =>
    points.reduce((sum, point) => sum + (analyticsNumber(point[key]) ?? 0), 0);
  const first = points[0];
  const last = points[points.length - 1];
  return {
    slices: points.length,
    created: total('created'),
    resolved: total('resolved'),
    // Where the backlog started the period and where it got to. The shape in
    // between is the chart's, and the chart is on the page.
    backlog_first: first === undefined ? null : analyticsNumber(first.backlog),
    backlog_last: last === undefined ? null : analyticsNumber(last.backlog),
  };
}

function honourRows(honours: Record<string, unknown>[]): Record<string, unknown>[] {
  return honours.map((honour) => {
    const key = textOf(honour.key);
    return {
      // The title the page prints, from the one module that owns the wording.
      title: Object.hasOwn(HONOUR_TITLES, key) ? HONOUR_TITLES[key as HonourKey] : label(key),
      name: analyticsText(honour.name),
      value: analyticsText(honour.value),
      detail: analyticsText(honour.detail),
    };
  });
}

function hardestRows(hardest: Record<string, unknown>[]): Record<string, unknown>[] {
  return hardest.map((ticket) => {
    // The database redacts a ticket this reader may not open: the row still
    // counts, with no number and no title. An absent key says that better than
    // a null one, which a model tends to read as a value it should go and find.
    const number = analyticsText(ticket.number);
    const title = analyticsText(ticket.title);
    return {
      ...(number === null ? {} : { number }),
      ...(title === null ? {} : { title }),
      category: labelFrom(TICKET_CATEGORY_LABELS, ticket.category),
      priority: labelFrom(PRIORITY_LABELS, ticket.priority),
      hours: analyticsNumber(ticket.hours),
      from_claim_hours: analyticsNumber(ticket.from_claim_hours),
      hands: analyticsNumber(ticket.hands),
      resolver_name: analyticsText(ticket.resolver_name),
      score: analyticsNumber(ticket.score),
    };
  });
}

/** The whole document, as much of it as is worth saying out loud. */
function trimAnalytics(
  document: Record<string, unknown>,
  asked: { period: string; bucket: string; since: string | null },
): Record<string, unknown> {
  const people = analyticsRecord(document.people);
  const waiting = analyticsRecord(document.waiting);
  const arrivals = analyticsRecord(document.arrivals);
  return {
    // The period is ours: the function is given two instants and a bucket, and
    // has never heard of "this term".
    period: asked.period,
    bucket: asked.bucket,
    // The instants the work was measured between. `until` is when the database
    // read the clock, which is a little after the question was asked; `since`
    // is null for all time.
    since: analyticsText(document.since) ?? asked.since,
    until: analyticsText(document.until),
    overview: analyticsRecord(document.overview),
    throughput: throughputSummary(rows(document.throughput)),
    // When tickets arrive, Monday first and midnight first. Thirty-one numbers
    // answer "when are we busiest"; the 7 × 24 matrix behind them does not.
    arrivals: {
      by_weekday: numberList(arrivals.by_weekday),
      by_hour: numberList(arrivals.by_hour),
    },
    categories: rows(document.categories).map((row) => ({
      category: labelFrom(TICKET_CATEGORY_LABELS, row.category),
      resolved: analyticsNumber(row.resolved) ?? 0,
      share: percentOf(analyticsNumber(row.share)),
      median_hours: analyticsNumber(row.median_hours),
    })),
    priorities: rows(document.priorities).map((row) => ({
      priority: labelFrom(PRIORITY_LABELS, row.priority),
      resolved: analyticsNumber(row.resolved) ?? 0,
      share: percentOf(analyticsNumber(row.share)),
      median_hours: analyticsNumber(row.median_hours),
      p90_hours: analyticsNumber(row.p90_hours),
      median_from_claim_hours: analyticsNumber(row.median_from_claim_hours),
    })),
    channels: rows(document.channels).map((row) => ({
      channel: labelFrom(CHANNEL_LABELS, row.channel),
      count: analyticsNumber(row.count) ?? 0,
      share: percentOf(analyticsNumber(row.share)),
    })),
    waiting: {
      tickets_waited: analyticsNumber(waiting.tickets_waited) ?? 0,
      share: percentOf(analyticsNumber(waiting.share)),
      median_wait_hours: analyticsNumber(waiting.median_wait_hours),
      reasons: rows(waiting.reasons).map((row) => ({
        reason: analyticsText(row.reason),
        count: analyticsNumber(row.count) ?? 0,
      })),
    },
    honours: honourRows(rows(people.honours)),
    // The reader's own row. `people.rows` — everybody's, ranked — is the
    // administrators' table and stays on the page.
    me: isRecord(people.me) ? people.me : null,
    hardest: hardestRows(rows(document.hardest)),
  };
}

const TOOLS: Record<string, ToolSpec> = {
  // --- Read ---------------------------------------------------------------

  search_records: {
    group: 'read',
    description:
      'Search tickets, people, devices, groups and group events at once by number, name, email, OSIS, staff id, guardian phone, asset tag or serial. Use this before acting on anything named by a person rather than by id.',
    fields: {
      query: { type: 'string', required: true, description: 'What to search for.' },
      limit: { type: 'integer', description: 'How many results to return. Default 8, at most 25.' },
    },
    run: async (args, ctx) => {
      const data = await rpc(ctx, 'app_search', {
        p_query: args.query,
        p_limit: Math.min(Number(args.limit ?? 8), 25),
      });
      return outcome(data, `Searched for "${String(args.query)}" and found ${countOf(data)}.`);
    },
  },

  get_today_briefing: {
    group: 'read',
    description:
      "What needs this person today: how many tickets are unclaimed, how many of theirs are waiting on a reply, how many they own, and who is waiting for access, with the top few rows under each. The same read the Today screen uses, so the assistant and the screen never disagree about the numbers.",
    fields: {},
    run: async (_args, ctx) => {
      const data = await rpc(ctx, 'app_today_briefing', {});
      return outcome(data, 'Read what needs you today.');
    },
  },

  draft_ticket_from_text: {
    group: 'read',
    description:
      'Read a pasted email or message as a ticket draft: a title, the issue with the quoted thread and signature removed, the sender to search the directory for, and a suggested category and priority. It creates NOTHING. Use create_ticket afterwards, with whatever the person corrected.',
    fields: {
      text: {
        type: 'string',
        required: true,
        description: 'The message as it was pasted, headers and all.',
        maxLength: 20000,
      },
    },
    run: async (args) => {
      /*
       * No database call, and that is the point: this is the same pure reader
       * the intake form uses with no account and no network, so a draft is a
       * draft whichever way it was asked for. Naming it as a tool lets the
       * assistant do the paste-and-fill in one turn without the model inventing
       * a title of its own — and, because it changes nothing, it never has to
       * ask first.
       */
      const draft = draftFromText(String(args.text));
      return outcome(draft, `Read a ${String(args.text).length}-character message as a draft.`);
    },
  },

  get_ticket: {
    group: 'read',
    description: 'The full record of one ticket: its details, history, notes, work log and linked devices.',
    fields: {
      ticket: { type: 'string', required: true, description: 'Ticket number such as EDT-1042, or its id.' },
    },
    run: async (args, ctx) => {
      const ticket = await resolveTicket(ctx, String(args.ticket));
      const data = await rpc(ctx, 'app_ticket_detail', { p_ticket: ticket.id });
      return outcome(data, `Read ${ticket.number}.`);
    },
  },

  list_queue: {
    group: 'read',
    description:
      'List tickets. Scopes: open_queue (unclaimed), mine, collaborating, closed, and all (administrators only).',
    fields: {
      scope: { type: 'string', description: 'Which list to read. Default open_queue.', choices: TICKET_SCOPES },
      query: { type: 'string', description: 'Free text to narrow the list.' },
      status: { type: 'string', description: 'Only this status.', choices: TICKET_STATUSES },
      priority: { type: 'string', description: 'Only this priority.', choices: PRIORITIES },
      category: { type: 'string', description: 'Only this category.', choices: CATEGORIES },
      limit: { type: 'integer', description: 'How many to return. Default 25, at most 100.' },
    },
    run: async (args, ctx) => {
      const scope = String(args.scope ?? 'open_queue');
      const data = await rpc(ctx, 'app_list_tickets', {
        p_scope: scope,
        p_query: args.query ?? null,
        p_status: args.status ?? null,
        p_priority: args.priority ?? null,
        p_category: args.category ?? null,
        p_limit: Math.min(Number(args.limit ?? 25), 100),
        p_offset: 0,
      });
      return outcome(data, `Listed ${countOf(data)} tickets from ${label(scope).toLowerCase()}.`);
    },
  },

  list_my_tickets: {
    group: 'read',
    description: 'The tickets this NetRider owns right now.',
    fields: {
      limit: { type: 'integer', description: 'How many to return. Default 25, at most 100.' },
    },
    run: async (args, ctx) => {
      const data = await rpc(ctx, 'app_list_tickets', {
        p_scope: 'mine',
        p_limit: Math.min(Number(args.limit ?? 25), 100),
        p_offset: 0,
      });
      return outcome(data, `Listed ${countOf(data)} of your tickets.`);
    },
  },

  list_people: {
    group: 'read',
    description:
      'List students or staff from the directory. The search reads every field of a record, so a room, a class or a guardian name finds people too.',
    fields: {
      kind: { type: 'string', required: true, description: 'Students or staff.', choices: PERSON_KINDS },
      query: { type: 'string', description: 'Name, email, OSIS, staff id, class or anything else on the record.' },
      page: { type: 'integer', description: 'Which page of fifty. Default 1.' },
    },
    run: async (args, ctx) => {
      const data = await rpc(ctx, 'app_list_people', {
        p_kind: args.kind,
        p_query: args.query ?? '',
        p_page: Math.max(1, Number(args.page ?? 1)),
      });
      return outcome(data, `Listed ${pageRows(data).length} of ${totalOf(data)} people.`);
    },
  },

  get_person: {
    group: 'read',
    description: 'One directory record with the machines they are holding.',
    fields: {
      person: { type: 'string', required: true, description: 'Name, email, OSIS, staff id or record id.' },
    },
    run: async (args, ctx) => {
      const person = await resolvePerson(ctx, String(args.person));
      const [record, devices] = await Promise.all([
        rpc(ctx, 'app_get_person', { p_id: person.id }),
        rpc(ctx, 'app_requester_devices', { p_requester: person.id }),
      ]);
      return outcome({ person: record, devices }, `Read ${person.name}.`);
    },
  },

  find_people: {
    group: 'read',
    description:
      'Look up a whole list of people at once — a class list, a roster, a column pasted out of a spreadsheet — and get one answer per entry, in the order they were given. Each entry is an OSIS number, a staff id, a school email address or a full name as the directory spells it; an identifier is matched exactly and a name is matched whole, ignoring capitals. Each answer is either the person (id, name, student or staff, their class or department, how many machines they hold and how many open tickets they have), "no match", or "ambiguous (n)" when the same name belongs to more than one record — in which case ask which one, or use the OSIS or staff id instead. Up to 200 at a time, in one call: do not call this once per person.',
    fields: {
      people: {
        type: 'string[]',
        required: true,
        maxItems: FIND_PEOPLE_LIMIT,
        description:
          'The people to look up, one per entry: OSIS number, staff id, school email address or full name.',
      },
    },
    run: async (args, ctx) => {
      const keys = args.people as string[];
      const found = rows(await rpc(ctx, 'app_find_people', { p_keys: keys }));

      const answers = found.map((row) => {
        const key = textOf(row.key);
        const matches = Number(row.matches ?? 0);
        if (textOf(row.found) !== 'match') {
          return { key, match: matches > 1 ? `ambiguous (${matches})` : 'no match' };
        }
        return {
          key,
          id: textOf(row.id),
          name: textOf(row.display_name),
          kind: textOf(row.kind),
          // A student's official class and a member of staff's department are
          // the same question asked of two records: "where in the school?".
          group: textOf(row.group_label),
          devices: Number(row.device_count ?? 0),
          openTickets: Number(row.open_ticket_count ?? 0),
        };
      });

      const matched = answers.filter((answer) => answer.match === undefined).length;
      const ambiguous = answers.filter((answer) => (answer.match ?? '').startsWith('ambiguous')).length;
      const missing = answers.length - matched - ambiguous;
      const parts = [`${matched} matched`];
      if (missing > 0) parts.push(`${missing} not found`);
      if (ambiguous > 0) parts.push(`${ambiguous} ambiguous`);
      return outcome(answers, `Looked up ${answers.length} people: ${parts.join(', ')}.`);
    },
  },

  contact_list: {
    group: 'read',
    description:
      "A copy-ready contact list, and a Gmail link, for a set of people: a group, a pasted list of OSIS numbers, staff ids, emails or names, or a directory filter (students or staff, optionally narrowed by a search such as a class). `format` is what to hand over: addresses (comma-separated emails), names, names_and_addresses (Name <email>, one per line), identifiers (OSIS or staff ids), or guardian_phones (Name: phone, students only). The answer carries the text to show the person in a code block so they can copy it, how many were included and how many had nothing on file, and, when `gmail` is true, a link that opens a Gmail compose window addressed to everyone the way this person prefers (their gmail_mode setting: to, cc or bcc). Give exactly one of group, people or kind.",
    fields: {
      format: {
        type: 'string',
        required: true,
        description: 'What to hand over.',
        choices: ['addresses', 'names', 'names_and_addresses', 'identifiers', 'guardian_phones'],
      },
      group: { type: 'string', description: 'A group, by name or id.' },
      people: {
        type: 'string[]',
        description: 'OSIS numbers, staff ids, emails or full names, one per entry. Up to 200.',
      },
      kind: { type: 'string', description: 'A directory filter: students or staff.', choices: ['student', 'staff'] },
      query: { type: 'string', description: 'Narrows the directory filter: a class, a department, a name.' },
      gmail: { type: 'boolean', description: 'Also return a Gmail compose link. Default false.' },
    },
    run: async (args, ctx) => {
      const format = String(args.format) as 'addresses' | 'names' | 'names_and_addresses' | 'identifiers' | 'guardian_phones';
      const kindByFormat: Record<typeof format, CopyKind> = {
        addresses: 'addresses',
        names: 'names',
        names_and_addresses: 'names-and-addresses',
        identifiers: 'identifiers',
        guardian_phones: 'guardian-phones',
      };
      const sources = [args.group, args.people, args.kind].filter((value) => value !== undefined && value !== null && value !== '').length;
      if (sources !== 1) throw new ToolError('Give exactly one of group, people or kind.');

      let people: PersonAddressee[] = [];
      let label = '';
      if (args.group !== undefined && args.group !== '') {
        const ref = await resolveGroup(ctx, String(args.group));
        const members = rows(await rpc(ctx, 'app_group_members', { p_group: ref.id }));
        people = members.map((row) => ({
          id: textOf(row.requester_id),
          displayName: textOf(row.display_name),
          email: row.email === null || row.email === undefined ? null : textOf(row.email),
          externalId: row.external_id === null || row.external_id === undefined ? null : textOf(row.external_id),
          kind: textOf(row.kind) === 'staff' ? 'staff' : 'student',
          guardianName: row.guardian_name === null || row.guardian_name === undefined ? null : textOf(row.guardian_name),
          guardianPhone: row.guardian_phone === null || row.guardian_phone === undefined ? null : textOf(row.guardian_phone),
        }));
        label = ref.name;
      } else if (Array.isArray(args.people)) {
        const keys = (args.people as unknown[]).map((entry) => String(entry).trim()).filter((entry) => entry !== '');
        if (keys.length === 0) throw new ToolError('Give at least one person.');
        if (keys.length > 200) throw new ToolError('Up to 200 people at a time.');
        const found = rows(await rpc(ctx, 'app_find_people', { p_keys: keys }));
        const ids = found.filter((row) => textOf(row.found) === 'match').map((row) => textOf(row.id));
        const byKind: PersonAddressee[] = [];
        for (const kind of ['student', 'staff'] as const) {
          const chosen = found.filter((row) => textOf(row.found) === 'match' && textOf(row.kind) === kind).map((row) => textOf(row.id));
          if (chosen.length === 0) continue;
          const answer = await rpc(ctx, 'app_people_addressees', { p_kind: kind, p_query: '', p_ids: chosen });
          byKind.push(...addresseesFrom(answer));
        }
        people = byKind;
        label = `${ids.length} of ${keys.length} listed`;
      } else {
        const kind = String(args.kind);
        const answer = await rpc(ctx, 'app_people_addressees', { p_kind: kind, p_query: String(args.query ?? ''), p_ids: null });
        people = addresseesFrom(answer);
        const capped = isRecord(answer) && answer.capped === true;
        label = `${people.length} ${kind === 'staff' ? 'staff' : 'students'}${capped ? ' (the first 500)' : ''}`;
      }

      const clip = clipboardFor(kindByFormat[format], people);
      const result: Record<string, unknown> = {
        who: label,
        count: clip.count,
        of: people.length,
        text: clip.text,
        note: clip.message,
      };
      if (args.gmail === true) {
        const mode = await gmailModeFor(ctx);
        const link = gmailLink(people, mode);
        result.gmail = link.url ? { url: link.url, mode, addresses: link.addressCount } : { url: null, reason: link.reason };
      }
      return outcome(result, `${clip.message} for ${label}`);
    },
  },

  list_groups: {
    group: 'read',
    description:
      "Every group the school keeps: the chapter's members and officers, a competition team, the people a cart belongs to. Each one answers with its name, what it is for, how many people are in it and when it last changed. Read this before naming a group, rather than guessing what one is called.",
    fields: {},
    run: async (_args, ctx) => {
      const data = await rpc(ctx, 'app_list_groups', {});
      return outcome(data, `Listed ${countOf(data)} groups.`);
    },
  },

  group_members: {
    group: 'read',
    description:
      'Who is in one group: their name, whether they are a student or staff, their class or department, their OSIS or staff id, the short note beside them in this group and when they were added.',
    fields: {
      group: { type: 'string', required: true, description: 'The group, by name or by id.' },
    },
    run: async (args, ctx) => {
      const group = await resolveGroup(ctx, String(args.group));
      const data = await rpc(ctx, 'app_group_members', { p_group: group.id });
      const count = countOf(data);
      return outcome(data, `Read ${group.name}: ${count} ${count === 1 ? 'person' : 'people'}.`);
    },
  },

  group_events: {
    group: 'read',
    description:
      'What a group has done: every meeting, practice or competition it has taken a register at, newest first, each with how many of its members were present.',
    fields: {
      group: { type: 'string', required: true, description: 'The group, by name or by id.' },
    },
    run: async (args, ctx) => {
      const group = await resolveGroup(ctx, String(args.group));
      const data = await rpc(ctx, 'app_list_group_events', { p_group: group.id });
      return outcome(data, `Listed ${countOf(data)} events for ${group.name}.`);
    },
  },

  event_attendance: {
    group: 'read',
    description:
      'Who was at one event and who was not. Name the group and the event; where a group uses one name every week, the newest event with that name is the one meant. Absentees are named, because "who do I chase?" is the question a register is kept to answer.',
    fields: {
      group: { type: 'string', required: true, description: 'The group, by name or by id.' },
      event: { type: 'string', required: true, description: 'The event, by name or by id.' },
    },
    run: async (args, ctx) => {
      const group = await resolveGroup(ctx, String(args.group));
      const event = await resolveGroupEvent(ctx, group, String(args.event));
      const roll = rows(await rpc(ctx, 'app_event_roll', { p_event: event.id }));

      const present = roll.filter((row) => row.present === true).map((row) => textOf(row.display_name));
      const absent = roll.filter((row) => row.present !== true).map((row) => textOf(row.display_name));

      return outcome(
        {
          event: event.name,
          held_on: event.heldOn,
          group: group.name,
          present_count: present.length,
          absent_count: absent.length,
          present,
          absent,
        },
        `${event.name} on ${event.heldOn}: ${present.length} of ${roll.length} present.`,
      );
    },
  },

  group_checklist: {
    group: 'read',
    description:
      'Where a group has got to on the things it ticks off — permission slips, dues, shirts. Answers one entry per column with how many members are ticked and WHO IS NOT, which is the list somebody is about to act on.',
    fields: {
      group: { type: 'string', required: true, description: 'The group, by name or by id.' },
    },
    run: async (args, ctx) => {
      const group = await resolveGroup(ctx, String(args.group));
      const [fields, marks, members] = await Promise.all([
        rpc(ctx, 'app_list_group_fields', { p_group: group.id }),
        rpc(ctx, 'app_group_marks', { p_group: group.id }),
        rpc(ctx, 'app_group_members', { p_group: group.id }),
      ]);

      const roster = rows(members);
      const ticked = new Map<string, Set<string>>();
      for (const row of rows(marks)) {
        const person = textOf(row.requester_id);
        const field = textOf(row.field_id);
        const set = ticked.get(field) ?? new Set<string>();
        set.add(person);
        ticked.set(field, set);
      }

      const columns = rows(fields).map((field) => {
        const id = textOf(field.id);
        const done = ticked.get(id) ?? new Set<string>();
        const missing = roster
          .filter((member) => !done.has(textOf(member.requester_id)))
          .map((member) => textOf(member.display_name));
        return {
          column: textOf(field.name),
          checked: roster.length - missing.length,
          of: roster.length,
          missing,
        };
      });

      const summary =
        columns.length === 0
          ? `${group.name} has no checklist columns.`
          : `${group.name}: ${columns
              .map((column) => `${column.column} ${column.checked}/${column.of}`)
              .join(', ')}.`;
      return outcome({ group: group.name, members: roster.length, columns }, summary);
    },
  },

  list_devices: {
    group: 'read',
    description:
      'List inventory machines. One search reads every field of a machine and of whoever is holding it, so a status, a room, a model or a name all narrow it.',
    fields: {
      query: { type: 'string', description: 'Asset tag, serial, model, room, status or holder name.' },
      person: { type: 'string', description: 'Only the machines this person is holding.' },
      page: { type: 'integer', description: 'Which page of fifty. Default 1.' },
    },
    run: async (args, ctx) => {
      const person = args.person === undefined ? null : await resolvePerson(ctx, String(args.person));
      const data = await rpc(ctx, 'app_list_inventory', {
        p_query: args.query ?? '',
        p_page: Math.max(1, Number(args.page ?? 1)),
        p_requester: person?.id ?? null,
      });
      return outcome(data, `Listed ${pageRows(data).length} of ${totalOf(data)} devices.`);
    },
  },

  get_device: {
    group: 'read',
    description: 'One machine: what it is, where it is and who is holding it.',
    fields: {
      device: { type: 'string', required: true, description: 'Asset tag, serial number, inventory id or record id.' },
    },
    run: async (args, ctx) => {
      const device = await resolveDevice(ctx, String(args.device));
      const data = await rpc(ctx, 'app_get_inventory_device', { p_id: device.id });
      return outcome(data, `Read ${device.label}.`);
    },
  },

  list_attachments: {
    group: 'read',
    description:
      'The files attached to one ticket or one device: what each is called, how big it is, who attached it and when. Name exactly one of the two.',
    fields: {
      ticket: { type: 'string', description: 'Ticket number or id.' },
      device: { type: 'string', description: 'Asset tag, serial number or inventory id.' },
    },
    run: async (args, ctx) => {
      const target = await resolveAttachmentTarget(ctx, args);
      const [attachments, directory] = await Promise.all([
        rpc(ctx, 'app_list_attachments', {
          p_ticket: target.ticketId,
          p_device: target.deviceId,
        }),
        // The row only names the uploader by id; the display name comes from
        // the same directory `resolveAccount` already reads elsewhere.
        rpc(ctx, 'app_directory', {}),
      ]);
      const names = new Map(rows(directory).map((entry) => [textOf(entry.id), textOf(entry.display_name)]));
      const data = rows(attachments).map((row) => ({
        id: textOf(row.id),
        filename: textOf(row.filename),
        mime: textOf(row.mime),
        size: formatBytes(Number(row.bytes ?? 0)),
        uploadedAt: textOf(row.uploaded_at),
        uploadedBy: names.get(textOf(row.uploaded_by)) || 'Unknown',
        // The path is how the server finds the bytes, and it is no use to a
        // model that cannot reach the bucket. It stays out of the result.
        via: row.performed_via === 'ai' ? 'ai' : 'user',
      }));
      return outcome(data, `Read ${data.length} ${data.length === 1 ? 'file' : 'files'} on ${target.label}.`);
    },
  },

  list_notifications: {
    group: 'read',
    description: "This NetRider's own notifications, newest first.",
    fields: {
      unread_only: { type: 'boolean', description: 'Only the ones not yet read.' },
      limit: { type: 'integer', description: 'How many to return. Default 20, at most 100.' },
    },
    run: async (args, ctx) => {
      const data = await rpc(ctx, 'app_notifications', {
        p_limit: Math.min(Number(args.limit ?? 20), 100),
        p_unread_only: args.unread_only ?? false,
      });
      return outcome(data, `Read ${countOf(data)} notifications.`);
    },
  },

  desk_analytics: {
    group: 'read',
    description:
      "The desk's numbers over a period: how many did we close this week, what is the most common issue, who is fastest on urgent tickets, when are we busiest. Counts and medians with the change on the period before, the mix by category, priority and channel, time spent waiting, the four honours, this person's own row, and the hardest tickets of the period. The page at /analytics (Work → Analytics) shows the same numbers with charts, so the two never disagree.",
    fields: {
      period: {
        type: 'string',
        description:
          'Which span: week (the school week so far), month (this calendar month), term (since 1 September) or all. Default month.',
        choices: STATS_PERIODS,
      },
    },
    run: async (args, ctx) => {
      /*
       * The period is turned into instants HERE, by the same `periodBounds` the
       * page calls, and the bucket by the same `bucketFor`. The database counts;
       * it is not asked where a school week begins.
       *
       * Who may read this is the database's decision, as everywhere else: the
       * function refuses an account that does not work tickets, and that refusal
       * arrives through `rpc` as an ordinary ToolError with the sentence it
       * wrote. `toolsFor` keeps a skills officer from being offered it at all,
       * and `executeTool` refuses the call before it is sent, so the round trip
       * is the third line rather than the first.
       */
      const period = toStatsPeriod(args.period);
      const bounds = periodBounds(period);
      const bucket = bucketFor(period);
      const document = analyticsRecord(
        await rpc(ctx, 'app_analytics', {
          p_since: bounds.since,
          p_until: bounds.until,
          p_bucket: bucket,
        }),
      );
      const answer = trimAnalytics(document, { period, bucket, since: bounds.since });
      const overview = analyticsRecord(document.overview);
      const resolved = analyticsNumber(overview.resolved) ?? 0;
      const created = analyticsNumber(overview.created) ?? 0;
      return outcome(
        answer,
        `Read the desk's analytics ${PERIOD_PHRASES[period]}: ${resolved} resolved, ${created} opened.`,
      );
    },
  },

  list_presets: {
    group: 'read',
    description:
      "The desk's quick tickets: the calls that repeat all day, written down once as a name, a title, an issue, a category, a priority and sometimes a room. Read this before editing, moving or deleting one, and before filing a call that sounds like one of them — a quick ticket is filed with create_ticket using its fields plus the requester and channel.",
    fields: {},
    run: async (_args, ctx) => {
      const presets = orderPresets(
        rows(await rpc(ctx, 'app_list_ticket_presets', {}))
          .map(presetFromRow)
          .filter((preset): preset is TicketPreset => preset !== null),
      );
      return outcome(
        presets,
        `Listed ${presets.length} quick ${presets.length === 1 ? 'ticket' : 'tickets'}.`,
      );
    },
  },

  export_people_csv: {
    group: 'read',
    directoryExport: true,
    description:
      'The directory as a spreadsheet, the same file the Export button on People makes: students or staff, optionally narrowed by a search, one row per person with their OSIS or staff id, class or department, email and, for students, guardian name and phone. This never hands over the file itself: it answers with how many rows the file will hold and the link to open, and the download is recorded in the history when the link is opened. Give the person the link.',
    fields: {
      kind: { type: 'string', required: true, description: 'Students or staff.', choices: PERSON_KINDS },
      query: { type: 'string', description: 'Narrows the list the way the search box does: a class, a department, a name.' },
    },
    run: async (args, ctx) => {
      const kind = String(args.kind);
      const query = String(args.query ?? '').trim();
      // One page, for the total in its envelope: the file itself is the
      // route's, and it walks every page when the link is opened.
      const page = await rpc(ctx, 'app_list_people', { p_kind: kind, p_query: query, p_page: 1 });
      const total = totalOf(page);
      const search = new URLSearchParams({ kind });
      if (query !== '') search.set('query', query);
      const link = `/people/export?${search.toString()}`;
      const noun = kind === 'staff' ? 'staff' : 'students';
      const capped = total > CSV_ROW_CAP;
      return outcome(
        {
          link,
          kind,
          query,
          rowCount: total,
          capped,
          note: 'Open the link to download the file. The export is recorded in the history when it is.',
        },
        `${total.toLocaleString('en-US')} ${noun}${query === '' ? '' : ` match "${query}"`}. Open ${link} to download the CSV.`,
      );
    },
  },

  export_devices_csv: {
    group: 'read',
    description:
      'The inventory as a spreadsheet, the same columns the Export button on Devices makes, optionally narrowed by a search or to the machines one person holds. This never hands over the file itself: it answers with the row count, the columns and a preview of up to 20 rows, and the full file is downloaded with the Export button on the Devices list.',
    fields: {
      query: { type: 'string', description: 'Asset tag, serial, model, room, status or holder name, as the list search takes it.' },
      person: { type: 'string', description: 'Only the machines this person is holding.' },
    },
    run: async (args, ctx) => {
      const person = args.person === undefined ? null : await resolvePerson(ctx, String(args.person));
      const query = String(args.query ?? '').trim();
      const page = await rpc(ctx, 'app_list_inventory', {
        p_query: query,
        p_page: 1,
        p_requester: person?.id ?? null,
      });
      const total = totalOf(page);
      const previewRows = pageRows(page).slice(0, EXPORT_PREVIEW_ROWS).map((row) =>
        deviceCsvRow(mapInventoryDevice(row as Parameters<typeof mapInventoryDevice>[0])),
      );
      const capped = total > CSV_ROW_CAP;
      const preview = toCsv(DEVICE_CSV_COLUMNS, previewRows);
      const note = 'Download the full file with the Export button on the Devices list.';
      const who = person === null ? '' : ` held by ${person.name}`;
      const what = query === '' ? '' : ` matching "${query}"`;
      return outcome(
        {
          filename: csvFileName('devices', schoolToday(), capped),
          rowCount: total,
          capped,
          columns: [...DEVICE_CSV_COLUMNS],
          preview,
          previewRows: previewRows.length,
          note,
        },
        `${total.toLocaleString('en-US')} ${total === 1 ? 'device' : 'devices'}${who}${what}. ${note}`,
      );
    },
  },

  export_group_csv: {
    group: 'read',
    description:
      "A group's roster, or one event's register, as a spreadsheet: the same files the Export buttons on the group's page make. The roster has one row per member with every checklist column; the register has one row per member with whether they were present and when they were marked. This never hands over the file itself: it answers with the link to open, and the export is recorded in the history when it is. Give the person the link.",
    fields: {
      group: { type: 'string', required: true, description: 'The group, by name or by id.' },
      event: { type: 'string', description: 'An event, by name or by id, for its register. Leave it out for the roster.' },
    },
    run: async (args, ctx) => {
      const group = await resolveGroup(ctx, String(args.group));
      if (args.event === undefined) {
        const link = `/groups/${group.id}/export`;
        return outcome(
          { link, group: group.name, rowCount: group.members },
          `${group.name}: ${group.members} ${group.members === 1 ? 'member' : 'members'}. Open ${link} to download the roster.`,
        );
      }
      const event = await resolveGroupEvent(ctx, group, String(args.event));
      const link = `/groups/${group.id}/events/${event.id}/export`;
      return outcome(
        { link, group: group.name, event: event.name, held_on: event.heldOn, rowCount: group.members },
        `${event.name} on ${event.heldOn}. Open ${link} to download the register.`,
      );
    },
  },

  list_invites: {
    group: 'read',
    adminOnly: true,
    description:
      'Every invite the helpdesk has sent: the address, the roles it grants, who sent it, when it expires, and whether it is pending, accepted, expired or revoked. Administrators only. Read this before revoking one.',
    fields: {
      state: {
        type: 'string',
        description: 'Only invites in this state. Leave it out for all of them.',
        choices: ['pending', 'accepted', 'expired', 'revoked'],
      },
    },
    run: async (args, ctx) => {
      const invites = rows(await rpc(ctx, 'app_admin_list_invites', {}))
        .filter((row) => args.state === undefined || textOf(row.state) === args.state)
        .map((row) => ({
          id: textOf(row.id),
          email: textOf(row.email),
          roles: Array.isArray(row.roles) ? row.roles.map(String) : [textOf(row.role)],
          name: textOf(row.display_name) || null,
          invitedBy: textOf(row.invited_by_name) || null,
          createdAt: textOf(row.created_at),
          expiresAt: textOf(row.expires_at),
          state: textOf(row.state),
        }));
      const which = args.state === undefined ? '' : ` ${String(args.state)}`;
      return outcome(invites, `Listed ${invites.length}${which} ${invites.length === 1 ? 'invite' : 'invites'}.`);
    },
  },

  list_access_requests: {
    group: 'read',
    adminOnly: true,
    description:
      'Who is waiting for an administrator to let them into the helpdesk: people who signed in with a Google address nobody invited. Name, address and when they asked, oldest first. Administrators only; review_access_request answers one.',
    fields: {},
    run: async (_args, ctx) => {
      const waiting = await waitingAccounts(ctx);
      return outcome(
        waiting.map((entry) => ({ id: entry.id, name: entry.name, email: entry.email, askedAt: entry.createdAt })),
        waiting.length === 0
          ? 'Nobody is waiting for access.'
          : `${waiting.length} ${waiting.length === 1 ? 'person is' : 'people are'} waiting for access.`,
      );
    },
  },

  // --- Write --------------------------------------------------------------

  create_ticket: {
    group: 'write',
    description:
      'Open a new ticket. Name the requester from the directory, or leave them out when there is nobody to name.',
    fields: {
      title: { type: 'string', required: true, description: 'A short summary of the problem.' },
      issue: { type: 'string', required: true, description: 'What the requester reported, in full.' },
      channel: { type: 'string', required: true, description: 'How the request arrived.', choices: CHANNELS },
      priority: { type: 'string', description: 'Default normal.', choices: PRIORITIES },
      category: { type: 'string', description: 'Default other.', choices: CATEGORIES },
      person: { type: 'string', description: 'The requester as a directory record: name, email, OSIS or staff id. Leave it out when nobody is named.' },
      location: { type: 'string', description: 'Room or area the problem is in.' },
      claim: { type: 'boolean', description: 'True to take ownership immediately instead of leaving it in the queue.' },
      submitted_on: {
        type: 'string',
        date: true,
        description: 'The school day it was reported, as YYYY-MM-DD, when that is not today. Administrators only; a NetRider\u2019s intake is always dated today.',
      },
      collaborators: {
        type: 'string[]',
        maxItems: 10,
        description: 'Colleagues to put on the ticket alongside the owner, by name or account id.',
      },
      devices: {
        type: 'string[]',
        maxItems: 10,
        description: 'Inventory machines the ticket is about, by asset tag, serial number or inventory id, linked at intake.',
      },
    },
    run: async (args, ctx) => {
      // The directory is the district's, so a requester is somebody already in
      // it or nobody at all. There is no inline "new requester" path, and the
      // database refuses one.
      const person = args.person === undefined ? null : await resolvePerson(ctx, String(args.person));
      const collaborators: string[] = [];
      for (const name of (args.collaborators as string[] | undefined) ?? []) {
        const account = await resolveAccount(ctx, name);
        if (!collaborators.includes(account.id)) collaborators.push(account.id);
      }
      const devices: string[] = [];
      for (const name of (args.devices as string[] | undefined) ?? []) {
        const device = await resolveDevice(ctx, name);
        if (!devices.includes(device.id)) devices.push(device.id);
      }
      const id = await rpc(ctx, 'app_create_ticket', {
        p_title: args.title,
        p_issue: args.issue,
        p_channel: args.channel,
        p_priority: args.priority ?? 'normal',
        // Left out rather than sent as null, so the function's own default
        // (today) applies exactly as it does for the form.
        ...(args.submitted_on === undefined ? {} : { p_submitted_on: args.submitted_on }),
        p_requester_id: person?.id ?? null,
        p_requester_unknown: person === null,
        p_location: args.location ?? null,
        p_owner_id: args.claim === true ? ctx.actor.id : null,
        p_collaborator_ids: collaborators,
        p_category: args.category ?? 'other',
        p_device_ids: devices,
      });
      const detail = await rpc(ctx, 'app_ticket_detail', { p_ticket: id });
      const ticket = isRecord(detail) && isRecord(detail.ticket) ? detail.ticket : {};
      const number = textOf(ticket.number) || 'the ticket';
      return outcome({ id, number }, `Opened ${number}: ${String(args.title)}`);
    },
  },

  import_resolved_tickets: {
    group: 'write',
    description:
      "Put the desk's old spreadsheet of already-finished jobs into the helpdesk, as many rows at a time as you were given (up to 50). Use it when somebody pastes a sheet or a table of past work — typically one row per call, with the date it came in, who rang and from where, what was wrong, who fixed it and the date it was closed. " +
      'Read the pasted rows yourself and map the columns onto these fields: the problem becomes title (short) and issue (the rest), the two dates become called_at and resolved_at, the room or area becomes location, and the person who reported it becomes requester. Convert every date to ISO before sending: a plain day is YYYY-MM-DD, which is read as that school day. If a column is ambiguous — two date columns with no headings, a name that could be the caller or the technician — ask ONCE, in one message, listing what you think each column is; otherwise do not ask, just send every row in one call. ' +
      'Leave requester out when the sheet names nobody the directory knows, and leave resolved_by out when the work was your own: naming a colleague is administrator-only. Each ticket lands resolved, owned by whoever fixed it, dated when it actually happened. The rows are written in order and the first one that fails stops the rest, so the answer says how many landed and which row stopped it. Sending rows again is safe: a row already in the helpdesk (same title, same two dates) is returned rather than duplicated, so after a stop, resend the whole sheet.',
    fields: {
      rows: {
        type: 'object[]',
        required: true,
        maxItems: IMPORT_ROW_LIMIT,
        description: `The rows of the sheet, in the order they were given. At most ${IMPORT_ROW_LIMIT} in one call; send a longer sheet in batches of ${IMPORT_ROW_LIMIT}.`,
        items: {
          title: {
            type: 'string',
            required: true,
            description: 'A short summary of the problem, 3 to 120 characters. Write one from the sheet if the sheet has no title column.',
          },
          issue: {
            type: 'string',
            description: 'What the sheet recorded about the problem, in full. Leave it out when the title is all there is.',
          },
          called_at: {
            type: 'string',
            required: true,
            instant: true,
            description: 'The day it came in, as YYYY-MM-DD, or a full ISO instant. Never later than resolved_at.',
          },
          resolved_at: {
            type: 'string',
            required: true,
            instant: true,
            description: 'The day it was closed, as YYYY-MM-DD, or a full ISO instant. Never in the future, and nothing older than three years.',
          },
          resolved_by: {
            type: 'string',
            description: "Who fixed it, by name or account id. Leave it out when it was the person you are working for; naming anybody else is administrator-only.",
          },
          requester: {
            type: 'string',
            description: 'Who reported it: name, OSIS, staff id or email, as the directory holds it. Leave it out when the sheet names nobody the directory knows — the ticket then records the requester as unknown.',
          },
          location: { type: 'string', description: 'Room or area the problem was in.' },
          category: { type: 'string', description: 'Default other.', choices: CATEGORIES },
          priority: { type: 'string', description: 'Default normal.', choices: PRIORITIES },
        },
      },
    },
    run: async (args, ctx) => {
      const sheet = args.rows as Record<string, unknown>[];

      /*
       * Everything that can be settled without the database is settled for
       * EVERY row first, and the whole call is refused if any of it is wrong.
       * A batch that stops halfway leaves tickets behind, so the checks that
       * cost nothing happen while nothing has happened yet.
       */
      for (const [index, row] of sheet.entries()) {
        const called = Date.parse(String(row.called_at));
        const resolved = Date.parse(String(row.resolved_at));
        if (resolved < called) {
          throw new ToolError(
            `Row ${index + 1} is resolved before it was called in. Check which date column is which.`,
          );
        }
      }

      /*
       * A sheet repeats names — the same teacher rings four times, one
       * technician fixed the lot — and each lookup is a round trip through the
       * directory. Resolving once per distinct name rather than once per row is
       * the difference between three calls and a hundred.
       */
      const people = new Map<string, PersonRef>();
      const colleagues = new Map<string, AccountRef>();

      const landed: string[] = [];
      for (const [index, row] of sheet.entries()) {
        try {
          const requester = row.requester === undefined ? null : String(row.requester);
          if (requester !== null && !people.has(requester)) {
            people.set(requester, await resolvePerson(ctx, requester));
          }
          const resolver = row.resolved_by === undefined ? null : String(row.resolved_by);
          if (resolver !== null && !colleagues.has(resolver)) {
            colleagues.set(resolver, await resolveAccount(ctx, resolver));
          }

          const id = await rpc(ctx, 'app_import_resolved_ticket', {
            p_title: row.title,
            p_issue: row.issue ?? null,
            p_called_at: row.called_at,
            p_resolved_at: row.resolved_at,
            p_resolved_by: resolver === null ? null : colleagues.get(resolver)?.id ?? null,
            p_requester_id: requester === null ? null : people.get(requester)?.id ?? null,
            p_location: row.location ?? null,
            p_category: row.category ?? null,
            p_priority: row.priority ?? null,
          });
          landed.push(String(id));
        } catch (error) {
          // The rows before this one are REAL tickets now. Saying so, with the
          // row that stopped it, is the only answer that lets somebody fix the
          // sheet and send the rest without importing anything twice.
          const message =
            error instanceof ToolError && error.message.trim() !== ''
              ? error.message
              : 'That row did not go through.';
          const done = landed.length;
          return {
            ok: false,
            result: {
              imported: done,
              rows_landed: landed.map((_, at) => at + 1),
              ticket_ids: landed,
              failed_row: index + 1,
              error: message,
              remaining: sheet.length - done,
            },
            summary:
              done === 0
                ? `Row 1 failed and nothing was imported: ${message}`
                : `Imported ${done} of ${sheet.length} rows, then row ${index + 1} failed: ${message}`,
          };
        }
      }

      // The numbers, for the sentence a person reads. Two reads rather than
      // fifty: the first and the last are what "EDT-1101 to EDT-1112" needs,
      // and a ticket that landed stays landed even if this read does not work.
      const first = await ticketNumberOf(ctx, landed[0]);
      const last = landed.length === 1 ? first : await ticketNumberOf(ctx, landed[landed.length - 1]);
      const range =
        first === '' ? '' : landed.length === 1 ? ` (${first})` : last === '' ? ` (from ${first})` : ` (${first} to ${last})`;
      return outcome(
        { imported: landed.length, ticket_ids: landed },
        `Imported ${landed.length} resolved ${landed.length === 1 ? 'ticket' : 'tickets'}${range}`,
      );
    },
  },

  claim_ticket: {
    group: 'write',
    description: 'Take ownership of an unclaimed ticket.',
    fields: { ticket: { type: 'string', required: true, description: 'Ticket number or id.' } },
    run: async (args, ctx) => {
      const ticket = await resolveTicket(ctx, String(args.ticket));
      await rpc(ctx, 'app_claim_ticket', { p_ticket: ticket.id });
      return outcome({ id: ticket.id }, `Claimed ${ticket.number}`);
    },
  },

  add_note: {
    group: 'write',
    description: 'Add a work note to a ticket. Notes are permanent and are attributed to this NetRider.',
    fields: {
      ticket: { type: 'string', required: true, description: 'Ticket number or id.' },
      body: { type: 'string', required: true, description: 'What to record.' },
    },
    run: async (args, ctx) => {
      const ticket = await resolveTicket(ctx, String(args.ticket));
      await rpc(ctx, 'app_add_note', { p_ticket: ticket.id, p_body: args.body });
      return outcome({ id: ticket.id }, `Added a note to ${ticket.number}`);
    },
  },

  set_priority: {
    group: 'write',
    description: 'Change a ticket’s priority.',
    fields: {
      ticket: { type: 'string', required: true, description: 'Ticket number or id.' },
      priority: { type: 'string', required: true, description: 'The new priority.', choices: PRIORITIES },
    },
    run: async (args, ctx) => {
      const ticket = await resolveTicket(ctx, String(args.ticket));
      await rpc(ctx, 'app_set_priority', { p_ticket: ticket.id, p_priority: args.priority });
      return outcome({ id: ticket.id }, `Set ${ticket.number} to ${String(args.priority)} priority`);
    },
  },

  set_category: {
    group: 'write',
    description: 'Change what kind of problem a ticket is.',
    fields: {
      ticket: { type: 'string', required: true, description: 'Ticket number or id.' },
      category: { type: 'string', required: true, description: 'The new category.', choices: CATEGORIES },
    },
    run: async (args, ctx) => {
      const ticket = await resolveTicket(ctx, String(args.ticket));
      await rpc(ctx, 'app_set_category', { p_ticket: ticket.id, p_category: args.category });
      return outcome({ id: ticket.id }, `Filed ${ticket.number} under ${label(String(args.category)).toLowerCase()}`);
    },
  },

  set_waiting: {
    group: 'write',
    description: 'Park a ticket while something outside the helpdesk is holding it up.',
    fields: {
      ticket: { type: 'string', required: true, description: 'Ticket number or id.' },
      reason: { type: 'string', required: true, description: 'What it is waiting for.' },
    },
    run: async (args, ctx) => {
      const ticket = await resolveTicket(ctx, String(args.ticket));
      await rpc(ctx, 'app_set_waiting', { p_ticket: ticket.id, p_reason: args.reason });
      return outcome({ id: ticket.id }, `Put ${ticket.number} on hold: ${String(args.reason)}`);
    },
  },

  resume_work: {
    group: 'write',
    description: 'Take a ticket off hold and put it back in progress.',
    fields: { ticket: { type: 'string', required: true, description: 'Ticket number or id.' } },
    run: async (args, ctx) => {
      const ticket = await resolveTicket(ctx, String(args.ticket));
      await rpc(ctx, 'app_resume_work', { p_ticket: ticket.id });
      return outcome({ id: ticket.id }, `Resumed work on ${ticket.number}`);
    },
  },

  resolve_ticket: {
    group: 'write',
    description: 'Close a ticket with the solution that fixed it.',
    fields: {
      ticket: { type: 'string', required: true, description: 'Ticket number or id.' },
      solution: { type: 'string', required: true, description: 'What fixed it.' },
    },
    run: async (args, ctx) => {
      const ticket = await resolveTicket(ctx, String(args.ticket));
      await rpc(ctx, 'app_resolve_ticket', { p_ticket: ticket.id, p_solution: args.solution });
      return outcome({ id: ticket.id }, `Resolved ${ticket.number}`);
    },
  },

  return_to_queue: {
    group: 'write',
    description: 'Give a ticket back to the open queue so somebody else can pick it up.',
    fields: { ticket: { type: 'string', required: true, description: 'Ticket number or id.' } },
    run: async (args, ctx) => {
      const ticket = await resolveTicket(ctx, String(args.ticket));
      await rpc(ctx, 'app_return_ticket_to_queue', { p_ticket: ticket.id });
      return outcome({ id: ticket.id }, `Returned ${ticket.number} to the open queue`);
    },
  },

  add_collaborator: {
    group: 'write',
    description: 'Bring a colleague onto a ticket so they can work on it too.',
    fields: {
      ticket: { type: 'string', required: true, description: 'Ticket number or id.' },
      colleague: { type: 'string', required: true, description: "The colleague's name or account id." },
    },
    run: async (args, ctx) => {
      const ticket = await resolveTicket(ctx, String(args.ticket));
      const account = await resolveAccount(ctx, String(args.colleague));
      await rpc(ctx, 'app_add_collaborator', { p_ticket: ticket.id, p_account: account.id });
      return outcome({ id: ticket.id }, `Added ${account.name} to ${ticket.number}`);
    },
  },

  join_ticket: {
    group: 'write',
    description:
      "Put yourself on a colleague's ticket as a collaborator when they ask for a hand. Works by ticket number even when the ticket is not in your lists yet. The owner is told, and the log records that you added yourself.",
    fields: {
      ticket: { type: 'string', required: true, description: 'Ticket number, such as EDT-1042.' },
    },
    run: async (args, ctx) => {
      const number = normaliseTicketNumber(String(args.ticket));
      if (number === null) throw new ToolError('Give a ticket number, such as EDT-1042.');
      const id = await rpc(ctx, 'app_join_ticket', { p_number: number });
      return outcome({ id: String(id) }, `Joined ${number}`);
    },
  },

  remove_collaborator: {
    group: 'write',
    description: 'Take a colleague off a ticket.',
    fields: {
      ticket: { type: 'string', required: true, description: 'Ticket number or id.' },
      colleague: { type: 'string', required: true, description: "The colleague's name or account id." },
    },
    run: async (args, ctx) => {
      const ticket = await resolveTicket(ctx, String(args.ticket));
      const account = await resolveAccount(ctx, String(args.colleague));
      await rpc(ctx, 'app_remove_collaborator', { p_ticket: ticket.id, p_account: account.id });
      return outcome({ id: ticket.id }, `Removed ${account.name} from ${ticket.number}`);
    },
  },

  log_work: {
    group: 'write',
    description: 'Record time spent on a ticket.',
    fields: {
      ticket: { type: 'string', required: true, description: 'Ticket number or id.' },
      minutes: { type: 'integer', required: true, description: 'Whole minutes spent.' },
      work_date: { type: 'string', description: 'The school day the work happened, as YYYY-MM-DD. Defaults to today.', date: true },
      description: { type: 'string', description: 'What the time went on.' },
    },
    run: async (args, ctx) => {
      const ticket = await resolveTicket(ctx, String(args.ticket));
      await rpc(ctx, 'app_log_work', {
        p_ticket: ticket.id,
        p_minutes: args.minutes,
        p_work_date: args.work_date ?? null,
        p_description: args.description ?? null,
      });
      return outcome({ id: ticket.id }, `Logged ${String(args.minutes)} minutes on ${ticket.number}`);
    },
  },

  record_device_observation: {
    group: 'write',
    description:
      'Record the machine a ticket is about when it is not in the inventory. For a machine that is, link it instead.',
    fields: {
      ticket: { type: 'string', required: true, description: 'Ticket number or id.' },
      device_type: { type: 'string', required: true, description: DEVICE_TYPE_HINT },
      model: { type: 'string', description: 'Model name.' },
      os_version: { type: 'string', description: 'Operating system and version.' },
      serial_number: { type: 'string', description: 'Serial number read off the machine.' },
      asset_tag: { type: 'string', description: 'Asset tag read off the machine.' },
      identifiers_not_applicable: { type: 'boolean', description: 'True when the machine carries no serial or tag.' },
    },
    run: async (args, ctx) => {
      const ticket = await resolveTicket(ctx, String(args.ticket));
      // The model writes whatever it heard; the vocabulary decides how it is
      // spelled, so a machine it called a "chromebook" is recorded and read
      // back as a Chromebook like every other one.
      const deviceType = deviceTypeLabel(String(args.device_type)) || String(args.device_type);
      await rpc(ctx, 'app_record_device', {
        p_ticket: ticket.id,
        p_device_type: deviceType,
        p_model: args.model ?? null,
        p_os_version: args.os_version ?? null,
        p_serial_number: args.serial_number ?? null,
        p_asset_tag: args.asset_tag ?? null,
        p_identifiers_not_applicable: args.identifiers_not_applicable ?? false,
      });
      return outcome({ id: ticket.id }, `Recorded a ${deviceType} on ${ticket.number}`);
    },
  },

  link_device_to_ticket: {
    group: 'write',
    description: 'Name an inventory machine on a ticket, so the ticket shows in that machine’s history.',
    fields: {
      ticket: { type: 'string', required: true, description: 'Ticket number or id.' },
      device: { type: 'string', required: true, description: 'Asset tag, serial number or inventory id.' },
    },
    run: async (args, ctx) => {
      const ticket = await resolveTicket(ctx, String(args.ticket));
      const device = await resolveDevice(ctx, String(args.device));
      await rpc(ctx, 'app_link_ticket_device', { p_ticket: ticket.id, p_device: device.id });
      return outcome({ id: ticket.id }, `Linked ${device.label} to ${ticket.number}`);
    },
  },

  attach_to_ticket: {
    group: 'write',
    description:
      'Put a picture the person sent you in THIS message onto a ticket, as a real attachment on the record. Pictures are not kept after the turn they arrive in, so this only works in the same message. It attaches what they sent; it cannot make a picture.',
    fields: {
      ticket: { type: 'string', required: true, description: 'Ticket number or id.' },
      picture: {
        type: 'string',
        description:
          'Which picture: its file name, or its position in the message as a number starting at 1. Leave it out when only one was sent.',
      },
    },
    run: async (args, ctx) => {
      if (ctx.attachments === undefined) {
        throw new ToolError('Files cannot be attached from here. Use the attachments panel on the ticket.');
      }

      const picture = resolvePicture(ctx, args.picture as string | undefined);
      // The bytes are read from the data URL rather than trusted: the same
      // reader the route uses on the way in, so the type and the size the
      // registry records are facts about the file.
      const read = readDataUrl(picture.dataUrl);
      if (read === null || !(ATTACHMENT_MIME_TYPES as readonly string[]).includes(read.mediaType)) {
        throw new ToolError('That picture is not a kind the helpdesk stores. Attach a JPEG, PNG, WebP, GIF or PDF.');
      }

      const ticket = await resolveTicket(ctx, String(args.ticket));
      const attached = await ctx.attachments.attach({
        actorId: ctx.actor.id,
        ticketId: ticket.id,
        filename: picture.name,
        mime: read.mediaType,
        base64: read.body,
      });
      if (!attached.ok) throw new ToolError(attached.error);

      return outcome(
        { id: attached.id, filename: attached.filename, ticket: ticket.number },
        `Attached ${attached.filename} (${formatBytes(attached.bytes)}) to ${ticket.number}`,
      );
    },
  },

  remove_attachment: {
    group: 'write',
    description:
      'Take a file off a ticket or a device. Only the person who attached it, or an administrator, may remove it, and the helpdesk decides which. Get the id from list_attachments.',
    fields: {
      attachment_id: { type: 'string', required: true, description: 'The id list_attachments gave for the file.' },
    },
    run: async (args, ctx) => {
      const id = String(args.attachment_id);
      if (!isUuid(id)) {
        throw new ToolError('That is not an attachment id. Read the files with list_attachments first.');
      }

      // The RPC runs in this person's own session and decides everything —
      // whether the file exists as far as they are concerned, whether the
      // ticket is closed, whether they uploaded it — and hands back the path.
      // Only then is the object removed, and only through the port, because the
      // bucket is unreachable from here.
      const path = await rpc(ctx, 'app_delete_attachment', { p_id: id });
      if (typeof path === 'string' && path !== '' && ctx.attachments !== undefined) {
        await ctx.attachments.removeObject(path);
      }
      return outcome({ id }, 'Removed the attachment');
    },
  },

  unlink_device_from_ticket: {
    group: 'write',
    description:
      'Take an inventory machine off a ticket. The machine and the ticket both stay; only the link between them goes.',
    fields: {
      ticket: { type: 'string', required: true, description: 'Ticket number or id.' },
      device: { type: 'string', required: true, description: 'Asset tag, serial number or inventory id.' },
    },
    run: async (args, ctx) => {
      const ticket = await resolveTicket(ctx, String(args.ticket));
      const device = await resolveDevice(ctx, String(args.device));
      await rpc(ctx, 'app_unlink_ticket_device', { p_ticket: ticket.id, p_device: device.id });
      return outcome({ id: ticket.id }, `Unlinked ${device.label} from ${ticket.number}`);
    },
  },

  mark_notifications_read: {
    group: 'write',
    description:
      "Mark this person's own notifications read. Name the ids from list_notifications, or say all to clear every unread one. Nobody else's notices are reachable.",
    fields: {
      notification_ids: {
        type: 'string[]',
        description: 'The ids list_notifications gave. Leave out when using all.',
      },
      all: { type: 'boolean', description: 'True to mark every unread notice read.' },
    },
    run: async (args, ctx) => {
      const ids = args.notification_ids as string[] | undefined;
      const everything = args.all === true;
      // Both is a contradiction and neither is a call with nothing in it. An
      // empty list is NOT read as "everything": that is the opposite of what
      // was asked for, and the screen refuses the same way.
      if (everything === (ids !== undefined)) {
        throw new ToolError('Name the notifications to mark read, or say all. Not both.');
      }

      const selected = everything ? null : (ids ?? []).filter(isUuid);
      if (selected !== null && selected.length === 0) {
        throw new ToolError('Those are not notification ids. Read them with list_notifications first.');
      }

      const marked = await rpc(ctx, 'app_mark_notifications_read', { p_ids: selected });
      const count = Number(marked ?? 0);
      return outcome(
        { marked: count },
        count === 0
          ? 'Nothing was unread.'
          : `Marked ${count} ${count === 1 ? 'notification' : 'notifications'} read`,
      );
    },
  },

  set_preference: {
    group: 'write',
    description:
      "Change one of this person's own settings. Their account only; there is no way to reach anybody else's. A theme change shows on the next page they open.",
    fields: {
      key: {
        type: 'string',
        required: true,
        description: 'Which setting to change.',
        choices: Object.keys(PREFERENCE_KEYS),
      },
      value: {
        type: 'string',
        required: true,
        description: `The new value. theme: ${THEME_CHOICES.join(', ')}. ai_reasoning: ${REASONING_CHOICES.join(', ')}. gmail_mode: to, cc or bcc (where a Gmail link puts the addresses; to is direct). ai_welcome_states: the effects the assistant's welcome may play, as a comma-separated list of ${WELCOME_EFFECT_HINT}; one is picked at random each time the panel opens, and the list replaces the old one, so include everything that should stay. assistant_notes: this person's own standing note to their assistant, the whole text, up to ${ASSISTANT_NOTES_MAX} characters; it replaces what was there, and the single word "clear" removes it. Everything else: true or false.`,
      },
    },
    run: async (args, ctx) => {
      const key = String(args.key) as PreferenceKey;
      const value = String(args.value);
      const patch: PreferencePatch = {};

      if (PREFERENCE_FLAGS.includes(key)) {
        // Three booleans, three vocabularies and one list, and every one of
        // them is checked by `preferencePatch` below — the same function the
        // settings screen uses, so both refuse in the same words.
        (patch as Record<string, boolean>)[PREFERENCE_KEYS[key]] = readFlag(key, value);
      } else if (key === 'ai_reasoning') {
        // Against what the interface OFFERS rather than what the column
        // accepts. `low` and `medium` are still valid stored values for rows
        // written before the levels were narrowed, and no screen offers either;
        // the assistant setting one would leave a settings page with a control
        // showing a level nobody can choose back.
        if (!(REASONING_CHOICES as readonly string[]).includes(value)) {
          throw new ToolError(`ai_reasoning is one of: ${REASONING_CHOICES.join(', ')}.`);
        }
        patch.aiReasoning = value as PreferencePatch['aiReasoning'];
      } else if (key === 'gmail_mode') {
        patch.gmailMode = value.trim().toLowerCase() as PreferencePatch['gmailMode'];
      } else if (key === 'ai_welcome_states') {
        patch.aiWelcomeStates = readWelcomeStates(value);
      } else if (key === 'assistant_notes') {
        // The note is pasted into every conversation this account has, so
        // it is cut where the settings box cuts it, and a word for "nothing"
        // takes it off: the checker reads an empty value as "not given".
        const cleared = CLEAR_WORDS.includes(value.trim().toLowerCase());
        if (!cleared && value.trim().length > ASSISTANT_NOTES_MAX) {
          throw new ToolError(`A note for the assistant is ${ASSISTANT_NOTES_MAX} characters at most.`);
        }
        patch.assistantNotes = cleared ? '' : value;
      } else {
        patch.theme = value as PreferencePatch['theme'];
      }

      const narrowed = preferencePatch(patch);
      if (!narrowed.ok) throw new ToolError(narrowed.error);

      await rpc(ctx, 'app_update_preferences', { p_patch: narrowed.patch });
      if (key === 'assistant_notes') {
        return outcome(
          { key, cleared: patch.assistantNotes === '' },
          patch.assistantNotes === '' ? 'Cleared your notes for the assistant' : 'Saved your notes for the assistant',
        );
      }
      return outcome({ key, value }, `Set your ${key.replace(/_/g, ' ')} to ${value}`);
    },
  },

  save_view: {
    group: 'write',
    description:
      'Name the filters on a list so one press puts them back. The address is an in-app path such as /queue, /all-tickets or /devices, and the query is the filter string without its leading question mark. Saved on this person’s own account.',
    fields: {
      name: { type: 'string', required: true, description: 'What to call it, such as "Room 214".' },
      path: { type: 'string', required: true, description: 'The list it belongs to: /queue, /all-tickets or /devices.' },
      query: {
        type: 'string',
        description: 'The filters, as a query string without the "?". Leave it out for the whole list, unfiltered.',
      },
    },
    run: async (args, ctx) => {
      const name = String(args.name).trim();
      const path = String(args.path).trim();
      const query = normaliseQuery(String(args.query ?? ''));

      // A view is a link, and this is the one field that becomes one. `//evil`
      // is a protocol-relative URL and every browser reads `/\evil` as the same
      // thing, so both spellings are refused here as well as by the RPC and by
      // the reader that renders the chip.
      if (!/^\/(?![/\\])/.test(path)) {
        throw new ToolError('A saved view points at a page in the helpdesk, such as /queue or /devices.');
      }

      const views = await currentSavedViews(ctx);
      const problem = savedViewError(name, views, path, query);
      if (problem !== null) throw new ToolError(problem);

      const view: SavedView = { id: globalThis.crypto.randomUUID(), name, path, query };
      await rpc(ctx, 'app_set_saved_views', { p_views: addSavedView(views, view) });
      return outcome({ name, path, query }, `Saved the view "${name}"`);
    },
  },

  delete_view: {
    group: 'write',
    description: "Remove one of this person's saved views by name.",
    fields: {
      name: { type: 'string', required: true, description: 'The name of the view to remove.' },
    },
    run: async (args, ctx) => {
      const name = String(args.name).trim();
      const views = await currentSavedViews(ctx);
      const folded = name.toLowerCase();
      const matches = views.filter((view) => view.name.toLowerCase() === folded);
      if (matches.length === 0) {
        const known = views.map((view) => view.name).join(', ');
        throw new ToolError(
          views.length === 0
            ? 'There are no saved views on this account.'
            : `No saved view is called "${name}". There is: ${known}.`,
        );
      }
      // Two views may share a name — `addSavedView` de-duplicates on the
      // filters, not on what somebody called them — and removing the wrong one
      // is not something the person can see happening.
      if (matches.length > 1) {
        throw new ToolError(`More than one saved view is called "${name}". Remove it on the list itself.`);
      }

      await rpc(ctx, 'app_set_saved_views', { p_views: removeSavedView(views, matches[0].id) });
      return outcome({ name: matches[0].name }, `Removed the view "${matches[0].name}"`);
    },
  },

  create_person: {
    group: 'write',
    description: 'Add somebody to the directory.',
    fields: {
      kind: { type: 'string', required: true, description: 'Student or staff.', choices: PERSON_KINDS },
      ...PERSON_FIELDS,
    },
    run: async (args, ctx) => {
      const data = {
        kind: args.kind,
        ...toJsonKeys(pick(args, Object.keys(PERSON_FIELDS)), PERSON_JSON_KEYS),
      };
      const id = await rpc(ctx, 'app_save_person', { p_id: null, p_version: null, p_data: data });
      const name = textOf(args.display_name) || `${textOf(args.first_name)} ${textOf(args.last_name)}`.trim();
      return outcome({ id }, `Added ${name || 'a new directory record'}`);
    },
  },

  update_person: {
    group: 'write',
    description: 'Change a directory record. Only the fields you send are changed; a student does not become staff.',
    fields: {
      person: { type: 'string', required: true, description: 'Name, email, OSIS, staff id or record id.' },
      ...PERSON_FIELDS,
    },
    run: async (args, ctx) => {
      const person = await resolvePerson(ctx, String(args.person));
      const patch = toJsonKeys(pick(args, Object.keys(PERSON_FIELDS)), PERSON_JSON_KEYS);
      if (Object.keys(patch).length === 0) throw new ToolError('Say what to change about that person.');

      // app_save_person states the whole record, so the current one is read
      // first and the patch laid over it. The version goes back with it, so an
      // edit somebody else has already made is refused rather than lost.
      const current = await rpc(ctx, 'app_get_person', { p_id: person.id });
      if (!isRecord(current)) throw new ToolError('There is no directory record with that id.');
      await rpc(ctx, 'app_save_person', {
        p_id: person.id,
        p_version: Number(current.version ?? 1),
        p_data: { ...current, ...patch },
      });
      return outcome({ id: person.id }, `Updated ${person.name}`);
    },
  },

  archive_person: {
    group: 'write',
    description:
      'Record that somebody has left the school, or that they have not after all. Their tickets, machines and history stay exactly where they are; a machine still assigned to them shows on Today as due back. Use this rather than trying to delete a record.',
    fields: {
      person: { type: 'string', required: true, description: 'Name, email, OSIS, staff id or record id.' },
      archived: {
        type: 'boolean',
        required: true,
        description: 'True when they have left. False to undo it.',
      },
    },
    run: async (args, ctx) => {
      const person = await resolvePerson(ctx, String(args.person));
      const archived = args.archived === true;

      /*
       * A separate tool rather than a field on update_person, because the two
       * halves of the contract are different shapes. `app_get_person` reads
       * back `archivedAt` — a timestamp, or null — and `app_save_person` takes
       * `archived`, a boolean, and stamps the moment itself. Nobody types when
       * somebody left. Putting a boolean called `archived` in the same table as
       * the fifteen text fields, next to a read that answers `archivedAt`,
       * would be the confusing way to say a simple thing.
       *
       * The current record goes back with it because the save states the whole
       * record, and the version with it, so an edit somebody else has already
       * made is refused rather than lost.
       */
      const current = await rpc(ctx, 'app_get_person', { p_id: person.id });
      if (!isRecord(current)) throw new ToolError('There is no directory record with that id.');
      await rpc(ctx, 'app_save_person', {
        p_id: person.id,
        p_version: Number(current.version ?? 1),
        p_data: { ...current, archived },
      });

      return outcome(
        { id: person.id, archived },
        archived ? `Recorded that ${person.name} has left` : `${person.name} is no longer archived`,
      );
    },
  },

  create_group: {
    group: 'write',
    description:
      'Start a group: a named list of people from the directory, such as "SkillsUSA members", "Officers" or "Chromebook cart 3". It starts empty; add_to_group puts people in it. A group with that name already existing is refused rather than duplicated.',
    fields: {
      name: {
        type: 'string',
        required: true,
        maxLength: 80,
        description: 'What the group is called. At most 80 characters, and unique.',
      },
      description: {
        type: 'string',
        maxLength: 300,
        description: 'One line saying what it is for.',
      },
    },
    run: async (args, ctx) => {
      const id = await rpc(ctx, 'app_create_group', {
        p_name: args.name,
        p_description: args.description ?? '',
      });
      return outcome({ id }, `Started the group ${String(args.name)}`);
    },
  },

  add_to_group: {
    group: 'write',
    description:
      'Add people to a group, a whole list at a time. Each entry is an OSIS number, a staff id, a school email address or a full name as the directory spells it, exactly as find_people takes them — so a class list pasted out of a spreadsheet goes in as it is. Reports how many were added, how many were already in the group, how many matched nobody and how many matched more than one person; the last two are named so somebody can fix them. Adding somebody who is already in the group is not an error.',
    fields: {
      group: { type: 'string', required: true, description: 'The group, by name or by id.' },
      people: {
        type: 'string[]',
        required: true,
        maxItems: FIND_PEOPLE_LIMIT,
        description:
          'The people to add, one per entry: OSIS number, staff id, school email address or full name.',
      },
    },
    run: async (args, ctx) => {
      const group = await resolveGroup(ctx, String(args.group));
      const keys = args.people as string[];

      // The same reader the paste box on the group's page uses, so the
      // assistant and the screen agree about what a line means.
      const found = rows(await rpc(ctx, 'app_find_people', { p_keys: keys }));
      const matched: string[] = [];
      const unmatched: string[] = [];
      const ambiguous: string[] = [];
      for (const row of found) {
        const key = textOf(row.key);
        if (textOf(row.found) === 'match') matched.push(textOf(row.id));
        else if (Number(row.matches ?? 0) > 1) ambiguous.push(key);
        else unmatched.push(key);
      }

      if (matched.length === 0) {
        throw new ToolError(
          `None of those ${keys.length} entries is somebody in the directory. Nobody was added.`,
        );
      }

      // What the database wrote, which is the people who were not already in
      // it. Anything else would be a number that sounds like work happened.
      const added = Number(
        await rpc(ctx, 'app_add_group_members', { p_group: group.id, p_requesters: matched }),
      );
      const skipped = matched.length - added;
      const parts = [`${added} added`];
      if (skipped > 0) parts.push(`${skipped} already in it`);
      if (unmatched.length > 0) parts.push(`${unmatched.length} not found`);
      if (ambiguous.length > 0) parts.push(`${ambiguous.length} ambiguous`);

      return outcome(
        { added, skipped, unmatched, ambiguous },
        `${group.name}: ${parts.join(', ')}.`,
      );
    },
  },

  remove_from_group: {
    group: 'write',
    description:
      'Take one person out of a group. They stay in the directory and keep everything else; only the membership goes.',
    fields: {
      group: { type: 'string', required: true, description: 'The group, by name or by id.' },
      person: { type: 'string', required: true, description: 'Name, email, OSIS, staff id or record id.' },
    },
    run: async (args, ctx) => {
      const group = await resolveGroup(ctx, String(args.group));
      const person = await resolvePerson(ctx, String(args.person));
      await rpc(ctx, 'app_remove_group_member', { p_group: group.id, p_requester: person.id });
      return outcome({ id: person.id }, `Took ${person.name} out of ${group.name}`);
    },
  },

  mark_attendance: {
    group: 'write',
    description:
      'Mark people present at one event, a list at a time — or, with present false, take a mark back for people who were marked by mistake. Each entry is an OSIS number, a staff id, an email address or a full name, resolved exactly as add_to_group resolves one. Reports how many were marked, how many were already marked, how many are not in the group, and which entries matched nobody or more than one person. Nobody outside the group is ever marked.',
    fields: {
      group: { type: 'string', required: true, description: 'The group, by name or by id.' },
      event: { type: 'string', required: true, description: 'The event, by name or by id.' },
      people: {
        type: 'string[]',
        required: true,
        maxItems: FIND_PEOPLE_LIMIT,
        description:
          'The people who were there, one per entry: OSIS number, staff id, school email address or full name.',
      },
      present: {
        type: 'boolean',
        description: 'Default true. False takes the mark back for everybody listed, which is how a wrong tick is undone.',
      },
    },
    run: async (args, ctx) => {
      const group = await resolveGroup(ctx, String(args.group));
      const event = await resolveGroupEvent(ctx, group, String(args.event));
      const keys = args.people as string[];

      const found = rows(await rpc(ctx, 'app_find_people', { p_keys: keys }));
      const matched: string[] = [];
      const unmatched: string[] = [];
      const ambiguous: string[] = [];
      for (const row of found) {
        const key = textOf(row.key);
        if (textOf(row.found) === 'match') matched.push(textOf(row.id));
        else if (Number(row.matches ?? 0) > 1) ambiguous.push(key);
        else unmatched.push(key);
      }

      if (matched.length === 0) {
        throw new ToolError(
          `None of those ${keys.length} entries is somebody in the directory. Nobody was marked.`,
        );
      }

      if (args.present === false) {
        /*
         * Unmarking has no batch function: the screen unticks one box at a
         * time through app_mark_attendance, and so does this. A person who is
         * not in the group is refused by the function, by name, and counted
         * here rather than stopping the rest.
         */
        let unmarked = 0;
        let outside = 0;
        for (const id of matched) {
          try {
            await rpc(ctx, 'app_mark_attendance', { p_event: event.id, p_requester: id, p_present: false });
            unmarked += 1;
          } catch (error) {
            if (error instanceof ToolError && /not in/.test(error.message)) outside += 1;
            else throw error;
          }
        }
        const parts = [`${unmarked} unmarked`];
        if (outside > 0) parts.push(`${outside} not in the group`);
        parts.push(...lookupTail(unmatched, ambiguous));
        return outcome(
          { unmarked, not_member: outside, unmatched, ambiguous },
          `${event.name} on ${event.heldOn}: ${parts.join(', ')}.`,
        );
      }

      const answers = rows(
        await rpc(ctx, 'app_mark_attendance_many', { p_event: event.id, p_requesters: matched }),
      );
      const counted = (name: string) =>
        answers.filter((row) => textOf(row.outcome) === name).length;
      const marked = counted('present');
      const already = counted('already');
      const outside = counted('not_member');

      const parts = [`${marked} marked`];
      if (already > 0) parts.push(`${already} already`);
      if (outside > 0) parts.push(`${outside} not in the group`);
      if (unmatched.length > 0) parts.push(`${unmatched.length} not found`);
      if (ambiguous.length > 0) parts.push(`${ambiguous.length} ambiguous`);

      return outcome(
        { marked, already, not_member: outside, unmatched, ambiguous },
        `${event.name} on ${event.heldOn}: ${parts.join(', ')}.`,
      );
    },
  },

  set_checklist_mark: {
    group: 'write',
    description:
      'Tick or untick one member against one of a group\'s checklist columns — "Dues", "Permission slip". Refuses somebody who is not in the group.',
    fields: {
      group: { type: 'string', required: true, description: 'The group, by name or by id.' },
      column: { type: 'string', required: true, description: 'The checklist column, by name or by id.' },
      person: { type: 'string', required: true, description: 'Name, email, OSIS, staff id or record id.' },
      checked: {
        type: 'boolean',
        required: true,
        description: 'True to tick it, false to take the tick back.',
      },
    },
    run: async (args, ctx) => {
      const group = await resolveGroup(ctx, String(args.group));
      const field = await resolveGroupField(ctx, group, String(args.column));
      const person = await resolvePerson(ctx, String(args.person));
      const checked = args.checked === true;

      await rpc(ctx, 'app_set_group_mark', {
        p_field: field.id,
        p_requester: person.id,
        p_checked: checked,
      });

      return outcome(
        { id: person.id, checked },
        checked
          ? `Ticked ${person.name} for ${field.name}`
          : `Took ${person.name}'s ${field.name} tick back`,
      );
    },
  },

  create_device: {
    group: 'write',
    description: 'Add a machine to the inventory.',
    fields: { ...DEVICE_FIELDS },
    run: async (args, ctx) => {
      const data = toJsonKeys(pick(args, Object.keys(DEVICE_FIELDS)), DEVICE_JSON_KEYS);
      if (Object.keys(data).length === 0) {
        throw new ToolError('Give at least the type, manufacturer, model and serial number.');
      }
      const id = await rpc(ctx, 'app_save_inventory_device', {
        p_id: null,
        p_version: null,
        p_data: data,
      });
      const name = textOf(args.asset_tag) || textOf(args.serial_number);
      return outcome({ id }, `Added ${name || 'a new device'} to the inventory`);
    },
  },

  update_device: {
    group: 'write',
    description: 'Change an inventory record. Only the fields you send are changed.',
    fields: {
      device: { type: 'string', required: true, description: 'Asset tag, serial number, inventory id or record id.' },
      ...DEVICE_FIELDS,
    },
    run: async (args, ctx) => {
      const device = await resolveDevice(ctx, String(args.device));
      const patch = toJsonKeys(pick(args, Object.keys(DEVICE_FIELDS)), DEVICE_JSON_KEYS);
      if (Object.keys(patch).length === 0) throw new ToolError('Say what to change about that device.');

      const current = await rpc(ctx, 'app_get_inventory_device', { p_id: device.id });
      if (!isRecord(current)) throw new ToolError('There is no device with that id.');
      await rpc(ctx, 'app_save_inventory_device', {
        p_id: device.id,
        p_version: Number(current.version ?? 1),
        p_data: { ...current, ...patch },
      });
      return outcome({ id: device.id }, `Updated ${device.label}`);
    },
  },

  assign_device: {
    group: 'write',
    description: 'Hand a machine out to somebody. This also marks it Assigned.',
    fields: {
      device: { type: 'string', required: true, description: 'Asset tag, serial number or inventory id.' },
      person: { type: 'string', required: true, description: 'Name, email, OSIS or staff id of whoever takes it.' },
      note: { type: 'string', description: 'Anything to record about the loan.' },
    },
    run: async (args, ctx) => {
      const device = await resolveDevice(ctx, String(args.device));
      const person = await resolvePerson(ctx, String(args.person));
      await rpc(ctx, 'app_assign_inventory_device', {
        p_device: device.id,
        p_requester: person.id,
        p_note: args.note ?? null,
      });
      return outcome({ id: device.id }, `Assigned ${device.label} to ${person.name}`);
    },
  },

  return_device: {
    group: 'write',
    description: 'Take a machine back from whoever holds it.',
    fields: {
      device: { type: 'string', required: true, description: 'Asset tag, serial number or inventory id.' },
      status: { type: 'string', description: `What state it came back in. Default Available; usually one of ${SEEDED_STATUSES}.` },
      note: { type: 'string', description: 'Anything to record about the return.' },
    },
    run: async (args, ctx) => {
      const device = await resolveDevice(ctx, String(args.device));
      const status = String(args.status ?? 'Available');
      await rpc(ctx, 'app_return_inventory_device', {
        p_device: device.id,
        p_status: status,
        p_note: args.note ?? null,
      });
      return outcome({ id: device.id }, `Took ${device.label} back as ${status.toLowerCase()}`);
    },
  },

  set_device_status: {
    group: 'write',
    description: `Change where a machine is in its life. Free text, usually one of ${SEEDED_STATUSES}.`,
    fields: {
      device: { type: 'string', required: true, description: 'Asset tag, serial number or inventory id.' },
      status: { type: 'string', required: true, description: 'The new status.' },
    },
    run: async (args, ctx) => {
      const device = await resolveDevice(ctx, String(args.device));
      await rpc(ctx, 'app_bulk_update_inventory', {
        p_ids: [device.id],
        p_patch: { status: args.status },
      });
      return outcome({ id: device.id }, `Marked ${device.label} ${String(args.status).toLowerCase()}`);
    },
  },

  move_device: {
    group: 'write',
    description: 'Record that a machine now lives somewhere else.',
    fields: {
      device: { type: 'string', required: true, description: 'Asset tag, serial number or inventory id.' },
      location: { type: 'string', required: true, description: 'The room or store it moved to.' },
    },
    run: async (args, ctx) => {
      const device = await resolveDevice(ctx, String(args.device));
      await rpc(ctx, 'app_bulk_update_inventory', {
        p_ids: [device.id],
        p_patch: { location: args.location },
      });
      return outcome({ id: device.id }, `Moved ${device.label} to ${String(args.location)}`);
    },
  },

  bulk_update_devices: {
    group: 'write',
    description:
      'Change the status, location or notes of up to 200 machines at once. Handing machines out is one at a time, with assign_device.',
    fields: {
      device_ids: {
        type: 'string[]',
        required: true,
        description: 'Asset tags, serial numbers or inventory ids of the machines to change.',
      },
      status: { type: 'string', description: `Set every one to this status. Usually one of ${SEEDED_STATUSES}.` },
      location: { type: 'string', description: 'Move every one here.' },
      notes: { type: 'string', description: 'Rewrite the notes on every one.' },
    },
    run: async (args, ctx) => {
      const names = args.device_ids as string[];
      if (names.length > 200) throw new ToolError('Change 200 devices or fewer at a time.');

      const resolved: DeviceRef[] = [];
      for (const name of names) resolved.push(await resolveDevice(ctx, name));

      const patch: Record<string, unknown> = {};
      if (args.status !== undefined) patch.status = args.status;
      if (args.location !== undefined) patch.location = args.location;
      if (args.notes !== undefined) patch.notes = args.notes;
      if (Object.keys(patch).length === 0) throw new ToolError('Say what to change for those devices.');

      const changed = await rpc(ctx, 'app_bulk_update_inventory', {
        p_ids: resolved.map((device) => device.id),
        p_patch: patch,
      });
      return outcome({ changed }, `Changed ${Number(changed ?? 0)} of ${resolved.length} devices`);
    },
  },

  create_tickets: {
    group: 'write',
    description:
      'Open several tickets in one call, from a list somebody handed over: a spreadsheet, a CSV, a screenshot of one, a message naming five broken machines. Each row takes exactly what create_ticket takes. Read the rows yourself and map the columns onto the fields; if a column is ambiguous, ask ONCE, in one message, and otherwise send every row in one call rather than one call per row. Every row is tried: a row the helpdesk refuses is named with its reason and the rest still land, so the answer says how many were opened, their numbers, and which rows were refused and why. Up to 50 rows; send a longer sheet in batches.',
    fields: {
      rows: {
        type: 'object[]',
        required: true,
        maxItems: IMPORT_ROW_LIMIT,
        description: `The tickets to open, one per row, in the order given. At most ${IMPORT_ROW_LIMIT} in one call.`,
        items: {
          title: { type: 'string', required: true, description: 'A short summary of the problem, 3 to 120 characters.' },
          issue: { type: 'string', required: true, description: 'What was reported, in full.' },
          channel: { type: 'string', required: true, description: 'How the request arrived.', choices: CHANNELS },
          priority: { type: 'string', description: 'Default normal.', choices: PRIORITIES },
          category: { type: 'string', description: 'Default other.', choices: CATEGORIES },
          person: { type: 'string', description: 'The requester as a directory record: name, email, OSIS or staff id. Leave it out when nobody is named.' },
          location: { type: 'string', description: 'Room or area the problem is in.' },
          claim: { type: 'boolean', description: 'True to take ownership of this one immediately.' },
        },
      },
    },
    run: async (args, ctx) => {
      const sheet = args.rows as Record<string, unknown>[];

      // A sheet repeats names, and each lookup is a round trip: once per
      // distinct name, and a name that will not resolve refuses only its row.
      const people = new Map<string, PersonRef | ToolError>();
      const opened: { row: number; id: string; number: string; title: string }[] = [];
      const refused: { row: number; title: string; error: string }[] = [];

      for (const [index, row] of sheet.entries()) {
        const title = String(row.title);
        try {
          const requester = row.person === undefined ? null : String(row.person);
          let person: PersonRef | null = null;
          if (requester !== null) {
            if (!people.has(requester)) {
              try {
                people.set(requester, await resolvePerson(ctx, requester));
              } catch (error) {
                if (!(error instanceof ToolError)) throw error;
                people.set(requester, error);
              }
            }
            const found = people.get(requester);
            if (found instanceof ToolError) throw found;
            person = found ?? null;
          }
          const id = String(
            await rpc(ctx, 'app_create_ticket', {
              p_title: title,
              p_issue: row.issue,
              p_channel: row.channel,
              p_priority: row.priority ?? 'normal',
              p_requester_id: person?.id ?? null,
              p_requester_unknown: person === null,
              p_location: row.location ?? null,
              p_owner_id: row.claim === true ? ctx.actor.id : null,
              p_category: row.category ?? 'other',
            }),
          );
          opened.push({ row: index + 1, id, number: await ticketNumberOf(ctx, id), title });
        } catch (error) {
          // Unlike a sheet of history, a list of new calls has no order that
          // matters: the rest are tried, and this one is named with why.
          const message =
            error instanceof ToolError && error.message.trim() !== ''
              ? error.message
              : 'That row did not go through.';
          refused.push({ row: index + 1, title, error: message });
        }
      }

      const numbers = opened.map((entry) => entry.number).filter((number) => number !== '');
      const range =
        numbers.length === 0
          ? ''
          : numbers.length === 1
            ? ` (${numbers[0]})`
            : ` (${numbers[0]} to ${numbers[numbers.length - 1]})`;
      const refusedLine =
        refused.length === 0
          ? ''
          : `; ${refused.length} refused: ${refused
              .slice(0, 3)
              .map((entry) => `row ${entry.row} ${unstopped(entry.error)}`)
              .join('; ')}${refused.length > 3 ? '; and more' : ''}`;
      return {
        ok: opened.length > 0,
        result: { opened: opened.length, refused: refused.length, tickets: opened, refusals: refused },
        summary:
          opened.length === 0
            ? `Nothing was opened${refusedLine}.`
            : `Opened ${opened.length} of ${sheet.length} ${sheet.length === 1 ? 'ticket' : 'tickets'}${range}${refusedLine}.`,
      };
    },
  },

  claim_tickets: {
    group: 'write',
    description:
      'Take ownership of several unclaimed tickets at once — the five reports of one dead projector, everything in a room. Claimed in the order given; the first one that cannot be claimed stops the rest, and the answer says how many were claimed before it. Up to 50.',
    fields: {
      tickets: {
        type: 'string[]',
        required: true,
        maxItems: IMPORT_ROW_LIMIT,
        description: 'Ticket numbers such as EDT-1042, or ids.',
      },
    },
    run: async (args, ctx) => {
      const names = args.tickets as string[];
      const tickets: TicketRef[] = [];
      for (const name of names) {
        const ticket = await resolveTicket(ctx, name);
        if (!tickets.some((entry) => entry.id === ticket.id)) tickets.push(ticket);
      }

      // Sequential, as the grouped row on Today is: the function takes a lock,
      // and a failure halfway through is a sentence rather than a guess.
      const claimed: string[] = [];
      for (const ticket of tickets) {
        try {
          await rpc(ctx, 'app_claim_ticket', { p_ticket: ticket.id });
          claimed.push(ticket.number);
        } catch (error) {
          const message =
            error instanceof ToolError && error.message.trim() !== ''
              ? error.message
              : 'That one did not go through.';
          return {
            ok: false,
            result: { claimed: claimed.length, numbers: claimed, stopped_at: ticket.number, error: message },
            summary:
              claimed.length === 0
                ? `${ticket.number} could not be claimed and nothing was: ${message}`
                : `Claimed ${claimed.length} of ${tickets.length} (${claimed.join(', ')}), then ${ticket.number} could not be: ${message}`,
          };
        }
      }
      return outcome(
        { claimed: claimed.length, numbers: claimed },
        `Claimed ${claimed.length} ${claimed.length === 1 ? 'ticket' : 'tickets'}: ${claimed.join(', ')}`,
      );
    },
  },

  set_display_name: {
    group: 'write',
    description:
      "Change the name this person is shown as, on tickets, notes and every history entry: the Display name box on Settings. Their own account only. Between 2 and 80 characters.",
    fields: {
      name: { type: 'string', required: true, maxLength: 80, description: 'The name to show.' },
    },
    run: async (args, ctx) => {
      const name = String(args.name).trim();
      const problem = displayNameError(name);
      if (problem !== null) throw new ToolError(problem);
      await rpc(ctx, 'app_update_display_name', { p_name: name });
      return outcome({ name }, `Changed your display name to ${name}`);
    },
  },

  update_shared_notes: {
    group: 'write',
    description:
      "Rewrite the school's shared notes for the assistant: the one box on Settings that everybody on the team reads and everybody may edit — what the desk is, room names, the rules of the house. The whole text replaces what was there, so read the current notes back to the person first when they ask for an addition rather than a rewrite. Up to 600 characters; leave the text out to clear it.",
    fields: {
      notes: {
        type: 'string',
        maxLength: ASSISTANT_NOTES_MAX,
        description: 'The new shared notes, whole. Leave it out to clear them.',
      },
    },
    run: async (args, ctx) => {
      const body = String(args.notes ?? '').trim();
      await rpc(ctx, 'app_set_assistant_notes_shared', { p_body: body });
      return outcome(
        { cleared: body === '', length: body.length },
        body === '' ? 'Cleared the shared notes' : `Saved the shared notes (${body.length} characters)`,
      );
    },
  },

  save_preset: {
    group: 'write',
    description:
      "Add a quick ticket, or change one: the desk's shared list on Settings → Quick tickets. To add one, give a name and a title at least; to change one, name it in preset and send only the fields that change. The requester and the channel are never part of a quick ticket. At most twelve.",
    fields: {
      preset: { type: 'string', description: 'An existing quick ticket to change, by name or id. Leave it out to add a new one.' },
      name: { type: 'string', maxLength: 40, description: 'What the desk calls it, such as "Projector". Required for a new one; 40 characters at most.' },
      title: { type: 'string', maxLength: 120, description: 'The title the ticket gets in the queue. Required for a new one; 120 at most.' },
      issue: { type: 'string', maxLength: 2000, description: 'The issue text the ticket starts with.' },
      category: { type: 'string', description: 'Default other for a new one.', choices: CATEGORIES },
      priority: { type: 'string', description: 'Default normal for a new one.', choices: PRIORITIES },
      location: { type: 'string', maxLength: 80, description: 'A room, when the call is always from the same one.' },
    },
    run: async (args, ctx) => {
      const existing = args.preset === undefined ? null : await resolvePreset(ctx, String(args.preset));
      if (existing === null) {
        // The database refuses a thirteenth too; this is the same sentence
        // before the round trip.
        const count = countOf(await rpc(ctx, 'app_list_ticket_presets', {}));
        if (count >= TICKET_PRESET_CAP) {
          throw new ToolError(
            `The desk already has ${TICKET_PRESET_CAP} quick tickets. Delete one before adding another.`,
          );
        }
      }
      const draft = {
        name: String(args.name ?? existing?.name ?? ''),
        title: String(args.title ?? existing?.title ?? ''),
        issue: String(args.issue ?? existing?.issue ?? ''),
        category: String(args.category ?? existing?.category ?? 'other') as TicketPreset['category'],
        priority: String(args.priority ?? existing?.priority ?? 'normal') as TicketPreset['priority'],
        location: String(args.location ?? existing?.location ?? ''),
      };
      if (existing !== null && Object.keys(pick(args, ['name', 'title', 'issue', 'category', 'priority', 'location'])).length === 0) {
        throw new ToolError(`Say what to change about the quick ticket ${existing.name}.`);
      }
      // The same rules the settings form applies, so a refusal is one
      // sentence here rather than a round trip.
      const problem = presetError(draft);
      if (problem !== null) throw new ToolError(problem);

      const saved = await rpc(ctx, 'app_save_ticket_preset', {
        p_id: existing?.id ?? null,
        p_name: draft.name.trim(),
        p_title: draft.title.trim(),
        p_issue: draft.issue.trim(),
        p_category: draft.category,
        p_priority: draft.priority,
        p_location: draft.location.trim(),
        p_position: existing?.position ?? null,
      });
      const id = isRecord(saved) ? textOf(saved.id) : existing?.id ?? '';
      return outcome(
        { id, name: draft.name.trim() },
        existing === null
          ? `Added the quick ticket ${draft.name.trim()}`
          : `Changed the quick ticket ${existing.name}`,
      );
    },
  },

  delete_preset: {
    group: 'write',
    description: "Remove a quick ticket from the desk's shared list. Tickets already filed from it are untouched.",
    fields: {
      preset: { type: 'string', required: true, description: 'The quick ticket, by name or id.' },
    },
    run: async (args, ctx) => {
      const preset = await resolvePreset(ctx, String(args.preset));
      await rpc(ctx, 'app_delete_ticket_preset', { p_id: preset.id });
      return outcome({ id: preset.id, name: preset.name }, `Removed the quick ticket ${preset.name}`);
    },
  },

  move_preset: {
    group: 'write',
    description: "Move a quick ticket one place up or down the desk's list, which is the order the menu and the palette show them in.",
    fields: {
      preset: { type: 'string', required: true, description: 'The quick ticket, by name or id.' },
      direction: { type: 'string', required: true, description: 'up or down.', choices: ['up', 'down'] },
    },
    run: async (args, ctx) => {
      const preset = await resolvePreset(ctx, String(args.preset));
      const presets = orderPresets(
        rows(await rpc(ctx, 'app_list_ticket_presets', {}))
          .map(presetFromRow)
          .filter((entry): entry is TicketPreset => entry !== null),
      );
      // The new order is worked out from the list as the database has it,
      // and only the rows whose position changes are written: usually two.
      const moves = movePreset(presets, preset.id, String(args.direction) as 'up' | 'down');
      if (moves.length === 0) {
        return outcome({ id: preset.id, moved: false }, `${preset.name} is already at the ${args.direction === 'up' ? 'top' : 'bottom'}`);
      }
      for (const move of moves) {
        const row = presets.find((entry) => entry.id === move.id);
        if (row === undefined) continue;
        await rpc(ctx, 'app_save_ticket_preset', {
          p_id: row.id,
          p_name: row.name,
          p_title: row.title,
          p_issue: row.issue,
          p_category: row.category,
          p_priority: row.priority,
          p_location: row.location,
          p_position: move.position,
        });
      }
      return outcome({ id: preset.id, moved: true }, `Moved ${preset.name} ${String(args.direction)}`);
    },
  },

  import_people: {
    group: 'write',
    description:
      "Put a list of people into the directory, up to 200 rows at a time: a class list, a new-staff sheet, a CSV or a screenshot of one. Each row is a student or a member of staff with the same fields create_person takes. A student is identified by OSIS and a member of staff by school email, and the import is safe to repeat: a row whose identifier is already in the directory UPDATES that record with the fields the row carries, and a row nobody has is added. Read the sheet yourself, map its columns onto the fields, say how many rows you read and which columns you mapped, and send every row in one call. A row that cannot be read — no identifier, a name that matches two records — is named with its reason and the rest still land.",
    fields: {
      rows: {
        type: 'object[]',
        required: true,
        maxItems: FIND_PEOPLE_LIMIT,
        description: `The people, one per row. At most ${FIND_PEOPLE_LIMIT} in one call.`,
        items: {
          kind: { type: 'string', required: true, description: 'student or staff.', choices: PERSON_KINDS },
          ...PERSON_FIELDS,
        },
      },
    },
    run: async (args, ctx) => {
      const sheet = args.rows as Record<string, unknown>[];

      /*
       * The identifier is settled for every row before anything is looked up:
       * a student's OSIS, a member of staff's email, which is what the
       * directory derives their staff id from. A row without one cannot be
       * matched and cannot be safely added, so it is refused by its number
       * while nothing has happened.
       */
      const keys: (string | null)[] = sheet.map((row) => {
        const kind = String(row.kind);
        const id = kind === 'staff' ? textOf(row.email).trim().toLowerCase() : textOf(row.external_id).trim();
        return id === '' ? null : id;
      });
      const refused: { row: number; error: string }[] = [];
      sheet.forEach((row, index) => {
        if (keys[index] === null) {
          refused.push({
            row: index + 1,
            error: row.kind === 'staff' ? 'needs an email address.' : 'needs an OSIS number.',
          });
        }
      });

      // One lookup for the whole sheet. `app_find_people` matches an
      // identifier and an email exactly, and answers under the key it was
      // asked with, so a row is matched by its own key and nothing looser.
      const distinct = [...new Set(keys.filter((key): key is string => key !== null))];
      const lookup = distinct.length === 0
        ? { matched: [], unmatched: [], ambiguous: [] }
        : await lookupPeople(ctx, distinct);
      const byKey = new Map<string, PersonRef>();
      for (const match of lookup.matched) byKey.set(match.key, { id: match.id, name: match.name });

      let created = 0;
      let updated = 0;
      for (const [index, row] of sheet.entries()) {
        const key = keys[index];
        if (key === null) continue;
        const patch = toJsonKeys(pick(row, Object.keys(PERSON_FIELDS)), PERSON_JSON_KEYS);
        const kind = String(row.kind);
        try {
          if (lookup.ambiguous.includes(key)) {
            throw new ToolError(`"${key}" matches more than one record. Say which one, or use the id.`);
          }
          const match = byKey.get(key);
          if (match !== undefined) {
            const current = await rpc(ctx, 'app_get_person', { p_id: match.id });
            if (!isRecord(current)) throw new ToolError('There is no directory record with that id.');
            if (textOf(current.kind) !== kind) {
              throw new ToolError(`"${key}" is already in the directory as ${textOf(current.kind)}, not ${kind}.`);
            }
            await rpc(ctx, 'app_save_person', {
              p_id: match.id,
              p_version: Number(current.version ?? 1),
              p_data: { ...current, ...patch },
            });
            updated += 1;
          } else {
            const displayName =
              textOf(patch.displayName) ||
              `${textOf(patch.firstName)} ${textOf(patch.lastName)}`.trim();
            if (displayName === '') throw new ToolError('needs a name.');
            await rpc(ctx, 'app_save_person', {
              p_id: null,
              p_version: null,
              p_data: { kind, ...patch, displayName },
            });
            created += 1;
          }
        } catch (error) {
          const message =
            error instanceof ToolError && error.message.trim() !== ''
              ? error.message
              : 'That row did not go through.';
          refused.push({ row: index + 1, error: message });
        }
      }

      refused.sort((a, b) => a.row - b.row);
      const parts = [`${created} added`, `${updated} updated`];
      if (refused.length > 0) parts.push(`${refused.length} refused`);
      const detail =
        refused.length === 0
          ? ''
          : `: ${refused
              .slice(0, 3)
              .map((entry) => `row ${entry.row} ${unstopped(entry.error)}`)
              .join('; ')}${refused.length > 3 ? '; and more' : ''}`;
      return {
        ok: created + updated > 0,
        result: { created, updated, refused: refused.length, refusals: refused },
        summary: `Imported ${sheet.length} ${sheet.length === 1 ? 'row' : 'rows'}: ${parts.join(', ')}${detail}.`,
      };
    },
  },

  update_group: {
    group: 'write',
    description: 'Rename a group, or rewrite the line saying what it is for. Only the fields you send are changed.',
    fields: {
      group: { type: 'string', required: true, description: 'The group, by name or by id.' },
      name: { type: 'string', maxLength: 80, description: 'The new name. At most 80 characters, and unique.' },
      description: { type: 'string', maxLength: 300, description: 'The new one-line description.' },
    },
    run: async (args, ctx) => {
      const group = await resolveGroup(ctx, String(args.group));
      if (args.name === undefined && args.description === undefined) {
        throw new ToolError(`Say what to change about ${group.name}: its name or its description.`);
      }
      const name = String(args.name ?? group.name);
      const description = String(args.description ?? group.description);
      await rpc(ctx, 'app_update_group', { p_group: group.id, p_name: name, p_description: description });
      return outcome(
        { id: group.id, name, description },
        args.name !== undefined && name !== group.name
          ? `Renamed ${group.name} to ${name}`
          : `Updated ${group.name}`,
      );
    },
  },

  set_group_member_note: {
    group: 'write',
    description:
      'Write the short note beside one member of a group — "treasurer", "needs a ride", "paid in cash". Up to 80 characters; leave the note out to clear it.',
    fields: {
      group: { type: 'string', required: true, description: 'The group, by name or by id.' },
      person: { type: 'string', required: true, description: 'Name, email, OSIS, staff id or record id.' },
      note: { type: 'string', maxLength: 80, description: 'The note. Leave it out to clear it.' },
    },
    run: async (args, ctx) => {
      const group = await resolveGroup(ctx, String(args.group));
      const person = await resolvePerson(ctx, String(args.person));
      const note = String(args.note ?? '').trim();
      await rpc(ctx, 'app_set_group_member_note', {
        p_group: group.id,
        p_requester: person.id,
        p_note: note,
      });
      return outcome(
        { id: person.id, note },
        note === ''
          ? `Cleared the note beside ${person.name} in ${group.name}`
          : `Noted "${note}" beside ${person.name} in ${group.name}`,
      );
    },
  },

  save_group_field: {
    group: 'write',
    description:
      'Add a checklist column to a group — "Dues", "Permission slip", "Shirt size" — or rename one. Name an existing column in column to rename it; leave it out to add one. Up to 40 columns per group, one of each name.',
    fields: {
      group: { type: 'string', required: true, description: 'The group, by name or by id.' },
      name: { type: 'string', required: true, maxLength: 40, description: 'What the column is called. 40 characters at most.' },
      column: { type: 'string', description: 'An existing column to rename, by its current name or id. Leave it out to add a new one.' },
      position: { type: 'integer', description: 'Where it sits, counting from 0 on the left. Default: at the end.' },
    },
    run: async (args, ctx) => {
      const group = await resolveGroup(ctx, String(args.group));
      const name = String(args.name);
      if (args.column !== undefined) {
        const field = await resolveGroupField(ctx, group, String(args.column));
        const fields = rows(await rpc(ctx, 'app_list_group_fields', { p_group: group.id }));
        const current = fields.find((entry) => textOf(entry.id) === field.id);
        await rpc(ctx, 'app_save_group_field', {
          p_field: field.id,
          p_group: group.id,
          p_name: name,
          p_position: args.position ?? Number(current?.position ?? 0),
        });
        return outcome({ id: field.id, name }, `Renamed the column ${field.name} to ${name} on ${group.name}`);
      }
      const fields = rows(await rpc(ctx, 'app_list_group_fields', { p_group: group.id }));
      const id = await rpc(ctx, 'app_save_group_field', {
        p_field: null,
        p_group: group.id,
        p_name: name,
        p_position: args.position ?? fields.length,
      });
      return outcome({ id, name }, `Added the column ${name} to ${group.name}`);
    },
  },

  delete_group_field: {
    group: 'write',
    description: 'Remove a checklist column from a group, and every tick on it.',
    fields: {
      group: { type: 'string', required: true, description: 'The group, by name or by id.' },
      column: { type: 'string', required: true, description: 'The column, by name or id.' },
    },
    run: async (args, ctx) => {
      const group = await resolveGroup(ctx, String(args.group));
      const field = await resolveGroupField(ctx, group, String(args.column));
      await rpc(ctx, 'app_delete_group_field', { p_field: field.id });
      return outcome({ id: field.id }, `Removed the column ${field.name} from ${group.name}`);
    },
  },

  set_checklist_marks: {
    group: 'write',
    description:
      'Tick, or untick, a whole list of members against one checklist column at once — everybody who paid dues today, the permission slips that came back. Each entry is an OSIS number, a staff id, an email address or a full name, resolved exactly as add_to_group resolves one. Reports how many were changed, how many are not in the group, and which entries matched nobody or more than one person.',
    fields: {
      group: { type: 'string', required: true, description: 'The group, by name or by id.' },
      column: { type: 'string', required: true, description: 'The checklist column, by name or by id.' },
      people: {
        type: 'string[]',
        required: true,
        maxItems: FIND_PEOPLE_LIMIT,
        description: 'The people to tick or untick, one per entry: OSIS number, staff id, school email address or full name.',
      },
      checked: { type: 'boolean', required: true, description: 'True to tick, false to take the tick back.' },
    },
    run: async (args, ctx) => {
      const group = await resolveGroup(ctx, String(args.group));
      const field = await resolveGroupField(ctx, group, String(args.column));
      const checked = args.checked === true;
      const { matched, unmatched, ambiguous } = await lookupPeople(ctx, args.people as string[]);
      if (matched.length === 0) {
        throw new ToolError(
          `None of those ${(args.people as string[]).length} entries is somebody in the directory. Nothing was ticked.`,
        );
      }

      // One tick is one call, as on the screen; a person who is not in the
      // group is refused by the function and counted rather than stopping
      // the rest.
      let changed = 0;
      let outside = 0;
      for (const person of matched) {
        try {
          await rpc(ctx, 'app_set_group_mark', { p_field: field.id, p_requester: person.id, p_checked: checked });
          changed += 1;
        } catch (error) {
          if (error instanceof ToolError && /not in/.test(error.message)) outside += 1;
          else throw error;
        }
      }

      const parts = [`${changed} ${checked ? 'ticked' : 'unticked'}`];
      if (outside > 0) parts.push(`${outside} not in the group`);
      parts.push(...lookupTail(unmatched, ambiguous));
      return outcome(
        { changed, not_member: outside, unmatched, ambiguous },
        `${field.name} on ${group.name}: ${parts.join(', ')}.`,
      );
    },
  },

  create_group_event: {
    group: 'write',
    description:
      'Add a day a group did something — a meeting, a practice, a competition — so attendance can be taken against it. Default today.',
    fields: {
      group: { type: 'string', required: true, description: 'The group, by name or by id.' },
      name: { type: 'string', required: true, maxLength: 80, description: 'What the event is called, such as "Weekly meeting". 80 characters at most.' },
      held_on: { type: 'string', date: true, description: 'The school day it was held, as YYYY-MM-DD. Default today.' },
    },
    run: async (args, ctx) => {
      const group = await resolveGroup(ctx, String(args.group));
      const id = await rpc(ctx, 'app_create_group_event', {
        p_group: group.id,
        p_name: args.name,
        p_held_on: args.held_on ?? null,
      });
      const day = args.held_on === undefined ? 'today' : String(args.held_on);
      return outcome({ id }, `Added ${String(args.name)} on ${day} to ${group.name}`);
    },
  },

  delete_group_event: {
    group: 'write',
    description: 'Delete one of a group\'s events and the attendance taken at it. A day can be taken again; the marks cannot be got back.',
    fields: {
      group: { type: 'string', required: true, description: 'The group, by name or by id.' },
      event: { type: 'string', required: true, description: 'The event, by name or by id.' },
    },
    run: async (args, ctx) => {
      const group = await resolveGroup(ctx, String(args.group));
      const event = await resolveGroupEvent(ctx, group, String(args.event));
      await rpc(ctx, 'app_delete_group_event', { p_event: event.id });
      return outcome({ id: event.id }, `Deleted ${event.name} on ${event.heldOn} from ${group.name}`);
    },
  },

  bulk_assign_devices: {
    group: 'write',
    description:
      'Hand a whole list of machines to one person at once — a cart to a teacher, a tray of loaners to the officer running an event. Each is assigned in turn, exactly as assign_device does one; the first that cannot be stops the rest, and the answer says how many were handed over before it. Up to 200.',
    fields: {
      devices: {
        type: 'string[]',
        required: true,
        maxItems: 200,
        description: 'Asset tags, serial numbers or inventory ids.',
      },
      person: { type: 'string', required: true, description: 'Name, email, OSIS or staff id of whoever takes them.' },
      note: { type: 'string', description: 'Anything to record about the loan, on every one.' },
    },
    run: async (args, ctx) => {
      const person = await resolvePerson(ctx, String(args.person));
      const devices: DeviceRef[] = [];
      for (const name of args.devices as string[]) {
        const device = await resolveDevice(ctx, name);
        if (!devices.some((entry) => entry.id === device.id)) devices.push(device);
      }
      let done = 0;
      for (const device of devices) {
        try {
          await rpc(ctx, 'app_assign_inventory_device', {
            p_device: device.id,
            p_requester: person.id,
            p_note: args.note ?? null,
          });
          done += 1;
        } catch (error) {
          const message =
            error instanceof ToolError && error.message.trim() !== '' ? error.message : 'That one did not go through.';
          return {
            ok: false,
            result: { assigned: done, of: devices.length, stopped_at: device.label, error: message },
            summary:
              done === 0
                ? `${device.label} could not be assigned and nothing was: ${message}`
                : `Assigned ${done} of ${devices.length} to ${person.name}, then ${device.label} could not be: ${message}`,
          };
        }
      }
      return outcome(
        { assigned: done, of: devices.length },
        `Assigned ${done} ${done === 1 ? 'device' : 'devices'} to ${person.name}`,
      );
    },
  },

  bulk_return_devices: {
    group: 'write',
    description:
      'Take a whole list of machines back from whoever holds them — a cart at the end of term. Each is returned in turn, exactly as return_device does one; the first that cannot be stops the rest, and the answer says how many came back before it. Up to 200.',
    fields: {
      devices: {
        type: 'string[]',
        required: true,
        maxItems: 200,
        description: 'Asset tags, serial numbers or inventory ids.',
      },
      status: { type: 'string', description: `What state they came back in. Default Available; usually one of ${SEEDED_STATUSES}.` },
      note: { type: 'string', description: 'Anything to record about the return, on every one.' },
    },
    run: async (args, ctx) => {
      const status = String(args.status ?? 'Available');
      const devices: DeviceRef[] = [];
      for (const name of args.devices as string[]) {
        const device = await resolveDevice(ctx, name);
        if (!devices.some((entry) => entry.id === device.id)) devices.push(device);
      }
      let done = 0;
      for (const device of devices) {
        try {
          await rpc(ctx, 'app_return_inventory_device', {
            p_device: device.id,
            p_status: status,
            p_note: args.note ?? null,
          });
          done += 1;
        } catch (error) {
          const message =
            error instanceof ToolError && error.message.trim() !== '' ? error.message : 'That one did not go through.';
          return {
            ok: false,
            result: { returned: done, of: devices.length, stopped_at: device.label, error: message },
            summary:
              done === 0
                ? `${device.label} could not be returned and nothing was: ${message}`
                : `Took back ${done} of ${devices.length}, then ${device.label} could not be: ${message}`,
          };
        }
      }
      return outcome(
        { returned: done, of: devices.length, status },
        `Took back ${done} ${done === 1 ? 'device' : 'devices'} as ${status.toLowerCase()}`,
      );
    },
  },

  // --- Administrator only --------------------------------------------------

  reassign_ticket: {
    group: 'admin',
    description: 'Move a ticket to a different owner.',
    fields: {
      ticket: { type: 'string', required: true, description: 'Ticket number or id.' },
      owner: { type: 'string', required: true, description: 'The colleague who should own it.' },
    },
    run: async (args, ctx) => {
      const ticket = await resolveTicket(ctx, String(args.ticket));
      const account = await resolveAccount(ctx, String(args.owner));
      await rpc(ctx, 'app_reassign_ticket', { p_ticket: ticket.id, p_new_owner: account.id });
      return outcome({ id: ticket.id }, `Reassigned ${ticket.number} to ${account.name}`);
    },
  },

  reopen_ticket: {
    group: 'admin',
    description: 'Reopen a ticket that was resolved or cancelled.',
    fields: {
      ticket: { type: 'string', required: true, description: 'Ticket number or id.' },
      reason: { type: 'string', required: true, description: 'Why it is being reopened.' },
    },
    run: async (args, ctx) => {
      const ticket = await resolveTicket(ctx, String(args.ticket));
      await rpc(ctx, 'app_reopen_ticket', { p_ticket: ticket.id, p_reason: args.reason });
      return outcome({ id: ticket.id }, `Reopened ${ticket.number}`);
    },
  },

  cancel_ticket: {
    group: 'admin',
    description: 'Cancel a ticket that should not have been raised, or that no longer applies.',
    fields: {
      ticket: { type: 'string', required: true, description: 'Ticket number or id.' },
      reason: { type: 'string', required: true, description: 'Why it is being cancelled.' },
    },
    run: async (args, ctx) => {
      const ticket = await resolveTicket(ctx, String(args.ticket));
      await rpc(ctx, 'app_cancel_ticket', { p_ticket: ticket.id, p_reason: args.reason });
      return outcome({ id: ticket.id }, `Cancelled ${ticket.number}`);
    },
  },

  review_access_request: {
    group: 'admin',
    description: 'Approve or decline somebody waiting for access to the helpdesk.',
    fields: {
      account: { type: 'string', required: true, description: 'The waiting account, by name or id.' },
      decision: { type: 'string', required: true, description: 'approve or deny.', choices: ['approve', 'deny'] },
      role: { type: 'string', description: 'The role to grant on approval. Default netrider.', choices: ROLES },
    },
    run: async (args, ctx) => {
      // Somebody waiting is not in the directory yet, on purpose, so the
      // waiting list itself is what a name is matched against.
      const account = await resolveWaitingAccount(ctx, String(args.account));
      await rpc(ctx, 'app_admin_review_access_request', {
        p_account: account.id,
        p_decision: args.decision,
        p_roles: [args.role ?? 'netrider'],
      });
      const verb = args.decision === 'approve' ? 'Approved' : 'Declined';
      return outcome({ id: account.id }, `${verb} access for ${account.name}`);
    },
  },

  create_invite: {
    group: 'admin',
    description: 'Invite somebody to the helpdesk by email address.',
    fields: {
      email: { type: 'string', required: true, description: 'The address they will sign in with.' },
      role: { type: 'string', required: true, description: 'What they may do.', choices: ROLES },
      name: { type: 'string', description: 'The name to show for them.' },
    },
    run: async (args, ctx) => {
      const id = await rpc(ctx, 'app_admin_create_invite', {
        p_email: args.email,
        p_roles: [args.role],
        p_display_name: args.name ?? null,
      });
      return outcome({ id }, `Invited ${String(args.email)} as ${roleLabel(args.role as AccountRole)}`);
    },
  },

  deactivate_account: {
    group: 'admin',
    description:
      'Take away a colleague’s access. Their name stays on everything they did and their tickets stay where they are; they simply cannot sign in. Use this for somebody who has left.',
    fields: {
      account: { type: 'string', required: true, description: 'The colleague, by name or account id.' },
    },
    run: async (args, ctx) => {
      const account = await resolveAccount(ctx, String(args.account));
      // The database is the guard, not this line. `app_set_account_status`
      // refuses an administrator changing their own status, an account that has
      // not finished setting a password, and one still waiting on an access
      // decision — that last one is answered by review_access_request instead.
      await rpc(ctx, 'app_set_account_status', { p_account: account.id, p_status: 'inactive' });
      return outcome({ id: account.id }, `Deactivated ${account.name}`);
    },
  },

  reactivate_account: {
    group: 'admin',
    description: 'Give a deactivated colleague their access back.',
    fields: {
      account: { type: 'string', required: true, description: 'The colleague, by name or account id.' },
    },
    run: async (args, ctx) => {
      const account = await resolveAccount(ctx, String(args.account));
      await rpc(ctx, 'app_set_account_status', { p_account: account.id, p_status: 'active' });
      return outcome({ id: account.id }, `Reactivated ${account.name}`);
    },
  },

  export_backup: {
    group: 'admin',
    description:
      'Take the school’s own copy of one table as CSV, the same read the Backups screen makes. This never hands over the file itself: it comes back as a row count, the columns and a preview of up to 20 rows, and the full file is downloaded from Administration → Backups.',
    fields: {
      table: {
        type: 'string',
        required: true,
        description: 'Which table to export.',
        choices: BACKUP_TABLE_NAMES,
      },
    },
    run: async (args, ctx) => {
      const table = String(args.table) as BackupTableName;
      const spec = BACKUP_TABLES[table];

      const read = await readBackupTable(ctx.supabase, table, CSV_ROW_CAP);
      if ('error' in read) throw new ToolError(read.error);

      const filename = csvFileName(table, schoolToday(), read.capped);
      const message = read.capped
        ? cappedExportMessage(spec.label, read.total)
        : `${spec.label}: ${read.rows.length.toLocaleString('en-US')} ${read.rows.length === 1 ? 'row' : 'rows'}.`;
      const note = 'Download the full file from Administration → Backups.';

      /*
       * A whole table is not something to put in a chat turn.
       *
       * The result is written into an `ai_messages` row, which the database
       * refuses over 256 KiB, and it is sent to the model, which pays for every
       * character of it and can do nothing useful with a table it cannot save
       * anywhere. The route that turns a tool result into what the panel sees
       * also forwards only `{ok, summary}`, never the result payload, so a
       * `data:` href here would reach nobody who could act on it. What actually
       * answers "what's in it" — the columns, a bounded preview, and a count —
       * comes back every time; the file itself stays where downloading it
       * already works.
       */
      const columns = csvHeaders(read.rows);
      const previewRows = Math.min(EXPORT_PREVIEW_ROWS, read.rows.length);
      const preview = encodeCsv(columns, read.rows.slice(0, previewRows));
      return outcome(
        {
          table,
          filename,
          rowCount: read.rows.length,
          capped: read.capped,
          columns,
          preview,
          previewRows,
          message,
          note,
        },
        `Read ${message} ${note}`,
      );
    },
  },

  list_audit: {
    group: 'read',
    adminOnly: true,
    description:
      'The audit log: ticket activity, account history and record history in one ordered list, newest first. Administrators only, and the database says so too.',
    fields: {
      since: { type: 'string', description: 'Only events from this school day onwards, as YYYY-MM-DD.', date: true },
      until: { type: 'string', description: 'Only events up to and including this school day.', date: true },
      kind: { type: 'string', description: 'Only this kind of event, such as claimed, resolved or role_changed.' },
      entity: { type: 'string', description: 'Only events about this kind of record.', choices: AUDIT_ENTITIES },
      via: { type: 'string', description: 'Only changes made by hand, or only changes made through an assistant.', choices: ['user', 'ai'] },
      limit: { type: 'integer', description: 'How many to return. Default 50, at most 200.' },
    },
    run: async (args, ctx) => {
      const data = rows(
        await rpc(ctx, 'app_audit_log', {
          p_actor: null,
          p_via: args.via ?? null,
          p_kind: args.kind ?? null,
          p_entity: args.entity ?? null,
          // The whole school day at both ends, the same bounds the screen uses.
          p_from: args.since === undefined ? null : schoolDayStart(String(args.since)),
          p_to: args.until === undefined ? null : schoolDayEnd(String(args.until)),
          p_limit: Math.min(Number(args.limit ?? 50), 200),
          p_offset: 0,
        }),
      );
      // `total_count` is the whole filtered set; the rows are one page of it.
      const total = data.length > 0 ? Number(data[0].total_count ?? 0) : 0;
      return outcome({ entries: data, total }, `Read ${data.length} of ${total} audit entries.`);
    },
  },

  set_roles: {
    group: 'admin',
    description:
      "Set a colleague's roles. This REPLACES what they hold, so name every role they should keep.",
    fields: {
      account: { type: 'string', required: true, description: 'The colleague, by name or account id.' },
      roles: {
        type: 'string',
        required: true,
        description: 'The complete new set, comma separated: admin, netrider, skills_officer.',
      },
    },
    run: async (args, ctx) => {
      // Checked before anything is resolved, and against ROLES rather than
      // through normalizeRoles: that helper is for display, where an
      // unreadable value quietly becomes netrider, and a hallucinated role
      // name here must be an error the operator sees named, not a silent
      // netrider grant.
      const tokens = String(args.roles)
        .split(',')
        .map((token) => token.trim().toLowerCase())
        .filter((token) => token.length > 0);
      if (tokens.length === 0) {
        throw new ToolError('Name at least one role: admin, netrider or skills_officer.');
      }
      const unknown = tokens.find((token) => !(ROLES as readonly string[]).includes(token));
      if (unknown !== undefined) {
        throw new ToolError(`"${unknown}" is not a role. Choose from: ${ROLES.join(', ')}.`);
      }

      const account = await resolveAccount(ctx, String(args.account));
      const roles = normalizeRoles(tokens);
      await rpc(ctx, 'app_set_account_roles', { p_account: account.id, p_roles: roles });
      return outcome({ id: account.id }, `Made ${account.name} ${rolesLabel(roles)}`);
    },
  },

  delete_group: {
    group: 'admin',
    description:
      'Delete a group and every membership, event, register and checklist in it. The people themselves stay in the directory. Administrators only, because a roster somebody spent an afternoon pasting in cannot be got back.',
    fields: {
      group: { type: 'string', required: true, description: 'The group, by name or by id.' },
    },
    run: async (args, ctx) => {
      const group = await resolveGroup(ctx, String(args.group));
      await rpc(ctx, 'app_delete_group', { p_group: group.id });
      return outcome(
        { id: group.id, name: group.name, members: group.members },
        `Deleted the group ${group.name} (${group.members} ${group.members === 1 ? 'member' : 'members'})`,
      );
    },
  },

  revoke_invite: {
    group: 'admin',
    description:
      'Take back an invite that has not been accepted, so that address no longer gains access on sign-in. Name it by the email address it went to, or its id from list_invites.',
    fields: {
      invite: { type: 'string', required: true, description: 'The email address the invite went to, or its id.' },
    },
    run: async (args, ctx) => {
      const invite = await resolveInvite(ctx, String(args.invite));
      if (invite.state !== 'pending') {
        throw new ToolError(`The invite to ${invite.email} is ${invite.state}, so there is nothing to revoke.`);
      }
      await rpc(ctx, 'app_admin_revoke_invite', { p_invite: invite.id });
      return outcome({ id: invite.id, email: invite.email }, `Revoked the invite to ${invite.email}`);
    },
  },

};

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

function namesIn(group: ToolGroup): string[] {
  return Object.entries(TOOLS)
    .filter(([, spec]) => spec.group === group)
    .map(([name]) => name);
}

export const READ_TOOLS: string[] = namesIn('read');
export const WRITE_TOOLS: string[] = namesIn('write');
export const ADMIN_TOOLS: string[] = namesIn('admin');

/**
 * Reads only an administrator is offered. Not a fourth group: these are in
 * READ_TOOLS like every other read, and never ask for approval.
 */
export const ADMIN_READ_TOOLS: string[] = Object.entries(TOOLS)
  .filter(([, spec]) => spec.adminOnly === true)
  .map(([name]) => name);

/** Whether this tool is for administrators, whichever of the two ways it is. */
function isAdminTool(spec: ToolSpec): boolean {
  return spec.group === 'admin' || spec.adminOnly === true;
}

/**
 * The only way a tool is looked up.
 *
 * `TOOLS[name]` alone answers for `toString`, `constructor` and `__proto__`,
 * which are inherited rather than declared — so a model that names one would
 * have found `isWriteTool` saying true and `validateArgs` throwing on a spec
 * that is really `Object.prototype.toString`. `Object.hasOwn` is the whole fix.
 */
function specFor(name: string): ToolSpec | undefined {
  return Object.hasOwn(TOOLS, name) ? TOOLS[name] : undefined;
}

/**
 * Whether a call changes anything. Administrator tools count: they are changes
 * with a higher bar, not reads.
 */
export function isWriteTool(name: string): boolean {
  const spec = specFor(name);
  return spec !== undefined && spec.group !== 'read';
}

/**
 * Whether this specific call has to be put to the operator before it runs.
 *
 * Every administrator tool asks, however the setting is set (Ruling 23).
 * Addendum 4 turns confirmations off by default for ordinary work; nothing in
 * the administrator group is ordinary work. Granting a role, inviting somebody,
 * deciding an access request, cancelling, reassigning or reopening a ticket and
 * committing an import are each hard or impossible to take back, and each is the
 * kind of thing a prompt buried in a ticket body would try to talk the assistant
 * into. Asking on the group rather than on a list means a tool added to the group
 * later is covered the day it lands.
 */
export function requiresApproval(
  name: string,
  args: Record<string, unknown>,
  confirmChanges: boolean,
): boolean {
  if (!isWriteCall(name, args)) return false;
  if (specFor(name)?.group === 'admin') return true;
  return confirmChanges;
}

/**
 * The same question about one CALL rather than one tool.
 *
 * No tool is currently a write in one shape and a read in another: `import_csv`
 * was, because its dry run rolled back inside the database, and it is gone with
 * the in-app importer. The signature is kept because the distinction is real —
 * a tool that gains a "check it first" mode belongs here rather than in a new
 * concept — and because every caller already asks this question about a call.
 */
export function isWriteCall(name: string, args: Record<string, unknown>): boolean {
  void args;
  return isWriteTool(name);
}

// ---------------------------------------------------------------------------
// Definitions handed to the model
// ---------------------------------------------------------------------------

function schemaFor(field: Field): JsonSchemaProperty {
  const base: string =
    field.type === 'string[]' || field.type === 'object[]'
      ? 'array'
      : field.type === 'integer'
        ? 'integer'
        : field.type;

  // Strict function tools require every property in `required`, so "optional"
  // is expressed by allowing null. That is the documented shape, and it is also
  // why an omitted argument and an explicit null mean the same thing here.
  const property: JsonSchemaProperty = {
    type: field.required === true ? base : [base, 'null'],
    description: field.description,
  };
  if (field.type === 'string[]') property.items = { type: 'string' };
  // A row schema is the same shape as a tool's own: closed, and every property
  // listed as required, with an optional one expressed as nullable instead.
  if (field.type === 'object[]') property.items = objectSchemaFor(field.items ?? {});
  if (field.choices !== undefined) {
    property.enum = field.required === true ? [...field.choices] : [...field.choices, null];
  }
  return property;
}

function objectSchemaFor(fields: Record<string, Field>): JsonSchema {
  const properties: Record<string, JsonSchemaProperty> = {};
  for (const [name, definition] of Object.entries(fields)) {
    properties[name] = schemaFor(definition);
  }
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

function defFor(name: string, spec: ToolSpec): ToolDef {
  return {
    type: 'function',
    name,
    description: spec.description,
    parameters: objectSchemaFor(spec.fields),
    strict: true,
  };
}

/**
 * Everything a skills officer who is neither a NetRider nor an administrator
 * may reach: the student and staff directory, the device inventory read-only,
 * and their own notifications.
 *
 * An allow-list rather than a rule over the groups, because "write" holds both
 * halves of the job — create_person is directory work and add_note is ticket
 * work — and a list that has to be edited when a tool is added is exactly the
 * property worth having here.
 *
 * search_records stays: it runs under the caller's own row-level security, so
 * for this account it can only ever return directory and device rows.
 */
const DIRECTORY_TOOLS = [
  'search_records',
  'list_people',
  'get_person',
  'find_people',
  'contact_list',
  'list_devices',
  'get_device',
  'list_attachments',
  'list_notifications',
  'mark_notifications_read',
  'set_preference',
  'save_view',
  'delete_view',
  'create_person',
  'update_person',
  'archive_person',
  // The rosters are the directory read sideways, and the account most likely
  // to keep one is exactly this one: a skills officer with a chapter to run.
  'list_groups',
  'group_members',
  'create_group',
  'add_to_group',
  'remove_from_group',
  // What a roster is for: a register at the door, and the list of who still
  // owes a permission slip. Both are chapter business rather than desk work.
  'group_events',
  'event_attendance',
  'mark_attendance',
  'group_checklist',
  'set_checklist_mark',
  // The rest of what a group's page can do: its name, the note beside a
  // member, its checklist columns, its events, and a whole column ticked at
  // once. Deleting a group is an administrator's and is gated by its group.
  'update_group',
  'set_group_member_note',
  'save_group_field',
  'delete_group_field',
  'set_checklist_marks',
  'create_group_event',
  'delete_group_event',
  // A sheet of people is directory work, exactly as one person is.
  'import_people',
  // Their own name and the note the whole desk shares, both on Settings.
  'set_display_name',
  'update_shared_notes',
  // The two exports every active account has a button for. The directory
  // export is not here: it is gated by `directoryExport`, which admits a
  // skills officer and refuses a NetRider.
  'export_devices_csv',
  'export_group_csv',
] as const;

/**
 * Reads gated by `canExportDirectory`: an administrator or a skills officer,
 * and not a NetRider. Exported so the suite can say which tools a NetRider is
 * NOT offered without naming them twice.
 */
export const DIRECTORY_EXPORT_TOOLS: string[] = Object.entries(TOOLS)
  .filter(([, spec]) => spec.directoryExport === true)
  .map(([name]) => name);

export function toolsFor(roles: readonly AccountRole[]): ToolDef[] {
  const admin = roles.includes('admin');
  const ticketWorker = canWorkTickets(roles);
  return Object.entries(TOOLS)
    .filter(([name, spec]) => {
      if (isAdminTool(spec)) return admin;
      if (spec.directoryExport === true) return canExportDirectory(roles);
      if (ticketWorker) return true;
      return (DIRECTORY_TOOLS as readonly string[]).includes(name);
    })
    .map(([name, spec]) => defFor(name, spec));
}

// ---------------------------------------------------------------------------
// Argument checking
// ---------------------------------------------------------------------------

function fieldError(name: string, message: string): string {
  return `${name} ${message}`;
}

function checkField(name: string, field: Field, value: unknown): { value?: unknown; error?: string } {
  switch (field.type) {
    case 'string': {
      if (typeof value !== 'string') return { error: fieldError(name, 'has to be text.') };
      const trimmed = value.trim();
      if (trimmed === '') {
        // An optional field sent as whitespace means "not given", which is
        // kinder than refusing the whole call over an empty box.
        return field.required === true ? { error: fieldError(name, 'cannot be empty.') } : {};
      }
      if (field.choices !== undefined && !field.choices.includes(trimmed)) {
        return { error: fieldError(name, `has to be one of: ${field.choices.join(', ')}.`) };
      }
      if (field.date === true && !/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
        return { error: fieldError(name, 'has to be a date written as YYYY-MM-DD.') };
      }
      if (field.date === true && Number.isNaN(Date.parse(`${trimmed}T00:00:00Z`))) {
        return { error: fieldError(name, 'is not a real date.') };
      }
      if (field.instant === true) {
        // Normalised here rather than in the tool: what reaches an RPC is then
        // one spelling of one instant, whatever the sheet said.
        const instant = historicInstant(trimmed);
        if (instant === null) {
          return {
            error: fieldError(
              name,
              'has to be a date written as YYYY-MM-DD, or a full ISO date and time.',
            ),
          };
        }
        return { value: instant };
      }
      const limit = field.maxLength ?? MAX_TEXT;
      if (trimmed.length > limit) {
        return {
          error: fieldError(name, `has to be ${limit.toLocaleString('en-GB')} characters or fewer.`),
        };
      }
      return { value: trimmed };
    }
    case 'integer': {
      if (typeof value !== 'number' || !Number.isInteger(value)) {
        return { error: fieldError(name, 'has to be a whole number.') };
      }
      return { value };
    }
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { error: fieldError(name, 'has to be a number.') };
      }
      return { value };
    }
    case 'boolean': {
      if (typeof value !== 'boolean') return { error: fieldError(name, 'has to be true or false.') };
      return { value };
    }
    case 'string[]': {
      if (!Array.isArray(value)) return { error: fieldError(name, 'has to be a list.') };
      if (field.maxItems !== undefined && value.length > field.maxItems) {
        return { error: fieldError(name, `takes at most ${field.maxItems} entries in one call.`) };
      }
      const cleaned: string[] = [];
      for (const entry of value) {
        if (typeof entry !== 'string' || entry.trim() === '') {
          return { error: fieldError(name, 'has to be a list of non-empty text values.') };
        }
        cleaned.push(entry.trim());
      }
      if (cleaned.length === 0) return { error: fieldError(name, 'needs at least one entry.') };
      return { value: cleaned };
    }
    case 'object[]': {
      if (!Array.isArray(value)) return { error: fieldError(name, 'has to be a list of rows.') };
      if (value.length === 0) return { error: fieldError(name, 'needs at least one row.') };
      if (field.maxItems !== undefined && value.length > field.maxItems) {
        return {
          error: fieldError(
            name,
            `takes at most ${field.maxItems} rows in one call. Send the rest in another call.`,
          ),
        };
      }

      const known = field.items ?? {};
      const cleaned: Record<string, unknown>[] = [];
      for (const [at, entry] of value.entries()) {
        // Numbered from one, because the person reading the refusal is looking
        // at a spreadsheet and spreadsheets start at one.
        const where = `${name} row ${at + 1}`;
        if (!isRecord(entry)) return { error: `${where} has to be an object of fields.` };

        const unknown = Object.keys(entry).filter((key) => !Object.hasOwn(known, key));
        if (unknown.length > 0) return { error: `${where} does not take ${unknown.join(', ')}.` };

        const row: Record<string, unknown> = {};
        for (const [itemName, itemField] of Object.entries(known)) {
          const raw = entry[itemName];
          if (raw === undefined || raw === null) {
            if (itemField.required === true) return { error: `${where} needs ${itemName}.` };
            continue;
          }
          const checked = checkField(itemName, itemField, raw);
          if (checked.error !== undefined) return { error: `${where}: ${checked.error}` };
          if (checked.value !== undefined) row[itemName] = checked.value;
          else if (itemField.required === true) return { error: `${where} needs ${itemName}.` };
        }
        cleaned.push(row);
      }
      return { value: cleaned };
    }
  }
}

/**
 * The hand-written checker.
 *
 * Deliberately not a schema library: the result has to be an error MESSAGE the
 * model can read and correct on its next turn, and the rules are few enough
 * that a table and a switch say them more plainly than a validator would.
 */
export function validateArgs(name: string, args: unknown): ValidationResult {
  const spec = specFor(name);
  if (spec === undefined) return { ok: false, error: `${name} is not a tool this helpdesk offers.` };
  if (!isRecord(args)) return { ok: false, error: 'Send the arguments as an object of fields.' };

  const known = Object.keys(spec.fields);
  const unknown = Object.keys(args).filter((key) => !known.includes(key));
  if (unknown.length > 0) {
    return { ok: false, error: `${name} does not take ${unknown.join(', ')}.` };
  }

  const value: Record<string, unknown> = {};
  for (const [field, definition] of Object.entries(spec.fields)) {
    const raw = args[field];
    if (raw === undefined || raw === null) {
      if (definition.required === true) return { ok: false, error: `${name} needs ${field}.` };
      continue;
    }
    const checked = checkField(field, definition, raw);
    if (checked.error !== undefined) return { ok: false, error: checked.error };
    if (checked.value !== undefined) value[field] = checked.value;
    else if (definition.required === true) return { ok: false, error: `${name} needs ${field}.` };
  }

  return { ok: true, value };
}

// ---------------------------------------------------------------------------
// Execution
// ---------------------------------------------------------------------------

/**
 * Runs one tool call.
 *
 * Nothing here throws: a refusal is a RESULT, because the model has to be able
 * to read what went wrong and try something else, and a thrown error would end
 * the turn instead. The role checks are belt and braces — a tool outside the
 * caller's roles is never offered in the first place, and the database would
 * refuse it anyway — but a model that invents a tool name should be told no here
 * rather than at the database.
 */
export async function executeTool(
  name: string,
  args: unknown,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  const checked = validateArgs(name, args);
  if (!checked.ok) return { ok: false, result: { error: checked.error }, summary: checked.error };

  const spec = specFor(name);
  if (spec === undefined) {
    const message = `${name} is not a tool this helpdesk offers.`;
    return { ok: false, result: { error: message }, summary: message };
  }
  if (isAdminTool(spec) && !ctx.actor.roles.includes('admin')) {
    const message = 'Only an administrator can do that.';
    return { ok: false, result: { error: message }, summary: message };
  }
  if (spec.directoryExport === true && !canExportDirectory(ctx.actor.roles)) {
    const message = 'Only an administrator or a skills officer can export the directory.';
    return { ok: false, result: { error: message }, summary: message };
  }
  if (
    !isAdminTool(spec) &&
    spec.directoryExport !== true &&
    !canWorkTickets(ctx.actor.roles) &&
    !(DIRECTORY_TOOLS as readonly string[]).includes(name)
  ) {
    const message = 'This account works the directory, not tickets.';
    return { ok: false, result: { error: message }, summary: message };
  }

  try {
    return await spec.run(checked.value, ctx);
  } catch (error) {
    /*
     * Only a ToolError's message is written to be read.
     *
     * Every refusal this module raises deliberately is a ToolError whose
     * `message` has already been through `safeRpcMessage`; its `raw` and `code`
     * are kept apart precisely so the driver's own text never becomes the
     * answer. Anything else caught here is a bug or a transport failure, and its
     * message is whatever the driver felt like saying — a PostgREST body, a SQL
     * fragment, a hostname and port, a `fetch failed`. Forwarding that verbatim
     * would put it in front of the operator AND send it to the model, which then
     * repeats it back and stores it in the conversation. So it goes to the
     * server log, where an administrator can find it, and the turn gets one
     * plain sentence.
     */
    if (error instanceof ToolError && error.message.trim() !== '') {
      return { ok: false, result: { error: error.message }, summary: error.message };
    }
    console.error('[ai] tool threw', {
      tool: name,
      message: error instanceof Error ? error.message : String(error),
    });
    const message = 'That did not go through. Try it on the page itself to see why.';
    return { ok: false, result: { error: message }, summary: message };
  }
}

/** Longest argument value an approval card shows before it is cut. */
const DESCRIBE_LIMIT = 120;

/**
 * One argument, as a card should show it.
 *
 * A long value is cut at a readable length: an approval card is read at a
 * glance, and an operator scrolling one is an operator not reading it.
 */
function describeValue(key: string, value: unknown): string {
  if (Array.isArray(value)) {
    // A list of ROWS is never readable spelled out — fifty objects on a card is
    // a card nobody reads — so it is counted, and named by the first title so
    // the person can see which sheet they are about to import.
    if (value.some(isRecord)) {
      const count = `${value.length} ${value.length === 1 ? 'row' : 'rows'}`;
      const first = value.find(isRecord);
      // A sheet of tickets has a title; a sheet of people has a name.
      const title =
        first === undefined
          ? ''
          : textOf(first.title) ||
            textOf(first.display_name) ||
            `${textOf(first.first_name)} ${textOf(first.last_name)}`.trim() ||
            textOf(first.external_id) ||
            textOf(first.email);
      return title === '' ? count : `${count}, starting "${title}"`;
    }
    const shown = value.slice(0, 5).map(String).join(', ');
    return value.length > 5 ? `${shown} and ${value.length - 5} more` : shown;
  }
  void key;
  const asText = String(value);
  if (asText.length <= DESCRIBE_LIMIT) return asText;
  return `${asText.slice(0, DESCRIBE_LIMIT).trimEnd()}\u2026`;
}

/** The description a pending approval card shows before anything has run. */
export function describeCall(name: string, args: Record<string, unknown>): string {
  const spec = specFor(name);
  if (spec === undefined) return name;
  const parts = Object.entries(args)
    .filter(([, value]) => value !== null && value !== undefined && value !== '')
    .map(([key, value]) => `${key.replace(/_/g, ' ')}: ${describeValue(key, value)}`);
  const subject = parts.length === 0 ? '' : ` (${parts.join('; ')})`;
  return `${label(name)}${subject}`;
}
