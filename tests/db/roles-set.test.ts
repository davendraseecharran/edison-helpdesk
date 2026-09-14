/**
 * Roles as a set.
 *
 * Two things are proved here. First, that the derived `role` column still tells
 * the truth however it is written — because forty-odd functions and every
 * policy still read it, and a set that disagreed with it would be a silent
 * privilege bug. Second, the access matrix: four kinds of account against
 * tickets, the directory, the inventory and administration.
 *
 * Every read and write below goes through a real signed-in session, so what is
 * being tested is row-level security and the RPC guards, not this file's idea
 * of them. The service role appears only to arrange a row or to read ground
 * truth.
 */

import { afterAll, describe, expect, it } from 'vitest';
import {
  adminServiceClient,
  createTicketAs,
  identity,
  openTicket,
  rpcFails,
  rpcOk,
  signIn,
} from './support/harness';

type AccountRow = { role: string; roles: string[] };

async function accountRow(id: string): Promise<AccountRow> {
  const { data, error } = await adminServiceClient()
    .from('app_accounts')
    .select('role, roles')
    .eq('id', id)
    .single();
  if (error || !data) throw new Error(`Could not read account ${id}: ${error?.message}`);
  return data as AccountRow;
}

async function setRoles(id: string, roles: string[]): Promise<void> {
  const { error } = await adminServiceClient().from('app_accounts').update({ roles }).eq('id', id);
  if (error) throw new Error(`Could not set roles: ${error.message}`);
}

/** A directory row a skills officer is allowed to read and to change. */
async function seedRequester(name: string): Promise<string> {
  const { data, error } = await adminServiceClient()
    .from('requesters')
    .insert({ display_name: name, kind: 'staff', created_by: identity('admin').id })
    .select('id')
    .single();
  if (error || !data) throw new Error(`Could not seed requester: ${error?.message}`);
  return data.id as string;
}

afterAll(async () => {
  // The derived-column tests move `unrelated` around; put it back so a later
  // file starts from the seeded arrangement.
  await setRoles(identity('unrelated').id, ['netrider']);
});

describe('the derived role column', () => {
  it('follows the set, however the set is written', async () => {
    const id = identity('unrelated').id;

    await setRoles(id, ['admin', 'skills_officer']);
    expect(await accountRow(id)).toEqual({ role: 'admin', roles: ['admin', 'skills_officer'] });

    await setRoles(id, ['skills_officer']);
    expect(await accountRow(id)).toEqual({ role: 'technician', roles: ['skills_officer'] });

    await setRoles(id, ['netrider']);
    expect(await accountRow(id)).toEqual({ role: 'technician', roles: ['netrider'] });
  });

  it('canonicalises a set that arrives unsorted or with duplicates', async () => {
    const id = identity('unrelated').id;
    await setRoles(id, ['skills_officer', 'netrider', 'netrider']);
    expect((await accountRow(id)).roles).toEqual(['netrider', 'skills_officer']);
  });

  it('translates a writer that sets only the old column, keeping the other roles', async () => {
    const service = adminServiceClient();
    const id = identity('unrelated').id;
    await setRoles(id, ['netrider', 'skills_officer']);

    // A promotion written the old way adds admin rather than replacing the set.
    const promoted = await service.from('app_accounts').update({ role: 'admin' }).eq('id', id);
    expect(promoted.error).toBeNull();
    expect(await accountRow(id)).toEqual({
      role: 'admin',
      roles: ['admin', 'netrider', 'skills_officer'],
    });

    // And a demotion written the old way removes admin and keeps the rest,
    // which is the answer somebody clicking "make them a NetRider" expects.
    const demoted = await service.from('app_accounts').update({ role: 'technician' }).eq('id', id);
    expect(demoted.error).toBeNull();
    expect(await accountRow(id)).toEqual({
      role: 'technician',
      roles: ['netrider', 'skills_officer'],
    });
  });

  it('refuses a role that does not exist, and an empty set', async () => {
    const service = adminServiceClient();
    const id = identity('unrelated').id;

    const unknown = await service.from('app_accounts').update({ roles: ['wizard'] }).eq('id', id);
    expect(unknown.error?.message ?? '').toMatch(/app_accounts_roles_valid/);

    const empty = await service.from('app_accounts').update({ roles: [] }).eq('id', id);
    expect(empty.error?.message ?? '').toMatch(/app_accounts_roles_valid/);
  });
});

describe('what each kind of account reaches', () => {
  it('reports its own set through app_my_account', async () => {
    const skills = await signIn('skillsOfficer');
    const rows = await rpcOk<Array<Record<string, unknown>>>(skills, 'app_my_account');
    expect(rows[0]?.roles).toEqual(['skills_officer']);
    // The derived column is what the older gates read, and it must say the
    // truth about administration even for a role that did not exist then.
    expect(rows[0]?.role).toBe('technician');

    const both = await signIn('netriderSkills');
    const mine = await rpcOk<Array<Record<string, unknown>>>(both, 'app_my_account');
    expect(mine[0]?.roles).toEqual(['netrider', 'skills_officer']);
  });

  it('gives a skills officer no ticket, not even a claimable one', async () => {
    const ticketId = await openTicket();
    const skills = await signIn('skillsOfficer');

    const { data, error } = await skills.from('tickets').select('id');
    expect(error).toBeNull();
    expect(data ?? []).toHaveLength(0);

    expect(await rpcOk<boolean>(skills, 'app_can_view_ticket', { p_ticket: ticketId })).toBe(false);

    const listed = await rpcOk<Array<Record<string, unknown>>>(skills, 'app_list_tickets', {
      p_scope: 'open_queue',
    });
    expect(listed).toHaveLength(0);

    const detail = await rpcOk<Record<string, unknown> | null>(skills, 'app_ticket_detail', {
      p_ticket: ticketId,
    });
    expect(detail).toBeNull();
  });

  it('refuses a skills officer every ticket mutation', async () => {
    const ticketId = await openTicket();
    const skills = await signIn('skillsOfficer');

    // The same sentence every unavailable ticket gets, so the claim endpoint
    // still says nothing about what exists.
    expect((await rpcFails(skills, 'app_claim_ticket', { p_ticket: ticketId })).message).toBe(
      'That ticket is not available to claim.',
    );
    expect(
      (await rpcFails(skills, 'app_add_note', { p_ticket: ticketId, p_body: 'Synthetic note.' }))
        .message,
    ).toMatch(/not available to this account/i);

    const intake = await rpcFails(skills, 'app_create_ticket', {
      p_title: 'Synthetic refusal',
      p_issue: 'A skills officer must not be able to open a ticket.',
      p_channel: 'walk_in',
      p_requester_unknown: true,
      p_location: 'Room 101',
    });
    expect(intake.message).toMatch(/netrider or an administrator/i);
  });

  it('refuses a skills officer the admin RPCs', async () => {
    const skills = await signIn('skillsOfficer');

    expect((await rpcFails(skills, 'app_admin_list_invites')).message).toMatch(
      /only an administrator/i,
    );
    expect(
      (
        await rpcFails(skills, 'app_set_account_roles', {
          p_account: identity('owner').id,
          p_roles: ['admin'],
        })
      ).message,
    ).toMatch(/only an administrator/i);
  });

  it('lets a skills officer read and write the student and staff directory', async () => {
    const skills = await signIn('skillsOfficer');
    const requesterId = await seedRequester('Synthetic Directory Staff');

    const { data, error } = await skills.from('requesters').select('id').eq('id', requesterId);
    expect(error).toBeNull();
    expect((data ?? []).length).toBe(1);

    const listed = await rpcOk<{ rows: unknown[] }>(skills, 'app_list_people', {
      p_kind: 'staff',
      p_query: 'Synthetic Directory',
    });
    expect(Array.isArray(listed.rows)).toBe(true);

    const savedId = await rpcOk<string>(skills, 'app_save_person', {
      p_id: null,
      p_version: null,
      p_data: {
        kind: 'staff',
        displayName: 'Synthetic Skills Officer Entry',
        email: 'synthetic.skills.entry@edison.example',
      },
    });
    expect(typeof savedId).toBe('string');

    const person = await rpcOk<Record<string, unknown>>(skills, 'app_get_person', {
      p_id: savedId,
    });
    expect(person.displayName).toBe('Synthetic Skills Officer Entry');

    // The directory lookups a skills officer's own screens use: staff picklist
    // options, the requester search behind an inline requester field, and the
    // devices already assigned to one requester.
    const options = await rpcOk<{ departments: unknown[]; roles: unknown[] }>(
      skills,
      'app_staff_directory_options',
    );
    expect(Array.isArray(options.departments)).toBe(true);

    const found = await rpcOk<Array<Record<string, unknown>>>(skills, 'app_search_requesters', {
      p_kind: 'staff',
      p_query: 'Synthetic Directory',
    });
    expect(found.some((row) => row.id === requesterId)).toBe(true);

    const devices = await rpcOk<unknown[]>(skills, 'app_assigned_devices', {
      p_requester: requesterId,
    });
    expect(Array.isArray(devices)).toBe(true);
  });

  it('lets a skills officer read the inventory but not change it', async () => {
    const skills = await signIn('skillsOfficer');

    const inventory = await rpcOk<{ rows: unknown[] }>(skills, 'app_list_inventory', {
      p_query: '',
      p_page: 1,
    });
    expect(Array.isArray(inventory.rows)).toBe(true);
    expect(Array.isArray(await rpcOk(skills, 'app_inventory_statuses'))).toBe(true);

    const refused = await rpcFails(skills, 'app_save_inventory_device', {
      p_id: null,
      p_version: null,
      p_data: {
        deviceType: 'Laptop',
        manufacturer: 'Synthetic',
        model: 'SX-1',
        serialNumber: `SYN-${Date.now()}`,
      },
    });
    expect(refused.message).toMatch(/netrider or an administrator/i);
  });

  it('refuses to hand ticket work to somebody who cannot see it', async () => {
    const ticketId = await openTicket();
    const admin = await signIn('admin');
    const skillsId = identity('skillsOfficer').id;

    const reassigned = await rpcFails(admin, 'app_reassign_ticket', {
      p_ticket: ticketId,
      p_new_owner: skillsId,
    });
    expect(reassigned.message).toMatch(/does not work tickets/i);

    await rpcOk(admin, 'app_claim_ticket', { p_ticket: ticketId });
    const collaborating = await rpcFails(admin, 'app_add_collaborator', {
      p_ticket: ticketId,
      p_account: skillsId,
    });
    expect(collaborating.message).toMatch(/does not work tickets/i);

    // Somebody who holds netrider as well is a perfectly good owner.
    expect(
      await rpcOk(admin, 'app_reassign_ticket', {
        p_ticket: ticketId,
        p_new_owner: identity('netriderSkills').id,
      }),
    ).toBe(ticketId);
  });

  it('gives an account holding both roles the queue and the directory', async () => {
    const ticketId = await openTicket();
    const both = await signIn('netriderSkills');

    expect(await rpcOk<boolean>(both, 'app_can_view_ticket', { p_ticket: ticketId })).toBe(true);
    const listed = await rpcOk<Array<Record<string, unknown>>>(both, 'app_list_tickets', {
      p_scope: 'open_queue',
    });
    expect(listed.length).toBeGreaterThan(0);

    // And they can still do the directory job the second role is for.
    const savedId = await rpcOk<string>(both, 'app_save_person', {
      p_id: null,
      p_version: null,
      p_data: {
        kind: 'staff',
        displayName: 'Synthetic Both Roles Entry',
        email: 'synthetic.both.entry@edison.example',
      },
    });
    expect(typeof savedId).toBe('string');

    // Their own intake works, which is the half a pure skills officer loses.
    const ownTicket = await createTicketAs('netriderSkills', {
      title: 'Synthetic both-roles intake',
      requesterUnknown: true,
    });
    expect(typeof ownTicket).toBe('string');
  });

  it('keeps a NetRider and an administrator exactly where they were', async () => {
    const ticketId = await openTicket();

    const netrider = await signIn('owner');
    expect(await rpcOk<boolean>(netrider, 'app_can_view_ticket', { p_ticket: ticketId })).toBe(true);
    expect((await rpcFails(netrider, 'app_admin_list_invites')).message).toMatch(
      /only an administrator/i,
    );

    const admin = await signIn('admin');
    expect(await rpcOk<boolean>(admin, 'app_can_view_ticket', { p_ticket: ticketId })).toBe(true);
    expect(Array.isArray(await rpcOk(admin, 'app_admin_list_invites'))).toBe(true);
  });
});

describe('invites carry a set', () => {
  it('records the roles an invite grants, and the single-value spelling still works', async () => {
    const admin = await signIn('admin');
    const service = adminServiceClient();

    const setId = await rpcOk<string>(admin, 'app_admin_create_invite', {
      p_email: 'synthetic.invite.set@edison.example',
      p_roles: ['netrider', 'skills_officer'],
      p_display_name: 'Synthetic Invite Set',
    });
    const legacyId = await rpcOk<string>(admin, 'app_admin_create_invite', {
      p_email: 'synthetic.invite.legacy@edison.example',
      p_role: 'technician',
    });

    const rows = await rpcOk<Array<Record<string, unknown>>>(admin, 'app_admin_list_invites');
    const withSet = rows.find((row) => row.id === setId);
    const legacy = rows.find((row) => row.id === legacyId);
    expect(withSet?.roles).toEqual(['netrider', 'skills_officer']);
    // The derived column on the invite follows the same rule as the account's.
    expect(withSet?.role).toBe('technician');
    // `technician` is the old spelling of netrider and is read as one.
    expect(legacy?.roles).toEqual(['netrider']);

    const bad = await rpcFails(admin, 'app_admin_create_invite', {
      p_email: 'synthetic.invite.bad@edison.example',
      p_roles: ['wizard'],
    });
    expect(bad.message).toMatch(/administrator, netrider or skills officer/i);

    await service
      .from('account_invites')
      .delete()
      .in('id', [setId, legacyId]);
  });
});
