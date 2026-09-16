import { describe, expect, it } from 'vitest';
import { stepOption } from '../../src/components/ai/reasoning-step';

const LEVELS = [
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Max' },
];

describe('stepOption', () => {
  it('moves along the scale with the arrows and stops at the ends', () => {
    expect(stepOption(LEVELS, 'high', 'ArrowRight')).toBe('xhigh');
    expect(stepOption(LEVELS, 'xhigh', 'ArrowDown')).toBe('max');
    expect(stepOption(LEVELS, 'max', 'ArrowRight')).toBe('max');
    expect(stepOption(LEVELS, 'max', 'ArrowLeft')).toBe('xhigh');
    expect(stepOption(LEVELS, 'high', 'ArrowUp')).toBe('high');
  });

  it('jumps to either end', () => {
    expect(stepOption(LEVELS, 'xhigh', 'Home')).toBe('high');
    expect(stepOption(LEVELS, 'high', 'End')).toBe('max');
  });

  it('leaves every other key to whoever is around it', () => {
    expect(stepOption(LEVELS, 'high', 'Enter')).toBeNull();
    expect(stepOption(LEVELS, 'high', 'Escape')).toBeNull();
    expect(stepOption(LEVELS, 'high', 'a')).toBeNull();
  });

  it('treats an unknown value as the first stop, and no options as nothing', () => {
    expect(stepOption(LEVELS, 'medium', 'ArrowRight')).toBe('xhigh');
    expect(stepOption([], 'high', 'ArrowRight')).toBeNull();
  });
});
