import { describe, expect, it } from 'vitest';
import {
  duplicateTokens,
  suggestCategory,
  suggestPriority,
  worthSuggesting,
} from '../src/lib/intake/suggest';

describe('suggestCategory', () => {
  it('reads the thing the sentence names', () => {
    const cases: Array<[string, string]> = [
      ['The projector in 118 shows no signal', 'projector_display'],
      ['Chromebook will not hold a charge', 'chromebook'],
      ['Wi-Fi keeps dropping in the library', 'network'],
      ['Printer queue is stuck', 'printer'],
      ['Student cannot log in to Google', 'account'],
      ['Clever extension will not install', 'software'],
      ['Classroom phone has no dial tone', 'phone'],
      ['Laptop keyboard has dead keys', 'laptop_desktop'],
    ];
    for (const [title, expected] of cases) {
      expect(suggestCategory(title, ''), title).toMatchObject({ value: expected });
    }
  });

  it('reads the issue when the title says nothing', () => {
    expect(suggestCategory('Room 118', 'The projector shows no signal')).toMatchObject({
      value: 'projector_display',
    });
  });

  it('prefers the more specific word', () => {
    // A cart of Chromebooks is a Chromebook problem, not a battery one.
    expect(suggestCategory('Chromebook cart will not charge', '')).toMatchObject({
      value: 'chromebook',
    });
  });

  it('says why', () => {
    expect(suggestCategory('The projector is out', '')?.because).toBe('projector');
  });

  it('suggests nothing rather than suggesting Other', () => {
    expect(suggestCategory('Something is wrong in 214', '')).toBeNull();
    expect(suggestCategory('', '')).toBeNull();
  });

  it('matches whole words only', () => {
    // "account" must not be found inside "accountant".
    expect(suggestCategory('Meeting with the accountant', '')).toBeNull();
  });
});

describe('suggestPriority', () => {
  it('reads the words that stop a lesson', () => {
    expect(suggestPriority('Regents testing today and the Wi-Fi is down', '')).toMatchObject({
      value: 'urgent',
    });
    expect(suggestPriority('Whole class cannot sign in', '')).toMatchObject({ value: 'urgent' });
  });

  it('reads the words that mean soon', () => {
    expect(suggestPriority('Projector needed for a parent presentation', '')).toMatchObject({
      value: 'high',
    });
    expect(suggestPriority('Can you look at this asap', '')).toMatchObject({ value: 'high' });
  });

  it('prefers urgent over high when both are there', () => {
    expect(suggestPriority('Regents exam today, asap please', '')).toMatchObject({
      value: 'urgent',
    });
  });

  it('never suggests lowering anything', () => {
    expect(suggestPriority('Projector shows no signal', '')).toBeNull();
    expect(suggestPriority('whenever you get a chance', '')).toBeNull();
  });
});

describe('duplicateTokens', () => {
  it('keeps the words that name the thing', () => {
    // Longest first, and only words long enough to name something: "the",
    // "in", "no" and the room number are matched by the room, not by the text.
    expect(duplicateTokens('The projector in room 118 shows no signal')).toEqual([
      'projector',
      'signal',
      'shows',
    ]);
  });

  it('drops short words and bare numbers', () => {
    expect(duplicateTokens('Cart 3 is out')).toEqual([]);
  });

  it('never repeats a word', () => {
    expect(duplicateTokens('Printer printer printer problem', 3)).toEqual(['printer', 'problem']);
  });

  it('respects the limit', () => {
    expect(duplicateTokens('projector display signal problem broken', 2).length).toBe(2);
  });
});

describe('worthSuggesting', () => {
  it('waits until there is a sentence to read', () => {
    expect(worthSuggesting('proj', '')).toBe(false);
    expect(worthSuggesting('projector', '')).toBe(true);
  });
});
