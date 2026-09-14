import 'server-only';

/**
 * The numbers behind `/insights`.
 *
 * One call to `app_insights`, which is the only read in the application that
 * deliberately sees past ticket visibility: a median resolution time computed
 * from the asker's own three tickets would not be a smaller truth, it would be a
 * misleading one. The gate is an active account — the function refuses anyone
 * else outright — and it returns aggregates only, never a ticket, a requester or
 * a note. Nothing here filters in JavaScript for security.
 *
 * Everything the RPC sends is re-read defensively into the shape the page
 * expects. A count that arrives missing, null or as a string becomes zero rather
 * than `NaN`, because a chart is arithmetic and one `NaN` takes the whole axis
 * with it.
 */

import { textOf } from '@/lib/guards';
import { createClient } from '@/lib/supabase/server';
import {
  DEVICE_STATUSES,
  type DeviceStatus,
  type Priority,
  type TicketCategory,
} from '@/lib/domain/types';

/** The statuses a ticket can be in while it is still somebody's problem. */
export const OPEN_STATUSES = ['open', 'assigned', 'in_progress', 'waiting'] as const;
export type OpenStatus = (typeof OPEN_STATUSES)[number];

/** Severest first: the row a teacher should look at is the row at the top. */
export const PRIORITIES_BY_SEVERITY: Priority[] = ['urgent', 'high', 'normal', 'low'];

export interface SeriesDay {
  date: string;
  opened: number;
  resolved: number;
}

export interface CategoryCount {
  category: TicketCategory | string;
  count: number;
}

export interface TypeCount {
  type: string;
  count: number;
}

export interface InsightsTechnician {
  accountId: string;
  name: string;
  resolved: number;
  minutes: number;
  open: number;
}

export interface Insights {
  /** The window the database actually used, after its own clamp. */
  days: number;
  series: SeriesDay[];
  openByStatus: Record<OpenStatus, number>;
  openByPriority: Record<Priority, number>;
  byCategory: CategoryCount[];
  resolution: {
    medianHours: number | null;
    meanHours: number | null;
    resolvedCount: number;
  };
  technicians: InsightsTechnician[];
  deviceTypesInTickets: TypeCount[];
  inventory: {
    byStatus: Record<DeviceStatus, number>;
    byType: TypeCount[];
    total: number;
  };
}

type Payload = Record<string, unknown>;

function record(value: unknown): Payload {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Payload)
    : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A non-negative whole number, or zero. Counts are never fractional. */
function count(value: unknown): number {
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) return 0;
  return Math.max(0, Math.trunc(number));
}

/** Hours to two decimals, or null when nothing was resolved — which is what the average of no numbers is. */
function hours(value: unknown): number | null {
  const number = typeof value === 'string' ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) return null;
  return number;
}


function countsByKey<Key extends string>(value: unknown, keys: readonly Key[]): Record<Key, number> {
  const source = record(value);
  const result = {} as Record<Key, number>;
  for (const key of keys) result[key] = count(source[key]);
  return result;
}

const PRIORITY_KEYS: Priority[] = ['low', 'normal', 'high', 'urgent'];

export async function loadInsights(days: number): Promise<Insights> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_insights', { p_days: days });

  if (error) {
    throw new Error(`Could not load insights: ${error.message}`);
  }

  const payload = record(data);

  return {
    days: count(payload.days) || days,
    series: list(payload.series).map((entry) => {
      const point = record(entry);
      return {
        date: textOf(point.date),
        opened: count(point.opened),
        resolved: count(point.resolved),
      };
    }),
    openByStatus: countsByKey(payload.open_by_status, OPEN_STATUSES),
    openByPriority: countsByKey(payload.open_by_priority, PRIORITY_KEYS),
    byCategory: list(payload.by_category)
      .map((entry) => {
        const row = record(entry);
        return { category: textOf(row.category), count: count(row.count) };
      })
      .filter((row) => row.category !== ''),
    resolution: {
      medianHours: hours(record(payload.resolution).median_hours),
      meanHours: hours(record(payload.resolution).mean_hours),
      resolvedCount: count(record(payload.resolution).resolved_count),
    },
    technicians: list(payload.technicians)
      .map((entry) => {
        const row = record(entry);
        return {
          accountId: textOf(row.account_id),
          name: textOf(row.name) || 'Unknown',
          resolved: count(row.resolved),
          minutes: count(row.minutes),
          open: count(row.open),
        };
      })
      .filter((row) => row.accountId !== ''),
    deviceTypesInTickets: typeCounts(payload.device_types_in_tickets),
    inventory: {
      byStatus: countsByKey(record(payload.inventory).by_status, DEVICE_STATUSES),
      byType: typeCounts(record(payload.inventory).by_type),
      total: count(record(payload.inventory).total),
    },
  };
}

function typeCounts(value: unknown): TypeCount[] {
  return list(value)
    .map((entry) => {
      const row = record(entry);
      return { type: textOf(row.type), count: count(row.count) };
    })
    .filter((row) => row.type !== '');
}
