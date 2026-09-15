/**
 * The picture rules, which run in two places that cannot see each other.
 *
 * The browser applies them before it encodes anything; the route applies them
 * again to the bytes that actually arrived, on the assumption that the browser
 * was not involved at all. Both halves are this one module, so these tests are
 * the contract between them.
 */

import { describe, expect, it } from 'vitest';
import {
  IMAGE_TYPES,
  MAX_ATTACHMENT_NOTE,
  MAX_IMAGES,
  MAX_IMAGE_BYTES,
  TOO_LARGE,
  TOO_MANY,
  WRONG_TYPE,
  attachmentNote,
  fileProblem,
  imageProblem,
  readDataUrl,
  readImages,
  storedMessageItem,
  userMessageItem,
} from '../../src/lib/ai/images';

/** A data URL of `bytes` decoded bytes, in `type`. */
function dataUrl(type: string, bytes: number): string {
  // Base64 carries three bytes in four characters; the padding says how many
  // of the last three were real.
  const whole = Math.floor(bytes / 3);
  const rest = bytes % 3;
  const body = 'AAAA'.repeat(whole) + (rest === 0 ? '' : rest === 1 ? 'AA==' : 'AAA=');
  return `data:${type};base64,${body}`;
}

const picture = { dataUrl: dataUrl('image/png', 64), name: 'crack.png' };

describe('readDataUrl', () => {
  it('reads the media type and the decoded size without decoding', () => {
    expect(readDataUrl(dataUrl('image/jpeg', 300))).toEqual({ mediaType: 'image/jpeg', bytes: 300 });
    expect(readDataUrl(dataUrl('image/png', 301))).toEqual({ mediaType: 'image/png', bytes: 301 });
    expect(readDataUrl(dataUrl('image/webp', 302))).toEqual({ mediaType: 'image/webp', bytes: 302 });
  });

  it('refuses anything that is not a base64 data URL', () => {
    expect(readDataUrl('https://example.test/photo.png')).toBeNull();
    expect(readDataUrl('data:image/png,not-base64')).toBeNull();
    expect(readDataUrl('data:image/png;base64,')).toBeNull();
    expect(readDataUrl(42)).toBeNull();
  });
});

describe('fileProblem', () => {
  it('takes the three types the Responses API reads', () => {
    for (const type of IMAGE_TYPES) {
      expect(fileProblem({ name: 'a', type, size: 10 }, 0)).toBeNull();
    }
  });

  it('refuses a file that is not one of them', () => {
    expect(fileProblem({ name: 'notes.pdf', type: 'application/pdf', size: 10 }, 0)).toBe(WRONG_TYPE);
    expect(fileProblem({ name: 'clip.gif', type: 'image/gif', size: 10 }, 0)).toBe(WRONG_TYPE);
  });

  it('refuses the fifth picture', () => {
    expect(fileProblem({ name: 'a.png', type: 'image/png', size: 10 }, MAX_IMAGES - 1)).toBeNull();
    expect(fileProblem({ name: 'a.png', type: 'image/png', size: 10 }, MAX_IMAGES)).toBe(TOO_MANY);
  });

  it('says nothing about size, because the shrink has not happened yet', () => {
    // Twelve megapixels off a phone, which becomes a 300 KB JPEG.
    expect(fileProblem({ name: 'photo.jpg', type: 'image/jpeg', size: 6_000_000 }, 0)).toBeNull();
  });
});

describe('imageProblem', () => {
  it('passes a picture inside the budget', () => {
    expect(imageProblem({ dataUrl: dataUrl('image/jpeg', MAX_IMAGE_BYTES), name: 'a' })).toBeNull();
  });

  it('refuses one byte over', () => {
    expect(imageProblem({ dataUrl: dataUrl('image/jpeg', MAX_IMAGE_BYTES + 1), name: 'a' })).toBe(TOO_LARGE);
  });

  it('refuses a type the model cannot read, whatever the name says', () => {
    expect(imageProblem({ dataUrl: dataUrl('application/pdf', 10), name: 'x.png' })).toBe(WRONG_TYPE);
  });
});

describe('readImages', () => {
  it('accepts nothing at all', () => {
    expect(readImages(undefined)).toEqual({ ok: true, images: [] });
    expect(readImages(null)).toEqual({ ok: true, images: [] });
  });

  it('accepts a well-formed list and keeps the order', () => {
    const read = readImages([picture, { dataUrl: dataUrl('image/webp', 8), name: 'label.webp' }]);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.images.map((image) => image.name)).toEqual(['crack.png', 'label.webp']);
  });

  it('refuses a fifth picture with 400', () => {
    const read = readImages(Array.from({ length: MAX_IMAGES + 1 }, () => picture));
    expect(read).toMatchObject({ ok: false, status: 400, code: 'too_many_images', message: TOO_MANY });
  });

  it('refuses an oversized picture with 413', () => {
    const read = readImages([{ dataUrl: dataUrl('image/png', MAX_IMAGE_BYTES + 1), name: 'huge.png' }]);
    expect(read).toMatchObject({ ok: false, status: 413, code: 'image_too_large' });
  });

  it('refuses a type the model cannot read with 415', () => {
    const read = readImages([{ dataUrl: dataUrl('application/pdf', 10), name: 'notes.pdf' }]);
    expect(read).toMatchObject({ ok: false, status: 415, code: 'image_type' });
  });

  it('refuses a remote URL: only bytes this request carried are sent on', () => {
    expect(readImages([{ dataUrl: 'https://example.test/x.png', name: 'x.png' }])).toMatchObject({
      ok: false,
      status: 415,
    });
  });

  it('refuses anything that is not a list', () => {
    expect(readImages('crack.png')).toMatchObject({ ok: false, status: 400, code: 'bad_request' });
  });

  it('names a picture that arrived without one, and keeps a name to one line', () => {
    const read = readImages([{ dataUrl: picture.dataUrl }, { dataUrl: picture.dataUrl, name: 'a\nb' }]);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    expect(read.images[0].name).toBe('picture');
    expect(read.images[1].name).toBe('a b');
  });
});

describe('userMessageItem', () => {
  it('puts the words and the pictures in ONE user message, words first', () => {
    const item = userMessageItem('is this the same crack', [picture]);
    expect(item.type).toBe('message');
    expect(item.role).toBe('user');
    expect(item.content).toEqual([
      { type: 'input_text', text: 'is this the same crack' },
      { type: 'input_image', image_url: picture.dataUrl, detail: 'auto' },
    ]);
  });

  it('sends a picture with no words as a picture rather than as an empty sentence', () => {
    const item = userMessageItem('   ', [picture]);
    expect(item.content).toEqual([{ type: 'input_image', image_url: picture.dataUrl, detail: 'auto' }]);
  });

  it('is the plain text item when nothing is attached', () => {
    expect(userMessageItem('how many are open')).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'how many are open' }],
    });
  });

  it('keeps every picture, in the order they were attached', () => {
    const many = ['a.png', 'b.png', 'c.png', 'd.png'].map((name) => ({ dataUrl: picture.dataUrl, name }));
    const content = userMessageItem('four angles', many).content as Record<string, unknown>[];
    expect(content.filter((part) => part.type === 'input_image')).toHaveLength(4);
  });
});

describe('what the conversation row keeps', () => {
  it('never carries the bytes: a row is capped at 256 KiB and a picture is not', () => {
    const stored = JSON.stringify(storedMessageItem('look at this', [picture]));
    expect(stored).not.toContain('base64');
    expect(stored).not.toContain(picture.dataUrl);
  });

  it('names what was attached, and says the pictures are gone', () => {
    const note = attachmentNote([picture, { dataUrl: picture.dataUrl, name: 'label.webp' }]);
    expect(note).toContain('crack.png');
    expect(note).toContain('label.webp');
    expect(note).toContain('not kept');
  });

  it('falls back to a count when the names would not fit the budget', () => {
    const long = Array.from({ length: MAX_IMAGES }, (_, at) => ({
      dataUrl: picture.dataUrl,
      name: `${'photograph-of-the-broken-hinge'.repeat(3)}-${at}.png`,
    }));
    const note = attachmentNote(long);
    expect(note.length).toBeLessThanOrEqual(MAX_ATTACHMENT_NOTE);
    expect(note).toBe('4 pictures attached, not kept.');
  });

  it('says nothing at all when nothing was attached', () => {
    expect(attachmentNote([])).toBe('');
    expect(storedMessageItem('how many are open')).toEqual({
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'how many are open' }],
    });
  });

  it('keeps what the person typed in a part of its own', () => {
    const content = storedMessageItem('look at this', [picture]).content as Record<string, unknown>[];
    expect(content).toHaveLength(2);
    expect(content[0]).toEqual({ type: 'input_text', text: 'look at this' });
    expect(String(content[1].text)).toContain('Attached: crack.png');
  });
});
