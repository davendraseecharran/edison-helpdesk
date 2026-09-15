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

  it('says plainly to an administrator that every administrator tool asks', () => {
    const prompt = promptFor(['admin']);
    expect(prompt).toMatch(/EVERY one of those is put to this person for approval/);
    expect(prompt).toContain('list_audit');
    expect(prompt).toContain('export_backup');
    // And the two that were new abilities rather than new words for old ones.
    expect(prompt).toMatch(/deactivating and reactivating accounts/);
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
