'use client';

/**
 * The dotted mark, drawn on its own clock.
 *
 * `thinking-logos` supplies the geometry (a state resolved against the baked
 * points gives a frame function) and the paint; this component supplies the
 * time. The library's own component runs every cloud on one shared clock
 * that never rewinds, which is right for a page of marks meant to loop in
 * step and wrong for a mark that should open on the logo: a second welcome
 * would start, or hold, wherever the first one left off. Here time starts
 * at the assembled mark when the canvas mounts, holds there for `holdMs`,
 * and runs on from it — and a mark that is scrolled or tabbed away stops its
 * clock rather than its picture, so what comes back is what left.
 *
 * Under reduced motion one frame is painted, the assembled mark, and nothing
 * else happens.
 */

import { useEffect, useRef } from 'react';
import { resolveLogo, type LogoPointSet, type LogoState } from 'thinking-logos';
import { paintFrame, type ModeOpts } from 'thinking-logos/engine';
import { cloudTime } from '@/lib/ai/mark-clock';

/** The library's own defaults, restated because a preset may leave either unset. */
const DWELL = 5.5;
const MORPH = 1.9;

export function MarkCloud({
  logo,
  state,
  size,
  dark,
  tune,
  holdMs = 0,
  reduced = false,
  className,
}: {
  logo: LogoPointSet;
  state: LogoState;
  /** Rendered size in CSS pixels; the canvas is square. */
  size: number;
  dark: boolean;
  tune?: ModeOpts;
  /** How long the assembled mark is held before the first movement. */
  holdMs?: number;
  reduced?: boolean;
  className?: string;
}) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const ratio = Math.min(2, (typeof devicePixelRatio === 'number' && devicePixelRatio) || 1);
    canvas.width = Math.round(size * ratio);
    canvas.height = Math.round(size * ratio);
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const { frame, speed, opts, binding } = resolveLogo(state, logo, tune);
    const dwell = typeof opts.dwell === 'number' ? opts.dwell : DWELL;
    const morph = typeof opts.morph === 'number' ? opts.morph : MORPH;
    // The instant in the cycle at which every dot is on the logo.
    const mark = dwell + morph;

    const paint = (t: number) => {
      ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
      ctx.clearRect(0, 0, size, size);
      paintFrame(ctx, frame(size, t, opts, binding), dark);
    };

    paint(mark);
    if (reduced) return;

    // Elapsed time is accumulated only while the frames are running, so a
    // pause (hidden tab, scrolled out of view) does not skip ahead on return.
    let elapsed = 0;
    let last: number | null = null;
    let handle = 0;
    let running = false;
    const step = (now: number) => {
      if (last !== null) elapsed += now - last;
      last = now;
      paint(cloudTime(elapsed, holdMs, speed, mark));
      if (running) handle = requestAnimationFrame(step);
    };
    const start = () => {
      if (running) return;
      running = true;
      last = null;
      handle = requestAnimationFrame(step);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(handle);
    };

    let visible = true;
    const observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(([entry]) => {
            visible = entry.isIntersecting;
            if (visible && document.visibilityState !== 'hidden') start();
            else stop();
          });
    observer?.observe(canvas);
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') stop();
      else if (visible) start();
    };
    document.addEventListener('visibilitychange', onVisibility);
    if (!observer) start();

    return () => {
      stop();
      observer?.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [logo, state, size, dark, tune, holdMs, reduced]);

  return (
    <canvas
      ref={ref}
      className={className}
      aria-hidden="true"
      style={{ width: size, height: size, display: 'block' }}
    />
  );
}
