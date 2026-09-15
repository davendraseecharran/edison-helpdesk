'use client';

/**
 * Motion wrappers over the `motion` package.
 *
 * Motion answers actions; it never decorates. Two moments are covered: a
 * surface arriving from an edge or the centre (`SpringSurface`) and a list
 * settling into place on first paint (`StaggerList` and `StaggerItem`). A
 * single-element `FadeIn` was left out because nothing needed it; the AI
 * panel's chips and cards (Task 27) can add one on `useEntranceAllowed`.
 * Every wrapper is inert under `prefers-reduced-motion`, through
 * `useReducedMotion` here and the global kill switch in `base.css`.
 *
 * Entrance animations run only for mounts that happen after hydration, that
 * is on client-side navigation. Server-rendered HTML therefore never arrives
 * with elements at opacity 0 waiting for JavaScript: streamed content is
 * visible the moment it lands, and the skeleton-to-content swap is the moment.
 */

import {
  createContext,
  useContext,
  useMemo,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
} from 'react';
import { AnimatePresence, motion, useIsPresent, type Transition } from 'motion/react';
import { useReducedMotion } from './media';

export { AnimatePresence, motion };

/** Durations in seconds. Everything sits between 120 and 220 milliseconds. */
export const DURATION = { fast: 0.12, base: 0.18, slow: 0.22 } as const;

/** Seconds between one list row settling and the next. */
export const STAGGER_STEP = 0.02;

/** Rows past this index share one delay, so a long page settles as a group. */
export const STAGGER_CAP = 12;

/** The delay, in seconds, before row `index` of a list settles into place. */
export function staggerDelay(
  index: number,
  { step = STAGGER_STEP, cap = STAGGER_CAP }: { step?: number; cap?: number } = {},
): number {
  return Math.min(Math.max(index, 0), cap) * step;
}

/** A stiff, quick spring with no bounce, for a panel arriving from an edge. */
export const SPRING: Transition = { type: 'spring', visualDuration: DURATION.slow, bounce: 0 };

/** The standard entrance: settle over 180ms. */
export const EASE_OUT: Transition = { duration: DURATION.base, ease: 'easeOut' };

/**
 * The standard exit: gone in 120ms, quicker than arriving, and still eased
 * out. `ease-in` holds the first frame back, which is the frame the eye is on;
 * a surface leaving on it reads as sluggish even though the clock says it was
 * fast. Nothing in this product uses ease-in.
 */
export const EASE_OUT_FAST: Transition = { duration: DURATION.fast, ease: 'easeOut' };

/** No transition at all, for reduced motion. */
export const INSTANT: Transition = { duration: 0 };

function subscribeToNothing(): () => void {
  return () => {};
}

/**
 * Whether this component instance mounted after hydration.
 *
 * During hydration `useSyncExternalStore` returns the server snapshot, so the
 * value captured on the first render is `false`; a component mounted by a
 * later client-side navigation captures `true`. Only those mounts animate.
 */
function useMountedOnClient(): boolean {
  const client = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
  const [mountedOnClient] = useState(client);
  return mountedOnClient;
}

/** True when an entrance may animate: a client mount, and no reduced-motion preference. */
function useEntranceAllowed(): boolean {
  const reduced = useReducedMotion();
  const mountedOnClient = useMountedOnClient();
  return mountedOnClient && !reduced;
}

const RISE = { opacity: 0, y: 4 };
const SETTLED = { opacity: 1, y: 0 };

const StaggerContext = createContext<{ active: boolean }>({ active: false });

/**
 * Rows settle in with a short stagger, on first paint only.
 *
 * `generation` identifies the data set on show; pass the rows array. Items
 * rendered while it is still the value seen at mount animate. Items that
 * arrive with a later value, after a page change, a filter or a refresh,
 * appear in place, because a list that re-animates every time it updates
 * stops meaning anything.
 */
export function StaggerList({
  generation,
  enabled = true,
  children,
}: {
  generation: unknown;
  enabled?: boolean;
  children: ReactNode;
}) {
  const allowed = useEntranceAllowed();
  const [first] = useState(generation);
  const active = enabled && allowed && Object.is(generation, first);
  const value = useMemo(() => ({ active }), [active]);
  return <StaggerContext.Provider value={value}>{children}</StaggerContext.Provider>;
}

const STAGGER_ELEMENTS = { tr: motion.tr, li: motion.li, div: motion.div } as const;

/**
 * One row of a `StaggerList`. `index` sets its place in the sequence.
 *
 * `rest` is passed straight to the element, which is how the keyboard model
 * puts a row's identity and roving tabindex on the same node the stagger
 * animates. Nothing here reads it.
 */
export function StaggerItem({
  as = 'div',
  index,
  className,
  rest,
  children,
}: {
  as?: keyof typeof STAGGER_ELEMENTS;
  index: number;
  className?: string;
  rest?: Record<string, unknown>;
  children: ReactNode;
}) {
  const { active } = useContext(StaggerContext);
  const Element = STAGGER_ELEMENTS[as];
  return (
    <Element
      className={className}
      {...rest}
      initial={active ? RISE : false}
      animate={SETTLED}
      transition={active ? { ...EASE_OUT, delay: staggerDelay(index) } : INSTANT}
    >
      {children}
    </Element>
  );
}

/**
 * One icon replacing another, when the swap is the feedback.
 *
 * A contextual icon change — search becoming close, play becoming pause — is
 * the one place a small piece of motion earns its cost, because the two glyphs
 * are the same size in the same box and a hard cut reads as a flicker. The
 * entering glyph grows from a quarter size out of a 4px blur while the leaving
 * one shrinks back into it, on a spring with no bounce.
 *
 * `initial={false}` keeps the first render still: the icon is already in its
 * default state on page load and has nothing to announce. Under reduced
 * motion the swap is instant, and it is never the only cue — every caller also
 * changes the control's accessible name.
 */
export function IconSwap({ token, children }: { token: string; children: ReactNode }) {
  const reduced = useReducedMotion();
  if (reduced) return <span className="icon-swap">{children}</span>;
  return (
    <span className="icon-swap">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={token}
          initial={{ opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
          animate={{ opacity: 1, scale: 1, filter: 'blur(0px)' }}
          exit={{ opacity: 0, scale: 0.25, filter: 'blur(4px)' }}
          transition={{ type: 'spring', duration: 0.3, bounce: 0 }}
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

export interface SpringSurfaceProps {
  /** `sheet` arrives from an edge on a spring; `dialog` scales up from 0.98 in the centre. */
  kind: 'sheet' | 'dialog';
  side?: 'right' | 'bottom';
  panelRef?: Ref<HTMLDivElement>;
  panelClassName?: string;
  /** Accessibility attributes for the panel: role, modal state, labelling, focusability. */
  panelProps?: {
    role?: 'dialog' | 'alertdialog';
    'aria-modal'?: boolean;
    'aria-labelledby'?: string;
    'aria-describedby'?: string;
    tabIndex?: number;
  };
  /**
   * Opens and closes with no motion at all. For a surface somebody reaches for
   * dozens of times a day: the command palette. An animation there is charged
   * on every keystroke that opens it, and after the tenth time it is only a
   * delay between asking and typing.
   */
  instant?: boolean;
  onBackdropPress: () => void;
  children: ReactNode;
}

/**
 * The backdrop and panel of a modal surface, with their one orchestrated
 * moment: the backdrop fades over 120ms while the panel springs in from its
 * edge, or the dialog scales from 0.98 to 1. Render inside `AnimatePresence`
 * so closing plays the same in reverse, faster; while that exit plays the
 * root carries `data-exiting` and takes no pointer events, so a second press
 * lands on the page underneath rather than on a surface that is leaving.
 * Under reduced motion both appear and disappear at once.
 */
export function SpringSurface({
  kind,
  side = 'right',
  panelRef,
  panelClassName,
  panelProps,
  instant = false,
  onBackdropPress,
  children,
}: SpringSurfaceProps) {
  const reduced = useReducedMotion() || instant;
  const present = useIsPresent();

  const hidden =
    kind === 'dialog'
      ? { opacity: 0, scale: 0.98 }
      : side === 'bottom'
        ? { y: '100%' }
        : { x: '100%' };
  const shown = kind === 'dialog' ? { opacity: 1, scale: 1 } : side === 'bottom' ? { y: 0 } : { x: 0 };

  return (
    <div className="overlay" data-kind={kind} data-exiting={present ? undefined : 'true'}>
      <motion.div
        className="overlay-backdrop"
        aria-hidden="true"
        onClick={onBackdropPress}
        initial={reduced ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={reduced ? undefined : { opacity: 0 }}
        transition={reduced ? INSTANT : { duration: DURATION.fast }}
      />
      <motion.div
        ref={panelRef}
        className={panelClassName}
        {...panelProps}
        initial={reduced ? false : hidden}
        animate={shown}
        exit={reduced ? undefined : { ...hidden, transition: EASE_OUT_FAST }}
        transition={reduced ? INSTANT : kind === 'dialog' ? EASE_OUT : SPRING}
      >
        {children}
      </motion.div>
    </div>
  );
}
