import { describe, expect, it } from 'vitest';
import {
  followsOf,
  greetingMoment,
  isFridayAfternoon,
  linesOf,
  MAX_LINE_LENGTH,
  MOMENTS,
  placeholdersIn,
  say,
  variantIndex,
  voiceLine,
} from '../src/lib/voice/moments';

/**
 * The voice is copy, so the tests are the style guide: enough variants that a
 * line is not read twice in a morning, short enough to be a remark rather than
 * a paragraph, and never a sentence with a hole in it.
 */
describe('the moment library', () => {
  it('gives every moment at least three lines', () => {
    for (const moment of MOMENTS) {
      expect(linesOf(moment).length, moment).toBeGreaterThanOrEqual(3);
    }
  });

  it('keeps every line inside the length a remark can be', () => {
    for (const moment of MOMENTS) {
      for (const line of [...linesOf(moment), ...followsOf(moment)]) {
        expect(line.length, `${moment}: ${line}`).toBeLessThanOrEqual(MAX_LINE_LENGTH);
      }
    }
  });

  it('is written in the interface voice: sentence case, no shouting, no emoji', () => {
    for (const moment of MOMENTS) {
      for (const line of [...linesOf(moment), ...followsOf(moment)]) {
        expect(line, moment).not.toContain('!');
        // Nothing in the copy is a middle dot, an arrow or an emoji.
        expect(/[·→←\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(line), line).toBe(false);
        // A line never opens in title case on two words running.
        expect(/^[A-Z][a-z]+ [A-Z][a-z]+ /.test(line), line).toBe(false);
      }
    }
  });

  it('pairs every second line with a first one', () => {
    for (const moment of MOMENTS) {
      const follow = followsOf(moment);
      if (follow.length === 0) continue;
      expect(follow.length, moment).toBeGreaterThanOrEqual(3);
    }
  });
});

describe('voiceLine', () => {
  it('fills the placeholders a line names', () => {
    const line = voiceLine('ticket.resolved', { subject: 'EDT-1042', count: 4, seed: 0 });
    expect(line.text).toContain('EDT-1042');
    expect(line.text).not.toContain('{');
  });

  it('never picks a line whose values it does not have', () => {
    // No count: the two lines that quote one are not candidates.
    for (let seed = 0; seed < 12; seed += 1) {
      const line = voiceLine('assistant.idle', { seed });
      expect(line.text).not.toContain('{count}');
      expect(line.text).not.toMatch(/\bNaN\b|\bundefined\b/);
    }
  });

  it('greets by name and stays silent about the count it was not given', () => {
    const line = voiceLine('today.morning', { name: 'Tanav', seed: 1 });
    expect(line.text).toContain('Tanav');
    expect(line.text).not.toContain('{');
  });

  it('returns the same line for the same context', () => {
    const context = { name: 'Ada', hour: 9, weekday: 2 };
    expect(voiceLine('today.morning', context)).toEqual(voiceLine('today.morning', context));
  });

  it('carries a second line only where the moment has one', () => {
    expect(voiceLine('signin.first', { name: 'Ada', key: '⌘K' }).follow).toContain('⌘K');
    expect(voiceLine('ticket.claimed', { subject: 'EDT-7' }).follow).toBeNull();
  });

  it('falls back to a line rather than to nothing', () => {
    // Every placeholder unsatisfiable: the moment still says something.
    const line = voiceLine('ticket.resolved', {});
    expect(line.text.length).toBeGreaterThan(0);
    expect(line.text).not.toContain('{');
  });

  it('say() is the sentence on its own', () => {
    expect(say('queue.cleared', { seed: 1 })).toBe(voiceLine('queue.cleared', { seed: 1 }).text);
  });
});

describe('placeholdersIn', () => {
  it('reads the tokens a line depends on', () => {
    expect(placeholdersIn('{subject} closed. {count} still open.')).toEqual(['subject', 'count']);
    expect(placeholdersIn('Queue is clear. That was real work.')).toEqual([]);
  });
});

describe('variantIndex', () => {
  it('stays inside the list for any context', () => {
    for (const seed of [-9, -1, 0, 1, 7, 1_000_003]) {
      expect(variantIndex({ seed }, 4)).toBeGreaterThanOrEqual(0);
      expect(variantIndex({ seed }, 4)).toBeLessThan(4);
    }
  });

  it('is zero for an empty list rather than NaN', () => {
    expect(variantIndex({ seed: 3 }, 0)).toBe(0);
  });

  it('moves through the day', () => {
    const morning = variantIndex({ hour: 8, weekday: 1 }, 4);
    const evening = variantIndex({ hour: 17, weekday: 1 }, 4);
    expect(morning).not.toBe(evening);
  });
});

describe('greetingMoment', () => {
  it('splits the school day into three', () => {
    expect(greetingMoment(0)).toBe('today.morning');
    expect(greetingMoment(11)).toBe('today.morning');
    expect(greetingMoment(12)).toBe('today.afternoon');
    expect(greetingMoment(16)).toBe('today.afternoon');
    expect(greetingMoment(17)).toBe('today.evening');
    expect(greetingMoment(23)).toBe('today.evening');
  });
});

describe('isFridayAfternoon', () => {
  it('is Friday from noon and nothing else', () => {
    expect(isFridayAfternoon({ weekday: 5, hour: 13 })).toBe(true);
    expect(isFridayAfternoon({ weekday: 5, hour: 9 })).toBe(false);
    expect(isFridayAfternoon({ weekday: 4, hour: 15 })).toBe(false);
    expect(isFridayAfternoon({})).toBe(false);
  });
});

describe('the moments that are wired to a real path', () => {
  it('names the ticket that was closed', () => {
    // The resolve toast is the one line that marks a win, and every variant of
    // it has to be able to say which ticket.
    expect(say('ticket.resolved', { subject: 'EDT-1042' })).toContain('EDT-1042');
  });

  it('says something usable when a claim has no number in hand', () => {
    // A claim from a notification or the palette does not always carry the
    // number; without a line that names nothing, this renders " is yours."
    const line = say('ticket.claimed');
    expect(line).not.toMatch(/\{|^\s|\s\s/);
    expect(line.length).toBeGreaterThan(0);
  });

  it('still names the ticket when the number is there', () => {
    expect(say('ticket.claimed', { subject: 'EDT-1042' })).toContain('EDT-1042');
  });

  it('gives the generic error the same sentence every time it happens', () => {
    // The runtime pins the variant by seed: an unexplained failure that reads
    // differently on each attempt looks like three different failures.
    expect(say('error.generic', { seed: 0 })).toBe(say('error.generic', { seed: 0 }));
    expect(say('error.generic', { seed: 0 })).toContain('Nothing changed');
    expect(say('error.generic', { seed: 2 })).toContain('connection');
  });
});
