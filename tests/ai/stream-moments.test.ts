/**
 * Which orb a stream line asks for.
 *
 * The rule that needs pinning is the one about `phase`: the route sends
 * `{ phase: 'tool' }` before it knows which tool is coming, so that line must
 * leave the orb where it is. The `tool_call` right behind it is what names the
 * work, and it is the only line that may say "reading" or "changing".
 */

import { describe, expect, it } from 'vitest';
import { momentForLine } from '../../src/components/ai/useAiChat';

describe('momentForLine', () => {
  it('leaves the moment alone for a tool phase, so no read orb flashes before a write', () => {
    expect(momentForLine({ type: 'phase', phase: 'tool' })).toBeNull();
  });

  it('follows the tool_call that names the work', () => {
    expect(momentForLine({ type: 'tool_call', name: 'get_ticket' })).toBe('reading');
    expect(momentForLine({ type: 'tool_call', name: 'claim_ticket' })).toBe('changing');
    expect(momentForLine({ type: 'tool_call', name: 'claim_ticket', needsApproval: true })).toBe(
      'approval',
    );
  });

  it('maps the phases it can be sure about', () => {
    expect(momentForLine({ type: 'phase', phase: 'writing' })).toBe('writing');
    expect(momentForLine({ type: 'phase', phase: 'thinking' })).toBe('sending');
    expect(momentForLine({ type: 'reasoning', text: 'Looking.' })).toBe('reasoning');
    expect(momentForLine({ type: 'delta', text: 'Three' })).toBe('writing');
    expect(momentForLine({ type: 'tool_result', callId: 'c1', ok: true })).toBe('sending');
  });

  it('says nothing about a line that is not about work', () => {
    expect(momentForLine({ type: 'conversation', id: 'k1' })).toBeNull();
    expect(momentForLine({ type: 'done' })).toBeNull();
  });
});
