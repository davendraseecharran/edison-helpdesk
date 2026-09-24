/**
 * A tick that draws itself: the ring closes, then the check is written.
 *
 * Two strokes over `pathLength="1"`, so the dash arithmetic is the same at
 * every size. The timing is `forms.css`'s; under reduced motion both strokes
 * are simply drawn.
 */
export function CheckDraw({ size = 64, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className ? `check-draw ${className}` : 'check-draw'}
      width={size}
      height={size}
      viewBox="0 0 64 64"
      aria-hidden="true"
      focusable="false"
    >
      <circle className="check-draw-ring" cx="32" cy="32" r="29" pathLength={1} />
      <path className="check-draw-tick" d="M20 33.5 28.5 42 45 24" pathLength={1} />
    </svg>
  );
}
