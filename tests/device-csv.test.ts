/**
 * The pure rules behind the inventory screens: how the URL filters are read
 * and how a machine becomes a line of the CSV export.
 */

import { describe, expect, it } from 'vitest';
import { toDeviceFilters } from '../src/app/(app)/devices/search-params';
import { DEVICE_CSV_COLUMNS, deviceCsvRow } from '../src/lib/data/device-csv';
import { toCsv } from '../src/lib/csv';
import type { DeviceSummary } from '../src/lib/domain/types';

function device(overrides: Partial<DeviceSummary> = {}): DeviceSummary {
  return {
    id: 'x',
    externalId: 'DEV-4F2A9C1B77E0',
    deviceType: 'Laptop',
    manufacturer: 'Lenovo',
    model: '13w Yoga',
    osVersion: 'Windows 11',
    serialNumber: 'PF3HK2QJ',
    assetTag: 'DOE-LN0000001',
    status: 'In repair',
    location: 'Cart 4',
    notes: '',
    assignedRequesterId: null,
    assignedName: null,
    assignedKind: null,
    version: 1,
    updatedAt: '2026-09-13T10:00:00Z',
    ...overrides,
  };
}

describe('inventory filters from the URL', () => {
  it('carries the search term and the page', () => {
    expect(toDeviceFilters({ query: 'DOE-LN', page: '3' })).toMatchObject({
      query: 'DOE-LN',
      page: 3,
    });
    expect(toDeviceFilters({}).page).toBe(1);
  });

  it('drops a requester that is not an id rather than making the database raise', () => {
    const real = '11111111-2222-3333-4444-555555555555';
    expect(toDeviceFilters({ requester: real }).requesterId).toBe(real);
    expect(toDeviceFilters({ requester: 'Amara' }).requesterId).toBeNull();
    expect(toDeviceFilters({}).requesterId).toBeNull();
  });
});

describe('device CSV rows', () => {
  it('writes the columns the list shows, with the status as the district writes it', () => {
    const row = deviceCsvRow(device());
    expect(row).toHaveLength(DEVICE_CSV_COLUMNS.length);
    expect(row[7]).toBe('In repair');
    expect(row[10]).toBeNull();
    const csv = toCsv(DEVICE_CSV_COLUMNS, [row]);
    expect(csv.split('\r\n')[0]).toBe(DEVICE_CSV_COLUMNS.join(','));
    expect(csv.split('\r\n')[1]).toBe(
      'DOE-LN0000001,PF3HK2QJ,DEV-4F2A9C1B77E0,Laptop,Lenovo,13w Yoga,Windows 11,In repair,Cart 4,,,2026-09-13T10:00:00Z',
    );
  });

  it('labels a holder by kind', () => {
    const row = deviceCsvRow(
      device({
        status: 'Assigned',
        assignedRequesterId: 'p',
        assignedName: 'Amara Whitfield',
        assignedKind: 'student',
      }),
    );
    expect(row[7]).toBe('Assigned');
    expect(row[9]).toBe('Amara Whitfield');
    expect(row[10]).toBe('Student');
  });

  it('carries a status the district invented through unchanged', () => {
    expect(deviceCsvRow(device({ status: 'Awaiting parts' }))[7]).toBe('Awaiting parts');
  });
});
