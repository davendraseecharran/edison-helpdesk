'use client';

/**
 * The keyboard on a list of rows.
 *
 * Binds the model in `src/lib/lists/keys.ts` to a real list: `j` and `k` move
 * the focus, the number keys jump, `o` opens, `c` claims, `r` resolves and `e`
 * edits. Arrow keys, Home and End work too, but only while the focus is
 * already inside the list — bound globally they would take the page's scroll
 * away from everybody who never wanted a list shortcut.
 *
 * Three things this hook is careful about.
 *
 * It never steals focus. The first render focuses nothing; a row takes the
 * browser's focus only after a key moved it there, which is the difference
 * between a list you can drive and a page that grabs your cursor when it loads.
 *
 * It never animates. This is the interaction repeated all day, and the rule
 * does not bend: the lamp moves to the focused row instantly, the browser
 * scrolls it into view with no smooth behaviour, and nothing fades.
 *
 * It keeps your place when the list changes under you. Claim the row you are
 * on and it leaves the list; the focus stays at that position, on whatever
 * moved up into it, rather than jumping back to the top.
 *
 * Every key presses a control that is visible on the row. Nothing here is the
 * only way to do anything.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { actionFor, focusAfterChange, nextFocus, type ListAction } from '@/lib/lists/keys';
import { isEditable, modalOpen } from './shortcuts';

export interface RowKeysOptions<Row> {
  rows: readonly Row[];
  /** A stable identity per row, so the focus survives the list changing. */
  keyOf: (row: Row) => string;
  /** Bind nothing while false: a screen with no list, or one behind a dialog. */
  enabled?: boolean;
  /** What an action does with the focused row. */
  onAction: (action: ListAction, row: Row) => void;
  /**
   * Whether this row offers this action at all. Pressing `c` on a row that
   * cannot be claimed does nothing, rather than failing at the server.
   */
  can?: (action: ListAction, row: Row) => boolean;
}

export interface RowKeys {
  /** The row the keyboard is on, or null. */
  focusedKey: string | null;
  /** Point the keyboard at a row, for a pointer press or a programmatic move. */
  focus: (key: string | null) => void;
  /** Attributes for the row element: identity, roving tabindex, the lamp. */
  rowProps: (key: string) => {
    'data-row-key': string;
    'data-focused': '' | undefined;
    tabIndex: 0 | -1;
    onFocus: () => void;
  };
  /** Attributes for the list element: the arrow keys, scoped to the list. */
  listProps: {
    ref: (element: HTMLElement | null) => void;
    onKeyDown: (event: ReactKeyboardEvent) => void;
  };
}

/** A plain press: no modifier, no repeat from a held key, not mid-composition. */
function isBare(event: KeyboardEvent): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  return !event.isComposing && !event.repeat;
}

export function useRowKeys<Row>({
  rows,
  keyOf,
  enabled = true,
  onAction,
  can,
}: RowKeysOptions<Row>): RowKeys {
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const listRef = useRef<HTMLElement | null>(null);
  // Set only by a key press, so a re-render never pulls the browser's focus
  // onto a row the reader did not ask for.
  const moveRequested = useRef(false);

  const keys = rows.map(keyOf);
  const signature = keys.join('\u0000');

  // The latest list and handlers, read by the one document listener, so the
  // listener is bound once per screen rather than rebound on every render.
  // Written in an effect rather than during render: a ref is not rendering
  // state, and a press cannot happen between a commit and its effects.
  const latest = useRef({ keys, rows, onAction, can, focusedKey });
  useEffect(() => {
    latest.current = { keys, rows, onAction, can, focusedKey };
  });

  // Keep the focus on the identity it was on; when that row has gone, stay at
  // the same position rather than returning to the top of the list. Keyed on
  // the joined signature rather than the array, which is rebuilt every render;
  // the array itself is read from the ref the effect above has just refreshed.
  const previous = useRef<readonly string[]>(keys);
  useEffect(() => {
    const next = latest.current.keys;
    const settled = focusAfterChange(previous.current, next, latest.current.focusedKey);
    previous.current = next;
    setFocusedKey((current) => (settled === current ? current : settled));
  }, [signature]);

  // Move the browser's focus to follow the keyboard's, but only after a key
  // asked for it. `block: 'nearest'` and no smooth behaviour: a list driven
  // with `j` must not animate once per press.
  useEffect(() => {
    if (!moveRequested.current) return;
    moveRequested.current = false;
    if (focusedKey === null) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-row-key="${CSS.escape(focusedKey)}"]`,
    );
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: 'nearest' });
  }, [focusedKey]);

  const move = useCallback((key: string) => {
    const { keys: current, focusedKey: at } = latest.current;
    const target = nextFocus(at === null ? -1 : current.indexOf(at), key, current.length);
    if (target === null) return;
    moveRequested.current = true;
    setFocusedKey(current[target]);
  }, []);

  const live = enabled && rows.length > 0;

  /*
   * One listener for the whole model.
   *
   * The same two guards every single-key shortcut in this application uses:
   * nothing editable has the focus, and no modal surface owns the keyboard. A
   * bare letter is the fastest thing a keyboard can do and the easiest thing to
   * get wrong — `c` while a note is half-typed must type a C.
   */
  useEffect(() => {
    if (!live) return;
    function onKeyDown(event: KeyboardEvent) {
      if (!isBare(event)) return;
      if (modalOpen() || isEditable(event.target)) return;

      const { keys: current, rows: currentRows, onAction: act, can: allows, focusedKey: at } = latest.current;

      if (nextFocus(-1, event.key, current.length) !== null && event.key.toLowerCase() !== 'enter') {
        // Home and End are movement too, but they belong to the list's own
        // handler: pressed with the focus elsewhere they mean "top of the page".
        const key = event.key.toLowerCase();
        if (key === 'home' || key === 'end' || key === 'arrowup' || key === 'arrowdown') return;
        event.preventDefault();
        move(event.key);
        return;
      }

      const action = actionFor(event.key);
      if (action === null || at === null) return;
      // Enter belongs to whatever has the focus. On the row itself it opens;
      // on a button inside the row it presses that button, and swallowing it
      // here would make the visible control the one thing that does not work.
      if (
        event.key === 'Enter' &&
        !(event.target instanceof HTMLElement && event.target.hasAttribute('data-row-key'))
      ) {
        return;
      }
      const index = current.indexOf(at);
      if (index < 0) return;
      const row = currentRows[index];
      if (allows && !allows(action, row)) return;
      event.preventDefault();
      act(action, row);
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [live, move]);

  const focus = useCallback((key: string | null) => setFocusedKey(key), []);

  const rowProps = useCallback(
    (key: string) => ({
      'data-row-key': key,
      'data-focused': (key === focusedKey ? '' : undefined) as '' | undefined,
      tabIndex: (key === focusedKey ? 0 : -1) as 0 | -1,
      onFocus: () => setFocusedKey(key),
    }),
    [focusedKey],
  );

  /** Arrows, Home and End, only while the focus is inside the list. */
  const onKeyDown = useCallback(
    (event: ReactKeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key !== 'arrowup' && key !== 'arrowdown' && key !== 'home' && key !== 'end') return;
      event.preventDefault();
      move(event.key);
    },
    [move],
  );

  const setList = useCallback((element: HTMLElement | null) => {
    listRef.current = element;
  }, []);

  return { focusedKey, focus, rowProps, listProps: { ref: setList, onKeyDown } };
}
