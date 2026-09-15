/**
 * Pictures in a conversation.
 *
 * Half of this application's work is looking at a machine: a cracked panel, a
 * projector showing a blue rectangle, an error dialog somebody photographed
 * with their phone rather than typed out. Describing one of those in prose is
 * the slowest way to say it, so the composer takes the picture itself.
 *
 * Everything here is PURE, and it is the whole of the rule set, because the
 * same rules have to hold in two places that cannot see each other:
 *
 *   - the browser, which decides what may be attached before it encodes
 *     anything (and which downscales first, `src/lib/image/resize.ts`);
 *   - the route, which trusts none of that and checks the bytes it was
 *     actually handed.
 *
 * Three numbers and three types, in one file, so the two halves can never
 * drift apart.
 *
 * WHAT IS SENT AND WHAT IS KEPT ARE DIFFERENT THINGS. The turn the model sees
 * carries the pictures as `input_image` parts alongside the text. The row
 * written to `ai_messages` carries the text and the NAMES of what was attached
 * and nothing else: `ai_messages_content_size` refuses a row over 256 KiB as it
 * arrives, and four megabytes of base64 is sixteen times that. So the
 * conversation remembers that there were pictures and what they were called,
 * which is what a later turn needs in order to say "the photo you sent earlier"
 * honestly, and it does not pretend to still have them.
 */

import type { InputItem } from './responses-client';
import { isRecord } from '@/lib/guards';

/** The three formats the Responses API reads and a phone or a laptop produces. */
export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

/**
 * The most one picture may weigh, AFTER the browser has downscaled it.
 *
 * A 1600px JPEG at 0.85 is a few hundred kilobytes; four megabytes is a
 * screenshot of a 5K display saved as PNG, which is the honest upper end of
 * what somebody might paste. Past that the message is refused here, where it
 * can say what to do, rather than by the model with a wall of JSON.
 */
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

/** The most one turn may carry. Four is a device from four angles. */
export const MAX_IMAGES = 4;

/** One picture on its way to the model. */
export interface TurnImage {
  /** `data:image/jpeg;base64,...` — the bytes, inline, as the API takes them. */
  dataUrl: string;
  /** What the file was called, for the chip and for the conversation row. */
  name: string;
}

/** What a file says about itself before anything has read it. */
export interface ChosenImage {
  name: string;
  type: string;
  size: number;
}

function isImageType(type: string): boolean {
  return (IMAGE_TYPES as readonly string[]).includes(type.toLowerCase());
}

/** The sentence shown wherever a picture of the wrong sort is offered. */
export const WRONG_TYPE =
  'The assistant reads PNG, JPEG and WebP pictures. Attach one of those, or describe what you can see.';

export const TOO_LARGE =
  'That picture is too large to send. Four megabytes is the most one picture can be.';

export const TOO_MANY = `The assistant takes ${MAX_IMAGES} pictures in one message. Send these, then attach the rest.`;

/**
 * What a data URL declares and how much it decodes to.
 *
 * The length is computed rather than the string decoded: this runs on the
 * server for every attached picture, and turning four megabytes of base64 into
 * a buffer only to measure it is four megabytes of work for a number that
 * arithmetic already knows.
 */
export function readDataUrl(
  value: unknown,
): { mediaType: string; bytes: number; body: string } | null {
  if (typeof value !== 'string') return null;
  const match = /^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,([A-Za-z0-9+/=]*)$/i.exec(value);
  if (!match) return null;
  const body = match[2];
  if (body.length === 0 || body.length % 4 !== 0) return null;
  const padding = body.endsWith('==') ? 2 : body.endsWith('=') ? 1 : 0;
  return { mediaType: match[1].toLowerCase(), bytes: (body.length / 4) * 3 - padding, body };
}

/**
 * What each format's first bytes look like once they are base64.
 *
 * Base64 encodes three bytes at a time, so the first characters of the encoding
 * are a fixed function of the first bytes of the file — which means the check
 * costs a `startsWith` and no decoding at all:
 *
 *   PNG   89 50 4E 47 ...  ->  iVBOR
 *   JPEG  FF D8 FF    ...  ->  /9j/
 *   WebP  52 49 46 46 ...  ->  UklGR   ("RIFF")
 */
const MAGIC: Record<string, string> = {
  'image/png': 'iVBOR',
  'image/jpeg': '/9j/',
  'image/webp': 'UklGR',
};

/**
 * Whether the bytes are the kind of file the data URL says they are.
 *
 * `data:image/png;base64,` is something the sender wrote, not something the
 * file proved. Without this, an HTML page, a PDF or a script travels to the
 * model labelled as a photograph, and the size and count rules are the only
 * thing it has passed. This is not a decoder and does not pretend to validate
 * the image — it establishes that the first bytes belong to the format that was
 * declared, which is the claim being made.
 */
export function bytesMatchType(mediaType: string, base64: string): boolean {
  const magic = MAGIC[mediaType.toLowerCase()];
  return magic !== undefined && base64.startsWith(magic);
}

/**
 * Why this file cannot be attached, or null.
 *
 * Type and count only. The SIZE is deliberately not judged here: the browser
 * downscales a photograph to 1600px before it is encoded, and a twelve-megapixel
 * original that becomes a 300 KB JPEG is a picture that attaches perfectly well.
 * `imageProblem` judges what actually came out.
 */
export function fileProblem(file: ChosenImage, alreadyAttached: number): string | null {
  if (!isImageType(file.type ?? '')) return WRONG_TYPE;
  if (alreadyAttached >= MAX_IMAGES) return TOO_MANY;
  return null;
}

/** Why this encoded picture cannot be sent, or null. */
export function imageProblem(image: TurnImage): string | null {
  const read = readDataUrl(image.dataUrl);
  if (read === null || !isImageType(read.mediaType)) return WRONG_TYPE;
  // The label and the bytes have to agree. A declared media type is a claim the
  // sender made about a file nobody opened.
  if (!bytesMatchType(read.mediaType, read.body)) return WRONG_TYPE;
  if (read.bytes > MAX_IMAGE_BYTES) return TOO_LARGE;
  return null;
}

/** What the route decided about the pictures a request carried. */
export type ImagesRead =
  | { ok: true; images: TurnImage[] }
  | { ok: false; status: number; code: string; message: string };

/** How long an attached file's name may be before it is cut. */
const MAX_NAME = 80;

function nameOf(value: unknown): string {
  const text = typeof value === 'string' ? value.trim() : '';
  if (text === '') return 'picture';
  // A name is shown on a chip and written into a conversation row. Newlines
  // would break both, and nothing useful is lost by refusing them.
  return text.replace(/[\r\n\t]+/g, ' ').slice(0, MAX_NAME);
}

/**
 * The pictures a request may carry, checked as though the browser had lied.
 *
 * It might have: this endpoint is reachable with curl, and the composer's own
 * limits are a courtesy to the person typing rather than a control. Count,
 * media type and decoded size are all re-derived from the bytes themselves.
 */
export function readImages(value: unknown): ImagesRead {
  if (value === undefined || value === null) return { ok: true, images: [] };
  if (!Array.isArray(value)) {
    return { ok: false, status: 400, code: 'bad_request', message: 'Send the pictures as a list.' };
  }
  if (value.length > MAX_IMAGES) {
    return { ok: false, status: 400, code: 'too_many_images', message: TOO_MANY };
  }

  const images: TurnImage[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) {
      return { ok: false, status: 400, code: 'bad_request', message: 'That request was not readable.' };
    }
    const image: TurnImage = { dataUrl: String(entry.dataUrl ?? ''), name: nameOf(entry.name) };
    const problem = imageProblem(image);
    if (problem === TOO_LARGE) {
      return { ok: false, status: 413, code: 'image_too_large', message: TOO_LARGE };
    }
    if (problem !== null) {
      return { ok: false, status: 415, code: 'image_type', message: WRONG_TYPE };
    }
    images.push(image);
  }
  return { ok: true, images };
}

/**
 * The user's turn, as the Responses API takes it.
 *
 * One message, text first and then the pictures, because that is the order
 * they were meant in: somebody types "is this the same crack as yesterday" and
 * then attaches the photo. An empty message is allowed — a photograph on its
 * own is a question — and contributes no text part rather than an empty one.
 */
export function userMessageItem(text: string, images: readonly TurnImage[] = []): InputItem {
  const content: Record<string, unknown>[] = [];
  const said = text.trim();
  if (said !== '') content.push({ type: 'input_text', text: said });
  for (const image of images) {
    content.push({ type: 'input_image', image_url: image.dataUrl, detail: 'auto' });
  }
  return { type: 'message', role: 'user', content };
}

/**
 * The budget for the attachment line in a stored row.
 *
 * Small on purpose. This line exists so a later turn can refer to "the photo of
 * the cracked screen" rather than to nothing at all; it is not a manifest, and
 * four long filenames should not push a real message out of its row.
 */
export const MAX_ATTACHMENT_NOTE = 240;

/**
 * What the conversation row says about pictures it is not keeping.
 *
 * Names when they fit, a count when they do not. Either way the sentence says
 * plainly that the pictures themselves are gone, because a model told "two
 * images attached" and given no images will otherwise describe what it cannot
 * see.
 */
export function attachmentNote(images: readonly TurnImage[]): string {
  if (images.length === 0) return '';
  const gone = 'The pictures are not kept after the turn they were sent in.';
  const named = `Attached: ${images.map((image) => image.name).join(', ')}. ${gone}`;
  if (named.length <= MAX_ATTACHMENT_NOTE) return named;
  const count = images.length === 1 ? '1 picture attached' : `${images.length} pictures attached`;
  return `${count}, not kept.`;
}

/**
 * The user's turn, as the conversation row keeps it.
 *
 * The person's own words untouched, and the attachment line as a part of its
 * own beside them. Two parts rather than one string: nothing this application
 * writes should be indistinguishable from what somebody typed.
 */
export function storedMessageItem(text: string, images: readonly TurnImage[] = []): InputItem {
  const content: Record<string, unknown>[] = [];
  const said = text.trim();
  if (said !== '') content.push({ type: 'input_text', text: said });
  const note = attachmentNote(images);
  if (note !== '') content.push({ type: 'input_text', text: note });
  return { type: 'message', role: 'user', content };
}
