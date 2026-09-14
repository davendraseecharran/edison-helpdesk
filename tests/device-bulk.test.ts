/**
 * The pure shapes behind the inventory actions: how a bulk change is sent and
 * how the toast reports what the database actually changed.
 */

import { describe, expect, it } from 'vitest';
import { bulkResultMessage, shapeBulkPatch } from '../src/lib/data/device-bulk';

describe('shapeBulkPatch', () => {
  it('sends only the keys that are actually being changed', () => {
    expect(shapeBulkPatch({ status: 'In repair' })).toEqual({ status: 'In repair' });
    expect(shapeBulkPatch({ status: 'Lost', location: 'Cart 9' })).toEqual({
      status: 'Lost',
      location: 'Cart 9',
    });
    expect(shapeBulkPatch({})).toEqual({});
  });

  it('keeps an empty location and empty notes, which is how the database clears one', () => {
    expect(shapeBulkPatch({ location: '' })).toEqual({ location: '' });
    expect(shapeBulkPatch({ notes: '' })).toEqual({ notes: '' });
  });

  it('never sends an assignment: a loan is one machine and one person', () => {
    // The key is not on BulkDevicePatch at all, so a caller cannot smuggle one
    // in; this pins the shape the database refuses anyway.
    expect(Object.keys(shapeBulkPatch({ status: 'Available' }))).toEqual(['status']);
  });
});

describe('bulkResultMessage', () => {
  it('reports what the database changed, in the right words', () => {
    expect(bulkResultMessage({ status: 'In repair' }, 1)).toBe('Status updated on 1 device.');
    expect(bulkResultMessage({ status: 'In repair' }, 4)).toBe('Status updated on 4 devices.');
    expect(bulkResultMessage({ location: 'Cart 9' }, 12)).toBe('12 devices moved.');
    expect(bulkResultMessage({ location: '' }, 2)).toBe('Location cleared on 2 devices.');
    expect(bulkResultMessage({ notes: 'Battery swollen' }, 1)).toBe('Notes updated on 1 device.');
  });

  it('says so when nothing was found to change', () => {
    expect(bulkResultMessage({ location: 'Cart 4' }, 0)).toBe(
      'Nothing changed: none of the selected devices could be updated.',
    );
  });
});
