/**
 * Quick tickets: the pure rules the menu, the palette and the settings list all
 * read from.
 *
 * Three of them are worth naming. The URL a preset files from is the only thing
 * the top bar, the palette and the intake page have to agree on, so it is one
 * function. The order is the one the database returns and the browser has to
 * reproduce without asking again. And a move writes only the rows whose
 * position actually changes, because every row it writes is a history entry.
 *
 * Everything the database refuses is refused here too — the same sentences, so
 * a typo is reported beside the field rather than after a round trip. The
 * database is still what decides; `tests/db/m5-ticket-presets.test.ts` is where
 * that is proved.
 */

import { describe, expect, it } from 'vitest';
import {
  isPriority,
  movePreset,
  orderPresets,
  presetActionLabel,
  presetDraft,
  presetError,
  presetFromRow,
  presetHref,
  presetKeywords,
  PRESET_NAME_MAX,
  TICKET_PRESET_CAP,
  type TicketPreset,
} from '../src/lib/domain/ticket-presets';

function preset(overrides: Partial<TicketPreset> = {}): TicketPreset {
  return {
    id: 'a1',
    name: 'Projector',
    title: 'Projector will not display',
    issue: 'The projector is on and the screen stays blank.',
    category: 'projector_display',
    priority: 'normal',
    location: '',
    position: 0,
    ...overrides,
  };
}

describe('presetHref', () => {
  it('files from the intake form with the preset named', () => {
    expect(presetHref('a1')).toBe('/tickets/new?preset=a1');
  });

  it('escapes an id rather than pasting it into the query', () => {
    expect(presetHref('a b&c=1')).toBe('/tickets/new?preset=a%20b%26c%3D1');
  });
});

describe('presetActionLabel and presetKeywords', () => {
  it('names the row by what it files', () => {
    expect(presetActionLabel(preset())).toBe('New ticket: Projector');
  });

  it('finds a preset by a word from its name or its title', () => {
    const words = presetKeywords(preset({ name: 'No Wi-Fi', title: 'No Wi-Fi in the room' }));
    expect(words).toContain('wi');
    expect(words).toContain('fi');
    expect(words).toContain('room');
    // The one-letter fragments a split leaves behind are not search terms.
    expect(words.every((word) => word.length > 1)).toBe(true);
  });
});

describe('orderPresets', () => {
  it('is position first, then the name without regard to case', () => {
    const list = [
      preset({ id: 'c', name: 'chromebook', position: 1 }),
      preset({ id: 'b', name: 'Beam', position: 1 }),
      preset({ id: 'a', name: 'Wi-Fi', position: 0 }),
    ];
    expect(orderPresets(list).map((one) => one.id)).toEqual(['a', 'b', 'c']);
  });

  it('breaks a full tie on the id, so the order never wobbles', () => {
    const list = [
      preset({ id: 'b2', name: 'Same', position: 0 }),
      preset({ id: 'b1', name: 'same', position: 0 }),
    ];
    expect(orderPresets(list).map((one) => one.id)).toEqual(['b1', 'b2']);
  });

  it('leaves the list it was given alone', () => {
    const list = [preset({ id: 'b', position: 1 }), preset({ id: 'a', position: 0 })];
    orderPresets(list);
    expect(list.map((one) => one.id)).toEqual(['b', 'a']);
  });
});

describe('movePreset', () => {
  const list = [
    preset({ id: 'a', name: 'A', position: 0 }),
    preset({ id: 'b', name: 'B', position: 1 }),
    preset({ id: 'c', name: 'C', position: 2 }),
  ];

  it('swaps the two rows it moves between, and writes nothing else', () => {
    expect(movePreset(list, 'c', 'up')).toEqual([
      { id: 'c', position: 1 },
      { id: 'b', position: 2 },
    ]);
  });

  it('moves down the same way', () => {
    expect(movePreset(list, 'a', 'down')).toEqual([
      { id: 'b', position: 0 },
      { id: 'a', position: 1 },
    ]);
  });

  it('writes nothing at either end of the list', () => {
    expect(movePreset(list, 'a', 'up')).toEqual([]);
    expect(movePreset(list, 'c', 'down')).toEqual([]);
  });

  it('writes nothing for an id that is not in the list', () => {
    expect(movePreset(list, 'nope', 'up')).toEqual([]);
  });

  it('renumbers a list that has never been ordered', () => {
    // Every position at 0 is what the database gives before anybody has moved
    // anything: the order on screen was the name tie-break, and the first move
    // makes it the desk's.
    const unordered = [
      preset({ id: 'a', name: 'Apple', position: 0 }),
      preset({ id: 'b', name: 'Banana', position: 0 }),
      preset({ id: 'c', name: 'Cherry', position: 0 }),
    ];
    expect(movePreset(unordered, 'c', 'up')).toEqual([
      { id: 'c', position: 1 },
      { id: 'b', position: 2 },
    ]);
  });
});

describe('presetError', () => {
  const good = {
    name: 'Projector',
    title: 'Projector will not display',
    issue: 'No signal.',
    category: 'projector_display' as const,
    priority: 'normal' as const,
    location: 'Room 212',
  };

  it('accepts a preset the database would accept', () => {
    expect(presetError(good)).toBeNull();
  });

  it('asks for a name and a title, and counts them trimmed', () => {
    expect(presetError({ ...good, name: '   ' })).toBe('Give the quick ticket a name.');
    expect(presetError({ ...good, title: '' })).toBe(
      'Give the quick ticket a title for the queue.',
    );
    expect(presetError({ ...good, name: 'x'.repeat(PRESET_NAME_MAX + 1) })).toContain(
      '40 characters at most',
    );
  });

  it('refuses a category or a priority the ticket vocabulary does not contain', () => {
    expect(presetError({ ...good, category: 'toaster' as never })).toBe(
      'Choose a category for this quick ticket.',
    );
    expect(presetError({ ...good, priority: 'whenever' as never })).toBe(
      'Choose a priority: low, normal, high or urgent.',
    );
  });

  it('does not take an inherited property for a vocabulary', () => {
    expect(presetError({ ...good, category: 'constructor' as never })).not.toBeNull();
    expect(isPriority('toString')).toBe(false);
  });
});

describe('presetFromRow', () => {
  it('reads a row the database gave', () => {
    const row = {
      id: 'a1',
      name: 'No Wi-Fi',
      title: 'No Wi-Fi in the room',
      issue: 'Nothing can reach the network.',
      category: 'network',
      priority: 'high',
      location: '',
      position: 2,
    };
    expect(presetFromRow(row)).toEqual({ ...row });
  });

  it('is nothing at all without an id, a name and a title', () => {
    expect(presetFromRow({ name: 'No id', title: 'x' })).toBeNull();
    expect(presetFromRow({ id: 'a1', title: 'x' })).toBeNull();
  });

  it('falls back rather than handing the form a value it cannot show', () => {
    const narrowed = presetFromRow({ id: 'a1', name: 'n', title: 't', category: 'toaster' });
    expect(narrowed?.category).toBe('other');
    expect(narrowed?.priority).toBe('normal');
    expect(narrowed?.issue).toBe('');
    expect(narrowed?.position).toBe(0);
  });
});

describe('presetDraft', () => {
  it('carries the five fields the intake form starts from, and no id', () => {
    const draft = presetDraft(preset({ location: 'Room 212' }));
    expect(draft).toEqual({
      name: 'Projector',
      title: 'Projector will not display',
      issue: 'The projector is on and the screen stays blank.',
      category: 'projector_display',
      priority: 'normal',
      location: 'Room 212',
    });
    expect('id' in draft).toBe(false);
  });
});

describe('the cap', () => {
  it('is twelve, and the database is what holds it', () => {
    expect(TICKET_PRESET_CAP).toBe(12);
  });
});
