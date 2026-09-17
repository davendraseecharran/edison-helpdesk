/**
 * Quick tickets: the calls that repeat all day, written down once.
 *
 * `20260916130200_m5_ticket_presets.sql` adds a table that is unusual in this
 * schema in the same way `assistant_notes_shared` is — it is SHARED — and five
 * things about it are load-bearing:
 *
 * 1. EVERY TICKET WORKER MAY WRITE IT. Not administrators, and not only whoever
 *    typed it: an administrator and a NetRider get the same answer, and either
 *    may edit or delete a preset the other wrote. The three calls are the
 *    school's, not one person's.
 * 2. A SKILLS OFFICER IS NOT A TICKET WORKER. They read nothing and write
 *    nothing here, and the read is empty rather than an error because the row
 *    policy is what answers it.
 * 3. THE FUNCTIONS ARE THE ONLY DOOR. The table is readable and nothing more,
 *    so the cap, the vocabularies, the attribution and the history entry cannot
 *    be walked around by writing a row directly.
 * 4. THE VOCABULARIES ARE THE TICKET'S OWN. A preset that could hold a category
 *    no ticket may carry would fail at the one moment it is used.
 * 5. THE HISTORY NAMES THE PRESET AND NOTHING ELSE. `record_events` is
 *    append-only and every administrator reads it; the issue text stays in the
 *    table.
 *
 * Exercised through real signed-in sessions, because every gate here is derived
 * inside the function body from the caller's own session.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import { anonClient, identity, rpcFails, rpcOk, signIn } from './support/harness';

interface PresetRow {
  id: string;
  name: string;
  title: string;
  issue: string;
  category: string;
  priority: string;
  location: string;
  position: number;
  created_by: string | null;
  updated_at: string;
}

interface AuditRow {
  kind: string;
  summary: string;
  entity_type: string;
  actor_id: string;
  actor_name: string;
  performed_via: string;
}

interface SaveOptions {
  id?: string | null;
  name: string;
  title?: string;
  issue?: string;
  category?: string;
  priority?: string;
  location?: string;
  position?: number | null;
}

let admin: SupabaseClient;
let worker: SupabaseClient;
let other: SupabaseClient;
let officer: SupabaseClient;
let inactive: SupabaseClient;

/** The three the migration wrote, in the order it wrote them. */
const SEEDED = ['Projector', 'Chromebook will not charge', 'No Wi-Fi'];

function args(options: SaveOptions): Record<string, unknown> {
  return {
    p_id: options.id ?? null,
    p_name: options.name,
    p_title: options.title ?? 'Projector will not display',
    p_issue: options.issue ?? 'The projector is on and the screen stays blank.',
    p_category: options.category ?? 'projector_display',
    p_priority: options.priority ?? 'normal',
    p_location: options.location ?? '',
    p_position: options.position ?? null,
  };
}

async function save(client: SupabaseClient, options: SaveOptions): Promise<PresetRow> {
  return rpcOk<PresetRow>(client, 'app_save_ticket_preset', args(options));
}

async function list(client: SupabaseClient): Promise<PresetRow[]> {
  return rpcOk<PresetRow[]>(client, 'app_list_ticket_presets');
}

async function remove(client: SupabaseClient, id: string): Promise<void> {
  await rpcOk(client, 'app_delete_ticket_preset', { p_id: id });
}

/** A name nothing else in the suite can collide with. */
function uniqueName(prefix: string): string {
  return `${prefix} ${crypto.randomUUID().slice(0, 6)}`;
}

beforeAll(async () => {
  admin = await signIn('admin');
  worker = await signIn('owner');
  other = await signIn('collaborator');
  officer = await signIn('skillsOfficer');
  inactive = await signIn('inactive');
});

describe('the desk’s quick tickets', () => {
  it('starts as the three the migration wrote, in the order it wrote them', async () => {
    const presets = await list(worker);
    expect(presets.map((preset) => preset.name)).toEqual(SEEDED);
    // Nobody wrote them, so nobody is named as having done so.
    expect(presets.every((preset) => preset.created_by === null)).toBe(true);
    expect(presets[0].category).toBe('projector_display');
  });

  it('is written by a NetRider and read by everybody else at the desk', async () => {
    const name = uniqueName('Cart will not wake');
    const saved = await save(worker, {
      name,
      title: 'Chromebook cart will not wake',
      issue: 'The whole cart is asleep after the weekend.',
      category: 'chromebook',
      priority: 'high',
      location: 'Room 118',
    });

    expect(saved.name).toBe(name);
    expect(saved.priority).toBe('high');
    expect(saved.created_by).toBe(identity('owner').id);
    // Written to the end of the list, past the three seeds.
    expect(saved.position).toBe(3);

    for (const reader of [admin, worker, other]) {
      const found = (await list(reader)).find((preset) => preset.id === saved.id);
      expect(found?.title).toBe('Chromebook cart will not wake');
      expect(found?.location).toBe('Room 118');
    }

    await remove(worker, saved.id);
  });

  it('trims what it is given', async () => {
    const name = uniqueName('Trimmed');
    const saved = await save(worker, {
      name: `  ${name}  `,
      title: '  Projector will not display  ',
      issue: '  No signal.  ',
      location: '  Room 212  ',
    });
    expect(saved.name).toBe(name);
    expect(saved.title).toBe('Projector will not display');
    expect(saved.issue).toBe('No signal.');
    expect(saved.location).toBe('Room 212');
    await remove(worker, saved.id);
  });

  it('is ordered by position first and by name second', async () => {
    const zulu = await save(worker, { name: uniqueName('zzz shares a position'), position: 90 });
    const mike = await save(worker, { name: uniqueName('mmm shares a position'), position: 90 });
    const alpha = await save(worker, { name: uniqueName('aaa sits after them'), position: 91 });

    const ids = (await list(worker)).map((preset) => preset.id);
    // Within one position the name decides, so mmm comes before zzz.
    expect(ids.indexOf(mike.id)).toBeLessThan(ids.indexOf(zulu.id));
    // And the position outranks the name: aaa is last because 91 is after 90.
    expect(ids.indexOf(zulu.id)).toBeLessThan(ids.indexOf(alpha.id));

    for (const preset of [zulu, mike, alpha]) await remove(worker, preset.id);
  });

  it('is edited by somebody who did not write it', async () => {
    const written = await save(worker, { name: uniqueName('Shared edit') });

    const edited = await rpcOk<PresetRow>(other, 'app_save_ticket_preset', {
      ...args({ name: written.name, id: written.id }),
      p_title: 'Projector shows no signal at all',
      p_priority: 'urgent',
      p_position: 7,
    });

    expect(edited.id).toBe(written.id);
    expect(edited.title).toBe('Projector shows no signal at all');
    expect(edited.priority).toBe('urgent');
    expect(edited.position).toBe(7);
    // Attribution is who wrote it, and an edit by somebody else does not claim
    // otherwise.
    expect(edited.created_by).toBe(identity('owner').id);

    await remove(other, written.id);
  });

  it('is deleted by somebody who did not write it, and only once', async () => {
    const written = await save(worker, { name: uniqueName('Deleted by another') });
    await remove(other, written.id);

    expect((await list(worker)).some((preset) => preset.id === written.id)).toBe(false);

    const again = await rpcFails(other, 'app_delete_ticket_preset', { p_id: written.id });
    expect(again.message).toContain('no longer there');
  });

  it('refuses a second preset with the same name, whatever the case', async () => {
    const written = await save(worker, { name: uniqueName('One of a kind') });

    const refused = await rpcFails(other, 'app_save_ticket_preset', {
      ...args({ name: written.name.toUpperCase() }),
    });
    expect(refused.message).toContain('already exists');

    // Saving the row under its own name is not a duplicate of itself.
    const again = await save(worker, { id: written.id, name: written.name.toLowerCase() });
    expect(again.id).toBe(written.id);

    await remove(worker, written.id);
  });

  it('refuses a name or a title that is empty or too long', async () => {
    expect((await rpcFails(worker, 'app_save_ticket_preset', args({ name: '   ' }))).message).toContain(
      'Give the quick ticket a name',
    );
    expect(
      (await rpcFails(worker, 'app_save_ticket_preset', args({ name: 'x'.repeat(41) }))).message,
    ).toContain('40 characters at most');
    expect(
      (
        await rpcFails(
          worker,
          'app_save_ticket_preset',
          args({ name: uniqueName('No title'), title: '  ' }),
        )
      ).message,
    ).toContain('title for the queue');
    expect(
      (
        await rpcFails(
          worker,
          'app_save_ticket_preset',
          args({ name: uniqueName('Long title'), title: 'x'.repeat(121) }),
        )
      ).message,
    ).toContain('120 characters at most');
  });

  it('refuses a category or a priority the ticket vocabulary does not contain', async () => {
    const category = await rpcFails(
      worker,
      'app_save_ticket_preset',
      args({ name: uniqueName('Bad category'), category: 'toaster' }),
    );
    expect(category.message).toContain('Choose a category');

    const priority = await rpcFails(
      worker,
      'app_save_ticket_preset',
      args({ name: uniqueName('Bad priority'), priority: 'whenever' }),
    );
    expect(priority.message).toContain('Choose a priority');

    // And the vocabulary it does contain is the ticket's own.
    const labels = await rpcOk<Record<string, string>>(worker, 'app_category_labels');
    for (const value of Object.keys(labels)) {
      const saved = await save(worker, { name: uniqueName('Vocabulary'), category: value });
      expect(saved.category).toBe(value);
      await remove(worker, saved.id);
    }
  });

  it('holds the list at twelve, and still lets the twelfth be edited', async () => {
    const before = await list(worker);
    const added: string[] = [];

    while (before.length + added.length < 12) {
      const saved = await save(worker, { name: uniqueName(`Filler ${added.length}`) });
      added.push(saved.id);
    }

    expect((await list(worker)).length).toBe(12);

    const refused = await rpcFails(
      worker,
      'app_save_ticket_preset',
      args({ name: uniqueName('Thirteenth') }),
    );
    expect(refused.message).toContain('Twelve quick tickets is the limit');
    expect((await list(worker)).length).toBe(12);

    // The cap is on adding, never on correcting: an operator fixing a typo on
    // the twelfth row must not be told the list is full.
    const last = (await list(worker)).find((preset) => preset.id === added[added.length - 1]);
    if (!last) throw new Error('The twelfth preset was not in the list.');
    const corrected = await save(worker, {
      id: last.id,
      name: last.name,
      title: 'Corrected while the list was full',
    });
    expect(corrected.title).toBe('Corrected while the list was full');

    for (const id of added) await remove(worker, id);
    expect((await list(worker)).length).toBe(before.length);
  });

  it('records the name in the audit log, and never the issue', async () => {
    const name = uniqueName('Logged');
    const written = await save(admin, {
      name,
      issue: 'A sentence that must not reach the history.',
    });

    const afterSave = await rpcOk<AuditRow[]>(admin, 'app_audit_log', {
      p_kind: 'ticket_preset',
      p_limit: 50,
    });
    expect(afterSave[0].entity_type).toBe('account');
    expect(afterSave[0].summary).toBe(`Quick ticket added: ${name}.`);
    expect(afterSave[0].actor_id).toBe(identity('admin').id);
    expect(afterSave[0].actor_name).toBe(identity('admin').displayName);
    expect(afterSave[0].performed_via).toBe('user');
    expect(
      afterSave.some((row) => row.summary.includes('must not reach the history')),
    ).toBe(false);

    await save(worker, { id: written.id, name });
    const afterEdit = await rpcOk<AuditRow[]>(admin, 'app_audit_log', {
      p_kind: 'ticket_preset',
      p_limit: 50,
    });
    expect(afterEdit[0].summary).toBe(`Quick ticket edited: ${name}.`);
    expect(afterEdit[0].actor_id).toBe(identity('owner').id);

    await remove(worker, written.id);
    const afterDelete = await rpcOk<AuditRow[]>(admin, 'app_audit_log', {
      p_kind: 'ticket_preset',
      p_limit: 50,
    });
    expect(afterDelete[0].summary).toBe(`Quick ticket deleted: ${name}.`);
  });

  it('is closed to a skills officer, who does not work tickets', async () => {
    // The read is empty rather than an error: the row policy is what answers
    // it, exactly as it answers every ticket read they make.
    expect(await list(officer)).toEqual([]);

    const written = await rpcFails(
      officer,
      'app_save_ticket_preset',
      args({ name: uniqueName('Not mine to write') }),
    );
    expect(written.message).toContain('does not work tickets');

    const seeded = (await list(worker))[0];
    const deleted = await rpcFails(officer, 'app_delete_ticket_preset', { p_id: seeded.id });
    expect(deleted.message).toContain('does not work tickets');

    // And nothing happened: the preset they tried to delete is still there.
    expect((await list(worker)).some((preset) => preset.id === seeded.id)).toBe(true);
  });

  it('is closed to an account that is not active', async () => {
    const refused = await rpcFails(
      inactive,
      'app_save_ticket_preset',
      args({ name: uniqueName('Let me in') }),
    );
    expect(refused.message).toContain('cannot access helpdesk records');

    const read = await inactive.from('ticket_presets').select('id');
    expect(read.error).toBeNull();
    expect(read.data).toHaveLength(0);
  });

  it('is closed to a session that never signed in', async () => {
    const anon = anonClient();
    // anon has EXECUTE on none of the three, so it is refused before any body
    // runs rather than answered with nothing.
    expect((await rpcFails(anon, 'app_list_ticket_presets')).message).not.toBe('');
    expect(
      (await rpcFails(anon, 'app_save_ticket_preset', args({ name: 'Anonymous' }))).message,
    ).not.toBe('');

    const read = await anon.from('ticket_presets').select('id');
    expect(read.error).not.toBeNull();
  });

  it('is readable as a row but not writable as one', async () => {
    const read = await worker.from('ticket_presets').select('id, name');
    expect(read.error).toBeNull();
    expect((read.data ?? []).length).toBeGreaterThanOrEqual(3);

    const seeded = (await list(worker))[0];

    // The functions are the one door. A direct write has no grant behind it, so
    // the cap, the vocabularies, the attribution and the history entry cannot
    // be walked around.
    const updated = await worker
      .from('ticket_presets')
      .update({ name: 'Straight in' })
      .eq('id', seeded.id);
    expect(updated.error).not.toBeNull();

    const inserted = await worker
      .from('ticket_presets')
      .insert({ name: 'Straight in', title: 'Straight in', category: 'other' });
    expect(inserted.error).not.toBeNull();

    const deleted = await worker.from('ticket_presets').delete().eq('id', seeded.id);
    expect(deleted.error).not.toBeNull();

    expect((await list(worker)).map((preset) => preset.name)).toContain(SEEDED[0]);
  });
});
