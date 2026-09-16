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

/**
 * Whether a keystroke would type into `target`: a field, anything editable, or
 * the one control that types without looking like a field.
 *
 * A select's trigger takes a letter the moment it has focus and jumps its list
 * to the first option that starts with it, list open or closed — that is what
 * every select on the machine does, and Radix does not stop the character
 * travelling on to the document afterwards. It used to be a native `<select>`
 * and the tag check below covered it; there is no `<select>` left in this
 * product, so the check that names it is the one that is left.
 */
export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  if (target.closest('[data-slot="select-trigger"]') !== null) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA';
}

/**
 * The two ways a surface says "the keyboard is mine while I am here".
 *
 * The palette, the sheets and the dialogs all carry `role="dialog"` with
 * `aria-modal="true"`, which is both the honest accessibility answer and a
 * selector everything here can agree on. `data-keyboard-owner` is for the rest,
 * and there are more of them than there look: the assistant panel sits beside
 * the page on desktop and so only claims `aria-modal` in the phone layout; the
 * account and notifications popovers are panels rather than dialogs; and an
 * open menu or select list is neither, but it navigates with the arrows and
 * types ahead, and Radix passes a character key straight on to the document
 * after using it. With a menu open, a bare `n` used to jump the typeahead *and*
 * navigate to the new-ticket form behind it.
 */
const KEYBOARD_OWNERS = '[role="dialog"][aria-modal="true"], [data-keyboard-owner]';

/** Whether any of those is on screen right now. */
export function modalOpen(): boolean {
  return document.querySelector(KEYBOARD_OWNERS) !== null;
}

/*
 * The docked assistant is a keyboard owner for bare keys (`n` in its
 * composer is a letter, not a shortcut) but it is not a modal: it sits
 * beside the page. Cmd K is asked for from inside it all day, so for that
 * one chord the docked panel does not count. Its own menus still do.
 */
const CHORD_OWNERS =
  '[role="dialog"][aria-modal="true"], [data-keyboard-owner]:not(.ai-root[data-layout="docked"])';

/** Whether something that should swallow a modifier chord is on screen. */
export function chordOwnerOpen(): boolean {
  return document.querySelector(CHORD_OWNERS) !== null;
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
