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

import { isUuid } from '@/lib/guards';
import { createClient } from '@/lib/supabase/server';
// School-local day bounds live in `format.ts` with the rest of the calendar
// rules: they are pure, and a helper this easy to get wrong belongs where the
// unit suite can reach it rather than behind `server-only`.
import { schoolDayEnd, schoolDayStart } from '@/lib/format';
import { AUDIT_ENTITIES, type AuditEntity } from '@/lib/domain/audit-entities';

/** Matches the RPC's own default page. Its hard ceiling is 200. */
export const AUDIT_PAGE_SIZE = 50;

export type AuditVia = 'user' | 'ai';

/**
 * The six things the log can be about, from the one module that owns them —
 * pure, so the assistant's `list_audit` can offer the same vocabulary without
 * dragging `server-only` into the unit suite.
 */
export { AUDIT_ENTITIES, type AuditEntity };

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

function asVia(value: string | undefined): AuditVia | null {
  return value === 'user' || value === 'ai' ? value : null;
}

function asEntity(value: string | undefined): AuditEntity | null {
  return AUDIT_ENTITIES.includes(value as AuditEntity) ? (value as AuditEntity) : null;
}

function asActor(value: string | undefined): string | null {
  return value && isUuid(value) ? value : null;
}

function asKind(value: string | undefined): string | null {
  const kind = value?.trim();
  return kind ? kind : null;
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
