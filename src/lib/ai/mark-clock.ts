/**
 * The mark's own clock.
 *
 * The library keeps one clock for every cloud on the page: it starts with the
 * first instance ever drawn and never rewinds, and "start at the mark" is a
 * fixed offset on top of it. So a cloud mounted later starts wherever that
 * clock happens to be, and a cloud paused on mount holds a frame from the
 * middle of somebody else's cycle. The welcome wants the opposite: the
 * assembled logo, held still, and then motion that begins from that very
 * frame. That is a clock per mark, and this is its arithmetic, kept pure so
 * it can be tested without a canvas.
 */

/**
 * The frame time for a mark `elapsedMs` after it was mounted.
 *
 * `mark` is the instant in the cycle at which the logo is assembled (the
 * dwell plus one morph, in the library's seconds). For the first `holdMs`
 * the answer is `mark` itself, so the picture does not change; after that
 * the cycle runs on from it at `speed` cycle-seconds per real second.
 */
export function cloudTime(elapsedMs: number, holdMs: number, speed: number, mark: number): number {
  const moving = Math.max(0, elapsedMs - Math.max(0, holdMs)) / 1000;
  return mark + moving * Math.max(0, speed);
}
