import { describe, expect, it } from 'vitest';
import {
  ACTION_LABELS,
  actionFor,
  focusAfterChange,
  nextFocus,
} from '../src/lib/lists/keys';

describe('nextFocus', () => {
  it('moves with j and k', () => {
    expect(nextFocus(0, 'j', 5)).toBe(1);
    expect(nextFocus(3, 'k', 5)).toBe(2);
  });

  it('takes the arrow keys as the same movement', () => {
    expect(nextFocus(0, 'ArrowDown', 5)).toBe(1);
    expect(nextFocus(3, 'ArrowUp', 5)).toBe(2);
  });

  it('clamps rather than wrapping, so holding j keeps your place', () => {
    expect(nextFocus(4, 'j', 5)).toBe(4);
    expect(nextFocus(0, 'k', 5)).toBe(0);
  });

  it('starts at the right end when nothing is focused yet', () => {
    expect(nextFocus(-1, 'j', 5)).toBe(0);
    expect(nextFocus(-1, 'k', 5)).toBe(4);
  });

  it('jumps to the ends', () => {
    expect(nextFocus(3, 'Home', 5)).toBe(0);
    expect(nextFocus(1, 'End', 5)).toBe(4);
  });

  it('jumps with the number keys', () => {
    expect(nextFocus(0, '4', 7)).toBe(3);
    expect(nextFocus(0, '1', 7)).toBe(0);
  });

  it('ignores a number past the end of the list', () => {
    expect(nextFocus(0, '9', 3)).toBeNull();
  });

  it('ignores a key that is not movement', () => {
    for (const key of ['o', 'c', 'r', 'e', 'Enter', '0', 'x']) {
      expect(nextFocus(0, key, 5), key).toBeNull();
    }
  });

  it('moves nothing in an empty list', () => {
    expect(nextFocus(0, 'j', 0)).toBeNull();
    expect(nextFocus(-1, 'Home', 0)).toBeNull();
  });

  it('treats a nonsense index as nothing focused', () => {
    expect(nextFocus(Number.NaN, 'j', 5)).toBe(0);
  });
});

describe('actionFor', () => {
  it('maps the four action keys, in either case', () => {
    expect(actionFor('o')).toBe('open');
    expect(actionFor('O')).toBe('open');
    expect(actionFor('Enter')).toBe('open');
    expect(actionFor('c')).toBe('claim');
    expect(actionFor('r')).toBe('resolve');
    expect(actionFor('e')).toBe('edit');
  });

  it('claims no other key', () => {
    for (const key of ['j', 'k', 'x', 'q', '1', ' ']) {
      expect(actionFor(key), key).toBeNull();
    }
  });

  it('names every action it can run', () => {
    for (const key of ['o', 'c', 'r', 'e']) {
      const action = actionFor(key);
      expect(action).not.toBeNull();
      expect(ACTION_LABELS[action!].length).toBeGreaterThan(0);
    }
  });
});

describe('focusAfterChange', () => {
  const before = ['a', 'b', 'c', 'd'];

  it('follows the row it was on', () => {
    expect(focusAfterChange(before, ['d', 'c', 'b', 'a'], 'b')).toBe('b');
  });

  it('stays at the position when the row is claimed away', () => {
    expect(focusAfterChange(before, ['a', 'c', 'd'], 'b')).toBe('c');
  });

  it('holds the end of the list when the last row goes', () => {
    expect(focusAfterChange(before, ['a', 'b', 'c'], 'd')).toBe('c');
  });

  it('lets go when the list empties', () => {
    expect(focusAfterChange(before, [], 'b')).toBeNull();
  });

  it('focuses nothing when nothing was focused', () => {
    expect(focusAfterChange(before, ['a', 'b'], null)).toBeNull();
  });

  it('focuses nothing when the old row was never in the old list either', () => {
    expect(focusAfterChange(before, ['a', 'b'], 'zzz')).toBeNull();
  });
});
