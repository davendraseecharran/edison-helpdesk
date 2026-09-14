'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';
import type { CatalogEntry } from './inventory-actions';
import type { DeviceInput, InventoryPage, InventorySaveResult, ManagedDevice, PersonInput, PersonKind, PersonRecord } from '@/lib/inventory/types';

interface StaffDirectoryOptions {
  departments: string[];
  roles: string[];
}

async function client() {
  const actor = await loadActor();
  if (actor.kind !== 'active') throw new Error('Sign in again to access inventory.');
  return createClient();
}
async function read<T>(name: string, args: Record<string, unknown> = {}): Promise<T> {
  const db = await client();
  const { data, error } = await db.rpc(name, args);
  if (error) throw new Error(error.message);
  return data as T;
}
async function save(name: string, id: string | null, version: number | null, input: PersonInput | DeviceInput): Promise<InventorySaveResult> {
  try {
    const db = await client();
    const { data, error } = await db.rpc(name, { p_id: id, p_version: version, p_data: input });
    if (error) return { ok: false, error: error.message };
    revalidatePath('/', 'layout');
    return { ok: true, id: data as string };
  } catch {
    return { ok: false, error: 'The record could not be saved. Check your connection and session, then try again.' };
  }
}
export async function listPeople(kind: PersonKind, query: string, page = 1): Promise<InventoryPage<PersonRecord>> {
  return read('app_list_people', { p_kind: kind, p_query: query, p_page: page });
}
export async function getPerson(id: string): Promise<PersonRecord> {
  return read('app_get_person', { p_id: id });
}
export async function listManagedDevices(query: string, page = 1, requesterId?: string): Promise<InventoryPage<ManagedDevice>> {
  return read('app_list_inventory', { p_query: query, p_page: page, p_requester: requesterId ?? null });
}
export async function getManagedDevice(id: string): Promise<ManagedDevice> {
  return read('app_get_inventory_device', { p_id: id });
}
export async function savePerson(id: string | null, version: number | null, input: PersonInput): Promise<InventorySaveResult> {
  return save('app_save_person', id, version, input);
}
export async function saveManagedDevice(id: string | null, version: number | null, input: DeviceInput): Promise<InventorySaveResult> {
  return save('app_save_inventory_device', id, version, input);
}
export async function loadManagementOptions(): Promise<{
  catalog: CatalogEntry[];
  statuses: string[];
  staffDepartments: string[];
  staffRoles: string[];
}> {
  const [catalog, statuses, staffOptions] = await Promise.all([
    read<{ device_type: string; manufacturer: string; model: string }[]>('app_device_catalog'),
    read<string[]>('app_inventory_statuses'),
    read<StaffDirectoryOptions>('app_staff_directory_options'),
  ]);
  return {
    catalog: catalog.map(row => ({
      deviceType: row.device_type,
      manufacturer: row.manufacturer,
      model: row.model,
    })),
    statuses,
    staffDepartments: staffOptions.departments,
    staffRoles: staffOptions.roles,
  };
}
