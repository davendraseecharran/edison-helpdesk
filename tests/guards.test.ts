import { describe, expect, it } from 'vitest';
import { isRecord, isUuid, textOf } from '../src/lib/guards';

describe('isRecord', () => {
  it('accepts a plain object', () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it('refuses null, an array and every primitive', () => {
    for (const value of [null, undefined, [], [1], 'a', 1, true, Symbol('a')]) {
      expect(isRecord(value)).toBe(false);
    }
  });
});

describe('textOf', () => {
  it('returns a string as it was given', () => {
    expect(textOf('EDT-1042')).toBe('EDT-1042');
    expect(textOf('')).toBe('');
  });

  it('returns an empty string for anything else, and never stringifies', () => {
    for (const value of [null, undefined, 0, 42, true, {}, [], { toString: () => 'x' }]) {
      expect(textOf(value)).toBe('');
    }
  });
});

describe('isUuid', () => {
  it('accepts a uuid in either case', () => {
    expect(isUuid('11111111-1111-4111-8111-111111111111')).toBe(true);
    expect(isUuid('AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE')).toBe(true);
  });

  it('refuses anything that is not exactly one', () => {
    for (const value of [
      '',
      '11111111-1111-4111-8111-11111111111',
      '11111111-1111-4111-8111-1111111111111',
      '11111111111141118111111111111111',
      'gggggggg-1111-4111-8111-111111111111',
      'EDT-1042',
    ]) {
      expect(isUuid(value)).toBe(false);
    }
  });

  it('does not trim, so the id that was checked is the id that travels', () => {
    expect(isUuid(' 11111111-1111-4111-8111-111111111111 ')).toBe(false);
  });
});
