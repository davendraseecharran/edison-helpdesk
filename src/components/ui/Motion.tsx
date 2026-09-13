'use client';

/**
 * Motion wrappers over the `motion` package.
 *
 * Motion answers actions; it never decorates. Three moments are covered: a
 * surface arriving from an edge or the centre (`SpringSurface`), a list
 * settling into place on first paint (`StaggerList` and `StaggerItem`), and a
 * single element fading in (`FadeIn`). Every wrapper is inert under
 * `prefers-reduced-motion`, through `useReducedMotion` here and the global
 * kill switch in `base.css`.
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
import { AnimatePresence, motion, type Transition } from 'motion/react';
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

/** The standard exit: gone in 120ms, quicker than arriving. */
export const EASE_IN_FAST: Transition = { duration: DURATION.fast, ease: 'easeIn' };

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
export function useMountedOnClient(): boolean {
  const client = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
  const [mountedOnClient] = useState(client);
  return mountedOnClient;
}

/** True when an entrance may animate: a client mount, and no reduced-motion preference. */
export function useEntranceAllowed(): boolean {
  const reduced = useReducedMotion();
  const mountedOnClient = useMountedOnClient();
  return mountedOnClient && !reduced;
}

const RISE = { opacity: 0, y: 4 };
const SETTLED = { opacity: 1, y: 0 };

/** One block that fades and rises 4px into place when it mounts on the client. */
export function FadeIn({
  children,
  delay = 0,
  className,
}: {
  children: ReactNode;
  /** Seconds. */
  delay?: number;
  className?: string;
}) {
  const allowed = useEntranceAllowed();
  return (
    <motion.div
      className={className}
      initial={allowed ? RISE : false}
      animate={SETTLED}
      transition={allowed ? { ...EASE_OUT, delay } : INSTANT}
    >
      {children}
    </motion.div>
  );
}

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

/** One row of a `StaggerList`. `index` sets its place in the sequence. */
export function StaggerItem({
  as = 'div',
  index,
  className,
  children,
}: {
  as?: keyof typeof STAGGER_ELEMENTS;
  index: number;
  className?: string;
  children: ReactNode;
}) {
  const { active } = useContext(StaggerContext);
  const Element = STAGGER_ELEMENTS[as];
  return (
    <Element
      className={className}
      initial={active ? RISE : false}
      animate={SETTLED}
      transition={active ? { ...EASE_OUT, delay: staggerDelay(index) } : INSTANT}
    >
      {children}
    </Element>
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
  onBackdropPress: () => void;
  children: ReactNode;
}

/**
 * The backdrop and panel of a modal surface, with their one orchestrated
 * moment: the backdrop fades over 120ms while the panel springs in from its
 * edge, or the dialog scales from 0.98 to 1. Render inside `AnimatePresence`
 * so closing plays the same in reverse, faster. Under reduced motion both
 * appear and disappear at once.
 */
export function SpringSurface({
  kind,
  side = 'right',
  panelRef,
  panelClassName,
  panelProps,
  onBackdropPress,
  children,
}: SpringSurfaceProps) {
  const reduced = useReducedMotion();

  const hidden =
    kind === 'dialog'
      ? { opacity: 0, scale: 0.98 }
      : side === 'bottom'
        ? { y: '100%' }
        : { x: '100%' };
  const shown = kind === 'dialog' ? { opacity: 1, scale: 1 } : side === 'bottom' ? { y: 0 } : { x: 0 };

  return (
    <div className="overlay" data-kind={kind}>
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
        exit={reduced ? undefined : { ...hidden, transition: EASE_IN_FAST }}
        transition={reduced ? INSTANT : kind === 'dialog' ? EASE_OUT : SPRING}
      >
        {children}
      </motion.div>
    </div>
  );
}
