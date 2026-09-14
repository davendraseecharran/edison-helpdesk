'use client';

/**
 * Single-key shortcuts, and the two guards every one of them needs.
 *
 * A bare letter is the fastest thing a keyboard can do and the easiest thing to
 * get wrong: press `c` while a note is half-typed and the ticket claims itself
 * instead of writing a C. So every shortcut here goes through the same two
 * checks the palette's `/` already used — nothing editable has focus, and no
 * modal surface is open — which is why they live in one module rather than
 * being written again beside each handler.
 *
 * Shortcuts are for actions the page already offers with a visible control.
 * Nothing is reachable only from the keyboard, and every key bound here is
 * shown as a keycap on the button it presses.
 */

import { useEffect, useRef } from 'react';

/** Whether a keystroke would type into `target`: a field, or anything editable. */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/**
 * Whether a modal surface owns the keyboard.
 *
 * The palette, the sheets, the dialogs and the account and bell popovers all
 * carry `role="dialog"` with `aria-modal="true"`, which is both the honest
 * accessibility answer and the one selector everything here can agree on. The
 * assistant panel is a partial exception: on desktop it sits beside the page
 * rather than over it, so it only sets `aria-modal` in the phone layout — but
 * it still owns the keyboard while it has focus, so it marks its root with
 * `data-keyboard-owner` for this check to catch either way.
 */
export function modalOpen(): boolean {
  return (
    document.querySelector('[role="dialog"][aria-modal="true"]') !== null ||
    document.querySelector('[data-keyboard-owner]') !== null
  );
}

/** A plain press of `key`: no modifier, no repeat, not mid-composition. */
function isBarePress(event: KeyboardEvent, key: string): boolean {
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  if (event.isComposing || event.repeat) return false;
  return event.key.toLowerCase() === key;
}

/**
 * Runs `handler` on a bare press of `key`, while `enabled`.
 *
 * `handler` is read from a ref on every press, so a component may pass a fresh
 * closure each render without rebinding the listener — and without the listener
 * ever calling a stale one. `enabled` is the component's own answer to "is this
 * action available right now": a claim shortcut is bound only while the ticket
 * can actually be claimed, so an unavailable key does nothing rather than
 * failing at the server.
 */
export function useShortcut(key: string, handler: () => void, enabled = true): void {
  const latest = useRef(handler);
  useEffect(() => {
    latest.current = handler;
  });

  useEffect(() => {
    if (!enabled) return;
    function onKeyDown(event: KeyboardEvent) {
      if (!isBarePress(event, key)) return;
      if (modalOpen() || isEditable(event.target)) return;
      event.preventDefault();
      latest.current();
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [key, enabled]);
}
