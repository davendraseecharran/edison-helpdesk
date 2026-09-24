/**
 * The session search index and the change stamps (September 24).
 *
 * `app_search_index()` hands every active account the directory and the
 * inventory in the palette's row shape, for the browser to search in memory:
 * so the gate (active accounts only), what is left out (archived people,
 * guardian phones, addresses) and the shape are what is proved here.
 *
 * `app_change_stamps` tells open screens that an area of the desk moved:
 * readable by active accounts only, writable by nobody, moved by the
 * database's own triggers once per statement.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adminServiceClient,
  anonClient,
  identity,
  rpcOk,
  seedInventoryDevice,
  seedRequester,
  signIn,
} from './support/harness';

interface IndexRow {
  kind: string;
  id: string;
  title: string;
  subtitle: string | null;
  meta: string | null;
  keys: string;
}

let netrider: SupabaseClient;
let officer: SupabaseClient;
let inactive: SupabaseClient;

beforeAll(async () => {
  netrider = await signIn('owner');
  officer = await signIn('skillsOfficer');
  inactive = await signIn('inactive');
});

describe('app_search_index', () => {
  it('hands an active account the people and machines, in the palette shape', async () => {
    const person = await seedRequester('student', {
      guardian_phone: '718 555 0142',
      address: '1 Invented Street',
      official_class: '9Z',
    });
    const device = await seedInventoryDevice({ assigned_requester_id: person.id, status: 'Assigned' });

    for (const client of [netrider, officer]) {
      const rows = await rpcOk<IndexRow[]>(client, 'app_search_index', {});
      const p = rows.find((row) => row.id === person.id);
      const d = rows.find((row) => row.id === device.id);
      expect(p).toMatchObject({ kind: 'person', title: person.displayName, meta: person.externalId });
      expect(p?.keys).toContain(person.externalId.toLowerCase());
      expect(p?.keys).toContain('@edison.example');
      expect(p?.keys).not.toContain('0142');
      expect(p?.keys).not.toContain('invented street');
      expect(d).toMatchObject({ kind: 'device', title: device.assetTag });
      expect(d?.meta).toContain(person.displayName);
      expect(d?.keys).toContain(device.serialNumber.toLowerCase());
    }
  });

  it('leaves archived people out', async () => {
    const gone = await seedRequester('student', { archived_at: new Date().toISOString() });
    const rows = await rpcOk<IndexRow[]>(netrider, 'app_search_index', {});
    expect(rows.some((row) => row.id === gone.id)).toBe(false);
  });

  it('answers nothing to an inactive account, and refuses the anonymous', async () => {
    await seedRequester('staff');
    const rows = await rpcOk<IndexRow[]>(inactive, 'app_search_index', {});
    expect(rows).toEqual([]);
    const { error } = await anonClient().rpc('app_search_index');
    expect(error).not.toBeNull();
  });
});

describe('app_change_stamps', () => {
  async function versions(client: SupabaseClient): Promise<Record<string, number>> {
    const { data, error } = await client.from('app_change_stamps').select('area, version');
    if (error) throw new Error(error.message);
    return Object.fromEntries((data ?? []).map((row) => [row.area, row.version]));
  }

  it('moves an area once per writing statement', async () => {
    const before = await versions(netrider);
    await seedInventoryDevice();
    const after = await versions(netrider);
    expect(after.inventory).toBe(before.inventory + 1);
    expect(after.tickets).toBe(before.tickets);

    const service = adminServiceClient();
    const createdBy = identity('admin').id;
    const beforeBulk = await versions(netrider);
    const { error } = await service.from('requesters').insert(
      [1, 2, 3].map((n) => ({
        display_name: `Bulk Synthetic ${n} ${crypto.randomUUID().slice(0, 6)}`,
        kind: 'staff',
        external_id: `bulk.${crypto.randomUUID().slice(0, 8)}`,
        email: `bulk${n}${crypto.randomUUID().slice(0, 4)}@edison.example`,
        created_by: createdBy,
      })),
    );
    expect(error).toBeNull();
    expect((await versions(netrider)).directory).toBe(beforeBulk.directory + 1);
  });

  it('is read by active accounts only and written by nobody', async () => {
    expect(Object.keys(await versions(officer)).sort()).toEqual(
      ['directory', 'forms', 'groups', 'inventory', 'tickets', 'workflows'],
    );
    const { data: hidden } = await inactive.from('app_change_stamps').select('area');
    expect(hidden ?? []).toEqual([]);
    const { error: anonError } = await anonClient().from('app_change_stamps').select('area');
    expect(anonError).not.toBeNull();

    const { error: write } = await netrider
      .from('app_change_stamps')
      .update({ version: 0 })
      .eq('area', 'tickets');
    expect(write).not.toBeNull();
  });
});
