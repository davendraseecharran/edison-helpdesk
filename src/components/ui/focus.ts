'use client';

import { useEffect, useLayoutEffect, useRef, type RefObject } from 'react';

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** Every element inside `root` that can currently take keyboard focus. */
export function focusableWithin(root: HTMLElement): HTMLElement[] {
  return Array.from(root.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
    (el) => !el.hasAttribute('aria-hidden') && el.offsetParent !== null,
  );
}

/**
 * Keep keyboard focus inside `ref` while `active`, and put it back where it
 * came from afterwards.
 *
 * On activation focus moves to the first element marked `data-autofocus`, else
 * the first focusable element, else the container itself. Tab and Shift+Tab
 * wrap at the edges. Nothing here changes the document's own focus order, so
 * closing the surface restores exactly what the user had before.
 */
export function useFocusTrap(ref: RefObject<HTMLElement | null>, active: boolean): void {
  const previous = useRef<HTMLElement | null>(null);

  useLayoutEffect(() => {
    if (!active) return;
    const root = ref.current;
    if (!root) return;

    previous.current = document.activeElement as HTMLElement | null;
    const preferred = root.querySelector<HTMLElement>('[data-autofocus]');
    const target = preferred ?? focusableWithin(root)[0] ?? root;
    target.focus({ preventScroll: true });

    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab' || !root) return;
      const items = focusableWithin(root);
      if (items.length === 0) {
        event.preventDefault();
        root.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const current = document.activeElement;
      if (event.shiftKey && (current === first || current === root)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && current === last) {
        event.preventDefault();
        first.focus();
      }
    }

    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      const back = previous.current;
      if (back && back.isConnected) back.focus({ preventScroll: true });
    };
  }, [ref, active]);
}

/**
 * Stop the page behind a modal surface from scrolling.
 *
 * Restores whatever inline overflow value the body had, so nesting or a page
 * that already locks scrolling is left exactly as found.
 */
export function useBodyScrollLock(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const body = document.body;
    const previous = body.style.overflow;
    body.style.overflow = 'hidden';
    return () => {
      body.style.overflow = previous;
    };
  }, [active]);
}

/** Call `onEscape` when Escape is pressed anywhere while `active`. */
export function useEscape(active: boolean, onEscape: () => void): void {
  useEffect(() => {
    if (!active) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault();
        onEscape();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [active, onEscape]);
}

/**
 * Call `onOutside` for a pointer press that lands outside every ref given.
 *
 * `pointerdown` rather than `click`: a press that starts outside should close
 * the surface even if the pointer then moves, and it must run before the
 * element under the pointer receives its own click.
 */
export function useOutsidePress(
  active: boolean,
  refs: RefObject<HTMLElement | null>[],
  onOutside: () => void,
): void {
  useEffect(() => {
    if (!active) return;
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node | null;
      if (!target) return;
      if (refs.some((ref) => ref.current?.contains(target))) return;
      onOutside();
    }
    document.addEventListener('pointerdown', onPointerDown);
    return () => document.removeEventListener('pointerdown', onPointerDown);
  }, [active, refs, onOutside]);
}
