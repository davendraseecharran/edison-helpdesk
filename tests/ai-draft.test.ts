import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { clearDraft, DRAFT_MAX_LENGTH, readDraft, writeDraft } from '../src/components/ai/draft-store';

/**
 * The draft has one job: survive the device-code round trip. So the tests are
 * about the failures that would silently lose it — a different account, a
 * browser that refuses storage, and a value long enough to fill the quota.
 */
type Store = { [key: string]: string };

function fakeStorage(store: Store, refuse = false) {
  return {
    getItem: (key: string) => {
      if (refuse) throw new Error('storage disabled');
      return Object.hasOwn(store, key) ? store[key] : null;
    },
    setItem: (key: string, value: string) => {
      if (refuse) throw new Error('storage disabled');
      store[key] = value;
    },
    removeItem: (key: string) => {
      if (refuse) throw new Error('storage disabled');
      delete store[key];
    },
  };
}

function install(store: Store, refuse = false): void {
  vi.stubGlobal('window', { sessionStorage: fakeStorage(store, refuse) });
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the composer draft', () => {
  it('comes back the way it went in', () => {
    const store: Store = {};
    install(store);
    writeDraft('acct-1', 'who has cart 3');
    expect(readDraft('acct-1')).toBe('who has cart 3');
  });

  it('belongs to one account', () => {
    const store: Store = {};
    install(store);
    writeDraft('acct-1', 'mine');
    expect(readDraft('acct-2')).toBe('');
  });

  it('removes the key rather than storing an empty draft', () => {
    const store: Store = {};
    install(store);
    writeDraft('acct-1', 'something');
    writeDraft('acct-1', '   ');
    expect(Object.keys(store)).toEqual([]);
    expect(readDraft('acct-1')).toBe('');
  });

  it('clears on request', () => {
    const store: Store = {};
    install(store);
    writeDraft('acct-1', 'something');
    clearDraft('acct-1');
    expect(readDraft('acct-1')).toBe('');
  });

  it('caps what it will store', () => {
    const store: Store = {};
    install(store);
    writeDraft('acct-1', 'x'.repeat(DRAFT_MAX_LENGTH + 500));
    expect(readDraft('acct-1').length).toBe(DRAFT_MAX_LENGTH);
  });

  it('never throws when the browser refuses storage', () => {
    install({}, true);
    expect(() => writeDraft('acct-1', 'text')).not.toThrow();
    expect(() => clearDraft('acct-1')).not.toThrow();
    expect(readDraft('acct-1')).toBe('');
  });

  it('answers with nothing on the server', () => {
    // No `window` at all: the panel's initialiser runs during a server render.
    expect(readDraft('acct-1')).toBe('');
    expect(() => writeDraft('acct-1', 'text')).not.toThrow();
  });

  it('ignores an account with no id', () => {
    const store: Store = {};
    install(store);
    writeDraft('', 'text');
    expect(Object.keys(store)).toEqual([]);
    expect(readDraft('')).toBe('');
  });
});
