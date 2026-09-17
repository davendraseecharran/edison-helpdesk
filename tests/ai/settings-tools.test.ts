/**
 * Everything on the Settings screen the assistant can now reach, with no
 * database behind it.
 *
 * Three things are pinned:
 *
 *   1. Each tool calls the RPC the screen's own control calls, with the same
 *      argument names, so a change made by asking is the change made by
 *      clicking.
 *   2. The refusals the screen makes before a round trip are made here too,
 *      in the same sentence: a one-letter name, a thirteenth quick ticket, a
 *      note over the cap.
 *   3. The quick-ticket list is the ticket desk's. A skills officer is not
 *      offered it, and the settings that are theirs stay theirs.
 */

import { describe, expect, it } from 'vitest';
import {
  executeTool,
  isWriteTool,
  requiresApproval,
  toolsFor,
  validateArgs,
  type ToolContext,
} from '../../src/lib/ai/tools';

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

function context(
  options: {
    results?: Record<string, unknown | ((args: Record<string, unknown>) => unknown)>;
    roles?: string[];
    error?: { code: string; message: string };
  } = {},
): { ctx: ToolContext; calls: Call[] } {
  const calls: Call[] = [];
  const ctx = {
    supabase: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        if (options.error !== undefined) return { data: null, error: options.error };
        const results = options.results ?? {};
        const found = fn in results ? results[fn] : null;
        return { data: typeof found === 'function' ? found(args) : found, error: null };
      },
    },
    actor: { id: 'actor-1', displayName: 'Nia Example', roles: options.roles ?? ['netrider'] },
  } as unknown as ToolContext;
  return { ctx, calls };
}

const PROJECTOR = 'dddddddd-1111-4111-8111-111111111111';
const CHROMEBOOK = 'dddddddd-2222-4222-8222-222222222222';
const PRINTER = 'dddddddd-3333-4333-8333-333333333333';

const PRESETS = [
  {
    id: PROJECTOR,
    name: 'Projector',
    title: 'Projector will not wake',
    issue: 'No signal on the podium.',
    category: 'projector_display',
    priority: 'high',
    location: '',
    position: 0,
  },
  {
    id: CHROMEBOOK,
    name: 'Chromebook swap',
    title: 'Chromebook swap',
    issue: '',
    category: 'chromebook',
    priority: 'normal',
    location: 'Library',
    position: 1,
  },
  {
    id: PRINTER,
    name: 'Printer jam',
    title: 'Printer jammed',
    issue: '',
    category: 'printer',
    priority: 'low',
    location: '',
    position: 2,
  },
];

describe('set_display_name', () => {
  it('sends the trimmed name to the RPC the Save button calls', async () => {
    const { ctx, calls } = context({});
    const result = await executeTool('set_display_name', { name: '  Nia Okonkwo ' }, ctx);
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ fn: 'app_update_display_name', args: { p_name: 'Nia Okonkwo' } }]);
    expect(result.summary).toBe('Changed your display name to Nia Okonkwo');
  });

  it('refuses a name the screen would refuse, before any round trip', async () => {
    const { ctx, calls } = context({});
    const result = await executeTool('set_display_name', { name: 'N' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/between 2 and 80 characters/);
    expect(calls).toEqual([]);
    expect(validateArgs('set_display_name', { name: 'x'.repeat(81) }).ok).toBe(false);
  });

  it('is everybody’s own, and follows the confirmation setting', () => {
    for (const roles of [['netrider'], ['skills_officer'], ['admin']]) {
      expect(toolsFor(roles as never).map((tool) => tool.name)).toContain('set_display_name');
    }
    expect(isWriteTool('set_display_name')).toBe(true);
    expect(requiresApproval('set_display_name', { name: 'Nia' }, false)).toBe(false);
    expect(requiresApproval('set_display_name', { name: 'Nia' }, true)).toBe(true);
  });
});

describe('update_shared_notes', () => {
  it('writes the whole note through the shared-notes RPC', async () => {
    const { ctx, calls } = context({});
    const result = await executeTool(
      'update_shared_notes',
      { notes: ' Room 214 is the repair bench. ' },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      { fn: 'app_set_assistant_notes_shared', args: { p_body: 'Room 214 is the repair bench.' } },
    ]);
    expect(result.summary).toBe('Saved the shared notes (29 characters)');
  });

  it('clears them when the text is left out', async () => {
    const { ctx, calls } = context({});
    const result = await executeTool('update_shared_notes', {}, ctx);
    expect(result.ok).toBe(true);
    expect(calls[0].args).toEqual({ p_body: '' });
    expect(result.summary).toBe('Cleared the shared notes');
  });

  it('holds the note to the length the box holds it to', () => {
    expect(validateArgs('update_shared_notes', { notes: 'x'.repeat(600) }).ok).toBe(true);
    expect(validateArgs('update_shared_notes', { notes: 'x'.repeat(601) }).ok).toBe(false);
  });

  it('is offered to every role, because every active account may edit the box', () => {
    for (const roles of [['netrider'], ['skills_officer'], ['admin']]) {
      expect(toolsFor(roles as never).map((tool) => tool.name)).toContain('update_shared_notes');
    }
  });
});

describe('set_preference assistant_notes', () => {
  it('writes the personal note under the column the RPC whitelists', async () => {
    const { ctx, calls } = context({});
    const result = await executeTool(
      'set_preference',
      { key: 'assistant_notes', value: 'I work the morning shift.' },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(calls).toEqual([
      { fn: 'app_update_preferences', args: { p_patch: { assistant_notes: 'I work the morning shift.' } } },
    ]);
    expect(result.summary).toBe('Saved your notes for the assistant');
  });

  it('takes the note off with the word people say', async () => {
    const { ctx, calls } = context({});
    const result = await executeTool('set_preference', { key: 'assistant_notes', value: 'clear' }, ctx);
    expect(result.ok).toBe(true);
    expect(calls[0].args).toEqual({ p_patch: { assistant_notes: '' } });
    expect(result.summary).toBe('Cleared your notes for the assistant');
  });

  it('refuses a note over the cap rather than cutting it silently', async () => {
    const { ctx, calls } = context({});
    const result = await executeTool(
      'set_preference',
      { key: 'assistant_notes', value: 'x'.repeat(601) },
      ctx,
    );
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/600 characters/);
    expect(calls).toEqual([]);
  });

  it('covers every key app_update_preferences accepts', () => {
    // The eight keys the RPC whitelists (20260916160200), and nothing else.
    const offered = toolsFor(['netrider']).find((tool) => tool.name === 'set_preference');
    const keys = offered?.parameters.properties.key.enum ?? [];
    expect([...keys].sort()).toEqual(
      [
        'ai_confirm_changes',
        'ai_reasoning',
        'ai_speak_replies',
        'ai_welcome_states',
        'assistant_notes',
        'gmail_mode',
        'notify_in_app',
        'theme',
      ].sort(),
    );
  });
});

describe('list_presets', () => {
  it('reads the list in the desk’s order', async () => {
    const { ctx, calls } = context({ results: { app_list_ticket_presets: [PRESETS[2], PRESETS[0], PRESETS[1]] } });
    const result = await executeTool('list_presets', {}, ctx);
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ fn: 'app_list_ticket_presets', args: {} }]);
    expect((result.result as { name: string }[]).map((preset) => preset.name)).toEqual([
      'Projector',
      'Chromebook swap',
      'Printer jam',
    ]);
    expect(result.summary).toBe('Listed 3 quick tickets.');
  });

  it('belongs to the ticket desk: a skills officer is not offered it', () => {
    const skills = toolsFor(['skills_officer']).map((tool) => tool.name);
    for (const name of ['list_presets', 'save_preset', 'delete_preset', 'move_preset']) {
      expect(skills).not.toContain(name);
      expect(toolsFor(['netrider']).map((tool) => tool.name)).toContain(name);
    }
  });
});

describe('save_preset', () => {
  it('adds one with the fields the settings form sends, defaults filled', async () => {
    const { ctx, calls } = context({
      results: { app_list_ticket_presets: PRESETS, app_save_ticket_preset: { id: 'new-1' } },
    });
    const result = await executeTool(
      'save_preset',
      { name: 'Password reset', title: 'Password reset', category: 'account' },
      ctx,
    );
    expect(result.ok).toBe(true);
    expect(calls.find((call) => call.fn === 'app_save_ticket_preset')?.args).toEqual({
      p_id: null,
      p_name: 'Password reset',
      p_title: 'Password reset',
      p_issue: '',
      p_category: 'account',
      p_priority: 'normal',
      p_location: '',
      p_position: null,
    });
    expect(result.summary).toBe('Added the quick ticket Password reset');
  });

  it('changes only the fields sent on an existing one, and keeps its place', async () => {
    const { ctx, calls } = context({
      results: { app_list_ticket_presets: PRESETS, app_save_ticket_preset: PRESETS[1] },
    });
    const result = await executeTool(
      'save_preset',
      { preset: 'chromebook', priority: 'high' },
      ctx,
    );
    expect(result.ok).toBe(true);
    const saved = calls.find((call) => call.fn === 'app_save_ticket_preset')?.args;
    expect(saved?.p_id).toBe(CHROMEBOOK);
    expect(saved?.p_priority).toBe('high');
    // Everything else exactly as it was, including the row's own position.
    expect(saved?.p_title).toBe('Chromebook swap');
    expect(saved?.p_location).toBe('Library');
    expect(saved?.p_position).toBe(1);
    expect(result.summary).toBe('Changed the quick ticket Chromebook swap');
  });

  it('refuses a thirteenth in the screen’s words, before the round trip', async () => {
    const twelve = Array.from({ length: 12 }, (_, at) => ({
      ...PRESETS[0],
      id: `${PROJECTOR.slice(0, -1)}${at.toString(16)}`,
      name: `Preset ${at}`,
    }));
    const { ctx, calls } = context({ results: { app_list_ticket_presets: twelve } });
    const result = await executeTool('save_preset', { name: 'One more', title: 'One more' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/12 quick tickets/);
    expect(calls.map((call) => call.fn)).not.toContain('app_save_ticket_preset');
  });

  it('refuses a new one with no name, and an edit with nothing to change', async () => {
    const empty = context({ results: { app_list_ticket_presets: PRESETS } });
    const nameless = await executeTool('save_preset', { title: 'Untitled' }, empty.ctx);
    expect(nameless.ok).toBe(false);
    expect(nameless.summary).toMatch(/name/);

    const idle = context({ results: { app_list_ticket_presets: PRESETS } });
    const nothing = await executeTool('save_preset', { preset: 'Projector' }, idle.ctx);
    expect(nothing.ok).toBe(false);
    expect(nothing.summary).toMatch(/what to change/);
    expect(idle.calls.map((call) => call.fn)).not.toContain('app_save_ticket_preset');
  });

  it('refuses a tie between two quick tickets rather than picking one', async () => {
    const { ctx } = context({
      results: {
        app_list_ticket_presets: [
          ...PRESETS,
          { ...PRESETS[0], id: 'dddddddd-4444-4444-8444-444444444444', name: 'Printer toner', position: 3 },
        ],
      },
    });
    const result = await executeTool('save_preset', { preset: 'printer', issue: 'x' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/Printer jam.*Printer toner|Printer toner.*Printer jam/);
  });
});

describe('delete_preset', () => {
  it('deletes the one named', async () => {
    const { ctx, calls } = context({ results: { app_list_ticket_presets: PRESETS } });
    const result = await executeTool('delete_preset', { preset: 'Printer jam' }, ctx);
    expect(result.ok).toBe(true);
    expect(calls.find((call) => call.fn === 'app_delete_ticket_preset')?.args).toEqual({ p_id: PRINTER });
    expect(result.summary).toBe('Removed the quick ticket Printer jam');
  });

  it('names what there is when asked for one that is not', async () => {
    const { ctx, calls } = context({ results: { app_list_ticket_presets: PRESETS } });
    const result = await executeTool('delete_preset', { preset: 'Smartboard' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Projector');
    expect(calls.map((call) => call.fn)).not.toContain('app_delete_ticket_preset');
  });
});

describe('move_preset', () => {
  it('writes only the rows whose position changes, from the list as the database has it', async () => {
    const { ctx, calls } = context({ results: { app_list_ticket_presets: PRESETS } });
    const result = await executeTool('move_preset', { preset: 'Printer jam', direction: 'up' }, ctx);
    expect(result.ok).toBe(true);
    const writes = calls.filter((call) => call.fn === 'app_save_ticket_preset');
    expect(writes.map((call) => [call.args.p_id, call.args.p_position])).toEqual([
      [PRINTER, 1],
      [CHROMEBOOK, 2],
    ]);
    // The rest of each row travels with it: the writer is a whole-row save.
    expect(writes[0].args.p_title).toBe('Printer jammed');
    expect(result.summary).toBe('Moved Printer jam up');
  });

  it('writes nothing for a move off the end, and says so', async () => {
    const { ctx, calls } = context({ results: { app_list_ticket_presets: PRESETS } });
    const result = await executeTool('move_preset', { preset: 'Projector', direction: 'up' }, ctx);
    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.fn)).not.toContain('app_save_ticket_preset');
    expect(result.summary).toMatch(/already at the top/);
  });

  it('takes only up or down', () => {
    expect(validateArgs('move_preset', { preset: 'Projector', direction: 'sideways' }).ok).toBe(false);
  });
});
