import 'server-only';

/**
 * The audit read.
 *
 * One call to `app_audit_log`, which unions ticket activity, account history
 * and record history into a single ordered, filtered, paged list and refuses
 * anybody who is not an administrator. Nothing here interleaves three tables in
 * JavaScript, nothing counts rows a second time, and nothing filters for
 * security: the database is the thing that decides, and the page above has
 * already sent a technician away.
 *
 * Every filter is optional and every one of them is validated here before it
 * reaches the RPC. A value outside the set the database knows is DROPPED rather
 * than passed through, because the RPC fails a bad filter closed: a mistyped
 * link would otherwise show an empty log, which is indistinguishable from a
 * desk where nothing has happened.
 */

import { createClient } from '@/lib/supabase/server';
import { SCHOOL_TIME_ZONE, isValidDateKey } from '@/lib/format';

/** Matches the RPC's own default page. Its hard ceiling is 200. */
export const AUDIT_PAGE_SIZE = 50;

export type AuditVia = 'user' | 'ai';

/** The six things the log can be about. `record_events.entity_type` plus tickets. */
export const AUDIT_ENTITIES = ['ticket', 'account', 'person', 'device', 'invite', 'import'] as const;
export type AuditEntity = (typeof AUDIT_ENTITIES)[number];

export interface AuditEntry {
  /** Which history table the row came from: activity, account or record. */
  source: string;
  id: string;
  at: string;
  actorId: string | null;
  /** Null for a trusted server flow that has no person behind it. */
  actorName: string | null;
  performedVia: AuditVia | null;
  aiModel: string | null;
  kind: string;
  entityType: AuditEntity | string;
  entityId: string | null;
  /** Null when the record this event names has since been deleted. */
  entityLabel: string | null;
  summary: string | null;
  detail: string | null;
}

export interface AuditFilters {
  actor?: string;
  via?: string;
  kind?: string;
  entity?: string;
  /** School-local `YYYY-MM-DD`; the whole day is included at both ends. */
  from?: string;
  to?: string;
  page?: number;
}

export interface AuditLogPage {
  entries: AuditEntry[];
  total: number;
  page: number;
  pageCount: number;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function asVia(value: string | undefined): AuditVia | null {
  return value === 'user' || value === 'ai' ? value : null;
}

function asEntity(value: string | undefined): AuditEntity | null {
  return AUDIT_ENTITIES.includes(value as AuditEntity) ? (value as AuditEntity) : null;
}

function asActor(value: string | undefined): string | null {
  return value && UUID.test(value) ? value : null;
}

function asKind(value: string | undefined): string | null {
  const kind = value?.trim();
  return kind ? kind : null;
}

/**
 * The school's clock, so a day filter means the day the desk worked.
 *
 * `Intl` is asked what the wall clock reads at a candidate instant, and the
 * difference from the instant is the offset in force. One refinement pass
 * settles the two hours a year when the first guess lands on the far side of a
 * daylight-saving change.
 */
const SCHOOL_CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: SCHOOL_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hour12: false,
});

function schoolOffsetAt(instant: number): number {
  const parts = SCHOOL_CLOCK.formatToParts(new Date(instant));
  const value = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? '0');
  // en-US with hour12:false renders midnight as 24 in some ICU versions.
  const hour = value('hour') % 24;
  const wall = Date.UTC(value('year'), value('month') - 1, value('day'), hour, value('minute'), value('second'));
  return wall - instant;
}

function schoolInstant(key: string, hour: number, minute: number, second: number, ms: number): string | null {
  if (!isValidDateKey(key)) return null;
  const [year, month, day] = key.split('-').map(Number);
  const wall = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  const first = wall - schoolOffsetAt(wall);
  const instant = wall - schoolOffsetAt(first);
  return new Date(instant).toISOString();
}

/** Midnight at the start of a school-local day. */
export function schoolDayStart(key: string): string | null {
  return schoolInstant(key, 0, 0, 0, 0);
}

/** The last millisecond of a school-local day, so "to" includes that day. */
export function schoolDayEnd(key: string): string | null {
  return schoolInstant(key, 23, 59, 59, 999);
}

interface AuditRow {
  source: string;
  id: string;
  at: string;
  actor_id: string | null;
  actor_name: string | null;
  performed_via: string | null;
  ai_model: string | null;
  kind: string;
  entity_type: string;
  entity_id: string | null;
  entity_label: string | null;
  summary: string | null;
  detail: string | null;
  total_count: number | string;
}

export async function loadAuditLog(filters: AuditFilters = {}): Promise<AuditLogPage> {
  const supabase = await createClient();
  const page = Math.max(1, filters.page ?? 1);

  const { data, error } = await supabase.rpc('app_audit_log', {
    p_actor: asActor(filters.actor),
    p_via: asVia(filters.via),
    p_kind: asKind(filters.kind),
    p_entity: asEntity(filters.entity),
    p_from: filters.from ? schoolDayStart(filters.from) : null,
    p_to: filters.to ? schoolDayEnd(filters.to) : null,
    p_limit: AUDIT_PAGE_SIZE,
    p_offset: (page - 1) * AUDIT_PAGE_SIZE,
  });

  if (error) {
    throw new Error(`Could not read the audit log: ${error.message}`);
  }

  const rows = (data ?? []) as AuditRow[];

  // The desk keeps working while the log is read, so a page that was the last
  // one a moment ago can empty out. Fall back to the first page rather than
  // showing a total of zero with no way back to the rows that do exist.
  if (rows.length === 0 && page > 1) return loadAuditLog({ ...filters, page: 1 });

  const total = rows.length > 0 ? Number(rows[0].total_count ?? 0) : 0;

  return {
    entries: rows.map((row) => ({
      source: row.source,
      id: row.id,
      at: row.at,
      actorId: row.actor_id,
      actorName: row.actor_name,
      performedVia: row.performed_via === 'ai' ? 'ai' : row.performed_via === 'user' ? 'user' : null,
      aiModel: row.ai_model,
      kind: row.kind,
      entityType: row.entity_type,
      entityId: row.entity_id,
      entityLabel: row.entity_label,
      summary: row.summary,
      detail: row.detail,
    })),
    total,
    page,
    pageCount: Math.max(1, Math.ceil(total / AUDIT_PAGE_SIZE)),
  };
}
