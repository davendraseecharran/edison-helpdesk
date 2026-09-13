import { expect, it } from 'vitest';
import { toFilters } from '../src/app/(app)/search-params';
import { TICKET_CATEGORIES } from '../src/lib/domain/types';
it('normalizes repeated query parameters and bounds pagination offsets', () => {
  expect(toFilters({ query: ['display', 'ignored'], owner: ['all'], page: ['2'] }))
    .toMatchObject({ query: 'display', owner: 'all', page: 2 });
  expect(toFilters({page:'999999999999999999999'}).page).toBe(1);
  expect(toFilters({page:'2000000000'}).page).toBe(1_000_000);
  expect(toFilters({page:'-1'}).page).toBe(1);
});

it('keeps only a category the database knows, so a mistyped link is not an empty queue', () => {
  expect(toFilters({ category: ['network', 'printer'] }).category).toBe('network');
  expect(toFilters({ category: 'smartboard' }).category).toBeUndefined();
  expect(toFilters({ category: '' }).category).toBeUndefined();
  expect(toFilters({}).category).toBeUndefined();
  // Every value the select can produce survives the round trip.
  for (const value of TICKET_CATEGORIES) {
    expect(toFilters({ category: value }).category).toBe(value);
  }
});
