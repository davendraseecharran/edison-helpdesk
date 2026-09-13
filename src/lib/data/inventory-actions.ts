'use server';

import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';

export interface CatalogEntry {
  deviceType: string;
  manufacturer: string;
  model: string;
}

export interface InventoryDevice extends CatalogEntry {
  id: string;
  serialNumber: string | null;
  assetTag: string | null;
  osVersion: string | null;
}

async function lookup(name: string, args: Record<string, unknown> = {}) {
  const actor = await loadActor();
  if (actor.kind !== 'active') throw new Error('Sign in again to search the directory.');
  const client = await createClient();
  const { data, error } = await client.rpc(name, args);
  if (error) throw new Error('The directory could not be loaded. Please try again.');
  return data ?? [];
}

export async function searchRequesters(kind: 'staff' | 'student', query: string): Promise<{
  id: string; displayName: string; externalId: string | null;
}[]> {
  const data = await lookup('app_search_requesters', { p_kind: kind, p_query: query });
  return data.map((row: { id: string; display_name: string; external_id: string | null }) => ({
    id: row.id, displayName: row.display_name, externalId: row.external_id,
  }));
}

export async function loadDeviceCatalog(): Promise<CatalogEntry[]> {
  const data = await lookup('app_device_catalog');
  return data.map((row: { device_type: string; manufacturer: string; model: string }) => ({
    deviceType: row.device_type, manufacturer: row.manufacturer, model: row.model,
  }));
}

export async function loadAssignedDevices(requesterId: string): Promise<InventoryDevice[]> {
  const data = await lookup('app_assigned_devices', { p_requester: requesterId });
  return data.map((row: {
    id: string; device_type: string; manufacturer: string; model: string | null;
    serial_number: string | null; asset_tag: string | null; os_version: string | null;
  }) => ({
    id: row.id, deviceType: row.device_type, manufacturer: row.manufacturer,
    model: row.model ?? '', serialNumber: row.serial_number,
    assetTag: row.asset_tag, osVersion: row.os_version,
  }));
}
