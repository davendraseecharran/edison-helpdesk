/**
 * Queue filters carried in the URL.
 *
 * Keeping them in the URL means a filtered queue is shareable and survives a
 * refresh, and — more importantly — that filtering is a server round trip
 * against the database rather than something applied to a client-side copy.
 */

import type { QueueFilters } from '@/lib/data/tickets';

export interface QueueSearchParams {
  query?: string | string[];
  status?: string | string[];
  priority?: string | string[];
  channel?: string | string[];
  owner?: string | string[];
  page?: string | string[];
}

export function toFilters(params: QueueSearchParams): QueueFilters {
  const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
  const page = Number.parseInt(first(params.page) ?? '1', 10);
  return {
    query: first(params.query),
    status: first(params.status),
    priority: first(params.priority),
    channel: first(params.channel),
    owner: first(params.owner),
    page: Number.isSafeInteger(page) && page > 0 ? Math.min(page, 1_000_000) : 1,
  };
}
