/**
 * Checklists: the things a group ticks off against its members.
 *
 * Three rules, and all three exist because the alternative is a roster nobody
 * can read:
 *
 * 1. SIX PER GROUP. Each column is a column on a table a phone has to show,
 *    and a seventh is welcome; forty is the only guard.
 * 2. ONE OF EACH NAME, however it is capitalised. Two columns called "Dues" is
 *    two people ticking different boxes for the same thing.
 * 3. A MARK IS A MEMBERSHIP FACT. Ticking somebody who is not in the group is
 *    refused, so the checklist can never disagree with the roster about who is
 *    in it.
 *
 * Deleting a column takes its ticks with it, deliberately: a column nobody
 * uses is the reason delete exists, and keeping its marks would keep the
 * column in everything but name.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { anonClient, rpcFails, rpcOk, seedRequester, signIn } from './support/harness';

interface FieldRow {
  id: string;
  name: string;
  position: number;
  checked_count: number;
}

interface MarkRow {
  requester_id: string;
  field_id: string;
}

let admin: SupabaseClient;
let netrider: SupabaseClient;
let officer: SupabaseClient;
let inactive: SupabaseClient;

function unique(label: string): string {
  return `${label} ${crypto.randomUUID().slice(0, 8)}`;
}

async function newGroup(client: SupabaseClient): Promise<string> {
  return rpcOk<string>(client, 'app_create_group', {
    p_name: unique('Checklist group'),
    p_description: '',
  });
}

async function fields(client: SupabaseClient, groupId: string): Promise<FieldRow[]> {
  return rpcOk<FieldRow[]>(client, 'app_list_group_fields', { p_group: groupId });
}

async function addField(
  client: SupabaseClient,
  groupId: string,
  name: string,
  position = 0,
): Promise<string> {
  return rpcOk<string>(client, 'app_save_group_field', {
    p_field: null,
    p_group: groupId,
    p_name: name,
    p_position: position,
  });
}

async function marks(client: SupabaseClient, groupId: string): Promise<MarkRow[]> {
  return rpcOk<MarkRow[]>(client, 'app_group_marks', { p_group: groupId });
}

beforeAll(async () => {
  admin = await signIn('admin');
  netrider = await signIn('owner');
  officer = await signIn('skillsOfficer');
  inactive = await signIn('inactive');
});

describe('the columns', () => {
  it('is added by any active account and comes back in position order', async () => {
    const groupId = await newGroup(officer);
    await addField(officer, groupId, 'Dues', 1);
    await addField(netrider, groupId, 'Permission slip', 0);

    const list = await fields(admin, groupId);
    expect(list.map((row) => row.name)).toEqual(['Permission slip', 'Dues']);
    expect(list.map((row) => row.position)).toEqual([0, 1]);
    expect(list.every((row) => row.checked_count === 0)).toBe(true);
  });

  it('refuses a nameless column and one longer than the heading allows', async () => {
    const groupId = await newGroup(officer);
    expect(
      (
        await rpcFails(officer, 'app_save_group_field', {
          p_field: null,
          p_group: groupId,
          p_name: '  ',
          p_position: 0,
        })
      ).message,
    ).toContain('Give the column a name');
    expect(
      (
        await rpcFails(officer, 'app_save_group_field', {
          p_field: null,
          p_group: groupId,
          p_name: 'x'.repeat(41),
          p_position: 0,
        })
      ).message,
    ).toContain('40 characters');
  });

  it('refuses a second column of the same name, however it is capitalised', async () => {
    const groupId = await newGroup(officer);
    await addField(officer, groupId, 'Dues');

    const refused = await rpcFails(officer, 'app_save_group_field', {
      p_field: null,
      p_group: groupId,
      p_name: 'DUES',
      p_position: 1,
    });
    expect(refused.message).toContain('already a column called');
  });

  it('allows the same name on two different groups', async () => {
    const first = await newGroup(officer);
    const second = await newGroup(officer);
    await addField(officer, first, 'Dues');
    await addField(officer, second, 'Dues');
    expect(await fields(officer, second)).toHaveLength(1);
  });

  it('keeps going past six: a roster has as many columns as it needs', async () => {
    const groupId = await newGroup(officer);
    for (let at = 0; at < 7; at += 1) await addField(officer, groupId, `Column ${at}`, at);
    expect(await fields(officer, groupId)).toHaveLength(7);
  });

  it('renames and reorders through the same function', async () => {
    const groupId = await newGroup(officer);
    const id = await addField(officer, groupId, 'Dues', 0);

    await rpcOk(officer, 'app_save_group_field', {
      p_field: id,
      p_group: groupId,
      p_name: 'Dues paid',
      p_position: 3,
    });

    const [row] = await fields(officer, groupId);
    expect(row.id).toBe(id);
    expect(row.name).toBe('Dues paid');
    expect(row.position).toBe(3);
  });

  it('refuses an edit to a column that is not there', async () => {
    const groupId = await newGroup(officer);
    const refused = await rpcFails(officer, 'app_save_group_field', {
      p_field: '11111111-1111-4111-8111-111111111111',
      p_group: groupId,
      p_name: 'Dues',
      p_position: 0,
    });
    expect(refused.message).toContain('no column with that id');
  });
});

describe('the ticks', () => {
  it('ticks a member, counts them, and unticks them again', async () => {
    const groupId = await newGroup(officer);
    const person = await seedRequester('student');
    await rpcOk(officer, 'app_add_group_members', {
      p_group: groupId,
      p_requesters: [person.id],
    });
    const fieldId = await addField(officer, groupId, 'Permission slip');

    await rpcOk(netrider, 'app_set_group_mark', {
      p_field: fieldId,
      p_requester: person.id,
      p_checked: true,
    });
    expect(await marks(officer, groupId)).toEqual([
      { requester_id: person.id, field_id: fieldId },
    ]);
    expect((await fields(officer, groupId))[0].checked_count).toBe(1);

    // Ticking twice is not two ticks.
    await rpcOk(officer, 'app_set_group_mark', {
      p_field: fieldId,
      p_requester: person.id,
      p_checked: true,
    });
    expect(await marks(officer, groupId)).toHaveLength(1);

    await rpcOk(officer, 'app_set_group_mark', {
      p_field: fieldId,
      p_requester: person.id,
      p_checked: false,
    });
    expect(await marks(officer, groupId)).toHaveLength(0);
    expect((await fields(officer, groupId))[0].checked_count).toBe(0);
  });

  it('refuses somebody who is not in the group', async () => {
    const groupId = await newGroup(officer);
    const stranger = await seedRequester('student');
    const fieldId = await addField(officer, groupId, 'Dues');

    const refused = await rpcFails(officer, 'app_set_group_mark', {
      p_field: fieldId,
      p_requester: stranger.id,
      p_checked: true,
    });
    expect(refused.message).toContain('not in this group');
    expect(await marks(officer, groupId)).toHaveLength(0);
  });

  it('refuses a column that does not exist', async () => {
    const person = await seedRequester('student');
    const refused = await rpcFails(officer, 'app_set_group_mark', {
      p_field: '11111111-1111-4111-8111-111111111111',
      p_requester: person.id,
      p_checked: true,
    });
    expect(refused.message).toContain('no column with that id');
  });

  it('loses the ticks when the column goes', async () => {
    const groupId = await newGroup(officer);
    const person = await seedRequester('student');
    await rpcOk(officer, 'app_add_group_members', {
      p_group: groupId,
      p_requesters: [person.id],
    });
    const fieldId = await addField(officer, groupId, 'Polo ordered');
    await rpcOk(officer, 'app_set_group_mark', {
      p_field: fieldId,
      p_requester: person.id,
      p_checked: true,
    });

    await rpcOk(officer, 'app_delete_group_field', { p_field: fieldId });
    expect(await fields(officer, groupId)).toHaveLength(0);
    expect(await marks(officer, groupId)).toHaveLength(0);
  });

  it('loses the columns when the group goes', async () => {
    const groupId = await newGroup(officer);
    await addField(officer, groupId, 'Dues');
    await rpcOk(admin, 'app_delete_group', { p_group: groupId });
    expect(await fields(officer, groupId)).toHaveLength(0);
  });
});

describe('who is refused outright', () => {
  it('tells an anonymous caller nothing', async () => {
    const anon = anonClient();
    expect(
      (await rpcFails(anon, 'app_list_group_fields', { p_group: crypto.randomUUID() })).message,
    ).not.toBe('');
  });

  it('refuses a deactivated account the read and the write', async () => {
    const groupId = await newGroup(officer);
    expect(
      (await rpcFails(inactive, 'app_list_group_fields', { p_group: groupId })).message,
    ).toContain('cannot access helpdesk records');
    expect(
      (
        await rpcFails(inactive, 'app_save_group_field', {
          p_field: null,
          p_group: groupId,
          p_name: 'Dues',
          p_position: 0,
        })
      ).message,
    ).toContain('cannot access helpdesk records');
  });

  it('keeps the tables closed to a direct write', async () => {
    const groupId = await newGroup(officer);
    const direct = await officer.from('group_fields').insert({ group_id: groupId, name: 'Dues' });
    expect(direct.error).not.toBeNull();
  });
});
