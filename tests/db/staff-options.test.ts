/**
 * Staff directory option lookup: suggestions cover the full staff directory,
 * are deduplicated, and remain behind the active-account authorization gate.
 */

import { randomUUID } from 'node:crypto';
import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adminServiceClient,
  anonClient,
  identity,
  rpcFails,
  rpcOk,
  signIn,
} from './support/harness';

interface StaffDirectoryOptions {
  departments: string[];
  roles: string[];
}

const token = randomUUID().replaceAll('-', '').slice(0, 12);
const sharedDepartment = `Options Shared Department ${token}`;
const lateDepartment = `Options Late Department ${token}`;
const sharedRole = `Options Shared Role ${token}`;
const lateRole = `Options Late Role ${token}`;
const lateExternalId = `options-staff-${token}-055`;

let admin: SupabaseClient;
let technician: SupabaseClient;
let inactive: SupabaseClient;
let pending: SupabaseClient;

beforeAll(async () => {
  [admin, technician, inactive, pending] = await Promise.all([
    signIn('admin'),
    signIn('owner'),
    signIn('inactive'),
    signIn('pending'),
  ]);

  const rows = Array.from({ length: 55 }, (_, index) => {
    const sequence = String(index + 1).padStart(3, '0');
    const isLast = index === 54;
    return {
      display_name: `Directory Options ${token} ${sequence}`,
      kind: 'staff',
      external_id: `options-staff-${token}-${sequence}`,
      email: `options-staff-${token}-${sequence}@school.example`,
      department: isLast ? lateDepartment : sharedDepartment,
      staff_role: isLast ? lateRole : sharedRole,
      created_by: identity('admin').id,
    };
  });

  const { error } = await adminServiceClient().from('requesters').insert(rows);
  if (error) throw new Error(`Could not seed staff option fixtures: ${error.message}`);
});

describe('staff directory options', () => {
  it('returns distinct values from all staff, including a value past the first list page', async () => {
    const firstPage = await rpcOk<{ rows: Array<{ externalId: string }>; total: number }>(
      technician,
      'app_list_people',
      { p_kind: 'staff', p_query: token, p_page: 1 },
    );
    expect(firstPage.total).toBe(55);
    expect(firstPage.rows).toHaveLength(50);
    expect(firstPage.rows.some((row) => row.externalId === lateExternalId)).toBe(false);

    const options = await rpcOk<StaffDirectoryOptions>(
      technician,
      'app_staff_directory_options',
    );
    expect(options.departments).toContain(sharedDepartment);
    expect(options.departments).toContain(lateDepartment);
    expect(options.departments.filter((value) => value === sharedDepartment)).toHaveLength(1);
    expect(options.roles).toContain(sharedRole);
    expect(options.roles).toContain(lateRole);
    expect(options.roles.filter((value) => value === sharedRole)).toHaveLength(1);
  });

  it('allows both active administrators and technicians to read the same options', async () => {
    const [adminOptions, technicianOptions] = await Promise.all([
      rpcOk<StaffDirectoryOptions>(admin, 'app_staff_directory_options'),
      rpcOk<StaffDirectoryOptions>(technician, 'app_staff_directory_options'),
    ]);
    expect(adminOptions).toEqual(technicianOptions);
  });

  it('refuses anonymous, inactive, and setup-pending callers', async () => {
    for (const actor of [anonClient(), inactive, pending]) {
      const failure = await rpcFails(actor, 'app_staff_directory_options');
      expect(failure.message).toMatch(/permission denied|cannot access|finish setting/i);
    }
  });
});
