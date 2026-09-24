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
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type Ref,
} from 'react';
import { AnimatePresence, motion, useIsPresent, type Transition } from 'motion/react';
import { useReducedMotion } from './media';

export { AnimatePresence, motion };

/**
 * Durations in seconds, the same three numbers as the stylesheet's tokens:
 * `fast` is `--dur-press` (a press, and every exit), `hover` is `--dur-hover`,
 * and `base` is `--dur-surface` (anything arriving). `slow` is a spring's
 * visual duration, a touch longer because a spring's tail is soft. A JS
 * animation and a CSS one that do the same job read the same number.
 */
export const DURATION = { fast: 0.12, hover: 0.15, base: 0.2, slow: 0.22 } as const;

/**
 * `--ease-out` from `tokens.css`, as control points. Motion's own `easeOut`
 * is the browser's weak curve; a panel that rose on it beside a menu that
 * rose on the token read as two different products.
 */
export const EASE_OUT_CURVE = [0.23, 1, 0.32, 1] as const;

/** The same curve for the Web Animations API, which takes a CSS string. */
export const EASE_OUT_CSS = 'cubic-bezier(0.23, 1, 0.32, 1)';

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

/** The standard entrance: settle over 200ms on the token curve. */
export const EASE_OUT: Transition = { duration: DURATION.base, ease: EASE_OUT_CURVE };

/**
 * The standard exit: gone in 120ms, quicker than arriving, and still eased
 * out. `ease-in` holds the first frame back, which is the frame the eye is on;
 * a surface leaving on it reads as sluggish even though the clock says it was
 * fast. Nothing in this product uses ease-in.
 */
export const EASE_OUT_FAST: Transition = { duration: DURATION.fast, ease: EASE_OUT_CURVE };

/**
 * A surface dropping into place from above and bouncing once: a spring with
 * real give, so it overshoots by about a quarter of the drop, comes back, and
 * settles. From 48px up that is a twelve-pixel bounce, which is meant to be
 * seen. The one place in the application with a bounce, because the palette
 * is summoned by hand a hundred times a day and should feel caught rather
 * than delivered.
 */
export const DROP: Transition = { type: 'spring', visualDuration: 0.34, bounce: 0.6 };

/**
 * The scrim behind a modal surface: fades in with the surface (200ms) and out
 * with it (120ms), the same two numbers as the CSS scrim on dialogs and sheets.
 */
export const SCRIM_IN: Transition = { duration: DURATION.base, ease: EASE_OUT_CURVE };
export const SCRIM_OUT: Transition = { duration: DURATION.fast, ease: EASE_OUT_CURVE };

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

/**
 * A number that changes while somebody is looking at it: the old figure
 * leaves and the new one takes its place, travelling the way the count went —
 * up when it grew, down when it shrank — like a counter turning over.
 *
 * The same moment as the selection bar's count (8px, 120ms, the token curve),
 * so every count in the application turns over the same way. It moves only
 * when the value changes after the first paint; a page that arrives with a
 * number simply shows it. Under reduced motion the figure is swapped in place.
 * The digits are `aria-hidden` inside a live wrapper that reads the plain
 * value, so a screen reader hears the number once, not both of them.
 */
export function CountSwap({ value, className }: { value: number; className?: string }) {
  const reduced = useReducedMotion();
  const [seen, setSeen] = useState(value);
  const [direction, setDirection] = useState<1 | -1>(1);
  if (seen !== value) {
    // Adjusted during render so the entering and leaving figures agree on the
    // direction in the same frame.
    setDirection(value > seen ? 1 : -1);
    setSeen(value);
  }
  const classes = className ? `count-swap ${className}` : 'count-swap';
  if (reduced) return <span className={classes}>{value}</span>;
  return (
    <span className={classes}>
      <span className="visually-hidden">{value}</span>
      <span className="count-swap-track" aria-hidden="true">
        <AnimatePresence initial={false} mode="popLayout" custom={direction}>
          <motion.span
            key={value}
            custom={direction}
            variants={COUNT_VARIANTS}
            initial="enter"
            animate="rest"
            exit="leave"
            transition={EASE_OUT_FAST}
          >
            {value}
          </motion.span>
        </AnimatePresence>
      </span>
    </span>
  );
}

const COUNT_VARIANTS = {
  enter: (direction: 1 | -1) => ({ y: 8 * direction, opacity: 0 }),
  rest: { y: 0, opacity: 1 },
  leave: (direction: 1 | -1) => ({ y: -8 * direction, opacity: 0 }),
};

/**
 * The skeleton handing over to the content it stood in for.
 *
 * Rendered inside every `LoadingRegion`. When the content lands and the
 * skeleton is taken away, the region's container — `<main>` for a route's
 * loading screen, the panel body for a panel that loads on its own — settles
 * from a little under full strength to full over 120ms instead of cutting in,
 * so every swap in the application is the same small moment. Opacity only:
 * on `<main>` a transform would re-parent the fixed bars, as the navigation
 * fade in `AppShell` explains. It runs in a layout effect's cleanup, which
 * React calls in the same commit that inserts the content, so the content's
 * first frame is already the first frame of the settle.
 */
export function SkeletonSettle() {
  const anchor = useRef<HTMLSpanElement>(null);
  useLayoutEffect(() => {
    const container = anchor.current?.parentElement?.parentElement;
    return () => {
      if (!container || !container.isConnected) return;
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
      container.animate([{ opacity: 0.4 }, { opacity: 1 }], {
        duration: DURATION.fast * 1000,
        easing: EASE_OUT_CSS,
      });
    };
  }, []);
  return <span ref={anchor} hidden />;
}

export interface SpringSurfaceProps {
  /**
   * `sheet` arrives from an edge on a spring; `dialog` scales up from 0.98 in
   * the centre; `drop` is a dialog that falls in from just above with a bounce
   * and lifts away.
   */
  kind: 'sheet' | 'dialog' | 'drop';
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
 * moment: the backdrop fades in over 200ms (out in 120ms) while the panel springs in from its
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
      : kind === 'drop'
        ? { opacity: 0, y: -48 }
        : side === 'bottom'
          ? { y: '100%' }
          : { x: '100%' };
  const shown =
    kind === 'dialog'
      ? { opacity: 1, scale: 1 }
      : kind === 'drop'
        ? { opacity: 1, y: 0 }
        : side === 'bottom'
          ? { y: 0 }
          : { x: 0 };
  // Leaving is a slight lift, shorter than the arrival: the drop is the
  // moment, the lift is just the surface getting out of the way.
  const gone = kind === 'drop' ? { opacity: 0, y: -8 } : hidden;
  // The drop's spring is for position only: opacity on the same spring dips
  // below one on the return bounce, so it fades in on its own short curve.
  const arrive =
    kind === 'dialog' ? EASE_OUT : kind === 'drop' ? { ...DROP, opacity: EASE_OUT_FAST } : SPRING;

  return (
    <div
      className="overlay"
      data-kind={kind === 'drop' ? 'dialog' : kind}
      data-exiting={present ? undefined : 'true'}
    >
      <motion.div
        className="overlay-backdrop"
        aria-hidden="true"
        onClick={onBackdropPress}
        initial={reduced ? false : { opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={reduced ? undefined : { opacity: 0, transition: SCRIM_OUT }}
        transition={reduced ? INSTANT : SCRIM_IN}
      />
      <motion.div
        ref={panelRef}
        className={panelClassName}
        {...panelProps}
        initial={reduced ? false : hidden}
        animate={shown}
        exit={reduced ? undefined : { ...gone, transition: EASE_OUT_FAST }}
        transition={reduced ? INSTANT : arrive}
      >
        {children}
      </motion.div>
    </div>
  );
}
