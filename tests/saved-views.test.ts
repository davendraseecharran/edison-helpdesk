import { describe, expect, it } from 'vitest';
import {
  addSavedView,
  normaliseQuery,
  parseSavedViews,
  removeSavedView,
  SAVED_VIEW_LIMIT,
  SAVED_VIEW_NAME_MAX,
  savedViewError,
  viewFromRow,
  viewHref,
  viewIsCurrent,
  viewsFor,
  type SavedView,
} from '../src/lib/domain/saved-views';

function view(id: string, patch: Partial<SavedView> = {}): SavedView {
  return { id, name: `View ${id}`, path: '/queue', query: 'status=open', ...patch };
}

describe('normaliseQuery', () => {
  it('sorts the keys, so two views built in a different order are one view', () => {
    expect(normaliseQuery('priority=high&status=open')).toBe(
      normaliseQuery('status=open&priority=high'),
    );
  });

  it('drops the page, because a view is a filter and not a scroll position', () => {
    expect(normaliseQuery('status=open&page=3')).toBe('status=open');
  });

  it('drops an empty value', () => {
    expect(normaliseQuery('status=open&query=')).toBe('status=open');
  });

  it('reads an unfiltered list as an empty query rather than as nothing', () => {
    expect(normaliseQuery('')).toBe('');
  });
});

describe('viewHref', () => {
  it('links to the list with its filters', () => {
    expect(viewHref(view('a'))).toBe('/queue?status=open');
  });

  it('links to the bare list when the view has no filters', () => {
    expect(viewHref(view('a', { query: '' }))).toBe('/queue');
  });
});

describe('viewIsCurrent', () => {
  it('recognises the view on screen however its query was spelled', () => {
    const saved = view('a', { query: 'priority=high&status=open' });
    expect(viewIsCurrent(saved, '/queue', 'status=open&priority=high&page=2')).toBe(true);
  });

  it('is not the view on a different list', () => {
    expect(viewIsCurrent(view('a'), '/all-tickets', 'status=open')).toBe(false);
  });
});

describe('viewFromRow', () => {
  it('reads a whole row', () => {
    expect(viewFromRow({ id: 'a', name: ' Room 214 ', path: '/queue', query: 'page=2&q=x' })).toEqual({
      id: 'a',
      name: 'Room 214',
      path: '/queue',
      query: 'q=x',
    });
  });

  it('drops a row that is missing what a chip needs', () => {
    expect(viewFromRow(null)).toBeNull();
    expect(viewFromRow({ name: 'x', path: '/queue' })).toBeNull();
    expect(viewFromRow({ id: 'a', name: '   ', path: '/queue' })).toBeNull();
  });

  it('refuses a path that is not in-app, even from the database', () => {
    expect(viewFromRow({ id: 'a', name: 'x', path: 'https://evil.example' })).toBeNull();
    expect(viewFromRow({ id: 'a', name: 'x', path: '//evil.example' })).toBeNull();
  });

  it('caps a long name rather than refusing it', () => {
    const long = viewFromRow({ id: 'a', name: 'x'.repeat(200), path: '/queue' });
    expect(long?.name.length).toBe(SAVED_VIEW_NAME_MAX);
  });
});

describe('parseSavedViews', () => {
  it('reads a stored list', () => {
    const raw = JSON.stringify([{ id: 'a', name: 'Room 214', path: '/queue', query: '' }]);
    expect(parseSavedViews(raw)).toEqual([{ id: 'a', name: 'Room 214', path: '/queue', query: '' }]);
  });

  it('survives anything that is not a list', () => {
    expect(parseSavedViews(undefined)).toEqual([]);
    expect(parseSavedViews('not json')).toEqual([]);
    expect(parseSavedViews('{"a":1}')).toEqual([]);
    expect(parseSavedViews([null, 3, 'x'])).toEqual([]);
  });

  it('collapses duplicates and caps the list', () => {
    const many = Array.from({ length: 60 }, (_, index) => view(`v${index}`));
    expect(parseSavedViews([...many, view('v0')]).length).toBe(SAVED_VIEW_LIMIT);
  });
});

describe('addSavedView', () => {
  it('puts the newest first', () => {
    const list = [view('a', { query: 'status=open' })];
    const next = addSavedView(list, view('b', { query: 'priority=high' }));
    expect(next.map((entry) => entry.id)).toEqual(['b', 'a']);
  });

  it('replaces a view with the same filters rather than adding a second chip', () => {
    const list = [view('a', { name: 'Old', query: 'status=open' })];
    const next = addSavedView(list, view('b', { name: 'New', query: 'status=open' }));
    expect(next).toEqual([view('b', { name: 'New', query: 'status=open' })]);
  });

  it('replaces the same id', () => {
    const next = addSavedView([view('a', { name: 'Old' })], view('a', { name: 'New' }));
    expect(next.length).toBe(1);
    expect(next[0].name).toBe('New');
  });
});

describe('removeSavedView', () => {
  it('removes by id and leaves the rest', () => {
    expect(removeSavedView([view('a'), view('b')], 'a').map((entry) => entry.id)).toEqual(['b']);
  });
});

describe('savedViewError', () => {
  it('asks for a name', () => {
    expect(savedViewError('   ', [])).toBe('Give the view a name so you can find it again.');
  });

  it('refuses a name longer than the column takes', () => {
    expect(savedViewError('x'.repeat(200), [])).toContain('up to 60 characters');
  });

  it('refuses a list that is already full', () => {
    const full = Array.from({ length: SAVED_VIEW_LIMIT }, (_, index) => view(`v${index}`));
    expect(savedViewError('Another', full)).toContain('up to 24 saved views');
  });

  it('is happy with a name and room', () => {
    expect(savedViewError('Room 214', [])).toBeNull();
  });
});

describe('viewsFor', () => {
  it('shows a list only its own views', () => {
    const list = [view('a'), view('b', { path: '/devices' })];
    expect(viewsFor(list, '/queue').map((entry) => entry.id)).toEqual(['a']);
  });
});
