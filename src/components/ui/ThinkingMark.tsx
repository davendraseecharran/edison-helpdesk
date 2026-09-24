'use client';

/**
 * The application thinking, in its own mark.
 *
 * The assistant thinks in OpenAI's dotted knot because that is whose model
 * is doing the thinking. Everything else the application waits on — an
 * import, an export being assembled, a page of figures being counted — is
 * the application's own work, so it thinks in the application's own mark:
 * the Edison bulb from the sign-in screen, baked into the same dotted cloud
 * (`scripts/bake-edison-mark.cjs`) and moved by the same library. One
 * vocabulary of waiting across the product, and the verbs mean the same
 * thing in both marks:
 *
 * - `searching` — a globe swept by a meridian: looking something up.
 * - `solving` — a cube that scrambles and clicks back: importing, sorting out.
 * - `working` — a thread wound into a knot: making something.
 * - `listening` — a floating body that pulses: waiting to hear.
 * - `waiting` — a bellows of stacked rings: nothing to do yet.
 * - `thinking`, `generating` — a sphere, a crystal.
 *
 * It opens on the assembled bulb, painted before the first frame, and moves
 * from there. Monochrome: the library's ink ramp against the theme. Under
 * reduced motion it is the assembled bulb, still. Before hydration (and for
 * a reader) it is the drawn bulb, so a server-rendered empty state never
 * shows an empty box.
 *
 * `label` makes it a status (`role="status"`); without one it is decoration
 * beside words that already say what is happening.
 */

import type { CSSProperties } from 'react';
import type { LogoState } from 'thinking-logos';
import { useTheme } from '@/components/shell/ThemeProvider';
import { MarkCloud } from '@/components/ai/MarkCloud';
import { useReducedMotion } from './media';
import { BULB_LARGE, BULB_SMALL } from './edison-mark.baked';

/** The cloud is drawn larger than its box: the engine puts the mark in the middle of a sphere. */
const CLOUD_SCALE = 2;

/** Legibility at the small size, as `AiMark` tunes the 20px glyph. */
const SMALL_TUNE = { rBase: 1.1, rMin: 0.45, headInk: 0.85, lean: 0 };
const LARGE_TUNE = { lean: 0 };

export type ThinkingMarkState = LogoState;

export function ThinkingMark({
  state = 'working',
  size = 56,
  label,
  holdMs = 600,
  className,
}: {
  state?: ThinkingMarkState;
  /** The box, in CSS pixels. 24 inline, 56 in an empty state, 72 for a hero. */
  size?: number;
  /** What is happening, for a reader. Omit when words beside it say so. */
  label?: string;
  /** How long the assembled bulb holds before it starts to move. */
  holdMs?: number;
  className?: string;
}) {
  const { resolved } = useTheme();
  const reduced = useReducedMotion();
  const small = size < 40;
  return (
    <span
      className={className ? `thinking-mark ${className}` : 'thinking-mark'}
      style={{ '--thinking-size': `${size}px` } as CSSProperties}
      role={label ? 'status' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <svg className="thinking-mark-drawn" viewBox="4 1 40 44" width={size} height={size} focusable="false">
        <path d="M15 28.2 A13.5 13.5 0 1 1 33 28.2 C31 30 29.5 31.6 29.5 34.5 L18.5 34.5 C18.5 31.6 17 30 15 28.2 Z" />
        <path d="M20 34.5 V29 L22 25.5 L24 29 L26 25.5 L28 29 V34.5" />
        <path d="M18.5 38.5 H29.5 M20 42 H28" />
      </svg>
      <MarkCloud
        className="thinking-mark-cloud"
        logo={small ? BULB_SMALL : BULB_LARGE}
        state={state}
        size={Math.round(size * CLOUD_SCALE)}
        dark={resolved === 'dark'}
        tune={small ? SMALL_TUNE : LARGE_TUNE}
        holdMs={holdMs}
        reduced={reduced}
      />
    </span>
  );
}
