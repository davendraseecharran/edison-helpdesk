'use client';

/**
 * A row of exclusive choices, with one pill that moves between them.
 *
 * The pill is one blob placed by both edges, `left` and `right`, and the two
 * move on different clocks: the leading edge sets off at once and the
 * trailing edge follows, so between options it stretches and then snaps
 * shut, and an SVG "goo" filter keeps the stretched shape rounded. At rest it
 * is a plain pill. It began as the assistant's reasoning slider and is every
 * picker now, because a scale, a theme and a kind of person are the same
 * gesture. Under reduced motion the filter is off and the pill jumps.
 *
 * The blob is measured from the checked option's own box, so labels of any
 * width work; the variables are written by this component. Transitions are
 * enabled a frame after the first measurement, so the pill is born in place.
 */

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
} from 'react';
import { Icon, type LucideIcon } from './Icon';
import { useReducedMotion } from './media';

export interface SegmentedOption<Value extends string> {
  value: Value;
  label: string;
  icon?: LucideIcon;
}

export interface SegmentedControlProps<Value extends string> {
  /** Accessible name for the group. */
  label: string;
  value: Value;
  options: SegmentedOption<Value>[];
  onChange: (value: Value) => void;
  size?: 'sm' | 'md';
  /** Focus the checked option a frame after mount: for a control that opens inside a menu. */
  autoFocus?: boolean;
}

export function SegmentedControl<Value extends string>({
  label,
  value,
  options,
  onChange,
  size = 'md',
  autoFocus = false,
}: SegmentedControlProps<Value>) {
  const reduced = useReducedMotion();
  const filterId = useId();
  const track = useRef<HTMLDivElement>(null);
  const stops = useRef<(HTMLButtonElement | null)[]>([]);
  const [blob, setBlob] = useState<{ x: number; w: number } | null>(null);
  // Which edge leads depends on which way the pill is going.
  const lastAt = useRef<number | null>(null);
  const [dir, setDir] = useState<'right' | 'left'>('right');
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
    const frame = requestAnimationFrame(() => {
      if (autoFocus) stops.current[at]?.focus({ preventScroll: true });
      setReady(true);
    });
    return () => cancelAnimationFrame(frame);
    // Mount only: readiness and the opening focus are about the first paint.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    let next = at;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (at + 1) % options.length;
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      next = (at - 1 + options.length) % options.length;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = options.length - 1;
    else return;
    event.preventDefault();
    const option = options[next];
    onChange(option.value);
    stops.current[next]?.focus();
  }

  const style = blob
    ? ({ '--goo-x': `${blob.x}px`, '--goo-w': `${blob.w}px` } as CSSProperties)
    : undefined;

  return (
    <div
      ref={track}
      role="radiogroup"
      aria-label={label}
      className={size === 'sm' ? 'segmented segmented-sm' : 'segmented'}
      data-ready={ready && blob ? '' : undefined}
      data-reduced={reduced ? '' : undefined}
      data-dir={dir}
      style={style}
      onKeyDown={onKeyDown}
    >
      <span className="segmented-blobs" aria-hidden="true" style={{ filter: `url(#${filterId})` }}>
        <span className="segmented-blob" />
      </span>
      {options.map((option, index) => {
        const checked = option.value === value;
        return (
          <button
            key={option.value}
            ref={(node) => {
              stops.current[index] = node;
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            data-value={option.value}
            className="segmented-option"
            onClick={() => onChange(option.value)}
          >
            {option.icon ? <Icon icon={option.icon} size={size === 'sm' ? 14 : 16} /> : null}
            <span>{option.label}</span>
          </button>
        );
      })}
      {/* The goo. Blur the pill, push the alpha so a stretched shape stays
          solid, then paint the sharp original back on top. One per control,
          named by React's id, so two on one page never share a filter. */}
      <svg className="segmented-defs" aria-hidden="true" focusable="false">
        <defs>
          <filter id={filterId} colorInterpolationFilters="sRGB">
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
