import { describe, expect, it } from 'vitest';

import { DEVICE_TYPES, deviceTypeLabel, deviceTypeOptions } from '@/lib/domain/device-types';

describe('deviceTypeLabel', () => {
  it('gives a known type the vocabulary spelling, whatever case it arrives in', () => {
    expect(deviceTypeLabel('chromebook')).toBe('Chromebook');
    expect(deviceTypeLabel('CHROMEBOOK')).toBe('Chromebook');
    expect(deviceTypeLabel('ChromeBook')).toBe('Chromebook');
    expect(deviceTypeLabel('  interactive panel  ')).toBe('Interactive panel');
  });

  it('leaves a word this product has never seen exactly as it was typed', () => {
    expect(deviceTypeLabel('Document camera')).toBe('Document camera');
    expect(deviceTypeLabel('3D printer')).toBe('3D printer');
  });

  it('answers empty for nothing, so a caller can still ask whether there is anything to show', () => {
    expect(deviceTypeLabel('')).toBe('');
    expect(deviceTypeLabel('   ')).toBe('');
    expect(deviceTypeLabel(null)).toBe('');
    expect(deviceTypeLabel(undefined)).toBe('');
  });

  it('is idempotent: a label already correct comes back unchanged', () => {
    for (const type of DEVICE_TYPES) expect(deviceTypeLabel(type)).toBe(type);
  });
});

describe('deviceTypeOptions', () => {
  it('offers the whole vocabulary when the inventory has nothing to say', () => {
    expect(deviceTypeOptions()).toEqual([...DEVICE_TYPES].sort((a, b) => a.localeCompare(b)));
  });

  it('folds the catalogue into the vocabulary rather than listing it twice', () => {
    const options = deviceTypeOptions(['chromebook', 'Chromebook', 'CHROMEBOOK']);
    expect(options.filter((option) => option === 'Chromebook')).toHaveLength(1);
    expect(options).not.toContain('chromebook');
  });

  it('keeps a type the district invented, and sorts it in with the rest', () => {
    const options = deviceTypeOptions(['Document camera']);
    expect(options).toContain('Document camera');
    expect(options).toContain('Chromebook');
    expect([...options]).toEqual([...options].sort((a, b) => a.localeCompare(b)));
  });

  it('drops blanks the catalogue may carry', () => {
    expect(deviceTypeOptions(['', '   '])).toEqual(deviceTypeOptions());
  });
});
