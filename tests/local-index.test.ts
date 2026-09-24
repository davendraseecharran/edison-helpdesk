import { describe, expect, it } from 'vitest';
import { buildIndex, mergeHits, searchLocal, type IndexRow } from '@/lib/lookup/local-index';

const rows: IndexRow[] = [
  [0, 'p1', 'Nia Okonkwo', 'Student — 9A', '210982679', 'nia okonkwo nia okonkwo 210982679 nia.okonkwo@edison.example 9a'],
  [0, 'p2', 'Marcus Ellery', 'Staff — Science', 'mellery', 'marcus ellery marcus ellery mellery marcus.ellery@edison.example science'],
  [0, 'p3', 'José Núñez', 'Student — 10B', '243025319', 'josé núñez josé núñez 243025319 10b'],
  [1, 'd1', 'A-c630ed90', 'HP Fortis 14 G10 Chromebook', 'Assigned — Nia Okonkwo', 'a-c630ed90 5cdc630ed90 dev-1 fortis 14 g10 hp room 214 nia okonkwo'],
  [1, 'd2', 'A-61ef020e', 'Dell Latitude 3540 Laptop', 'In repair', 'a-61ef020e 5cd61ef020e dev-2 latitude 3540 dell repair bench'],
];
const index = buildIndex(rows, 0);

describe('the session search index', () => {
  it('finds a person by the start of each word typed', () => {
    expect(searchLocal(index, 'nia ok').map((hit) => hit.id)).toContain('p1');
    expect(searchLocal(index, 'ell').map((hit) => hit.id)).toEqual(['p2']);
  });

  it('ignores accents both ways', () => {
    expect(searchLocal(index, 'jose nun').map((hit) => hit.id)).toEqual(['p3']);
  });

  it('ranks an identifier that is the whole query first', () => {
    const hits = searchLocal(index, '210982679');
    expect(hits[0]).toMatchObject({ kind: 'person', id: 'p1', href: '/people/p1' });
  });

  it('finds a machine by any part of its tag, punctuation or not', () => {
    expect(searchLocal(index, '0ed9').map((hit) => hit.id)).toEqual(['d1']);
    expect(searchLocal(index, 'ac630').map((hit) => hit.id)).toEqual(['d1']);
  });

  it('finds a machine by the person holding it', () => {
    expect(searchLocal(index, 'okonkwo').map((hit) => hit.id)).toEqual(['p1', 'd1']);
  });

  it('asks nothing of one letter', () => {
    expect(searchLocal(index, 'n')).toEqual([]);
  });

  it('puts the server answer first and keeps local rows it did not return', () => {
    const local = searchLocal(index, 'okonkwo');
    const server = [{ kind: 'ticket' as const, id: 't1', title: 'EDT-1 x', subtitle: null, meta: null, href: '/tickets/t1' }, local[0]];
    expect(mergeHits(local, server).map((hit) => hit.id)).toEqual(['t1', 'p1', 'd1']);
  });
});

import { areasForPath } from '@/lib/domain/live-changes';

describe('which screens a colleague\'s change refreshes', () => {
  it('maps a screen to the areas it shows', () => {
    expect(areasForPath('/devices/abc')).toEqual(['inventory', 'directory']);
    expect(areasForPath('/events/1')).toContain('groups');
    expect(areasForPath('/settings')).toEqual([]);
  });
});
