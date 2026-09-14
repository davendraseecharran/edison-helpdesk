import { describe, expect, it } from 'vitest';
import {
  flattenStored,
  MAX_REPLAY_ITEMS,
  MAX_ROW_BYTES,
  splitForRows,
  toolOutputItem,
  trimItems,
  userItem,
} from '../../src/lib/ai/conversations';

/**
 * The shapes the Responses API actually produces for one assistant turn that
 * decided to call a tool. The order inside this array is the whole point: the
 * reasoning item has to arrive before the function_call it belongs to.
 */
const TURN = [
  { type: 'reasoning', id: 'rs_1', encrypted_content: 'abc', summary: [] },
  { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'claim_ticket', arguments: '{}' },
];

describe('flattenStored', () => {
  it('keeps the order of items inside one stored batch', () => {
    const { items } = flattenStored([TURN]);
    expect(items.map((item) => item.type)).toEqual(['reasoning', 'function_call']);
  });

  it('keeps the order of batches, and the order within each', () => {
    const { items } = flattenStored([
      [userItem('claim EDT-1042')],
      TURN,
      [toolOutputItem('call_1', { ok: true })],
    ]);
    expect(items.map((item) => item.type)).toEqual([
      'message',
      'reasoning',
      'function_call',
      'function_call_output',
    ]);
  });

  it('still reads a row written one item at a time', () => {
    // Conversations stored before batches shared a row have to keep replaying.
    const { items } = flattenStored([TURN[0], TURN[1]]);
    expect(items.map((item) => item.type)).toEqual(['reasoning', 'function_call']);
  });

  it('takes pending approvals out of the item list', () => {
    const call = { callId: 'call_9', name: 'resolve_ticket', args: {}, summary: 'Resolve ticket' };
    const { items, pending } = flattenStored([TURN, { pending: true, call }]);
    expect(items).toHaveLength(2);
    expect(pending).toEqual([call]);
  });

  it('ignores a row whose content is neither an item nor a batch', () => {
    const { items, pending } = flattenStored([null, 'nonsense', 42, []]);
    expect(items).toEqual([]);
    expect(pending).toEqual([]);
  });
});

describe('trimItems', () => {
  function conversation(turns: number) {
    const items = [userItem('the original question')];
    for (let at = 0; at < turns; at += 1) {
      items.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: `${at}` }] });
      items.push(userItem(`follow up ${at}`));
    }
    return items;
  }

  it('leaves a short conversation alone', () => {
    const items = conversation(3);
    expect(trimItems(items)).toEqual(items);
  });

  it('caps a long conversation at the replay limit plus the first question', () => {
    const items = conversation(200);
    const trimmed = trimItems(items);
    expect(trimmed.length).toBe(MAX_REPLAY_ITEMS + 1);
  });

  it('always keeps the first user message', () => {
    const items = conversation(200);
    const trimmed = trimItems(items);
    expect(trimmed[0]).toBe(items[0]);
  });

  it('does not duplicate the first message when it is still in the window', () => {
    const items = conversation(2);
    const trimmed = trimItems(items, 100);
    expect(trimmed.filter((item) => item === items[0])).toHaveLength(1);
  });

  it('keeps the most recent items', () => {
    const items = conversation(200);
    const trimmed = trimItems(items);
    expect(trimmed[trimmed.length - 1]).toBe(items[items.length - 1]);
  });

  it('drops a tool output whose call fell outside the window', () => {
    // The API refuses a function_call_output with no matching function_call, so
    // a naive tail would turn a long conversation into a hard failure.
    const items = [
      userItem('start'),
      { type: 'function_call', call_id: 'call_old', name: 'get_ticket', arguments: '{}' },
      ...conversation(60).slice(1),
      toolOutputItem('call_old', { ok: true }),
    ];
    const trimmed = trimItems(items, 10);
    expect(trimmed.some((item) => item.type === 'function_call_output')).toBe(false);
  });

  it('keeps a tool output whose call is still in the window', () => {
    const items = [
      userItem('start'),
      { type: 'function_call', call_id: 'call_new', name: 'get_ticket', arguments: '{}' },
      toolOutputItem('call_new', { ok: true }),
    ];
    expect(trimItems(items, 10)).toHaveLength(3);
  });

  it('keeps a trailing function call that has no output yet', () => {
    // That is exactly the pending-approval shape, and it has to survive.
    const items = [
      userItem('resolve it'),
      { type: 'function_call', call_id: 'call_p', name: 'resolve_ticket', arguments: '{}' },
    ];
    expect(trimItems(items, 10)).toEqual(items);
  });

  it('keeps reasoning that introduces a function call', () => {
    const items = [userItem('claim EDT-1042'), ...TURN];
    expect(trimItems(items, 10)).toEqual(items);
  });

  it('keeps several reasoning items introducing one function call', () => {
    const items = [
      userItem('claim EDT-1042'),
      { type: 'reasoning', id: 'rs_a', encrypted_content: 'a', summary: [] },
      { type: 'reasoning', id: 'rs_b', encrypted_content: 'b', summary: [] },
      TURN[1],
    ];
    expect(trimItems(items, 10)).toEqual(items);
  });

  it('keeps reasoning that introduces the assistant reply', () => {
    const items = [
      userItem('how many are open'),
      { type: 'reasoning', id: 'rs_c', encrypted_content: 'c', summary: [] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Twelve.' }] },
    ];
    expect(trimItems(items, 10)).toEqual(items);
  });

  it('drops a trailing reasoning item left by a round that failed', () => {
    // The API refuses a reasoning item without the item it has to precede, and
    // the item is in the HISTORY, so every later turn would fail the same way.
    const items = [
      userItem('claim EDT-1042'),
      { type: 'reasoning', id: 'rs_lost', encrypted_content: 'x', summary: [] },
    ];
    expect(trimItems(items, 10)).toEqual([items[0]]);
  });

  it('drops a reasoning item stranded mid-history by a failed round', () => {
    const items = [
      userItem('claim EDT-1042'),
      { type: 'reasoning', id: 'rs_lost', encrypted_content: 'x', summary: [] },
      userItem('are you there'),
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Yes.' }] },
    ];
    expect(trimItems(items, 10).map((item) => item.id)).not.toContain('rs_lost');
    expect(trimItems(items, 10)).toHaveLength(3);
  });
});

describe('splitForRows', () => {
  const big = (bytes: number, id: string) => ({ type: 'reasoning', id, encrypted_content: 'x'.repeat(bytes) });

  it('leaves an ordinary batch as one row', () => {
    expect(splitForRows(TURN)).toEqual([TURN]);
  });

  it('writes nothing for an empty batch', () => {
    expect(splitForRows([])).toEqual([]);
  });

  it('splits a batch over the budget into sequential rows, in order', () => {
    const items = [big(80_000, 'a'), big(80_000, 'b'), big(80_000, 'c')];
    const groups = splitForRows(items, 200_000);
    expect(groups.length).toBeGreaterThan(1);
    expect(groups.flat()).toEqual(items);
  });

  it('never puts more than the budget in one row', () => {
    const items = Array.from({ length: 9 }, (_, at) => big(40_000, `i${at}`));
    for (const group of splitForRows(items, 200_000)) {
      expect(JSON.stringify(group).length).toBeLessThanOrEqual(200_000);
    }
  });

  it('gives an item larger than the budget a row of its own', () => {
    const items = [big(10, 'small'), big(300_000, 'huge'), big(10, 'after')];
    const groups = splitForRows(items, 200_000);
    expect(groups.map((group) => group.map((item) => item.id))).toEqual([
      ['small'],
      ['huge'],
      ['after'],
    ]);
  });

  it('stays under the 256 KiB row constraint by default', () => {
    expect(MAX_ROW_BYTES).toBeLessThan(262_144);
  });
});

describe('toolOutputItem', () => {
  it('names the call it answers', () => {
    const item = toolOutputItem('call_1', { ok: true });
    expect(item.type).toBe('function_call_output');
    expect(item.call_id).toBe('call_1');
    expect(JSON.parse(item.output as string)).toEqual({ ok: true });
  });

  it('truncates a result too large to send, and says so', () => {
    const item = toolOutputItem('call_1', { rows: 'x'.repeat(50_000) });
    const output = JSON.parse(item.output as string) as Record<string, unknown>;
    expect(output.truncated).toBe(true);
    expect(String(output.note)).toMatch(/too long/i);
    expect((item.output as string).length).toBeLessThan(30_000);
  });
});
