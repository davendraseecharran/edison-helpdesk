'use client';

/**
 * The school's seal as a coin.
 *
 * Thomas A. Edison CTE High School's seal (from the school's website; white on
 * transparent in public/taehs-seal.png, of which only the alpha is used) is
 * stamped on the face of a disc with real thickness: a stack of thin rings
 * behind the face makes the edge, so when the coin turns you see its rim. On
 * arrival it spins in and settles face-on; after that it leans toward the
 * pointer (at most ~14 degrees) while a highlight slides across its face the
 * way light slides across metal. On a touch screen it sways slowly instead.
 *
 * All CSS 3D and one rAF-batched pointer listener: no canvas, no library,
 * nothing that delays the form under it. Monochrome — ink on paper in the light
 * theme, light on ink in the dark. Reduced motion: face-on and still.
 */

import { useEffect, useRef } from 'react';

const EDGE_LAYERS = 12;
const MAX_TILT = 14;

export function SealCoin() {
  const coin = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = coin.current;
    if (!el) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const fine = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    if (reduced || !fine) return;

    let frame = 0;
    let x = 0;
    let y = 0;
    const apply = () => {
      frame = 0;
      const rect = el.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      // Distance from the coin, eased so the lean saturates rather than snaps.
      const dx = Math.tanh((x - cx) / 320);
      const dy = Math.tanh((y - cy) / 320);
      el.style.setProperty('--ry', `${(dx * MAX_TILT).toFixed(2)}deg`);
      el.style.setProperty('--rx', `${(-dy * MAX_TILT).toFixed(2)}deg`);
      el.style.setProperty('--glare-x', `${(50 + dx * 45).toFixed(1)}%`);
      el.style.setProperty('--glare-y', `${(40 + dy * 40).toFixed(1)}%`);
    };
    const onMove = (event: PointerEvent) => {
      x = event.clientX;
      y = event.clientY;
      if (!frame) frame = requestAnimationFrame(apply);
    };
    const onLeave = () => {
      el.style.setProperty('--ry', '0deg');
      el.style.setProperty('--rx', '0deg');
      el.style.setProperty('--glare-x', '50%');
      el.style.setProperty('--glare-y', '35%');
    };
    window.addEventListener('pointermove', onMove, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    return () => {
      if (frame) cancelAnimationFrame(frame);
      window.removeEventListener('pointermove', onMove);
      document.documentElement.removeEventListener('pointerleave', onLeave);
    };
  }, []);

  return (
    <span className="seal-stage" aria-hidden="true">
      <span className="auth-bulb-halo" />
      <span className="seal-spin">
        <span className="seal-coin" ref={coin}>
          {Array.from({ length: EDGE_LAYERS }, (_, i) => (
            <span
              key={i}
              className="seal-edge"
              style={{ transform: `translateZ(${-(i + 1) * 1}px)` }}
            />
          ))}
          <span className="seal-back" />
          <span className="seal-face">
            <span className="seal-stamp" />
            <span className="seal-glare" />
          </span>
        </span>
      </span>
    </span>
  );
}
