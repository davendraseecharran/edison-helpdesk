import 'server-only';

/**
 * The Today screen's one read.
 *
 * `app_today_briefing()` is SECURITY INVOKER, so this runs under the caller's
 * own row-level security exactly as the queue does: nothing here filters for
 * safety, and the pending access requests come back only for an administrator
 * because the policy on `app_accounts` says so.
 *
 * One RPC rather than four queries. Today is the page every session opens on,
 * and four sequential round trips from a server render is four round trips
 * before anything paints.
 *
 * A failure is an empty briefing, not an error screen. The greeting, the rail
 * and the palette are still worth having when the database had a bad second,
 * and an empty "needs you" list reads as "nothing to do" rather than as a
 * broken page — which is why the caller is told, through `ok`, whether the
 * emptiness is real.
 */

import { cache } from 'react';
import { createClient } from '@/lib/supabase/server';
import { isRecord, textOf } from '@/lib/guards';
import {
  EMPTY_BRIEFING,
  type Briefing,
  type BriefingAccessRequest,
  type BriefingTicket,
} from '@/lib/domain/today';
import { PRIORITY_LABELS, TICKET_STATUS_LABELS, type Priority, type TicketStatus } from '@/lib/domain/types';

export interface TodayView extends Briefing {
  /** False when the briefing could not be read at all, which is not the same as nothing to do. */
  ok: boolean;
}

function priorityOf(value: unknown): Priority {
  return typeof value === 'string' && value in PRIORITY_LABELS ? (value as Priority) : 'normal';
}

function statusOf(value: unknown): TicketStatus {
  return typeof value === 'string' && value in TICKET_STATUS_LABELS ? (value as TicketStatus) : 'open';
}

function textOrNull(value: unknown): string | null {
  const text = textOf(value).trim();
  return text === '' ? null : text;
}

/** One briefing row, checked rather than cast: a schema change fails here, visibly. */
function ticketFrom(row: unknown): BriefingTicket | null {
  if (!isRecord(row)) return null;
  const id = textOf(row.id);
  if (id === '') return null;
  const createdAt = textOf(row.created_at);
  return {
    id,
    number: textOf(row.number),
    title: textOf(row.title),
    priority: priorityOf(row.priority),
    status: statusOf(row.status),
    waitingReason: textOrNull(row.waiting_reason),
    createdAt,
    since: textOf(row.since) || createdAt,
    requesterName: textOrNull(row.requester_name),
  };
}

function accessFrom(row: unknown): BriefingAccessRequest | null {
  if (!isRecord(row)) return null;
  const id = textOf(row.id);
  if (id === '') return null;
  return {
    id,
    name: textOf(row.name) || 'Unnamed account',
    email: textOf(row.email),
    createdAt: textOf(row.created_at),
  };
}

function list<T>(value: unknown, map: (row: unknown) => T | null): T[] {
  if (!Array.isArray(value)) return [];
  const out: T[] = [];
  for (const row of value) {
    const mapped = map(row);
    if (mapped) out.push(mapped);
  }
  return out;
}

function countOf(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : 0;
}

/**
 * The briefing, memoised for the render pass.
 *
 * The page and the assistant's opening message both want it, and they must
 * quote the same numbers: a greeting that says three and a panel that says two
 * is worse than either on its own.
 */
export const loadTodayBriefing = cache(async (): Promise<TodayView> => {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_today_briefing');
  if (error || !isRecord(data)) return { ...EMPTY_BRIEFING, ok: false };

  const counts = isRecord(data.counts) ? data.counts : {};
  return {
    ok: true,
    at: textOf(data.at),
    counts: {
      waiting: countOf(counts.waiting),
      unassigned: countOf(counts.unassigned),
      mine: countOf(counts.mine),
      accessRequests: countOf(counts.access_requests),
    },
    waiting: list(data.waiting, ticketFrom),
    unassigned: list(data.unassigned, ticketFrom),
    mine: list(data.mine, ticketFrom),
    accessRequests: list(data.access_requests, accessFrom),
  };
});
