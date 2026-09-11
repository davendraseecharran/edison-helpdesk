import { expect, it } from 'vitest';
import { toFilters } from '../src/app/(app)/search-params';
it('normalizes repeated query parameters and bounds pagination offsets', () => {
  expect(toFilters({ query: ['display', 'ignored'], owner: ['all'], page: ['2'] }))
    .toMatchObject({ query: 'display', owner: 'all', page: 2 });
  expect(toFilters({page:'999999999999999999999'}).page).toBe(1);
  expect(toFilters({page:'2000000000'}).page).toBe(1_000_000);
  expect(toFilters({page:'-1'}).page).toBe(1);
});
