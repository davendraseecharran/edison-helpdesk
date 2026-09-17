import { describe, expect, it } from 'vitest';
import { systemInstructions, titleFromMessage } from '../../src/lib/ai/prompt';
import { ADMIN_TOOLS, toolsFor } from '../../src/lib/ai/tools';

/**
 * What the assistant is told, checked against what it can actually do.
 *
 * A prompt that describes abilities the tool table no longer has is worse than
 * one that says nothing: the model tries them, the call fails, and the person
 * is told about a feature that is gone. So the two are pinned to each other.
 */

function promptFor(roles: ('admin' | 'netrider' | 'skills_officer')[]): string {
  return systemInstructions({ actorName: 'Nia Example', roles, today: '2026-09-15' });
}

describe('systemInstructions', () => {
  it('names who is asking, what today is, and what they may do', () => {
    const prompt = promptFor(['netrider']);
    expect(prompt).toContain('Nia Example');
    expect(prompt).toContain('2026-09-15');
    expect(prompt).toContain('NetRider');
  });

  it('describes no ability the tool table has taken away', () => {
    // The in-app importer went with P2; a prompt still promising a dry run
    // would have the model reaching for a tool that is not there.
    for (const prompt of [promptFor(['admin']), promptFor(['netrider'])]) {
      expect(prompt).not.toMatch(/importer/i);
      expect(prompt).not.toMatch(/dry run/i);
      expect(prompt).not.toContain('import_csv');
    }
  });

  it('tells the assistant a picture lives for one message', () => {
    const prompt = promptFor(['netrider']);
    expect(prompt).toContain('attach_to_ticket');
    expect(prompt).toMatch(/arrived in and no longer/);
  });

  it('tells it that settings are the person’s own', () => {
    const prompt = promptFor(['netrider']);
    expect(prompt).toContain('set_preference');
    expect(prompt).toContain('ai_confirm_changes');
    expect(prompt).toMatch(/nobody else/i);
  });

  it('tells it that every setting is reachable, and which are not', () => {
    const prompt = promptFor(['netrider']);
    expect(prompt).toMatch(/whether or not they can find the control/);
    expect(prompt).toContain('set_display_name');
    expect(prompt).toContain('update_shared_notes');
    // Signing in is the browser's: linking Google, passwords, pairing a phone.
    expect(prompt).toMatch(/Signing in is not yours/);
    expect(prompt).toMatch(/pairing a phone as a scanner/);
  });

  it('tells it what to do with a sheet, a CSV or a screenshot of one', () => {
    const prompt = promptFor(['netrider']);
    expect(prompt).toMatch(/Spreadsheets, CSVs and screenshots of them/);
    // Read it, say what was read and mapped, then ONE bulk call.
    expect(prompt).toMatch(/say how many rows you read and which column you took for which field/);
    expect(prompt).toMatch(/Never call the single-record tool once per row/);
    for (const name of [
      'create_tickets',
      'import_resolved_tickets',
      'import_people',
      'claim_tickets',
      'set_checklist_marks',
      'bulk_assign_devices',
      'bulk_return_devices',
    ]) {
      expect(prompt).toContain(name);
    }
    // Ambiguity is one question, not a refusal and not a guess.
    expect(prompt).toMatch(/ask ONCE, in one message/);
    // A batch is a change: the application asks once, and the model does not.
    expect(prompt).toMatch(/A bulk change is a change/);
    expect(prompt).toMatch(/put to them once, as one card/);
    // And the counts come back as the tool gave them.
    expect(prompt).toMatch(/how many were made, how many were skipped, how many were refused/);
    expect(prompt).toMatch(/Never round a partial result up/);
  });

  it('names only the bulk tools a skills officer actually has', () => {
    const prompt = promptFor(['skills_officer']);
    expect(prompt).toContain('import_people');
    expect(prompt).toContain('set_checklist_marks');
    for (const name of ['create_tickets', 'claim_tickets', 'import_resolved_tickets', 'bulk_assign_devices']) {
      expect(prompt).not.toContain(name);
    }
    // The quick-ticket paragraph is the ticket desk's.
    expect(prompt).not.toContain('list_presets');
    expect(promptFor(['netrider'])).toContain('list_presets');
  });

  it('tells it to look for an open duplicate before opening a ticket, and that exports are links', () => {
    const prompt = promptFor(['netrider']);
    expect(prompt).toMatch(/search for an open one about the same thing/);
    expect(prompt).toMatch(/never hand you the file/);
    expect(prompt).toContain('export_devices_csv');
  });

  it('says plainly to an administrator that every administrator tool asks', () => {
    const prompt = promptFor(['admin']);
    expect(prompt).toMatch(/EVERY one of those is put to this person for approval/);
    expect(prompt).toContain('list_audit');
    expect(prompt).toContain('export_backup');
    // And the two that were new abilities rather than new words for old ones.
    expect(prompt).toMatch(/deactivating and reactivating accounts/);
    // The two administrator reads added for parity, and the two changes.
    expect(prompt).toContain('list_invites');
    expect(prompt).toContain('list_access_requests');
    expect(prompt).toMatch(/revoking them/);
    expect(prompt).toMatch(/deleting a group/);
  });

  it('says nothing about administrator tools to somebody who has none', () => {
    const prompt = promptFor(['netrider']);
    for (const name of ADMIN_TOOLS) expect(prompt).not.toContain(name);
    expect(toolsFor(['netrider']).map((tool) => tool.name)).not.toContain('list_audit');
  });

  it('tells a skills officer why there are no ticket tools in the conversation', () => {
    const prompt = promptFor(['skills_officer']);
    expect(prompt).toMatch(/does not work tickets/);
    expect(prompt).toMatch(/no ticket tools in this conversation/);
  });

  it('names the record on screen when there is one', () => {
    const prompt = systemInstructions({
      actorName: 'Nia Example',
      roles: ['netrider'],
      today: '2026-09-15',
      page: { kind: 'ticket', id: 'abc', label: 'EDT-1042' },
    });
    expect(prompt).toContain('EDT-1042');
    expect(prompt).toContain('"this one"');
  });
});

describe('titleFromMessage', () => {
  it('uses the message when it fits a sidebar row', () => {
    expect(titleFromMessage('  Projector in 214 will not wake  ')).toBe('Projector in 214 will not wake');
  });

  it('names an empty message rather than leaving a blank row', () => {
    expect(titleFromMessage('   ')).toBe('New conversation');
  });

  it('cuts a long one at a word boundary', () => {
    const title = titleFromMessage('x'.repeat(20) + ' ' + 'y'.repeat(80));
    expect(title.endsWith('…')).toBe(true);
    expect(title.length).toBeLessThanOrEqual(61);
  });
});
