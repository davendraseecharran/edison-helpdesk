'use client';

/**
 * A signature, drawn with a finger or a mouse.
 *
 * An SVG rather than a canvas: the strokes are kept as points and stored as
 * one path in the pad's own 600 × 200 units, so a signature is a few
 * kilobytes of text that redraws crisply at any size and in either theme
 * (`currentColor`), where a PNG would be tens of kilobytes of pixels in one
 * colour. `touch-action: none` on the surface is what stops the page
 * scrolling under the finger.
 *
 * Controlled by its path: the parent holds the string, and a path handed in
 * from outside (a response being re-shown) is drawn as it is.
 */

import { useRef, useState, type PointerEvent } from 'react';
import { Eraser } from 'lucide-react';
import {
  FORM_SIGNATURE_MAX,
  SIGNATURE_HEIGHT,
  SIGNATURE_WIDTH,
  strokesToPath,
} from '@/lib/domain/forms';
import { Button } from '@/components/ui/Button';

interface Point {
  x: number;
  y: number;
}

export function SignaturePad({
  id,
  value,
  onChange,
  disabled,
  invalid,
  describedBy,
  label,
}: {
  id: string;
  value: string;
  onChange: (path: string) => void;
  disabled?: boolean;
  invalid?: boolean;
  describedBy?: string;
  label: string;
}) {
  const surface = useRef<SVGSVGElement>(null);
  const strokes = useRef<Point[][]>([]);
  const drawing = useRef(false);
  const [live, setLive] = useState<string | null>(null);
  const [full, setFull] = useState(false);

  // What is on screen: the stroke in progress, or the stored path.
  const path = live ?? value;

  function pointOf(event: PointerEvent<SVGSVGElement>): Point {
    const box = surface.current?.getBoundingClientRect();
    if (!box || box.width === 0 || box.height === 0) return { x: 0, y: 0 };
    return {
      x: ((event.clientX - box.left) / box.width) * SIGNATURE_WIDTH,
      y: ((event.clientY - box.top) / box.height) * SIGNATURE_HEIGHT,
    };
  }

  function start(event: PointerEvent<SVGSVGElement>) {
    if (disabled || full) return;
    event.preventDefault();
    surface.current?.setPointerCapture(event.pointerId);
    drawing.current = true;
    // Strokes that no longer match what the parent holds — a path handed in
    // from outside, or a pad the parent cleared — start over from nothing.
    if (live === null && strokesToPath(strokes.current) !== value) strokes.current = [];
    strokes.current.push([pointOf(event)]);
    setLive(strokesToPath(strokes.current));
  }

  function move(event: PointerEvent<SVGSVGElement>) {
    if (!drawing.current) return;
    const stroke = strokes.current[strokes.current.length - 1];
    const next = pointOf(event);
    const last = stroke[stroke.length - 1];
    // Two units is below what a finger can mean, and it halves the path.
    if (Math.hypot(next.x - last.x, next.y - last.y) < 2) return;
    stroke.push(next);
    const drawn = strokesToPath(strokes.current);
    if (drawn.length > FORM_SIGNATURE_MAX) {
      stroke.pop();
      setFull(true);
      finish();
      return;
    }
    setLive(drawn);
  }

  function finish() {
    if (!drawing.current) return;
    drawing.current = false;
    const drawn = strokesToPath(strokes.current);
    setLive(null);
    onChange(drawn);
  }

  function clear() {
    strokes.current = [];
    setLive(null);
    setFull(false);
    onChange('');
  }

  return (
    <div className={invalid ? 'signature signature-invalid' : 'signature'}>
      <svg
        ref={surface}
        id={id}
        className="signature-surface"
        viewBox={`0 0 ${SIGNATURE_WIDTH} ${SIGNATURE_HEIGHT}`}
        role="img"
        aria-label={path ? `${label}: signed` : `${label}: draw your signature here`}
        aria-describedby={describedBy}
        data-disabled={disabled ? '' : undefined}
        onPointerDown={start}
        onPointerMove={move}
        onPointerUp={finish}
        onPointerCancel={finish}
      >
        <line
          className="signature-baseline"
          x1={24}
          x2={SIGNATURE_WIDTH - 24}
          y1={SIGNATURE_HEIGHT - 44}
          y2={SIGNATURE_HEIGHT - 44}
        />
        {path ? <path className="signature-ink" d={path} /> : null}
      </svg>
      <div className="signature-foot">
        <span className="signature-note">
          {full ? 'That is as long as a signature can be.' : path ? 'Signed.' : 'Sign above the line.'}
        </span>
        <Button size="sm" variant="ghost" icon={Eraser} onClick={clear} disabled={disabled || !path}>
          Clear
        </Button>
      </div>
    </div>
  );
}

/** A stored signature, drawn small: the responses table's cell. */
export function SignatureThumb({ path, label }: { path: string; label: string }) {
  return (
    <svg
      className="signature-thumb"
      viewBox={`0 0 ${SIGNATURE_WIDTH} ${SIGNATURE_HEIGHT}`}
      role="img"
      aria-label={label}
    >
      <path className="signature-ink" d={path} />
    </svg>
  );
}
