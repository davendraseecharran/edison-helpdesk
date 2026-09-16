'use client';

/**
 * The provider's mark, where the chrome talks about the assistant.
 *
 * The assistant runs on the person's own ChatGPT account, so the thing the top
 * bar and the connect card show is OpenAI's mark — mono, in `currentColor`, so
 * it takes the ink of whatever it sits in and never becomes a second brand
 * colour on the screen. It replaced a sparkle, which is the icon every
 * generated product reaches for and which says nothing about what is behind
 * the button.
 *
 * At rest it is the drawn mark: one path, crisp at 20px, `--ink-2` from the
 * button around it. That is what it is nearly all of the time, and a knot of
 * thin ribbons has to be drawn, not sampled, to survive at that size.
 *
 * When something is actually happening the same mark comes apart into the dots
 * it is made of and thinks — `thinking-logos` over a point cloud baked at
 * build time, so nothing rasterises at run time. The canvas begins on the
 * assembled mark (`startAtMark`), which is the frame the drawn path is already
 * showing, so the crossfade between them reads as one object changing state
 * rather than two images swapping.
 *
 * Two clouds are baked, one per rendered size, because dots need about two
 * pixels of pitch to resolve: the 20px chrome glyph and the 44px connect card
 * are separate designs, not a scale factor.
 *
 * The orb stays inside the panel. It is the assistant's face while it is
 * working — streaming, calling a tool, listening — and those are conversation
 * states, not chrome.
 *
 * Under `prefers-reduced-motion` the mark never leaves the drawn path; a
 * `waiting` or `working` mark holds at the dim end instead, which still reads
 * as "something is happening" without a single pixel moving.
 */

import { ThinkingLogo } from 'thinking-logos';
import { type CSSProperties, useSyncExternalStore } from 'react';

import { MARK_LARGE, MARK_SMALL } from './openai-mark.baked';

/**
 * What the mark is doing.
 *
 * - `still` — nothing is pending. The drawn path, and no canvas at all.
 * - `working` — a reply is on its way. The dots turn over on tilted orbits.
 * - `waiting` — the product is waiting on somebody else: the connect card
 *   while a device code is outstanding, or before one has been asked for.
 *   Slower and flatter than `working`, because nobody here is doing anything.
 */
export type AiMarkState = 'still' | 'working' | 'waiting';

/**
 * OpenAI's mark, the monochrome single-path form, traced from
 * `@lobehub/icons` 5.18.0 (`es/OpenAI/components/Mono.js`, viewBox 0 0 24 24,
 * fill-rule evenodd). The path is inline and that package is not a dependency:
 * the drawn state costs no component and no chunk, and this file and
 * `scripts/bake-openai-mark.cjs` can be read against each other, which they
 * have to be — they must stay the same artwork.
 */
const OPENAI_PATH =
  'M9.205 8.658v-2.26c0-.19.072-.333.238-.428l4.543-2.616c.619-.357 1.356-.523 2.117-.523 2.854 0 4.662 2.212 4.662 4.566 0 .167 0 .357-.024.547l-4.71-2.759a.797.797 0 00-.856 0l-5.97 3.473zm10.609 8.8V12.06c0-.333-.143-.57-.429-.737l-5.97-3.473 1.95-1.118a.433.433 0 01.476 0l4.543 2.617c1.309.76 2.189 2.378 2.189 3.948 0 1.808-1.07 3.473-2.76 4.163zM7.802 12.703l-1.95-1.142c-.167-.095-.239-.238-.239-.428V5.899c0-2.545 1.95-4.472 4.591-4.472 1 0 1.927.333 2.712.928L8.23 5.067c-.285.166-.428.404-.428.737v6.898zM12 15.128l-2.795-1.57v-3.33L12 8.658l2.795 1.57v3.33L12 15.128zm1.796 7.23c-1 0-1.927-.332-2.712-.927l4.686-2.712c.285-.166.428-.404.428-.737v-6.898l1.974 1.142c.167.095.238.238.238.428v5.233c0 2.545-1.974 4.472-4.614 4.472zm-5.637-5.303l-4.544-2.617c-1.308-.761-2.188-2.378-2.188-3.948A4.482 4.482 0 014.21 6.327v5.423c0 .333.143.571.428.738l5.947 3.449-1.95 1.118a.432.432 0 01-.476 0zm-.262 3.9c-2.688 0-4.662-2.021-4.662-4.519 0-.19.024-.38.047-.57l4.686 2.71c.286.167.571.167.856 0l5.97-3.448v2.26c0 .19-.07.333-.237.428l-4.543 2.616c-.619.357-1.356.523-2.117.523zm5.899 2.83a5.947 5.947 0 005.827-4.756C22.287 18.339 24 15.84 24 13.296c0-1.665-.713-3.282-1.998-4.448.119-.5.19-.999.19-1.498 0-3.401-2.759-5.947-5.946-5.947-.642 0-1.26.095-1.88.31A5.962 5.962 0 0010.205 0a5.947 5.947 0 00-5.827 4.757C1.713 5.447 0 7.945 0 10.49c0 1.666.713 3.283 1.998 4.448-.119.5-.19 1-.19 1.499 0 3.401 2.759 5.946 5.946 5.946.642 0 1.26-.095 1.88-.309a5.96 5.96 0 004.162 1.713z';

/**
 * How much bigger the canvas is than the glyph box it sits in.
 *
 * The engine projects its points onto a sphere, so the mark occupies the
 * middle of its canvas and not the whole of it. Matching the canvas to the
 * glyph box renders a 20px mark at about twelve, and twelve pixels of dotted
 * filigree is a smudge. Measured against the drawn path at both sizes: 1.7
 * puts the same ink in the same place. The canvas is out of flow, so a
 * larger one costs no layout.
 */
const CLOUD_SCALE = 2.2;

/**
 * Tuning for the 20px chrome glyph, over the library's presets.
 *
 * Three things go wrong at this size and each number fixes one. `headInk`
 * lifts the unlit part of the knot from 0.4 to 0.8, because at twenty pixels
 * a dot at 40% ink is not there and the toggle looked empty for two seconds
 * of every cycle. `rBase` and `rMin` grow the dots, since a dot smaller than
 * a device pixel is an antialiased grey smear rather than a mark. `dwell` and
 * `morph` shift the cycle towards the shape and away from the transition,
 * because the transition is the part that cannot resolve here.
 */
const SMALL_TUNE = {
  headInk: 0.85,
  headWidth: 0.12,
  wraps: 4,
  minor: 0.42,
  major: 0.58,
  rBase: 1.15,
  rMin: 0.45,
  dwell: 6.6,
  morph: 1.3,
};

const QUERY = '(prefers-reduced-motion: reduce)';

function subscribe(onChange: () => void) {
  if (typeof matchMedia === 'undefined') return () => {};
  const query = matchMedia(QUERY);
  query.addEventListener('change', onChange);
  return () => query.removeEventListener('change', onChange);
}

/**
 * Live `prefers-reduced-motion`, read on the client only. The server renders
 * the drawn path either way, which is what the reduced branch also renders,
 * so nothing is rewritten under the reader on hydration.
 */
function useReducedMotion() {
  return useSyncExternalStore(
    subscribe,
    () => (typeof matchMedia === 'undefined' ? false : matchMedia(QUERY).matches),
    () => true,
  );
}

export function AiMark({
  size = 20,
  state = 'still',
  className,
}: {
  /** 20 in the top bar, 44 in the connect card. */
  size?: number;
  /** @default 'still' */
  state?: AiMarkState;
  className?: string;
}) {
  const reduced = useReducedMotion();
  // At rest the mark is the drawn glyph; the dotted cloud appears only while
  // the assistant is doing something (or, in the panel's welcome, as `waiting`).
  const cloud = state === 'still' || reduced ? null : state;

  return (
    <span
      className={className ? `ai-mark ${className}` : 'ai-mark'}
      data-state={state}
      style={{ '--ai-mark-size': `${size}px` } as CSSProperties}
      aria-hidden="true"
    >
      <svg
        className="ai-mark-drawn"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill="currentColor"
        fillRule="evenodd"
        focusable="false"
      >
        <path d={OPENAI_PATH} />
      </svg>
      {cloud ? (
        <ThinkingLogo
          className="ai-mark-cloud"
          logo={size >= 32 ? MARK_LARGE : MARK_SMALL}
          state={cloud}
          size={Math.round(size * CLOUD_SCALE)}
          tune={size >= 32 ? undefined : SMALL_TUNE}
          startAtMark
        />
      ) : null}
    </span>
  );
}
