/**
 * The moment-to-orb map from Addendum 3 of the plan. It is user-confirmed, so
 * every entry is pinned here: a change to any of them is a decision, not a
 * side effect of a refactor.
 */

import { describe, expect, it } from 'vitest';
import {
  MOMENTS,
  momentForTool,
  orbAppearanceFor,
  orbStateFor,
  type Moment,
} from '../../src/components/ai/orb-state';

const EXPECTED: Record<Moment, string> = {
  idle: 'weaving',
  sending: 'breathing',
  reasoning: 'solving',
  writing: 'composing',
  reading: 'working',
  searching: 'searching',
  changing: 'connecting',
  approval: 'weaving',
  listening: 'listening',
  speaking: 'listening',
  connecting: 'shaping',
  // Addendum 3: "phone-scanner pairing dialog waiting for scans `shaping`".
  pairing: 'shaping',
  error: 'breathing',
};

describe('orbStateFor', () => {
  it('lists every moment exactly once', () => {
    expect([...MOMENTS].sort()).toEqual(Object.keys(EXPECTED).sort());
  });

  for (const [moment, state] of Object.entries(EXPECTED) as [Moment, string][]) {
    it(`maps ${moment} to ${state}`, () => {
      expect(orbStateFor(moment)).toBe(state);
    });
  }
});

describe('orbAppearanceFor', () => {
  it('freezes the orb and tints it with the bad colour on an error', () => {
    expect(orbAppearanceFor('error')).toEqual({ state: 'breathing', paused: true, tone: 'bad' });
  });

  it('keeps every other moment moving in the ink colour', () => {
    for (const moment of MOMENTS) {
      if (moment === 'error') continue;
      const appearance = orbAppearanceFor(moment);
      expect(appearance.paused).toBe(false);
      expect(appearance.tone).toBe('ink');
      expect(appearance.state).toBe(EXPECTED[moment]);
    }
  });
});

describe('momentForTool', () => {
  it('treats the search tool as searching', () => {
    expect(momentForTool('search_records')).toBe('searching');
  });

  it('treats every get_ and list_ tool as a read', () => {
    for (const name of ['get_ticket', 'get_person', 'get_device', 'get_insights', 'list_queue', 'list_my_tickets', 'list_people', 'list_devices', 'list_notifications']) {
      expect(momentForTool(name)).toBe('reading');
    }
  });

  it('treats everything else as a change', () => {
    for (const name of ['claim_ticket', 'add_note', 'create_ticket', 'import_csv', 'set_roles', 'bulk_update_devices']) {
      expect(momentForTool(name)).toBe('changing');
    }
  });
});
