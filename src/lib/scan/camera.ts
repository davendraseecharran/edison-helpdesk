/**
 * What can go wrong with a camera, said in words a person can act on.
 *
 * `getUserMedia` fails with a DOMException whose NAME is the only reliable
 * signal, and the names are the browser's vocabulary rather than anybody's
 * who is holding a laptop: "NotReadableError" means another app has the
 * camera; "OverconstrainedError" means the one we asked for is not there. The
 * viewfinder, the palette's scan and the phone page all say the same thing
 * about the same failure because they all ask here.
 *
 * Pure, so the mapping is tested without a camera.
 */

export type CameraProblem = 'unsupported' | 'insecure' | 'refused' | 'no-camera' | 'in-use' | 'decoder' | 'failed';

export interface ProblemCopy {
  title: string;
  body: string;
  /** Whether trying again can help without the person changing something first. */
  retry: boolean;
}

export const CAMERA_PROBLEMS: Record<CameraProblem, ProblemCopy> = {
  unsupported: {
    title: 'This browser has no camera access',
    body: 'Use a USB scanner, scan with your phone, or type the code.',
    retry: false,
  },
  insecure: {
    title: 'The camera needs a secure page',
    body: 'Open the helpdesk over https to use the camera. Type the code for now.',
    retry: false,
  },
  refused: {
    title: 'Camera access is blocked',
    body: 'Allow the camera in this site’s settings (the icon at the left of the address bar), then try again.',
    retry: true,
  },
  'no-camera': {
    title: 'No camera found',
    body: 'This device has no camera the browser can use. Use a USB scanner, or scan with your phone.',
    retry: true,
  },
  'in-use': {
    title: 'The camera is busy',
    body: 'Another app or tab is using it. Close that one, then try again.',
    retry: true,
  },
  decoder: {
    title: 'The barcode reader did not load',
    body: 'Check the connection, then try again. Typing the code still works.',
    retry: true,
  },
  failed: {
    title: 'The camera stopped',
    body: 'It stopped sending pictures. Try again.',
    retry: true,
  },
};

/** A `getUserMedia` rejection, named. */
export function problemFromError(error: unknown, secure = true): CameraProblem {
  if (!secure) return 'insecure';
  const name = typeof error === 'object' && error !== null && 'name' in error ? String((error as { name: unknown }).name) : '';
  switch (name) {
    case 'NotAllowedError':
    case 'PermissionDeniedError':
    case 'SecurityError':
      return 'refused';
    case 'NotFoundError':
    case 'DevicesNotFoundError':
    case 'OverconstrainedError':
    case 'ConstraintNotSatisfiedError':
      return 'no-camera';
    case 'NotSupportedError':
      return 'unsupported';
    case 'NotReadableError':
    case 'TrackStartError':
    case 'AbortError':
      return 'in-use';
    default:
      return 'failed';
  }
}

export type Facing = 'environment' | 'user';

/** The zoom a track offers, when it offers one worth a control. */
export interface ZoomRange {
  min: number;
  max: number;
  step: number;
}

/** Reads the zoom range out of `getCapabilities()`; null when there is none to speak of. */
export function zoomRange(capabilities: unknown): ZoomRange | null {
  if (typeof capabilities !== 'object' || capabilities === null) return null;
  const zoom = (capabilities as { zoom?: unknown }).zoom;
  if (typeof zoom !== 'object' || zoom === null) return null;
  const { min, max, step } = zoom as { min?: unknown; max?: unknown; step?: unknown };
  if (typeof min !== 'number' || typeof max !== 'number' || !(max > min)) return null;
  // A range of 1× to 1.2× is not a zoom anybody would reach for.
  if (max / Math.max(min, 0.01) < 1.5) return null;
  return { min, max, step: typeof step === 'number' && step > 0 ? step : 0.1 };
}

export function torchSupported(capabilities: unknown): boolean {
  return typeof capabilities === 'object' && capabilities !== null && (capabilities as { torch?: unknown }).torch === true;
}

/** A zoom value inside the range, on its step. */
export function clampZoom(range: ZoomRange, value: number): number {
  const clamped = Math.min(range.max, Math.max(range.min, value));
  const stepped = range.min + Math.round((clamped - range.min) / range.step) * range.step;
  return Math.min(range.max, Math.max(range.min, Number(stepped.toFixed(4))));
}

/** Two fingers moved apart by `ratio`: the zoom they ask for, from where it was. */
export function pinchZoom(range: ZoomRange, startZoom: number, ratio: number): number {
  if (!Number.isFinite(ratio) || ratio <= 0) return clampZoom(range, startZoom);
  return clampZoom(range, startZoom * ratio);
}

/** "2.5×": the zoom as the slider's label says it. */
export function zoomLabel(value: number): string {
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}×`;
}
