'use client';

/**
 * Objects lean towards the pointer.
 *
 * A few things on screen are objects rather than rows — a workflow's tile,
 * the model of a machine on its own page, the stack of blank forms — and
 * those, and only those, carry `data-tilt`. Under a precise pointer they
 * turn a few degrees towards it (never more than `--tilt-max`, 4° by
 * default) and a soft glare follows the pointer across them, the way a card
 * held under a lamp catches the light. It says "this is a thing you can
 * pick up" without a word, and it settles back flat the moment the pointer
 * leaves.
 *
 * One listener for the whole application, delegated from the document, so
 * an object needs no code of its own: the attribute and the stylesheet
 * (`components.css`, "Tilt") are all of it. The work per event is one
 * `getBoundingClientRect` and three custom properties, batched to the next
 * frame, and only `transform` and `opacity` move. A touch screen, a coarse
 * pointer or reduced motion never tilts anything.
 */

import { useEffect } from 'react';

const FINE = '(hover: hover) and (pointer: fine)';
const REDUCED = '(prefers-reduced-motion: reduce)';

export function TiltField() {
  useEffect(() => {
    if (typeof window.matchMedia !== 'function') return;
    const fine = window.matchMedia(FINE);
    const reduced = window.matchMedia(REDUCED);

    let active: HTMLElement | null = null;
    let frame = 0;
    let last: PointerEvent | null = null;

    const release = () => {
      if (!active) return;
      active.removeAttribute('data-tilting');
      active.style.removeProperty('--tilt-x');
      active.style.removeProperty('--tilt-y');
      active = null;
    };

    const apply = () => {
      frame = 0;
      const event = last;
      if (!event || !active) return;
      const rect = active.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      const px = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width));
      const py = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height));
      // Unitless, -1 to 1; the stylesheet multiplies by the object's maximum.
      active.style.setProperty('--tilt-x', ((0.5 - py) * 2).toFixed(3));
      active.style.setProperty('--tilt-y', ((px - 0.5) * 2).toFixed(3));
      active.style.setProperty('--glare-x', `${(px * 100).toFixed(1)}%`);
      active.style.setProperty('--glare-y', `${(py * 100).toFixed(1)}%`);
    };

    const onMove = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || !fine.matches || reduced.matches) {
        release();
        return;
      }
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-tilt]') : null;
      if (target !== active) {
        release();
        if (!target) return;
        active = target;
        active.setAttribute('data-tilting', '');
      }
      last = event;
      if (!frame) frame = requestAnimationFrame(apply);
    };

    const onLeave = () => release();

    document.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    window.addEventListener('blur', onLeave);
    return () => {
      cancelAnimationFrame(frame);
      release();
      document.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      window.removeEventListener('blur', onLeave);
    };
  }, []);
  return null;
}
