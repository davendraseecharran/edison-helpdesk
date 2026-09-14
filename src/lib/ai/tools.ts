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
import {
  canWorkTickets,
  normalizeRoles,
  roleLabel,
  rolesLabel,
  type AccountRole,
} from '@/lib/auth/roles';
import { parseCsv } from '@/lib/import/csv';
import { detectPreset } from '@/lib/import/presets';
import { toDeviceRows, toPersonRows } from '@/lib/import/normalize';

// ---------------------------------------------------------------------------
// Schema and validation vocabulary
// ---------------------------------------------------------------------------

export interface JsonSchemaProperty {
  type: string | string[];
  description?: string;
  enum?: (string | null)[];
  items?: { type: string };
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

type FieldType = 'string' | 'integer' | 'number' | 'boolean' | 'string[]';

interface Field {
  type: FieldType;
  description: string;
  /** Absent means optional, which is expressed to the model as nullable. */
  required?: boolean;
  choices?: readonly string[];
  /** A plain calendar date, `YYYY-MM-DD`. */
  date?: boolean;
  /** Longest text accepted. Defaults to MAX_TEXT; only pasted files need more. */
  maxLength?: number;
}

/**
 * A ceiling on every text argument, so a model that loops cannot post a
 * megabyte into a note field and have the database be the thing that says no.
 * The one field that legitimately carries a file overrides it.
 */
const MAX_TEXT = 4000;

/**
 * The most CSV `import_csv` accepts in one call.
 *
 * It was five million characters, which no path could actually carry. A tool
 * call made through the panel is stored TWICE in `ai_messages` — once as the
 * assistant's `function_call` item, and again as the pending-approval row that
 * holds the arguments until the operator answers, because an import commit
 * always asks — and that column is capped at 256 KiB by
 * `ai_messages_content_size`. So an AI import of anything larger than a quarter
 * of a megabyte did not fail at the import: it failed at storing the turn, with
 * a raw check-constraint message and before a single row was read.
 *
 * A hundred thousand characters is about 1,200 inventory rows, which is more
 * than a model will compose into one call anyway, and it leaves the constraint
 * room even for a sheet of entirely two-byte characters. Bigger files are what
 * the administration import screen is for, and the refusal says so.
 */
const MAX_CSV_TEXT = 100_000;

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
const DEVICE_STATUSES = ['in_stock', 'deployed', 'in_repair', 'retired', 'lost', 'surplus'] as const;
const PERSON_KINDS = ['student', 'staff'] as const;
const ROLES = ['admin', 'netrider', 'skills_officer'] as const;
const IMPORT_KINDS = ['people', 'devices'] as const;
const IMPORT_MODES = ['dry_run', 'commit'] as const;

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

export interface ToolContext {
  /** The signed-in technician's client, already carrying `x-edison-via: ai`. */
  supabase: SupabaseClient;
  actor: ToolActor;
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

interface DeviceRef {
  id: string;
  label: string;
}

function deviceLabel(row: Record<string, unknown>): string {
  return textOf(row.asset_tag) || textOf(row.serial_number) || textOf(row.device_id) || 'that device';
}

async function resolveDevice(ctx: ToolContext, value: string): Promise<DeviceRef> {
  const query = value.trim();
  if (query === '') throw new ToolError('Name the device by its asset tag, serial number or id.');

  if (isUuid(query)) {
    const detail = await rpc(ctx, 'app_device_detail', { p_device: query });
    const device = isRecord(detail) && isRecord(detail.device) ? detail.device : null;
    if (device === null) throw new ToolError('There is no device with that id.');
    return { id: query, label: deviceLabel(device) };
  }

  const found = rows(await rpc(ctx, 'app_list_devices', { p_query: query, p_limit: 5 }));
  if (found.length === 0) throw new ToolError(`No device matches "${query}".`);

  const folded = query.toUpperCase();
  const exact = found.find((row) =>
    [textOf(row.device_id), textOf(row.serial_number), textOf(row.asset_tag)]
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
    const detail = await rpc(ctx, 'app_person_detail', { p_person: query });
    const person = isRecord(detail) && isRecord(detail.person) ? detail.person : null;
    if (person === null) throw new ToolError('There is no directory record with that id.');
    return { id: query, name: textOf(person.display_name) };
  }

  const found = rows(await rpc(ctx, 'app_list_people_m5', { p_query: query, p_limit: 5 }));
  if (found.length === 0) throw new ToolError(`Nobody in the directory matches "${query}".`);

  const folded = query.toLowerCase();
  const exact = found.find((row) =>
    [textOf(row.display_name), textOf(row.email), textOf(row.osis), textOf(row.staff_id)]
      .map((candidate) => candidate.toLowerCase())
      .includes(folded),
  );
  const chosen = exact ?? (found.length === 1 ? found[0] : undefined);
  if (chosen === undefined) {
    const options = found.map((row) => textOf(row.display_name)).join(', ');
    throw new ToolError(`"${query}" matches more than one person: ${options}. Say which one.`);
  }
  return { id: textOf(chosen.id), name: textOf(chosen.display_name) };
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

// ---------------------------------------------------------------------------
// Tool table
// ---------------------------------------------------------------------------

type ToolGroup = 'read' | 'write' | 'admin';

interface ToolSpec {
  group: ToolGroup;
  description: string;
  fields: Record<string, Field>;
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolOutcome>;
}

/** Every optional string field a directory record accepts. */
const PERSON_FIELDS: Record<string, Field> = {
  first_name: { type: 'string', description: 'Given name.' },
  last_name: { type: 'string', description: 'Family name.' },
  display_name: { type: 'string', description: 'The name the helpdesk shows. Defaults to first and last.' },
  email: { type: 'string', description: 'School email address.' },
  osis: { type: 'string', description: 'Student OSIS number, 6 to 12 digits.' },
  staff_id: { type: 'string', description: 'Staff identifier.' },
  school_dbn: { type: 'string', description: 'School DBN.' },
  department: { type: 'string', description: 'Department, for staff.' },
  role_title: { type: 'string', description: 'Job title, for staff.' },
  official_class: { type: 'string', description: 'Official class, for students.' },
  class_of: { type: 'string', description: 'Graduating year, for students.' },
  parent_name: { type: 'string', description: 'Parent or guardian name.' },
  parent_phone: { type: 'string', description: 'Parent or guardian phone number.' },
  home_phone: { type: 'string', description: 'Home phone number.' },
  address: { type: 'string', description: 'Home address.' },
  notes: { type: 'string', description: 'Anything else worth recording.' },
};

/** Every optional field an inventory record accepts. */
const DEVICE_FIELDS: Record<string, Field> = {
  device_id: { type: 'string', description: 'The inventory identifier printed on the machine.' },
  serial_number: { type: 'string', description: 'Manufacturer serial number.' },
  asset_tag: { type: 'string', description: 'School asset tag.' },
  type: { type: 'string', description: 'Chromebook, Laptop, Desktop, Projector and so on.' },
  manufacturer: { type: 'string', description: 'Who made it.' },
  model: { type: 'string', description: 'Model name.' },
  os: { type: 'string', description: 'Operating system and version.' },
  status: { type: 'string', description: 'Where the machine is in its life.', choices: DEVICE_STATUSES },
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

const TOOLS: Record<string, ToolSpec> = {
  // --- Read ---------------------------------------------------------------

  search_records: {
    group: 'read',
    description:
      'Search tickets, people and devices at once by number, name, email, OSIS, staff id, asset tag or serial. Use this before acting on anything named by a person rather than by id.',
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
    description: 'The tickets this technician owns right now.',
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
    description: 'List students and staff from the directory.',
    fields: {
      query: { type: 'string', description: 'Name, email, OSIS or staff id.' },
      kind: { type: 'string', description: 'Only students or only staff.', choices: PERSON_KINDS },
      department: { type: 'string', description: 'Only this department.' },
      class_of: { type: 'string', description: 'Only this graduating year.' },
      limit: { type: 'integer', description: 'How many to return. Default 25, at most 100.' },
    },
    run: async (args, ctx) => {
      const data = await rpc(ctx, 'app_list_people_m5', {
        p_query: args.query ?? null,
        p_kind: args.kind ?? null,
        p_department: args.department ?? null,
        p_class_of: args.class_of ?? null,
        p_active: true,
        p_limit: Math.min(Number(args.limit ?? 25), 100),
        p_offset: 0,
      });
      return outcome(data, `Listed ${countOf(data)} people.`);
    },
  },

  get_person: {
    group: 'read',
    description: 'One directory record with the devices they hold and the tickets they have raised.',
    fields: {
      person: { type: 'string', required: true, description: 'Name, email, OSIS, staff id or record id.' },
    },
    run: async (args, ctx) => {
      const person = await resolvePerson(ctx, String(args.person));
      const data = await rpc(ctx, 'app_person_detail', { p_person: person.id });
      return outcome(data, `Read ${person.name}.`);
    },
  },

  list_devices: {
    group: 'read',
    description: 'List inventory machines.',
    fields: {
      query: { type: 'string', description: 'Asset tag, serial, id or model.' },
      type: { type: 'string', description: 'Only this kind of machine.' },
      status: { type: 'string', description: 'Only this status.', choices: DEVICE_STATUSES },
      location: { type: 'string', description: 'Only machines in this room or store.' },
      holder_kind: { type: 'string', description: 'Only machines held by students or by staff.', choices: PERSON_KINDS },
      limit: { type: 'integer', description: 'How many to return. Default 25, at most 100.' },
    },
    run: async (args, ctx) => {
      const data = await rpc(ctx, 'app_list_devices', {
        p_query: args.query ?? null,
        p_type: args.type ?? null,
        p_status: args.status ?? null,
        p_location: args.location ?? null,
        p_holder_kind: args.holder_kind ?? null,
        p_limit: Math.min(Number(args.limit ?? 25), 100),
        p_offset: 0,
      });
      return outcome(data, `Listed ${countOf(data)} devices.`);
    },
  },

  get_device: {
    group: 'read',
    description: 'One machine with who holds it, its loan history and the tickets it appears on.',
    fields: {
      device: { type: 'string', required: true, description: 'Asset tag, serial number, inventory id or record id.' },
    },
    run: async (args, ctx) => {
      const device = await resolveDevice(ctx, String(args.device));
      const data = await rpc(ctx, 'app_device_detail', { p_device: device.id });
      return outcome(data, `Read ${device.label}.`);
    },
  },

  list_notifications: {
    group: 'read',
    description: "This technician's own notifications, newest first.",
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

  get_insights: {
    group: 'read',
    description: 'Helpdesk statistics over a recent window: volumes, resolution times and busiest categories.',
    fields: {
      days: { type: 'integer', description: 'How many days back to look. Default 30.' },
    },
    run: async (args, ctx) => {
      try {
        const data = await rpc(ctx, 'app_insights', { p_days: Number(args.days ?? 30) });
        return outcome(data, `Read insights for the last ${Number(args.days ?? 30)} days.`);
      } catch (error) {
        // Task 13 adds app_insights. Until it lands, say so plainly rather than
        // reporting a database failure the operator cannot act on.
        //
        // Matched on the DRIVER'S code, not on prose: PGRST202 is PostgREST's
        // "not in the schema cache" and 42883 is Postgres's own undefined_function.
        // The text is checked too, because a PostgREST version that changes its
        // code should not turn a missing feature into a mystery.
        const missing =
          error instanceof ToolError &&
          (error.code === 'PGRST202' ||
            error.code === '42883' ||
            /function .* does not exist|could not find the function/i.test(error.raw));
        if (missing) {
          return {
            ok: false,
            result: { error: 'Insights are not available in this build yet.' },
            summary: 'Insights are not available yet.',
          };
        }
        throw error;
      }
    },
  },

  // --- Write --------------------------------------------------------------

  create_ticket: {
    group: 'write',
    description:
      'Open a new ticket. Give the requester as a directory person where there is one, so their history joins up.',
    fields: {
      title: { type: 'string', required: true, description: 'A short summary of the problem.' },
      issue: { type: 'string', required: true, description: 'What the requester reported, in full.' },
      channel: { type: 'string', required: true, description: 'How the request arrived.', choices: CHANNELS },
      priority: { type: 'string', description: 'Default normal.', choices: PRIORITIES },
      category: { type: 'string', description: 'Default other.', choices: CATEGORIES },
      person: { type: 'string', description: 'The requester as a directory record: name, email, OSIS or staff id.' },
      requester_name: { type: 'string', description: 'The requester by name when they are not in the directory.' },
      requester_kind: { type: 'string', description: 'Whether that person is a student or staff.', choices: PERSON_KINDS },
      location: { type: 'string', description: 'Room or area the problem is in.' },
      is_remote: { type: 'boolean', description: 'True when the requester is not on site.' },
      claim: { type: 'boolean', description: 'True to take ownership immediately instead of leaving it in the queue.' },
    },
    run: async (args, ctx) => {
      const person = args.person === undefined ? null : await resolvePerson(ctx, String(args.person));
      const id = await rpc(ctx, 'app_create_ticket', {
        p_title: args.title,
        p_issue: args.issue,
        p_channel: args.channel,
        p_priority: args.priority ?? 'normal',
        p_person_id: person?.id ?? null,
        p_requester_name: args.requester_name ?? null,
        p_requester_kind: args.requester_kind ?? 'staff',
        p_requester_unknown: person === null && args.requester_name === undefined,
        p_location: args.location ?? null,
        p_is_remote: args.is_remote ?? false,
        p_owner_id: args.claim === true ? ctx.actor.id : null,
        p_category: args.category ?? 'other',
      });
      const detail = await rpc(ctx, 'app_ticket_detail', { p_ticket: id });
      const ticket = isRecord(detail) && isRecord(detail.ticket) ? detail.ticket : {};
      const number = textOf(ticket.number) || 'the ticket';
      return outcome({ id, number }, `Opened ${number}: ${String(args.title)}`);
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
    description: 'Add a work note to a ticket. Notes are permanent and are attributed to this technician.',
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
      device_type: { type: 'string', required: true, description: 'Chromebook, laptop, projector and so on.' },
      model: { type: 'string', description: 'Model name.' },
      os_version: { type: 'string', description: 'Operating system and version.' },
      serial_number: { type: 'string', description: 'Serial number read off the machine.' },
      asset_tag: { type: 'string', description: 'Asset tag read off the machine.' },
      identifiers_not_applicable: { type: 'boolean', description: 'True when the machine carries no serial or tag.' },
    },
    run: async (args, ctx) => {
      const ticket = await resolveTicket(ctx, String(args.ticket));
      await rpc(ctx, 'app_record_device', {
        p_ticket: ticket.id,
        p_device_type: args.device_type,
        p_model: args.model ?? null,
        p_os_version: args.os_version ?? null,
        p_serial_number: args.serial_number ?? null,
        p_asset_tag: args.asset_tag ?? null,
        p_identifiers_not_applicable: args.identifiers_not_applicable ?? false,
      });
      return outcome({ id: ticket.id }, `Recorded a ${String(args.device_type)} on ${ticket.number}`);
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

  create_person: {
    group: 'write',
    description: 'Add somebody to the directory.',
    fields: {
      kind: { type: 'string', required: true, description: 'Student or staff.', choices: PERSON_KINDS },
      ...PERSON_FIELDS,
    },
    run: async (args, ctx) => {
      const payload = { kind: args.kind, ...pick(args, Object.keys(PERSON_FIELDS)) };
      const id = await rpc(ctx, 'app_upsert_person', { p_person: payload });
      const name = textOf(args.display_name) || `${textOf(args.first_name)} ${textOf(args.last_name)}`.trim();
      return outcome({ id }, `Added ${name || 'a new directory record'}`);
    },
  },

  update_person: {
    group: 'write',
    description: 'Change a directory record. Only the fields you send are changed.',
    fields: {
      person: { type: 'string', required: true, description: 'Name, email, OSIS, staff id or record id.' },
      kind: { type: 'string', description: 'Student or staff.', choices: PERSON_KINDS },
      ...PERSON_FIELDS,
    },
    run: async (args, ctx) => {
      const person = await resolvePerson(ctx, String(args.person));
      const patch = pick(args, ['kind', ...Object.keys(PERSON_FIELDS)]);
      if (Object.keys(patch).length === 0) throw new ToolError('Say what to change about that person.');
      await rpc(ctx, 'app_upsert_person', { p_person: { id: person.id, ...patch } });
      return outcome({ id: person.id }, `Updated ${person.name}`);
    },
  },

  create_device: {
    group: 'write',
    description: 'Add a machine to the inventory.',
    fields: { ...DEVICE_FIELDS },
    run: async (args, ctx) => {
      const payload = pick(args, Object.keys(DEVICE_FIELDS));
      if (Object.keys(payload).length === 0) {
        throw new ToolError('Give at least an inventory id, serial number or asset tag.');
      }
      const id = await rpc(ctx, 'app_upsert_device', { p_device: payload });
      const name = textOf(args.asset_tag) || textOf(args.serial_number) || textOf(args.device_id);
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
      const patch = pick(args, Object.keys(DEVICE_FIELDS));
      if (Object.keys(patch).length === 0) throw new ToolError('Say what to change about that device.');
      await rpc(ctx, 'app_upsert_device', { p_device: { id: device.id, ...patch } });
      return outcome({ id: device.id }, `Updated ${device.label}`);
    },
  },

  assign_device: {
    group: 'write',
    description: 'Hand a machine out to somebody. This also marks it deployed.',
    fields: {
      device: { type: 'string', required: true, description: 'Asset tag, serial number or inventory id.' },
      person: { type: 'string', required: true, description: 'Name, email, OSIS or staff id of whoever takes it.' },
      note: { type: 'string', description: 'Anything to record about the loan.' },
    },
    run: async (args, ctx) => {
      const device = await resolveDevice(ctx, String(args.device));
      const person = await resolvePerson(ctx, String(args.person));
      await rpc(ctx, 'app_assign_device', {
        p_device: device.id,
        p_person: person.id,
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
      status: { type: 'string', description: 'What state it came back in. Default in_stock.', choices: DEVICE_STATUSES },
      note: { type: 'string', description: 'Anything to record about the return.' },
    },
    run: async (args, ctx) => {
      const device = await resolveDevice(ctx, String(args.device));
      const status = String(args.status ?? 'in_stock');
      await rpc(ctx, 'app_return_device', {
        p_device: device.id,
        p_status: status,
        p_note: args.note ?? null,
      });
      return outcome({ id: device.id }, `Took ${device.label} back as ${label(status).toLowerCase()}`);
    },
  },

  set_device_status: {
    group: 'write',
    description: 'Change where a machine is in its life: in stock, in repair, retired, lost or surplus.',
    fields: {
      device: { type: 'string', required: true, description: 'Asset tag, serial number or inventory id.' },
      status: { type: 'string', required: true, description: 'The new status.', choices: DEVICE_STATUSES },
      reason: { type: 'string', description: 'Why it changed.' },
    },
    run: async (args, ctx) => {
      const device = await resolveDevice(ctx, String(args.device));
      await rpc(ctx, 'app_set_device_status', {
        p_device: device.id,
        p_status: args.status,
        p_reason: args.reason ?? null,
      });
      return outcome({ id: device.id }, `Marked ${device.label} ${label(String(args.status)).toLowerCase()}`);
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
      await rpc(ctx, 'app_move_device', { p_device: device.id, p_location: args.location });
      return outcome({ id: device.id }, `Moved ${device.label} to ${String(args.location)}`);
    },
  },

  bulk_update_devices: {
    group: 'write',
    description:
      'Change up to 500 machines at once. Send one of: a status, a location, somebody to assign them all to, or return_devices.',
    fields: {
      device_ids: {
        type: 'string[]',
        required: true,
        description: 'Asset tags, serial numbers or inventory ids of the machines to change.',
      },
      status: { type: 'string', description: 'Set every one to this status.', choices: DEVICE_STATUSES },
      location: { type: 'string', description: 'Move every one here.' },
      person: { type: 'string', description: 'Assign every one to this person.' },
      return_devices: { type: 'boolean', description: 'True to take every one back from whoever holds it.' },
    },
    run: async (args, ctx) => {
      const names = args.device_ids as string[];
      if (names.length > 500) throw new ToolError('Change 500 devices or fewer at a time.');

      const resolved: DeviceRef[] = [];
      for (const name of names) resolved.push(await resolveDevice(ctx, name));

      const patch: Record<string, unknown> = {};
      if (args.status !== undefined) patch.status = args.status;
      if (args.location !== undefined) patch.location = args.location;
      if (args.person !== undefined) patch.person_id = (await resolvePerson(ctx, String(args.person))).id;
      if (args.return_devices === true) patch.return = true;
      if (Object.keys(patch).length === 0) throw new ToolError('Say what to change for those devices.');

      const changed = await rpc(ctx, 'app_bulk_update_devices', {
        p_ids: resolved.map((device) => device.id),
        p_patch: patch,
      });
      return outcome({ changed }, `Changed ${Number(changed ?? 0)} of ${resolved.length} devices`);
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
      const account = await resolveAccount(ctx, String(args.account));
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
      const account = await resolveAccount(ctx, String(args.account));
      const roles = normalizeRoles(String(args.roles).split(','));
      await rpc(ctx, 'app_set_account_roles', { p_account: account.id, p_roles: roles });
      return outcome({ id: account.id }, `Made ${account.name} ${rolesLabel(roles)}`);
    },
  },

  import_csv: {
    group: 'admin',
    description:
      'Import people or devices from pasted CSV. Run dry_run first and read the counts back before committing.',
    fields: {
      kind: { type: 'string', required: true, description: 'people or devices.', choices: IMPORT_KINDS },
      csv_text: {
        type: 'string',
        required: true,
        description: 'The whole CSV, header row included.',
        maxLength: MAX_CSV_TEXT,
      },
      mode: { type: 'string', required: true, description: 'dry_run to check, commit to apply.', choices: IMPORT_MODES },
    },
    run: async (args, ctx) => {
      const kind = String(args.kind) as 'people' | 'devices';
      const csv = parseCsv(String(args.csv_text));
      if (csv.rows.length === 0) throw new ToolError('That CSV has a header but no rows.');

      const preset = detectPreset(csv.headers);
      if (preset === null) {
        throw new ToolError(
          `Those columns do not match a known ${kind} sheet. Headers seen: ${csv.headers.join(', ')}.`,
        );
      }
      if (preset.kind !== kind) {
        throw new ToolError(`Those columns look like a ${preset.kind} sheet, not a ${kind} one.`);
      }

      const parsed =
        kind === 'people' ? toPersonRows(csv, preset) : toDeviceRows(csv, preset);
      if (parsed.rows.length === 0) {
        const first = parsed.errors.slice(0, 3).map((row) => `row ${row.row}: ${row.message}`).join('; ');
        throw new ToolError(`No row in that CSV could be read. ${first}`);
      }

      const mode = String(args.mode);
      const result = await rpc(ctx, 'app_admin_import', {
        p_kind: kind,
        p_rows: parsed.rows,
        p_mode: mode,
      });

      const verb = mode === 'commit' ? 'Imported' : 'Checked';
      const skipped = parsed.errors.length === 0 ? '' : `, ${parsed.errors.length} unreadable`;
      return outcome(
        { ...(isRecord(result) ? result : { result }), unreadable_rows: parsed.errors },
        `${verb} ${parsed.rows.length} ${kind} rows${skipped}`,
      );
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
 * `import_csv` is the only tool that is both: a dry run rolls back inside the
 * database and changes nothing, so making the operator approve it would put a
 * confirmation in front of the check that exists to earn the confirmation.
 */
export function isWriteCall(name: string, args: Record<string, unknown>): boolean {
  if (!isWriteTool(name)) return false;
  if (name === 'import_csv' && args.mode === 'dry_run') return false;
  return true;
}

// ---------------------------------------------------------------------------
// Definitions handed to the model
// ---------------------------------------------------------------------------

function schemaFor(field: Field): JsonSchemaProperty {
  const base: string =
    field.type === 'string[]' ? 'array' : field.type === 'integer' ? 'integer' : field.type;

  // Strict function tools require every property in `required`, so "optional"
  // is expressed by allowing null. That is the documented shape, and it is also
  // why an omitted argument and an explicit null mean the same thing here.
  const property: JsonSchemaProperty = {
    type: field.required === true ? base : [base, 'null'],
    description: field.description,
  };
  if (field.type === 'string[]') property.items = { type: 'string' };
  if (field.choices !== undefined) {
    property.enum = field.required === true ? [...field.choices] : [...field.choices, null];
  }
  return property;
}

function defFor(name: string, spec: ToolSpec): ToolDef {
  const properties: Record<string, JsonSchemaProperty> = {};
  for (const [field, definition] of Object.entries(spec.fields)) {
    properties[field] = schemaFor(definition);
  }
  return {
    type: 'function',
    name,
    description: spec.description,
    parameters: {
      type: 'object',
      properties,
      required: Object.keys(properties),
      additionalProperties: false,
    },
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
  'list_devices',
  'get_device',
  'list_notifications',
  'create_person',
  'update_person',
] as const;

export function toolsFor(roles: readonly AccountRole[]): ToolDef[] {
  const admin = roles.includes('admin');
  const ticketWorker = canWorkTickets(roles);
  return Object.entries(TOOLS)
    .filter(([name, spec]) => {
      if (spec.group === 'admin') return admin;
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
      const limit = field.maxLength ?? MAX_TEXT;
      if (trimmed.length > limit) {
        // The CSV field is the one a person can plausibly overshoot, and it has
        // somewhere else to go, so its refusal says where.
        const where =
          field.maxLength === MAX_CSV_TEXT
            ? ' Import a file this size on the administration import screen instead.'
            : '';
        return {
          error: `${fieldError(name, `has to be ${limit.toLocaleString('en-GB')} characters or fewer.`)}${where}`,
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
  if (spec.group === 'admin' && !ctx.actor.roles.includes('admin')) {
    const message = 'Only an administrator can do that.';
    return { ok: false, result: { error: message }, summary: message };
  }
  if (
    spec.group !== 'admin' &&
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
 * A pasted spreadsheet is named rather than quoted: `import_csv` carries a
 * hundred thousand characters, and the operator approving it wants to know how
 * big it is, not to scroll it. Every other long value is cut at a readable
 * length.
 */
function describeValue(key: string, value: unknown): string {
  if (Array.isArray(value)) {
    const shown = value.slice(0, 5).map(String).join(', ');
    return value.length > 5 ? `${shown} and ${value.length - 5} more` : shown;
  }
  const asText = String(value);
  if (key === 'csv_text') return `${asText.length.toLocaleString('en-GB')} characters of CSV`;
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
