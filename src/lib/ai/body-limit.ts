/**
 * How much of a request body this application is willing to read.
 *
 * `serverActions.bodySizeLimit` bounds a Server Action; it does not bound a
 * route handler, and `/api/ai/chat` is a route handler that takes base64
 * pictures. Without a bound, `await request.json()` will happily buffer a
 * gigabyte into memory before any of the count, type and size rules in
 * `images.ts` get a chance to refuse it — the rules are all downstream of the
 * parse, which is the wrong order for the one number that decides how much
 * memory a stranger can make the server use.
 *
 * So the size is decided before anything is parsed, from the limits that are
 * already published: four pictures at four megabytes each, base64 (three bytes
 * become four characters, so about 1.34) plus the data-URL prefixes, the JSON
 * quoting, the names and the page-context block — 1.4 covers all of it with
 * room to spare — and the message itself. A request larger than everything this
 * endpoint can legitimately accept is refused by its headers, without being
 * read.
 */

/** Base64 growth plus the JSON, the data-URL prefixes and the attachment names. */
const ENCODING_OVERHEAD = 1.4;

/** The bound, in bytes, from the limits the endpoint already publishes. */
export function maxBodyBytes(
  maxImages: number,
  maxImageBytes: number,
  maxMessageChars: number,
): number {
  return Math.ceil(maxImages * maxImageBytes * ENCODING_OVERHEAD + maxMessageChars);
}

export type BoundedBody =
  | { ok: true; text: string }
  | { ok: false; reason: 'too_large' }
  | { ok: false; reason: 'unreadable' };

/**
 * The body as text, or a refusal, without ever holding more than `limit` bytes.
 *
 * Two guards, because one is not enough. `content-length` refuses the ordinary
 * oversized request before a byte of it is read; a chunked request declares no
 * length at all, so the stream is counted as it arrives and cancelled the moment
 * it passes the bound. A sender that lies in the header is caught by the second.
 */
export async function readBoundedBody(
  request: { headers: { get(name: string): string | null }; body: ReadableStream<Uint8Array> | null },
  limit: number,
): Promise<BoundedBody> {
  const declared = Number(request.headers.get('content-length') ?? '');
  if (Number.isFinite(declared) && declared > limit) return { ok: false, reason: 'too_large' };

  const stream = request.body;
  if (stream === null) return { ok: true, text: '' };

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let seen = 0;
  let text = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      seen += value.byteLength;
      if (seen > limit) {
        await reader.cancel();
        return { ok: false, reason: 'too_large' };
      }
      // `stream: true` keeps a multi-byte character split across two chunks whole.
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  return { ok: true, text };
}
