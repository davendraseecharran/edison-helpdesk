/**
 * Shrinking a photograph before it is uploaded.
 *
 * A technician photographs a cracked screen with the phone in their pocket. That
 * file is twelve megapixels and four megabytes; what anybody will ever do with
 * it is look at it on a laptop and decide whether the glass is broken. So the
 * browser draws it into a canvas at no more than 1600px on its long edge and
 * re-encodes it as JPEG at 0.85 before a single byte goes over the school's
 * wifi. Nothing useful is lost and the upload finishes.
 *
 * Three exceptions, each for a reason:
 *
 *   - A PDF is not an image. It is uploaded exactly as it is.
 *   - A GIF may be animated, and a canvas would flatten it to its first frame.
 *   - A small PNG is usually a screenshot or a logo with transparency, which
 *     JPEG has no way to keep. Under a megabyte it is not worth the loss.
 *
 * `resizeDecision` is pure and is where those rules live, so they can be tested
 * without a browser. `prepareUpload` is the half that needs a canvas.
 */

/** The long edge every re-encoded image is fitted inside. */
export const MAX_EDGE = 1600;

/** JPEG quality for a re-encode. High enough that a hairline crack survives. */
export const JPEG_QUALITY = 0.85;

/** Below this, a PNG keeps its transparency instead of becoming a JPEG. */
export const PNG_KEEP_MAX_BYTES = 1024 * 1024;

/**
 * What a phone hands over when it has not been asked for JPEG. Safari can
 * decode it; most other browsers cannot, and there is nothing this application
 * can do about that except say so plainly.
 */
export const HEIC_REFUSAL =
  'This browser cannot read a HEIC photo. Take the photo as JPEG or convert it first.';

export interface ChosenFile {
  name: string;
  type: string;
  size: number;
}

export type ResizeDecision =
  /** Upload the bytes as chosen. */
  | { action: 'keep'; reason: string }
  /** Draw it into a canvas and re-encode it as JPEG. */
  | { action: 'encode'; maxEdge: number; quality: number; reason: string }
  /** Nothing to try. The person is told why. */
  | { action: 'refuse'; reason: string };

function extensionOf(name: string): string {
  const dot = String(name ?? '').lastIndexOf('.');
  return dot < 0 ? '' : name.slice(dot).toLowerCase();
}

/**
 * HEIC arrives with an honest `image/heic`, with `image/heif`, and — on some
 * Android browsers and on a drag-and-drop from a file manager — with nothing at
 * all, which is why the extension is consulted too.
 */
export function isHeic(file: ChosenFile): boolean {
  const type = (file.type ?? '').toLowerCase();
  if (type === 'image/heic' || type === 'image/heif') return true;
  if (type !== '') return false;
  return ['.heic', '.heif'].includes(extensionOf(file.name));
}

export function resizeDecision(file: ChosenFile): ResizeDecision {
  const type = (file.type ?? '').toLowerCase();

  if (type === 'application/pdf') {
    return { action: 'keep', reason: 'A PDF is uploaded as it is.' };
  }

  // Tried, not refused: Safari decodes HEIC, and where it does the photograph
  // becomes an ordinary JPEG like any other. Where it does not, `prepareUpload`
  // reports HEIC_REFUSAL.
  if (isHeic(file)) {
    return {
      action: 'encode',
      maxEdge: MAX_EDGE,
      quality: JPEG_QUALITY,
      reason: 'HEIC is converted to JPEG where the browser can read it.',
    };
  }

  if (type === 'image/gif') {
    return { action: 'keep', reason: 'A GIF may be animated, and a canvas keeps one frame.' };
  }

  if (type === 'image/png' && file.size <= PNG_KEEP_MAX_BYTES) {
    return { action: 'keep', reason: 'A small PNG keeps its transparency.' };
  }

  if (type.startsWith('image/')) {
    return {
      action: 'encode',
      maxEdge: MAX_EDGE,
      quality: JPEG_QUALITY,
      reason: 'Photographs are fitted inside 1600px and saved as JPEG.',
    };
  }

  return { action: 'refuse', reason: 'Attach a JPEG, PNG, WebP, GIF or PDF.' };
}

/** The drawn size for an image of `width` × `height` fitted inside `maxEdge`. */
export function fitWithin(
  width: number,
  height: number,
  maxEdge: number,
): { width: number; height: number } {
  const longest = Math.max(width, height);
  if (longest <= maxEdge || longest === 0) {
    return { width: Math.max(1, Math.round(width)), height: Math.max(1, Math.round(height)) };
  }
  const scale = maxEdge / longest;
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

/** Swaps the extension for `.jpg`, because the bytes really are a JPEG now. */
export function asJpegName(name: string): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  return `${stem || 'photo'}.jpg`;
}

/**
 * The file to actually upload: the original, or a smaller JPEG of it.
 *
 * Failure here is never fatal on its own — an image the canvas cannot re-encode
 * is uploaded as it was chosen, provided it is small enough — except for HEIC,
 * where the original is of no use to anybody either and the person is told what
 * to do instead.
 */
export async function prepareUpload(file: File): Promise<File> {
  const decision = resizeDecision(file);
  if (decision.action !== 'encode') return file;

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    if (isHeic(file)) throw new Error(HEIC_REFUSAL);
    // Some other image this browser will not decode. Send it as it is and let
    // the size and type checks have the final word.
    return file;
  }

  try {
    const { width, height } = fitWithin(bitmap.width, bitmap.height, decision.maxEdge);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;

    const context = canvas.getContext('2d');
    if (!context) return file;
    // A photograph of a screen has fine detail in it; smoothing is what keeps a
    // hairline crack from disappearing into the downscale.
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = 'high';
    context.drawImage(bitmap, 0, 0, width, height);

    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', decision.quality);
    });
    if (!blob) {
      if (isHeic(file)) throw new Error(HEIC_REFUSAL);
      return file;
    }

    // A re-encode that came out bigger is not worth having, unless the original
    // is HEIC and nobody can open it anyway.
    if (blob.size >= file.size && !isHeic(file)) return file;

    return new File([blob], asJpegName(file.name), {
      type: 'image/jpeg',
      lastModified: file.lastModified,
    });
  } finally {
    bitmap.close();
  }
}
