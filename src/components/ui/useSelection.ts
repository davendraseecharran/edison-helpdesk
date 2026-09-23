'use client';

import { useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';

/**
 * A selection that outlives the view it was made in.
 *
 * Ticking three people, searching for a fourth and ticking them too is how a
 * list of recipients gets built, so a new search or page no longer drops what
 * was ticked before. The rows themselves are kept, not only their ids, so the
 * selection can be acted on (written to, copied, listed) while most of it is
 * off screen. A row that is on screen again is refreshed from the page.
 */
export function useKeptSelection<T>(rows: readonly T[], keyOf: (row: T) => string) {
  const [kept, setKept] = useState<ReadonlyMap<string, T>>(() => new Map());

  const onPage = useMemo(() => rows.map(keyOf), [rows, keyOf]);

  // Fresh copies of the rows in view, so an edit made elsewhere is not acted on stale.
  const items = useMemo(() => {
    const fresh = new Map(rows.map((row) => [keyOf(row), row] as const));
    return [...kept.keys()].map((id) => fresh.get(id) ?? (kept.get(id) as T));
  }, [kept, rows, keyOf]);

  function apply(ids: readonly string[], on: boolean) {
    setKept((prev) => {
      const next = new Map(prev);
      for (const id of ids) {
        if (!on) {
          next.delete(id);
          continue;
        }
        const row = rows.find((candidate) => keyOf(candidate) === id);
        if (row) next.set(id, row);
      }
      return next;
    });
  }

  const selectedOnPage = onPage.filter((id) => kept.has(id)).length;

  return {
    /** Every selected row, in the order they were picked. */
    items,
    size: kept.size,
    has: (id: string) => kept.has(id),
    apply,
    remove: (id: string) => apply([id], false),
    clear: () => setKept(new Map()),
    /** The ids in view, in display order, for ranges and paint. */
    onPage,
    allOnPage: onPage.length > 0 && selectedOnPage === onPage.length,
    someOnPage: selectedOnPage > 0,
    /** Selected rows the current view does not show. */
    offPage: kept.size - selectedOnPage,
    setAllOnPage: (on: boolean) => apply(onPage, on),
  };
}

/**
 * Checkboxes you can paint.
 *
 * Press on a box and drag down the column: every box the pointer crosses takes
 * the first box's new state, the way a spreadsheet fills a range. Shift-click
 * ticks (or clears) everything between the last box touched and this one. Both
 * are mouse gestures; on a touch screen a drag scrolls, so touch and the
 * keyboard (Space) keep the plain one-box toggle.
 *
 * The native click that follows a press is swallowed for the box the press
 * started on, because the press has already decided that box's state.
 */
export function usePaintSelect({
  order,
  isOn,
  apply,
}: {
  order: readonly string[];
  isOn: (id: string) => boolean;
  apply: (ids: readonly string[], on: boolean) => void;
}) {
  const painting = useRef<boolean | null>(null);
  const anchor = useRef<string | null>(null);
  const swallow = useRef<string | null>(null);
  const [active, setActive] = useState(false);

  useEffect(() => {
    if (!active) return;
    const stop = () => {
      painting.current = null;
      setActive(false);
      // The click that ends a press arrives before this timer; one released
      // over a different box never arrives, and must not eat a later Space.
      setTimeout(() => {
        swallow.current = null;
      }, 0);
    };
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    window.addEventListener('blur', stop);
    return () => {
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
      window.removeEventListener('blur', stop);
    };
  }, [active]);

  function range(from: string, to: string): string[] {
    const a = order.indexOf(from);
    const b = order.indexOf(to);
    if (a === -1 || b === -1) return [to];
    return order.slice(Math.min(a, b), Math.max(a, b) + 1);
  }

  return {
    /** Paint is under way; the list can show it (cursor, no text selection). */
    painting: active,
    boxProps(id: string) {
      return {
        'data-paint-box': '',
        onPointerDown(event: PointerEvent<HTMLElement>) {
          if (event.pointerType !== 'mouse' || event.button !== 0) return;
          event.preventDefault();
          const target = !isOn(id);
          swallow.current = id;
          if (event.shiftKey && anchor.current && anchor.current !== id) {
            apply(range(anchor.current, id), target);
            anchor.current = id;
            setActive(true);
            return;
          }
          apply([id], target);
          anchor.current = id;
          painting.current = target;
          setActive(true);
        },
        onPointerEnter() {
          const target = painting.current;
          if (target === null || isOn(id) === target) return;
          apply([id], target);
          anchor.current = id;
        },
      };
    },
    /** The checkbox's own change: the keyboard, a touch, or the swallowed click. */
    change(id: string, on: boolean) {
      if (swallow.current === id) {
        swallow.current = null;
        return;
      }
      swallow.current = null;
      apply([id], on);
      anchor.current = id;
    },
  };
}
