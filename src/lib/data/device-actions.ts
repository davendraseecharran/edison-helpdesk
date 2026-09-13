'use server';

/**
 * Inventory lookups for the application.
 *
 * One action, deliberately: finding one machine while somebody types, so a
 * technician can name it on a ticket. The inventory screen Task 18 builds reads
 * `app_list_devices` server-side with its own filters; this is the type-ahead.
 *
 * `app_list_devices` is SECURITY INVOKER, so the row policy decides what comes
 * back. An assignment row names a student, so the inventory is gated exactly as
 * the directory is: an account that is not active gets an empty list.
 */

import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';

export interface DeviceSearchResult {
  id: string;
  /** Asset tag, else serial, else managed-device id: how the machine is named. */
  label: string;
  type: string;
  model: string | null;
  status: string;
  holderName: string | null;
}

/** How many results a type-ahead shows before an operator should narrow the term. */
const SEARCH_LIMIT = 8;

export async function searchDevicesAction(query: string): Promise<DeviceSearchResult[]> {
  const term = query.trim();
  if (term.length < 2) return [];

  const actor = await loadActor();
  if (actor.kind !== 'active') return [];

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_list_devices', {
    p_query: term,
    p_limit: SEARCH_LIMIT,
  });
  if (error) return [];

  return ((data ?? []) as Array<{
    id: string;
    device_id: string | null;
    serial_number: string | null;
    asset_tag: string | null;
    type: string;
    model: string | null;
    status: string;
    holder_name: string | null;
  }>).map((row) => ({
    id: row.id,
    // The same order app_device_label uses in the database, so a machine is
    // named the same way in the picker and in the history it ends up in.
    label: row.asset_tag ?? row.serial_number ?? row.device_id ?? 'Unlabelled device',
    type: row.type,
    model: row.model,
    status: row.status,
    holderName: row.holder_name,
  }));
}
