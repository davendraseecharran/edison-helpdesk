'use client';

/**
 * One highlight that glides between the items of a list.
 *
 * Every list of pressable things — the rail, a menu, a table's rows, the tab
 * strips, Today's rows — used to warm each item up on its own: the one you
 * left went cold and the one you reached went warm, two fades crossing. Here
 * the list owns a single highlight and the pointer moves it: it springs from
 * the item you left to the item you reached, so running the mouse down a list
 * reads as one thing following your hand rather than a row of lights
 * switching.
 *
 * Rules it keeps:
 * - It appears where it is needed. The first item the pointer reaches is
 *   lit in place with a fade (never a slide in from a corner), later items
 *   are reached by the spring, and leaving the list fades it out where it
 *   stands.
 * - The keyboard moves it too. Focus that is visible (`:focus-visible`)
 *   lights its item the same way, so the two inputs agree about where you
 *   are. Menus follow Radix's `data-highlighted` instead, which is already
 *   the one answer both inputs give.
 * - Hover is for a precise pointer. On a touch screen the highlight is
 *   never lit by a tap, the same gate every `:hover` rule sits behind.
 * - Positions are measured against the list itself, in its own scrolled
 *   coordinates, so a list that scrolls, reflows or resizes keeps its
 *   highlight under the right item.
 * - Under reduced motion it jumps and still fades.
 * - It sits under the items (`z-index: -1` in an isolated list), so the text
 *   on top is never covered and a selected or current item's own fill still
 *   shows through as the stronger state.
 *
 * Items opt in with `data-glide-item`, or a caller names a selector. The
 * list keeps its own markup; the highlight is one `<span>` it renders.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentPropsWithoutRef,
  type ElementType,
  type ReactNode,
  type Ref,
} from 'react';
import { animate } from 'motion/react';

/** What the highlight looks like. The shapes are `components.css`, "Hover glide". */
export type GlideKind = 'fill' | 'row' | 'tab' | 'menu' | 'pad';

export interface GlideOptions {
  /** Which descendants are items. */
  selector?: string;
  /**
   * `pointer` follows hover and visible focus. `highlight` follows the item
   * Radix marks `data-highlighted`, which menus and selects keep for both.
   */
  follow?: 'pointer' | 'highlight';
  /** Off, and the list behaves as though it had none. */
  enabled?: boolean;
}

const FINE_POINTER = '(hover: hover) and (pointer: fine)';
const REDUCED = '(prefers-reduced-motion: reduce)';

/** Short and nearly critically damped: a hand's width of travel lands with at most a couple of pixels of give. */
const GLIDE_SPRING = { type: 'spring', visualDuration: 0.22, bounce: 0.14 } as const;
/** `--dur-hover`: the highlight arrives and leaves on the hover clock. */
const FADE = { duration: 0.15, ease: [0.23, 1, 0.32, 1] } as const;

function matches(query: string): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(query).matches;
}

/**
 * The behaviour, for a list that renders its own highlight element. `root`
 * is the positioned list, `light` the highlight inside it. Elements rather
 * than refs, held in state by the caller's callback refs, so a list that
 * mounts later than its component (a menu's content appears when it opens)
 * is picked up when it arrives.
 */
export function useHoverGlide(
  root: HTMLElement | null,
  light: HTMLElement | null,
  { selector = '[data-glide-item]', follow = 'pointer', enabled = true }: GlideOptions = {},
) {
  useEffect(() => {
    if (!root || !light || !enabled) return;

    let target: Element | null = null;
    let shown = false;
    let pointerInside = false;
    const running: Array<{ stop: () => void }> = [];

    const stopAll = () => {
      while (running.length) running.pop()?.stop();
    };

    const rectOf = (item: Element) => {
      const box = root.getBoundingClientRect();
      const rect = item.getBoundingClientRect();
      return {
        x: rect.left - box.left - root.clientLeft + root.scrollLeft,
        y: rect.top - box.top - root.clientTop + root.scrollTop,
        width: rect.width,
        height: rect.height,
      };
    };

    const place = (item: Element, instant: boolean) => {
      const next = rectOf(item);
      if (next.width === 0 || next.height === 0) return;
      stopAll();
      if (!shown || instant || matches(REDUCED)) {
        // Lit in place: set the box, then fade in. A highlight that is
        // already on screen and must jump (reduced motion) just moves.
        light.style.transform = `translate(${next.x}px, ${next.y}px)`;
        light.style.width = `${next.width}px`;
        light.style.height = `${next.height}px`;
        // Motion keeps its own copy of the transform; hand it the same place.
        running.push(animate(light, { x: next.x, y: next.y }, { duration: 0 }));
        if (!shown) {
          shown = true;
          light.dataset.on = '';
          running.push(animate(light, { opacity: 1 }, matches(REDUCED) ? { duration: 0 } : FADE));
        }
        return;
      }
      running.push(
        animate(
          light,
          { x: next.x, y: next.y, width: next.width, height: next.height, opacity: 1 },
          { ...GLIDE_SPRING, opacity: FADE },
        ),
      );
    };

    const hide = () => {
      if (!shown) return;
      shown = false;
      target = null;
      delete light.dataset.on;
      stopAll();
      running.push(animate(light, { opacity: 0 }, matches(REDUCED) ? { duration: 0 } : FADE));
    };

    const itemFrom = (node: EventTarget | null): Element | null => {
      if (!(node instanceof Element)) return null;
      const item = node.closest(selector);
      if (!item || !root.contains(item)) return null;
      if (item.matches('[aria-disabled="true"], [data-disabled], :disabled')) return null;
      return item;
    };

    const go = (item: Element | null) => {
      if (!item) return;
      if (item === target && shown) return;
      target = item;
      place(item, false);
    };

    // --- Pointer and focus ------------------------------------------------
    const onPointerOver = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || !matches(FINE_POINTER)) return;
      pointerInside = true;
      go(itemFrom(event.target));
    };
    const onPointerLeave = (event: PointerEvent) => {
      if (event.pointerType === 'touch') return;
      pointerInside = false;
      const focused = document.activeElement;
      const focusItem = focused && focused.matches(':focus-visible') ? itemFrom(focused) : null;
      if (focusItem) go(focusItem);
      else hide();
    };
    const onFocusIn = (event: FocusEvent) => {
      const node = event.target;
      if (!(node instanceof Element) || !node.matches(':focus-visible')) return;
      go(itemFrom(node));
    };
    const onFocusOut = (event: FocusEvent) => {
      const next = event.relatedTarget;
      if (next instanceof Node && root.contains(next)) return;
      if (!pointerInside) hide();
    };

    // --- Radix's highlighted item -----------------------------------------
    let observer: MutationObserver | null = null;
    if (follow === 'highlight') {
      const sync = () => {
        const item = root.querySelector(`${selector}[data-highlighted]`);
        if (item) go(item);
        else hide();
      };
      observer = new MutationObserver(sync);
      observer.observe(root, { subtree: true, attributes: true, attributeFilter: ['data-highlighted'] });
      sync();
    } else {
      root.addEventListener('pointerover', onPointerOver);
      root.addEventListener('pointerleave', onPointerLeave);
      root.addEventListener('focusin', onFocusIn);
      root.addEventListener('focusout', onFocusOut);
    }

    // The list reflowed or resized: the item is somewhere else now.
    const resize =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(() => {
            if (!shown || !target) return;
            if (!target.isConnected) {
              hide();
              return;
            }
            place(target, true);
          });
    resize?.observe(root);

    return () => {
      stopAll();
      observer?.disconnect();
      resize?.disconnect();
      root.removeEventListener('pointerover', onPointerOver);
      root.removeEventListener('pointerleave', onPointerLeave);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
    };
  }, [root, light, selector, follow, enabled]);
}

/** The highlight itself: rendered once, first, inside the list. */
export function GlideLight({ kind = 'fill', ref }: { kind?: GlideKind; ref: Ref<HTMLSpanElement> }) {
  return <span ref={ref} className="glide" data-glide-kind={kind} aria-hidden="true" />;
}

/**
 * The highlight and its behaviour, for a list that is not a client
 * component: rendered inside the list, it takes its parent as the host. The
 * parent carries `glide-host` itself.
 */
export function GlideLayer({ kind = 'fill', ...options }: { kind?: GlideKind } & GlideOptions) {
  const [light, setLight] = useState<HTMLSpanElement | null>(null);
  useHoverGlide(light?.parentElement ?? null, light, options);
  return <GlideLight kind={kind} ref={setLight} />;
}

type HoverGlideProps<T extends ElementType> = {
  as?: T;
  kind?: GlideKind;
  children: ReactNode;
  ref?: Ref<HTMLElement>;
} & GlideOptions &
  Omit<ComponentPropsWithoutRef<T>, 'children'>;

/**
 * A list with a gliding highlight. Renders `as` (a `div` by default) with the
 * `glide-host` class added, and the highlight as its first child.
 */
export function HoverGlide<T extends ElementType = 'div'>({
  as,
  kind = 'fill',
  selector,
  follow,
  enabled,
  className,
  children,
  ref,
  ...rest
}: HoverGlideProps<T>) {
  const Element = (as ?? 'div') as ElementType;
  const [host, setHost] = useState<HTMLElement | null>(null);
  const [light, setLight] = useState<HTMLSpanElement | null>(null);
  useHoverGlide(host, light, { selector, follow, enabled });
  const outer = useRef(ref);
  useEffect(() => {
    outer.current = ref;
  });
  const attach = useCallback((node: HTMLElement | null) => {
    setHost(node);
    const forward = outer.current;
    if (typeof forward === 'function') forward(node);
    else if (forward) (forward as { current: HTMLElement | null }).current = node;
  }, []);
  return (
    <Element
      {...rest}
      ref={attach}
      className={className ? `glide-host ${className}` : 'glide-host'}
    >
      <GlideLight kind={kind} ref={setLight} />
      {children}
    </Element>
  );
}
