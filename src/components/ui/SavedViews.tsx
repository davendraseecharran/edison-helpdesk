'use client';

/**
 * The filter sets somebody named, as chips above the list.
 *
 * A NetRider builds the same three or four filter combinations every week —
 * "Room 214", "Chromebook batteries", "Everything waiting on a part" — and
 * rebuilding one is six controls and a search box. A chip is one press.
 *
 * Where they live: `account_preferences.saved_views`, so they follow the person
 * to the phone and to whichever machine is free at the desk, with this
 * browser's own copy as the fallback. The browser copy is written first and the
 * server is told afterwards, because a chip that only appears after a round
 * trip is a chip somebody presses twice. If the server refuses, the chips still
 * work here and the next machine simply has not heard about them — which is a
 * better failure than losing the press.
 *
 * Nothing here animates. Chips are pressed all day.
 */

import { useCallback, useMemo, useState } from 'react';
import Link from 'next/link';
import { Check, Plus, X } from 'lucide-react';
import { useRuntime } from '@/components/AppRuntime';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { saveViewsAction } from '@/lib/data/view-actions';
import {
  addSavedView,
  parseSavedViews,
  removeSavedView,
  savedViewError,
  viewHref,
  viewIsCurrent,
  viewsFor,
  normaliseQuery,
  type SavedView,
} from '@/lib/domain/saved-views';
import '@/styles/lists.css';

const STORAGE_KEY = 'edison.saved-views';

function readLocal(): SavedView[] {
  if (typeof window === 'undefined') return [];
  try {
    return parseSavedViews(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return [];
  }
}

function writeLocal(views: SavedView[]): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(views));
  } catch {
    // Storage refused. The list still applies to this page.
  }
}

/** A short, stable id. `crypto.randomUUID` is not everywhere; this is enough. */
function newId(): string {
  return `v${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`;
}

export interface SavedViewsProps {
  /** The list this bar belongs to: `/queue`, `/all-tickets`. */
  path: string;
  /** The current query string, without its leading `?`. */
  query: string;
  /** What the account has saved, from the server. */
  stored: readonly SavedView[];
}

export function SavedViews({ path, query, stored }: SavedViewsProps) {
  const { notify } = useRuntime();
  /*
   * The server's list is the starting point and this browser's copy fills in
   * anything the server has not heard about yet. Merged rather than chosen,
   * because the two disagree for exactly as long as one save is in flight.
   */
  const [local, setLocal] = useState<SavedView[]>(readLocal);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  const all = useMemo(() => {
    let merged = [...stored];
    for (const view of local) merged = addSavedView(merged, view);
    return merged;
  }, [stored, local]);

  const chips = useMemo(() => viewsFor(all, path), [all, path]);
  const here = normaliseQuery(query);
  const alreadySaved = chips.some((view) => view.query === here);

  const persist = useCallback(
    (views: SavedView[]) => {
      setLocal(views);
      writeLocal(views);
      void saveViewsAction(views).then((result) => {
        if (!result.ok) {
          notify(
            'error',
            'That view is saved on this machine but could not be saved to your account. It will not follow you to another one.',
          );
        }
      });
    },
    [notify],
  );

  const save = useCallback(() => {
    const invalid = savedViewError(name, all);
    if (invalid) {
      setError(invalid);
      return;
    }
    persist(addSavedView(all, { id: newId(), name: name.trim(), path, query: here }));
    setName('');
    setNaming(false);
    setError(null);
  }, [name, all, persist, path, here]);

  const forget = useCallback(
    (id: string) => {
      persist(removeSavedView(all, id));
    },
    [all, persist],
  );

  // Nothing saved and nothing to save: the bar is not worth a row.
  if (chips.length === 0 && here === '' && !naming) return null;

  return (
    <div className="saved-views" role="group" aria-label="Saved views">
      {chips.map((view) => {
        const current = viewIsCurrent(view, path, query);
        return (
          <span key={view.id} className="saved-view" data-current={current || undefined}>
            <Link className="saved-view-open" href={viewHref(view)}>
              {current ? <Icon icon={Check} size={13} /> : null}
              {view.name}
            </Link>
            <button
              type="button"
              className="saved-view-forget"
              aria-label={`Remove the saved view ${view.name}`}
              onClick={() => forget(view.id)}
            >
              <Icon icon={X} size={13} />
            </button>
          </span>
        );
      })}

      {naming ? (
        <span className="saved-view-namer">
          <input
            className="saved-view-name"
            value={name}
            autoFocus
            maxLength={60}
            placeholder="Name this view"
            aria-label="Name this view"
            aria-invalid={error ? 'true' : undefined}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                save();
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                setNaming(false);
                setError(null);
              }
            }}
          />
          <Button size="sm" onClick={save}>
            Save
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setNaming(false)}>
            Cancel
          </Button>
        </span>
      ) : here !== '' && !alreadySaved ? (
        <button type="button" className="saved-view-add" onClick={() => setNaming(true)}>
          <Icon icon={Plus} size={13} />
          Save this view
        </button>
      ) : null}

      {error ? (
        <span className="saved-view-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
