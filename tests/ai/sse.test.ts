import { describe, expect, it } from 'vitest';
import { newSseState, parseSse, type ResponsesEvent } from '../../src/lib/ai/responses-client';

function frame(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

describe('parseSse', () => {
  it('returns nothing until a frame is complete', () => {
    const state = newSseState();
    const whole = frame({ type: 'response.output_text.delta', delta: 'Hello' });
    const cut = whole.length - 4;

    expect(parseSse(whole.slice(0, cut), state)).toEqual([]);
    expect(parseSse(whole.slice(cut), state)).toEqual([{ type: 'text_delta', text: 'Hello' }]);
  });

  it('handles a frame split in the middle of the JSON', () => {
    const state = newSseState();
    const whole = frame({ type: 'response.output_text.delta', delta: 'half and half' });
    const half = Math.floor(whole.length / 2);

    const first = parseSse(whole.slice(0, half), state);
    const second = parseSse(whole.slice(half), state);
    expect([...first, ...second]).toEqual([{ type: 'text_delta', text: 'half and half' }]);
  });

  it('reads several events out of one chunk', () => {
    const state = newSseState();
    const events = parseSse(
      frame({ type: 'response.output_text.delta', delta: 'a' }) +
        frame({ type: 'response.output_text.delta', delta: 'b' }) +
        frame({ type: 'response.completed', response: { id: 'resp_1' } }),
      state,
    );

    expect(events).toEqual([
      { type: 'text_delta', text: 'a' },
      { type: 'text_delta', text: 'b' },
      { type: 'done', responseId: 'resp_1' },
    ]);
  });

  it('accepts CRLF line endings and an event: line before the data', () => {
    const state = newSseState();
    const chunk =
      'event: response.output_text.delta\r\n' +
      `data: ${JSON.stringify({ type: 'response.output_text.delta', delta: 'crlf' })}\r\n\r\n`;
    expect(parseSse(chunk, state)).toEqual([{ type: 'text_delta', text: 'crlf' }]);
  });

  it('joins a data payload that the server wrote over several data lines', () => {
    const state = newSseState();
    const chunk = 'data: {"type":"response.output_text.delta",\ndata: "delta":"joined"}\n\n';
    expect(parseSse(chunk, state)).toEqual([{ type: 'text_delta', text: 'joined' }]);
  });

  it('ignores comments, blank keepalives and [DONE]', () => {
    const state = newSseState();
    expect(parseSse(': keepalive\n\n', state)).toEqual([]);
    expect(parseSse('data: [DONE]\n\n', state)).toEqual([]);
    expect(parseSse('\n\n', state)).toEqual([]);
  });

  it('ignores a frame whose data is not JSON rather than throwing', () => {
    const state = newSseState();
    expect(parseSse('data: not json\n\n', state)).toEqual([]);
  });

  it('reports reasoning summary and reasoning text as reasoning deltas', () => {
    const state = newSseState();
    const events = parseSse(
      frame({ type: 'response.reasoning_summary_text.delta', delta: 'thinking' }) +
        frame({ type: 'response.reasoning_text.delta', delta: ' more' }),
      state,
    );
    expect(events).toEqual([
      { type: 'reasoning_delta', text: 'thinking' },
      { type: 'reasoning_delta', text: ' more' },
    ]);
  });

  it('reads a function call out of a completed output item', () => {
    const state = newSseState();
    const item = {
      type: 'function_call',
      id: 'fc_1',
      call_id: 'call_abc',
      name: 'claim_ticket',
      arguments: '{"ticket":"EDT-1042"}',
    };
    const events = parseSse(frame({ type: 'response.output_item.done', item }), state);

    expect(events).toEqual([
      { type: 'output_item', item },
      { type: 'function_call', callId: 'call_abc', name: 'claim_ticket', args: '{"ticket":"EDT-1042"}' },
    ]);
  });

  it('reports every completed output item so the turn can be stored', () => {
    const state = newSseState();
    const item = { type: 'reasoning', id: 'rs_1', encrypted_content: 'xyz', summary: [] };
    expect(parseSse(frame({ type: 'response.output_item.done', item }), state)).toEqual([
      { type: 'output_item', item },
    ]);
  });

  it('turns a failed response into one error event', () => {
    const state = newSseState();
    const events = parseSse(
      frame({
        type: 'response.failed',
        response: { error: { code: 'rate_limit_exceeded', message: 'Slow down.' } },
      }),
      state,
    );
    expect(events).toEqual([{ type: 'error', message: 'Slow down.' }]);
  });

  it('turns a bare error frame into an error event', () => {
    const state = newSseState();
    expect(parseSse(frame({ type: 'error', message: 'Bad gateway.' }), state)).toEqual([
      { type: 'error', message: 'Bad gateway.' },
    ]);
  });

  it('carries nothing between two states', () => {
    const first = newSseState();
    parseSse('data: {"type":"response.output_te', first);
    const second = newSseState();
    expect(parseSse(frame({ type: 'response.output_text.delta', delta: 'clean' }), second)).toEqual(
      [{ type: 'text_delta', text: 'clean' } satisfies ResponsesEvent],
    );
  });
});
