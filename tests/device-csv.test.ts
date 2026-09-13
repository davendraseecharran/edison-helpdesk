/**
 * The pure rules behind the inventory screens: how the URL filters are read
 * and how a row becomes a line of the CSV export.
 */

import { describe, expect, it } from 'vitest';
import { toDeviceFilters } from '../src/app/(app)/devices/search-params';
import { DEVICE_CSV_COLUMNS, deviceCsvRow } from '../src/lib/data/device-csv';
import { toCsv } from '../src/lib/csv';
import { DEVICE_STATUSES } from '../src/lib/domain/types';

describe('inventory filters from the URL', () => {
  it('drops an unknown device status or holder rather than matching nothing', () => {
    expect(toDeviceFilters({ status: 'in_repair', holder: 'none', location: 'Cart 4' })).toMatchObject({
      status: 'in_repair',
      holder: 'none',
      location: 'Cart 4',
    });
    expect(toDeviceFilters({ status: 'broken' }).status).toBeUndefined();
    expect(toDeviceFilters({ holder: 'parent' }).holder).toBeUndefined();
    for (const status of DEVICE_STATUSES) {
      expect(toDeviceFilters({ status }).status).toBe(status);
    }
  });
});

describe('device CSV rows', () => {
  it('writes the columns the list shows, with labels rather than storage spellings', () => {
    const row = deviceCsvRow({
      id: 'x', device_id: null, serial_number: 'PF3HK2QJ', asset_tag: 'DOE-LN0000001',
      type: 'Laptop', manufacturer: 'Lenovo', model: '13w Yoga', os: 'Windows 11',
      status: 'in_repair', location: 'Cart 4', holder_id: null, holder_name: null,
      holder_kind: null, updated_at: '2026-09-13T10:00:00Z', total_count: '1',
    });
    expect(row).toHaveLength(DEVICE_CSV_COLUMNS.length);
    expect(row[7]).toBe('In repair');
    expect(row[10]).toBeNull();
    const csv = toCsv(DEVICE_CSV_COLUMNS, [row]);
    expect(csv.split('\r\n')[0]).toBe(DEVICE_CSV_COLUMNS.join(','));
    expect(csv.split('\r\n')[1]).toBe(
      'DOE-LN0000001,PF3HK2QJ,,Laptop,Lenovo,13w Yoga,Windows 11,In repair,Cart 4,,,2026-09-13T10:00:00Z',
    );
  });

  it('labels a holder by kind', () => {
    const row = deviceCsvRow({
      id: 'y', device_id: 'PW0FYJ9B-WIN', serial_number: null, asset_tag: null, type: 'Laptop',
      manufacturer: null, model: null, os: null, status: 'deployed', location: null,
      holder_id: 'p', holder_name: 'Amara Whitfield', holder_kind: 'student',
      updated_at: '2026-09-13T10:00:00Z', total_count: 1,
    });
    expect(row[7]).toBe('Deployed');
    expect(row[9]).toBe('Amara Whitfield');
    expect(row[10]).toBe('Student');
  });
});
