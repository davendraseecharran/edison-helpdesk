/**
 * The pure shapes behind the inventory actions: how a list filter becomes
 * RPC arguments, and how a bulk change is sent and reported.
 */

import { describe, expect, it } from 'vitest';
import { bulkResultMessage, shapeBulkPatch } from '../src/lib/data/device-bulk';
import { deviceListArgs, optionalFilter } from '../src/lib/data/device-filters';

describe('deviceListArgs', () => {
  it('sends NULL for a filter the screen is not applying', () => {
    expect(optionalFilter(undefined)).toBeNull();
    expect(optionalFilter('')).toBeNull();
    expect(optionalFilter('   ')).toBeNull();
    expect(optionalFilter('all')).toBeNull();
    expect(optionalFilter('Cart 4')).toBe('Cart 4');
    expect(deviceListArgs({}, 25, 0)).toEqual({
      p_query: null,
      p_type: null,
      p_status: null,
      p_location: null,
      p_holder_kind: null,
      p_limit: 25,
      p_offset: 0,
    });
  });

  it('passes every applied filter through with the page window', () => {
    expect(
      deviceListArgs(
        { query: 'DOE-LN', type: 'Laptop', status: 'in_repair', location: 'Cart 4', holder: 'none', page: 3 },
        100,
        200,
      ),
    ).toEqual({
      p_query: 'DOE-LN',
      p_type: 'Laptop',
      p_status: 'in_repair',
      p_location: 'Cart 4',
      p_holder_kind: 'none',
      p_limit: 100,
      p_offset: 200,
    });
  });
});

describe('shapeBulkPatch', () => {
  it('sends column names and only the keys that carry a value', () => {
    expect(shapeBulkPatch({ personId: 'p1' })).toEqual({ person_id: 'p1' });
    expect(shapeBulkPatch({ return: true, status: 'in_repair' })).toEqual({ return: true, status: 'in_repair' });
    expect(shapeBulkPatch({ status: 'lost', reason: '  Left on the bus ' })).toEqual({
      status: 'lost',
      reason: 'Left on the bus',
    });
    expect(shapeBulkPatch({ status: 'lost', reason: '   ' })).toEqual({ status: 'lost' });
    expect(shapeBulkPatch({ return: false })).toEqual({});
  });

  it('keeps an empty location, which is how the database clears one', () => {
    expect(shapeBulkPatch({ location: '' })).toEqual({ location: '' });
    expect(shapeBulkPatch({ location: 'Cart 9' })).toEqual({ location: 'Cart 9' });
    expect(shapeBulkPatch({})).toEqual({});
  });
});

describe('bulkResultMessage', () => {
  it('reports what the database changed, in the right words', () => {
    expect(bulkResultMessage({ personId: 'p1' }, 2)).toBe('2 devices assigned.');
    expect(bulkResultMessage({ personId: 'p1' }, 1)).toBe('1 device assigned.');
    expect(bulkResultMessage({ return: true }, 3)).toBe('3 devices returned.');
    expect(bulkResultMessage({ status: 'in_repair' }, 1)).toBe('Status updated on 1 device.');
    expect(bulkResultMessage({ location: 'Cart 9' }, 12)).toBe('12 devices moved.');
  });

  it('says so when nothing needed changing', () => {
    expect(bulkResultMessage({ location: 'Cart 4' }, 0)).toBe(
      'Nothing changed: the selected devices were already as asked.',
    );
  });
});
