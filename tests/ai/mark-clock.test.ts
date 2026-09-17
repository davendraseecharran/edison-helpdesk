import { describe, expect, it } from 'vitest';
import { cloudTime } from '../../src/lib/ai/mark-clock';

describe('cloudTime', () => {
  it('holds on the assembled mark for the whole hold', () => {
    expect(cloudTime(0, 1000, 1, 7.4)).toBe(7.4);
    expect(cloudTime(999, 1000, 1, 7.4)).toBe(7.4);
    expect(cloudTime(1000, 1000, 1, 7.4)).toBe(7.4);
  });

  it('runs on from the mark once the hold is over, at the preset speed', () => {
    expect(cloudTime(1500, 1000, 1, 7.4)).toBeCloseTo(7.9);
    expect(cloudTime(3000, 1000, 0.5, 7.4)).toBeCloseTo(8.4);
  });

  it('moves at once with no hold, and never runs backwards', () => {
    expect(cloudTime(250, 0, 1, 7.4)).toBeCloseTo(7.65);
    expect(cloudTime(250, -50, 1, 7.4)).toBeCloseTo(7.65);
    expect(cloudTime(-10, 0, 1, 7.4)).toBe(7.4);
    expect(cloudTime(2000, 0, -1, 7.4)).toBe(7.4);
  });
});
