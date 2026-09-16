import { describe, expect, it } from 'vitest';
import {
  TODAY_LINE_MAX_CHARS,
  TODAY_LINE_TTL_MS,
  acceptTodayLine,
  readCachedTodayLine,
  todayFacts,
  todayFactsFingerprint,
  todayLineHash,
  todayLineIsFresh,
  todayLinePrompt,
} from '../../src/lib/ai/today-line';
import { EMPTY_BRIEFING, type Briefing, type BriefingTicket } from '../../src/lib/domain/today';

function ticket(id: string, title: string, since: string): BriefingTicket {
  return {
    id,
    number: `EDT-${id}`,
    title,
    priority: 'normal',
    status: 'open',
    waitingReason: null,
    createdAt: since,
    since,
    requesterName: 'Nia Okonkwo',
  };
}

function briefing(patch: Partial<Briefing> = {}): Briefing {
  return {
    ...EMPTY_BRIEFING,
    at: '2026-09-15T09:00:00Z',
    counts: { waiting: 1, unassigned: 3, mine: 2, accessRequests: 0, devicesDue: 1 },
    unassigned: [
      ticket('a', 'Projector in 118 will not switch on', '2026-09-15T08:00:00Z'),
      ticket('b', 'projector in 118 will not switch on.', '2026-09-15T08:10:00Z'),
      ticket('c', 'Chromebook will not charge', '2026-09-15T08:20:00Z'),
    ],
    waiting: [
      { ...ticket('d', 'Smart board pen missing', '2026-09-14T14:00:00Z'), status: 'waiting' },
    ],
    ...patch,
  };
}

describe('what the model is shown', () => {
  it('names only the rows the screen is already showing', () => {
    const facts = todayFacts(briefing());
    // In the screen's own order, and two reports of one projector are one row
    // on screen, so they are one row here.
    expect(facts.rows).toEqual([
      { kind: 'waiting', title: 'Smart board pen missing', count: 1 },
      { kind: 'unassigned', title: 'Projector in 118 will not switch on', count: 2 },
      { kind: 'unassigned', title: 'Chromebook will not charge', count: 1 },
    ]);
    expect(facts.counts.unassigned).toBe(3);
  });

  it('never names a person, an address or an identifier', () => {
    const view = briefing({
      accessRequests: [
        {
          id: 'req-1',
          name: 'Priya Raman',
          email: 'praman@edison.example',
          createdAt: '2026-09-15T07:00:00Z',
        },
      ],
      counts: { waiting: 1, unassigned: 3, mine: 2, accessRequests: 1, devicesDue: 1 },
    });
    const { instructions, message } = todayLinePrompt(todayFacts(view));
    const sent = `${instructions}\n${message}`;

    expect(sent).not.toContain('Priya Raman');
    expect(sent).not.toContain('praman@edison.example');
    expect(sent).not.toContain('Nia Okonkwo');
    expect(sent).not.toContain('EDT-a');
    // The access request is still counted; it is the name that never travels.
    expect(message).toContain('people waiting for an administrator to approve access: 1');
  });

  it('gives the counts, the folded rows and the rules it will be judged by', () => {
    const { instructions, message } = todayLinePrompt(todayFacts(briefing()));

    expect(message).toContain('unclaimed tickets: 3');
    expect(message).toContain('your tickets waiting on a reply: 1');
    expect(message).toContain('your own open tickets: 2');
    expect(message).toContain('machines due back: 1');
    expect(message).toContain('unclaimed: Projector in 118 will not switch on (2 reports of this');
    expect(message).toContain('waiting on a reply: Smart board pen missing');

    expect(instructions).toContain(`at most ${TODAY_LINE_MAX_CHARS} characters`);
    expect(instructions).toContain('One sentence');
    expect(instructions).toContain('exclamation mark');
    expect(instructions).toContain('Never invent');
  });

  it('says plainly when there is nothing listed', () => {
    const { message } = todayLinePrompt(todayFacts(EMPTY_BRIEFING));
    expect(message).toContain('No ticket rows are listed on the screen.');
    expect(message).toContain('unclaimed tickets: 0');
  });
});

describe('the cache key', () => {
  it('is the same for the same screen and different for a changed count', () => {
    const one = todayLineHash(todayFacts(briefing()));
    const again = todayLineHash(todayFacts(briefing()));
    expect(again).toBe(one);

    const claimed = briefing({
      counts: { waiting: 1, unassigned: 2, mine: 3, accessRequests: 0, devicesDue: 1 },
    });
    expect(todayLineHash(todayFacts(claimed))).not.toBe(one);
  });

  it('changes when the titles change even though the counts do not', () => {
    const one = todayLineHash(todayFacts(briefing()));
    const swapped = briefing({
      unassigned: [
        ticket('a', 'Printer in the library is jammed', '2026-09-15T08:00:00Z'),
        ticket('b', 'Printer in the library is jammed.', '2026-09-15T08:10:00Z'),
        ticket('c', 'Chromebook will not charge', '2026-09-15T08:20:00Z'),
      ],
    });
    expect(todayLineHash(todayFacts(swapped))).not.toBe(one);
  });

  it('is a short hex fingerprint, not the facts themselves', () => {
    const hash = todayLineHash(todayFacts(briefing()));
    expect(hash).toMatch(/^[0-9a-f]{32}$/);
    expect(todayFactsFingerprint(todayFacts(briefing()))).toContain('u=3|w=1|m=2|a=0|d=1');
  });
});

describe('whether a stored line may be shown again', () => {
  const now = Date.parse('2026-09-15T09:00:00Z');
  const cached = {
    line: 'Two projector tickets in 118 look like one fault.',
    hash: 'abc123',
    generatedAt: '2026-09-15T08:55:00Z',
  };

  it('reuses a line written from these facts a few minutes ago', () => {
    expect(todayLineIsFresh(cached, 'abc123', now)).toBe(true);
  });

  it('writes again once the facts have changed, however recent it is', () => {
    expect(todayLineIsFresh(cached, 'def456', now)).toBe(false);
  });

  it('writes again past ten minutes, however unchanged the facts are', () => {
    const old = { ...cached, generatedAt: new Date(now - TODAY_LINE_TTL_MS - 1).toISOString() };
    expect(todayLineIsFresh(old, 'abc123', now)).toBe(false);

    const just = { ...cached, generatedAt: new Date(now - TODAY_LINE_TTL_MS + 1000).toISOString() };
    expect(todayLineIsFresh(just, 'abc123', now)).toBe(true);
  });

  it('treats nothing stored, and a timestamp it cannot read, as nothing to reuse', () => {
    expect(todayLineIsFresh(null, 'abc123', now)).toBe(false);
    expect(todayLineIsFresh({ ...cached, generatedAt: 'whenever' }, 'abc123', now)).toBe(false);
  });

  it('remembers an empty answer for two minutes, not ten', () => {
    const at = Date.parse('2026-09-15T09:00:00Z');
    const empty = { line: '', hash: 'abc123', generatedAt: '2026-09-15T08:59:00Z' };
    expect(todayLineIsFresh(empty, 'abc123', at)).toBe(true);
    expect(todayLineIsFresh({ ...empty, generatedAt: '2026-09-15T08:57:00Z' }, 'abc123', at)).toBe(
      false,
    );
    expect(todayLineIsFresh(empty, 'other', at)).toBe(false);
  });

  it('does not let a clock ahead of this one pin the line forever', () => {
    const ahead = { ...cached, generatedAt: '2026-09-15T10:00:00Z' };
    expect(todayLineIsFresh(ahead, 'abc123', now)).toBe(false);
  });

  it('reads the stored column, and refuses a shape it does not recognise', () => {
    expect(
      readCachedTodayLine({
        line: 'The queue is clear.',
        hash: 'abc123',
        generated_at: '2026-09-15T08:55:00Z',
      }),
    ).toEqual({
      line: 'The queue is clear.',
      hash: 'abc123',
      generatedAt: '2026-09-15T08:55:00Z',
    });

    expect(readCachedTodayLine({})).toBeNull();
    expect(readCachedTodayLine(null)).toBeNull();
    expect(readCachedTodayLine('a line')).toBeNull();
    expect(readCachedTodayLine({ line: 'No hash.', generated_at: '2026-09-15T08:55:00Z' })).toBeNull();
    // An empty line under a fingerprint is kept: it is the mark of an ask that
    // came back with nothing, and it stops the next visit asking again.
    expect(readCachedTodayLine({ line: '   ', hash: 'abc', generated_at: 'x' })).toEqual({
      line: '',
      hash: 'abc',
      generatedAt: 'x',
    });
  });
});

describe('falling back rather than showing a bad line', () => {
  it('takes the sentence the brief asked for', () => {
    expect(acceptTodayLine('Two projector tickets in room 118 look like one fault.')).toBe(
      'Two projector tickets in room 118 look like one fault.',
    );
    // Names and room labels keep their capitals.
    expect(acceptTodayLine('Mr Lopez in Room 204 has the Chromebook cart.')).toBe(
      'Mr Lopez in Room 204 has the Chromebook cart.',
    );
  });

  it('tidies whitespace, a wrapping quote, a label and a missing full stop', () => {
    expect(acceptTodayLine('  Three tickets   are waiting.  ')).toBe('Three tickets are waiting.');
    expect(acceptTodayLine('"Three tickets are waiting."')).toBe('Three tickets are waiting.');
    expect(acceptTodayLine('“Three tickets are waiting.”')).toBe('Three tickets are waiting.');
    expect(acceptTodayLine('Line: Three tickets are waiting.')).toBe('Three tickets are waiting.');
    expect(acceptTodayLine('Three tickets are waiting')).toBe('Three tickets are waiting.');
    expect(acceptTodayLine('```\nThree tickets are waiting.\n```')).toBe(
      'Three tickets are waiting.',
    );
    // The common shape of a fence: a newline after it, sometimes one before.
    expect(acceptTodayLine('```\nThree tickets are waiting.\n```\n')).toBe(
      'Three tickets are waiting.',
    );
    expect(acceptTodayLine('\n```text\nThree tickets are waiting.\n```')).toBe(
      'Three tickets are waiting.',
    );
  });

  it('refuses an exclamation mark, an emoji and a shout', () => {
    expect(acceptTodayLine('Three tickets are waiting!')).toBeNull();
    expect(acceptTodayLine('Three tickets are waiting 🎉.')).toBeNull();
    expect(acceptTodayLine('**Three tickets** are waiting.')).toBeNull();
    expect(acceptTodayLine('Three tickets | two projectors.')).toBeNull();
    expect(acceptTodayLine('THREE TICKETS ARE WAITING.')).toBeNull();
    expect(acceptTodayLine('Three Tickets Are Waiting On A Reply.')).toBeNull();
    expect(acceptTodayLine('Answer: THE QUEUE IS ON FIRE.')).toBeNull();
  });

  it('refuses a second sentence, however good the first one is', () => {
    expect(
      acceptTodayLine('Two projectors look like one fault. The rest of the queue is clear.'),
    ).toBeNull();
  });

  it('refuses a line the screen has no room for', () => {
    const long = `${'Two projector tickets in room 118 look like one single shared underlying fault'} today and tomorrow.`;
    expect(long.length).toBeGreaterThan(TODAY_LINE_MAX_CHARS);
    expect(acceptTodayLine(long)).toBeNull();
  });

  it('refuses an empty answer, a fragment and a model that answered a different question', () => {
    expect(acceptTodayLine('')).toBeNull();
    expect(acceptTodayLine('   ')).toBeNull();
    expect(acceptTodayLine('Sure')).toBeNull();
    expect(acceptTodayLine('three tickets are waiting.')).toBeNull();
  });
});
