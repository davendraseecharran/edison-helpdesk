import { describe, expect, it } from 'vitest';
import { maxBodyBytes, readBoundedBody } from '../../src/lib/ai/body-limit';
import { MAX_IMAGES, MAX_IMAGE_BYTES } from '../../src/lib/ai/images';

/** The chat route's own message bound, mirrored so the arithmetic is checkable. */
const MAX_MESSAGE_CHARS = 30_000;
const LIMIT = maxBodyBytes(MAX_IMAGES, MAX_IMAGE_BYTES, MAX_MESSAGE_CHARS);

/** A request-shaped object: the headers it declares and the bytes it sends. */
function request(body: string | null, headers: Record<string, string> = {}) {
  const lower = new Map(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), value]));
  return {
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    body:
      body === null
        ? null
        : new ReadableStream<Uint8Array>({
            start(controller) {
              // Two chunks, so the running count is exercised rather than one read.
              const bytes = new TextEncoder().encode(body);
              const half = Math.ceil(bytes.length / 2);
              controller.enqueue(bytes.slice(0, half));
              if (half < bytes.length) controller.enqueue(bytes.slice(half));
              controller.close();
            },
          }),
  };
}

describe('maxBodyBytes', () => {
  it('leaves room for every picture the endpoint accepts, encoded', () => {
    // Base64 is four characters per three bytes, so the full complement of
    // pictures has to fit with the JSON and the data-URL prefixes around it.
    expect(LIMIT).toBeGreaterThan(MAX_IMAGES * MAX_IMAGE_BYTES * (4 / 3));
    expect(LIMIT).toBeGreaterThan(MAX_MESSAGE_CHARS);
  });

  it('is a bound, not an invitation: it does not double the picture budget', () => {
    expect(LIMIT).toBeLessThan(MAX_IMAGES * MAX_IMAGE_BYTES * 2);
  });

  it('moves with the limits it is derived from', () => {
    expect(maxBodyBytes(8, MAX_IMAGE_BYTES, MAX_MESSAGE_CHARS)).toBeGreaterThan(LIMIT);
  });
});

describe('readBoundedBody', () => {
  it('reads an ordinary request whole', async () => {
    const text = JSON.stringify({ message: 'The projector in 118 shows no signal.' });
    const read = await readBoundedBody(request(text, { 'content-length': String(text.length) }), 1000);
    expect(read).toEqual({ ok: true, text });
  });

  it('refuses an oversized request on its header, without reading it', async () => {
    // No body at all: if the header were not enough, this would return ok.
    const read = await readBoundedBody(request(null, { 'content-length': '999999' }), 1000);
    expect(read).toEqual({ ok: false, reason: 'too_large' });
  });

  it('refuses a body that runs past the bound with no length declared', async () => {
    const read = await readBoundedBody(request('x'.repeat(2000)), 1000);
    expect(read).toEqual({ ok: false, reason: 'too_large' });
  });

  it('refuses a sender that understates its own length', async () => {
    const read = await readBoundedBody(request('x'.repeat(2000), { 'content-length': '10' }), 1000);
    expect(read).toEqual({ ok: false, reason: 'too_large' });
  });

  it('keeps a multi-byte character that was split across two chunks', async () => {
    const text = `{"message":"${'é'.repeat(200)}"}`;
    const read = await readBoundedBody(request(text), 10_000);
    expect(read).toEqual({ ok: true, text });
  });

  it('treats a request with no body as an empty one', async () => {
    expect(await readBoundedBody(request(null), 1000)).toEqual({ ok: true, text: '' });
  });
});
