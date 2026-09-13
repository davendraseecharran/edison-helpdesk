/**
 * Queue filters carried in the URL.
 *
 * Keeping them in the URL means a filtered queue is shareable and survives a
 * refresh, and — more importantly — that filtering is a server round trip
 * against the database rather than something applied to a client-side copy.
 */

import type { QueueFilters } from '@/lib/data/tickets';
import { isTicketCategory } from '@/lib/domain/types';

export interface QueueSearchParams {
  query?: string | string[];
  status?: string | string[];
  priority?: string | string[];
  channel?: string | string[];
  owner?: string | string[];
  category?: string | string[];
  page?: string | string[];
}

export function toFilters(params: QueueSearchParams): QueueFilters {
  const first = (value: string | string[] | undefined) => Array.isArray(value) ? value[0] : value;
  const page = Number.parseInt(first(params.page) ?? '1', 10);
  const category = first(params.category);
  return {
    query: first(params.query),
    status: first(params.status),
    priority: first(params.priority),
    channel: first(params.channel),
    owner: first(params.owner),
    // Validated here rather than passed through: an unrecognised category would
    // otherwise reach the database as a filter that silently matches nothing,
    // and a mistyped link would show an empty queue with no way to tell why.
    // Dropping it shows the unfiltered queue, which is what the URL meant.
    category: isTicketCategory(category) ? category : undefined,
    page: Number.isSafeInteger(page) && page > 0 ? Math.min(page, 1_000_000) : 1,
  };
}
