'use client';

/**
 * Three stops and one blob: the reasoning level as a slider.
 *
 * The levels are an ordered scale, not a list of unrelated choices, and a
 * control that slides says so where a column of ticks does not. The pill is
 * one blob whose two edges move on different clocks: the leading edge sets
 * off at once and the trailing edge follows, so between stops it stretches
 * and then snaps shut, and an SVG "goo" filter keeps the stretched shape
 * rounded. At rest it is a plain pill.
 *
 * It lives inside the composer's dropdown, so the keys it owns are stopped
 * before Radix can read them as menu navigation, and it takes focus itself
 * when the menu opens. A pick lets the blob arrive, then tells the menu to
 * close: the point of the motion is to be seen. Under reduced motion the
 * filter is off and the pill jumps.
 */

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { useReducedMotion } from '@/components/ui/media';
import { stepOption, type SliderOption } from './reasoning-step';

/** How long the blob is given to land before the menu closes. Just past the trailing edge's transition. */
const SETTLE_MS = 540;

export interface ReasoningSliderProps {
  value: string;
  options: readonly SliderOption[];
  onChange: (value: string) => void;
  /** After a pick has landed, so the surface around this can close. */
  onSettled?: () => void;
}

export function ReasoningSlider({ value, options, onChange, onSettled }: ReasoningSliderProps) {
  const reduced = useReducedMotion();
  const track = useRef<HTMLDivElement>(null);
  const stops = useRef<(HTMLButtonElement | null)[]>([]);
  const settle = useRef<number | null>(null);
  const [blob, setBlob] = useState<{ x: number; w: number } | null>(null);
  // Which edge leads depends on which way the pill is going.
  const lastAt = useRef<number | null>(null);
  const [dir, setDir] = useState<'right' | 'left'>('right');
  // Transitions are enabled a frame after the first measurement, so the blob
  // is born in place rather than sliding in from the left edge.
  const [ready, setReady] = useState(false);

  const at = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );

  useLayoutEffect(() => {
    if (lastAt.current !== null && lastAt.current !== at) setDir(at > lastAt.current ? 'right' : 'left');
    lastAt.current = at;
    const measure = () => {
      const stop = stops.current[at];
      if (!stop) return;
      setBlob({ x: stop.offsetLeft, w: stop.offsetWidth });
    };
    measure();
    if (typeof ResizeObserver === 'undefined' || !track.current) return;
    const observer = new ResizeObserver(measure);
    observer.observe(track.current);
    return () => observer.disconnect();
  }, [at, options.length]);

  useEffect(() => {
    // The menu hands focus over rather than taking it (`onOpenAutoFocus` is
    // prevented), so the checked stop takes it on the next frame.
    const frame = requestAnimationFrame(() => {
      stops.current[at]?.focus({ preventScroll: true });
      setReady(true);
    });
    return () => cancelAnimationFrame(frame);
    // Mount only: focus and readiness are about the opening, not about `at`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(
    () => () => {
      if (settle.current !== null) window.clearTimeout(settle.current);
    },
    [],
  );

  function pick(next: string, close: boolean) {
    if (next !== value) onChange(next);
    if (!close || !onSettled) return;
    if (settle.current !== null) window.clearTimeout(settle.current);
    settle.current = window.setTimeout(onSettled, reduced ? 0 : SETTLE_MS);
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const next = stepOption(options, value, event.key);
    if (next !== null) {
      event.preventDefault();
      event.stopPropagation();
      pick(next, false);
      stops.current[options.findIndex((option) => option.value === next)]?.focus();
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      event.stopPropagation();
      pick(value, true);
    }
  }

  const style = blob
    ? ({ '--goo-x': `${blob.x}px`, '--goo-w': `${blob.w}px` } as CSSProperties)
    : undefined;

  return (
    <div
      ref={track}
      className="goo-slider"
      role="radiogroup"
      aria-label="Reasoning level"
      data-ready={ready && blob ? '' : undefined}
      data-reduced={reduced ? '' : undefined}
      data-dir={dir}
      style={style}
      onKeyDown={onKeyDown}
    >
      <span className="goo-blobs" aria-hidden="true">
        <span className="goo-blob" />
      </span>
      {options.map((option, index) => (
        <button
          key={option.value}
          ref={(node) => {
            stops.current[index] = node;
          }}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          tabIndex={option.value === value ? 0 : -1}
          className="goo-stop"
          onClick={() => pick(option.value, true)}
        >
          {option.label}
        </button>
      ))}
      {/* The goo. Blur the pills, then push the alpha so the blurred halo
          between two nearby shapes becomes solid, then paint the sharp
          originals back on top. Inline because it has to exist wherever the
          slider does, and it weighs nothing. */}
      <svg className="goo-defs" aria-hidden="true" focusable="false">
        <defs>
          <filter id="ai-goo" colorInterpolationFilters="sRGB">
            <feGaussianBlur in="SourceGraphic" stdDeviation="5" result="blur" />
            <feColorMatrix
              in="blur"
              mode="matrix"
              values="1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 19 -8"
              result="goo"
            />
            <feComposite in="SourceGraphic" in2="goo" operator="atop" />
          </filter>
        </defs>
      </svg>
    </div>
  );
}
