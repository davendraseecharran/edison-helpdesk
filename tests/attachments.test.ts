/**
 * The pure rules behind attachments.
 *
 * Two of them are security, not tidiness. The stored path is what
 * `app_trusted_register_attachment` checks against the record the row names —
 * it must start with `ticket/<id>/` or `device/<id>/`, must have something
 * after that, and must not contain `..` anywhere — so a name that escapes its
 * folder is not a cosmetic problem, it is a way to hand out a file belonging to
 * a ticket the caller may not see. `sanitiseFilename` is what stops that
 * reaching the database at all, and `attachmentPath` is what puts the file
 * where the database expects to find it.
 *
 * The rest is the resize decision: which files are worth re-encoding in the
 * browser before they are uploaded, and which must be left exactly as chosen.
 */

import { describe, expect, it, vi } from 'vitest';

// `src/lib/data/attachments.ts` opens with `import 'server-only'`, which
// throws outside a Server Component. Its pure exports never touch a database
// or the bucket, so the marker is the only thing standing between this test
// and them; stub it out the same way tests/ai/route.test.ts does.
vi.mock('server-only', () => ({}));

import {
  ATTACHMENT_MAX_BYTES,
  attachmentPath,
  attachmentRefusal,
  formatBytes,
  isAllowedMime,
  isImageMime,
  sanitiseFilename,
  sniffMime,
  splitExtension,
  uniqueFilename,
} from '../src/lib/attachments';
import { mapAttachment, registryMessage, type AttachmentRow } from '../src/lib/data/attachments';
import {
  asJpegName,
  fitWithin,
  HEIC_REFUSAL,
  isHeic,
  JPEG_QUALITY,
  MAX_EDGE,
  PNG_KEEP_MAX_BYTES,
  prepareUpload,
  resizeDecision,
} from '../src/lib/image/resize';

describe('sanitiseFilename', () => {
  it('keeps an ordinary name as it is', () => {
    expect(sanitiseFilename('IMG_0042.jpg')).toBe('IMG_0042.jpg');
    expect(sanitiseFilename('repair-invoice.pdf')).toBe('repair-invoice.pdf');
    expect(sanitiseFilename('screen.2026-09-12.png')).toBe('screen.2026-09-12.png');
  });

  it('throws away every directory part, on either kind of slash', () => {
    expect(sanitiseFilename('../../etc/passwd')).toBe('passwd');
    expect(sanitiseFilename('/var/tmp/photo.jpg')).toBe('photo.jpg');
    expect(sanitiseFilename('C:\\Users\\Mercedes\\photo.jpg')).toBe('photo.jpg');
  });

  it('never lets ".." survive, because the database refuses a path containing it', () => {
    for (const name of ['..', '...', 'report..final.pdf', 'a...b.png', '..hidden.jpg']) {
      expect(sanitiseFilename(name)).not.toContain('..');
    }
    expect(sanitiseFilename('report..final.pdf')).toBe('report.final.pdf');
  });

  it('replaces anything outside letters, digits, dot, underscore and hyphen', () => {
    expect(sanitiseFilename('cracked screen (front).jpg')).toBe('cracked-screen-front.jpg');
    expect(sanitiseFilename('caf\u00e9 \u4e00 photo.png')).toBe('caf-photo.png');
    expect(sanitiseFilename('a?b*c|d.jpg')).toBe('a-b-c-d.jpg');
  });

  it('does not let two different names collapse into the same one', () => {
    expect(sanitiseFilename('front left.jpg')).not.toBe(sanitiseFilename('front right.jpg'));
  });

  it('drops control characters rather than turning them into hyphens', () => {
    expect(sanitiseFilename('photo\u0000\u001b.jpg')).toBe('photo.jpg');
  });

  it('trims leading dots and stray hyphens at either end', () => {
    expect(sanitiseFilename('.hidden.png')).toBe('hidden.png');
    expect(sanitiseFilename('  -photo-.jpg  ')).toBe('photo.jpg');
    expect(sanitiseFilename('---')).toBe('attachment');
  });

  it('always returns something a file can be called', () => {
    expect(sanitiseFilename('')).toBe('attachment');
    expect(sanitiseFilename('   ')).toBe('attachment');
    expect(sanitiseFilename('/')).toBe('attachment');
    // @ts-expect-error a browser can hand over anything at all
    expect(sanitiseFilename(undefined)).toBe('attachment');
  });

  it('shortens a very long name but keeps the extension', () => {
    const long = `${'a'.repeat(400)}.jpg`;
    const result = sanitiseFilename(long);
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result.endsWith('.jpg')).toBe(true);
  });
});

describe('splitExtension', () => {
  it('splits on the last dot', () => {
    expect(splitExtension('photo.final.jpg')).toEqual({ stem: 'photo.final', extension: '.jpg' });
  });

  it('treats a name with no usable extension as all stem', () => {
    expect(splitExtension('README')).toEqual({ stem: 'README', extension: '' });
    expect(splitExtension('trailing.')).toEqual({ stem: 'trailing.', extension: '' });
    expect(splitExtension('.gitignore')).toEqual({ stem: '.gitignore', extension: '' });
    // Prose after a dot is not an extension.
    expect(splitExtension('notes.aboutthething')).toEqual({
      stem: 'notes.aboutthething',
      extension: '',
    });
  });
});

describe('attachmentPath', () => {
  const ticket = '7c1a3f4e-2b90-4a1c-9f2d-0e5b6c7d8a91';
  const device = '1d2e3f40-5a6b-4c7d-8e9f-0a1b2c3d4e5f';

  it('puts the file directly under the record it belongs to', () => {
    expect(attachmentPath('ticket', ticket, 'IMG_0042.jpg')).toBe(
      `ticket/${ticket}/IMG_0042.jpg`,
    );
    expect(attachmentPath('device', device, 'invoice.pdf')).toBe(`device/${device}/invoice.pdf`);
  });

  it('sanitises the name on the way in, so the path cannot escape the folder', () => {
    const path = attachmentPath('ticket', ticket, '../../other/answer-key.pdf');
    expect(path).toBe(`ticket/${ticket}/answer-key.pdf`);
    expect(path).not.toContain('..');
    // What the database rebuilds and insists on.
    expect(path.startsWith(`ticket/${ticket}/`)).toBe(true);
    expect(path.length).toBeGreaterThan(`ticket/${ticket}/`.length);
  });

  it('never produces a bare folder, even for a name that sanitises away', () => {
    const path = attachmentPath('device', device, '   ');
    expect(path).toBe(`device/${device}/attachment`);
    expect(path.length).toBeGreaterThan(`device/${device}/`.length);
  });
});

describe('uniqueFilename', () => {
  it('puts the token before the extension so the file still opens', () => {
    expect(uniqueFilename('IMG_0001.jpg', 'a1b2c3d4')).toBe('IMG_0001-a1b2c3d4.jpg');
  });

  it('separates two phones that both called their photograph IMG_0001', () => {
    expect(uniqueFilename('IMG_0001.jpg', 'aaaa1111')).not.toBe(
      uniqueFilename('IMG_0001.jpg', 'bbbb2222'),
    );
  });

  it('stays inside the length cap and still carries the extension', () => {
    const result = uniqueFilename(`${'b'.repeat(300)}.png`, 'a1b2c3d4');
    expect(result.length).toBeLessThanOrEqual(120);
    expect(result.endsWith('-a1b2c3d4.png')).toBe(true);
  });

  it('handles a name with no extension at all', () => {
    expect(uniqueFilename('scan', 'a1b2c3d4')).toBe('scan-a1b2c3d4');
  });
});

describe('what may be attached', () => {
  it('accepts the five types the bucket accepts and nothing else', () => {
    for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']) {
      expect(isAllowedMime(mime)).toBe(true);
    }
    for (const mime of ['application/zip', 'image/heic', 'text/html', '']) {
      expect(isAllowedMime(mime)).toBe(false);
    }
  });

  it('is not confused by case or stray spaces', () => {
    expect(isAllowedMime(' IMAGE/JPEG ')).toBe(true);
    expect(isImageMime('IMAGE/PNG')).toBe(true);
    expect(isImageMime('application/pdf')).toBe(false);
  });

  it('refuses an empty file, an over-sized one and a type the bucket will not take', () => {
    expect(attachmentRefusal({ name: 'a.jpg', type: 'image/jpeg', size: 0 })).toMatch(/empty/i);
    expect(
      attachmentRefusal({ name: 'a.jpg', type: 'image/jpeg', size: ATTACHMENT_MAX_BYTES + 1 }),
    ).toMatch(/8 MB/);
    expect(attachmentRefusal({ name: 'a.zip', type: 'application/zip', size: 10 })).toMatch(
      /JPEG, PNG, WebP, GIF or PDF/,
    );
  });

  it('accepts the last byte that still fits', () => {
    expect(
      attachmentRefusal({ name: 'a.jpg', type: 'image/jpeg', size: ATTACHMENT_MAX_BYTES }),
    ).toBeNull();
  });
});

describe('formatBytes', () => {
  it('reads at a glance', () => {
    expect(formatBytes(1)).toBe('1 byte');
    expect(formatBytes(940)).toBe('940 bytes');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(812 * 1024)).toBe('812 KB');
    expect(formatBytes(2.4 * 1024 * 1024)).toBe('2.4 MB');
    expect(formatBytes(ATTACHMENT_MAX_BYTES)).toBe('8.0 MB');
  });

  it('says so rather than printing nonsense', () => {
    expect(formatBytes(Number.NaN)).toBe('Unknown size');
    expect(formatBytes(-1)).toBe('Unknown size');
  });
});

describe('the resize decision', () => {
  function file(type: string, size: number, name = 'photo') {
    return { name, type, size };
  }

  it('leaves a PDF exactly as it is', () => {
    expect(resizeDecision(file('application/pdf', 4_000_000, 'invoice.pdf')).action).toBe('keep');
  });

  it('leaves a GIF alone, because a canvas would keep one frame of it', () => {
    expect(resizeDecision(file('image/gif', 3_000_000, 'loop.gif')).action).toBe('keep');
  });

  it('keeps a small PNG so a screenshot does not lose its transparency', () => {
    expect(resizeDecision(file('image/png', PNG_KEEP_MAX_BYTES, 'shot.png')).action).toBe('keep');
  });

  it('re-encodes a large PNG, where the size is worth more than the alpha channel', () => {
    const decision = resizeDecision(file('image/png', PNG_KEEP_MAX_BYTES + 1, 'shot.png'));
    expect(decision.action).toBe('encode');
    if (decision.action === 'encode') {
      expect(decision.maxEdge).toBe(MAX_EDGE);
      expect(decision.quality).toBe(JPEG_QUALITY);
    }
  });

  it('re-encodes a photograph off a phone', () => {
    expect(resizeDecision(file('image/jpeg', 4_200_000, 'IMG_0042.jpg')).action).toBe('encode');
    expect(resizeDecision(file('image/webp', 2_000_000, 'shot.webp')).action).toBe('encode');
  });

  it('tries a HEIC rather than refusing it outright', () => {
    expect(resizeDecision(file('image/heic', 2_000_000, 'IMG_0042.HEIC')).action).toBe('encode');
    // Some browsers hand over no type at all, so the extension is consulted.
    expect(isHeic(file('', 10, 'IMG_0042.heic'))).toBe(true);
    expect(isHeic(file('image/jpeg', 10, 'IMG_0042.heic'))).toBe(false);
    expect(HEIC_REFUSAL).toMatch(/JPEG/);
  });

  it('refuses anything that is not an image or a PDF', () => {
    const decision = resizeDecision(file('application/zip', 100, 'stuff.zip'));
    expect(decision.action).toBe('refuse');
    expect(decision.reason).toMatch(/JPEG, PNG, WebP, GIF or PDF/);
  });
});

describe('fitting an image inside the long edge', () => {
  it('leaves anything already small enough alone', () => {
    expect(fitWithin(1200, 900, MAX_EDGE)).toEqual({ width: 1200, height: 900 });
    expect(fitWithin(MAX_EDGE, MAX_EDGE, MAX_EDGE)).toEqual({ width: 1600, height: 1600 });
  });

  it('scales the long edge down and keeps the proportions', () => {
    expect(fitWithin(4032, 3024, MAX_EDGE)).toEqual({ width: 1600, height: 1200 });
    expect(fitWithin(3024, 4032, MAX_EDGE)).toEqual({ width: 1200, height: 1600 });
  });

  it('never rounds a dimension down to nothing', () => {
    expect(fitWithin(8000, 3, MAX_EDGE).height).toBe(1);
    expect(fitWithin(0, 0, MAX_EDGE)).toEqual({ width: 1, height: 1 });
  });
});

describe('asJpegName', () => {
  it('says what the bytes now are', () => {
    expect(asJpegName('IMG_0042.HEIC')).toBe('IMG_0042.jpg');
    expect(asJpegName('screenshot.png')).toBe('screenshot.jpg');
    expect(asJpegName('scan')).toBe('scan.jpg');
  });
});

describe('mapAttachment', () => {
  function row(over: Partial<AttachmentRow> = {}): AttachmentRow {
    return {
      id: 'att-1',
      ticket_id: 'ticket-1',
      device_id: null,
      path: 'ticket/ticket-1/invoice.pdf',
      filename: 'invoice.pdf',
      mime: 'application/pdf',
      bytes: 4096,
      uploaded_by: 'acc-1',
      uploaded_at: '2026-09-12T10:00:00Z',
      ...over,
    };
  }

  it('defaults to the person when the row carries no attribution', () => {
    const attachment = mapAttachment(row());
    expect(attachment.performedVia).toBe('user');
    expect(attachment.aiModel).toBeNull();
  });

  it('carries the model when the row was stamped by an assistant', () => {
    const attachment = mapAttachment(row({ performed_via: 'ai', ai_model: 'gpt-6-luna' }));
    expect(attachment.performedVia).toBe('ai');
    expect(attachment.aiModel).toBe('gpt-6-luna');
  });

  it('never treats an unrecognised value as AI', () => {
    const attachment = mapAttachment(row({ performed_via: 'robot' }));
    expect(attachment.performedVia).toBe('user');
  });
});

describe('sniffMime', () => {
  const bytes = (...values: number[]) => Uint8Array.from(values);
  const ascii = (text: string, ...rest: number[]) =>
    Uint8Array.from([...[...text].map((c) => c.charCodeAt(0)), ...rest]);

  it('recognises each of the five types the bucket takes', () => {
    expect(sniffMime(bytes(0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10))).toBe('image/jpeg');
    expect(sniffMime(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00))).toBe('image/png');
    expect(sniffMime(ascii('GIF89a'))).toBe('image/gif');
    expect(sniffMime(ascii('GIF87a'))).toBe('image/gif');
    // 'RIFF', four bytes of length, then 'WEBP'.
    expect(sniffMime(Uint8Array.from([...ascii('RIFF'), 0x1a, 0x00, 0x00, 0x00, ...ascii('WEBP')]))).toBe(
      'image/webp',
    );
    expect(sniffMime(ascii('%PDF-1.7'))).toBe('application/pdf');
  });

  it('refuses a file whose declared type is the only thing PDF about it', () => {
    expect(sniffMime(ascii('PK', 0x03, 0x04))).toBeNull();
    expect(sniffMime(ascii('<?xml version="1.0"?>'))).toBeNull();
  });

  it('refuses anything too short, or too nearly right, to carry a signature', () => {
    expect(sniffMime(bytes())).toBeNull();
    expect(sniffMime(bytes(0xff, 0xd8))).toBeNull();
    // A RIFF container that is not a WebP.
    expect(sniffMime(Uint8Array.from([...ascii('RIFF'), 0x1a, 0x00, 0x00, 0x00, ...ascii('AVI ')]))).toBeNull();
  });
});

describe('registryMessage', () => {
  it('passes on the sentence the RPC raised for the person', () => {
    expect(
      registryMessage({
        code: '42501',
        message: 'Only the person who attached this file, or an administrator, can remove it.',
      }),
    ).toBe('Only the person who attached this file, or an administrator, can remove it.');
    expect(
      registryMessage({ code: 'P0002', message: 'That attachment is no longer available.' }),
    ).toBe('That attachment is no longer available.');
    // 23514 (check_violation) and 23505 (unique_violation): the codes
    // app_trusted_register_attachment raises for its own deliberate refusals
    // ("Attach a JPEG, PNG, WebP, GIF or PDF.", "That file has already been
    // attached."), same as P0002 and 42501 are for app_delete_attachment.
    expect(
      registryMessage({ code: '23514', message: 'Attach a JPEG, PNG, WebP, GIF or PDF.' }),
    ).toBe('Attach a JPEG, PNG, WebP, GIF or PDF.');
    expect(
      registryMessage({ code: '23505', message: 'That file has already been attached.' }),
    ).toBe('That file has already been attached.');
  });

  it('keeps the plumbing to itself and says what to do instead', () => {
    expect(registryMessage({ code: 'PGRST202', message: 'Could not find the function' })).toMatch(
      /Refresh the page and try again/,
    );
    expect(
      registryMessage({ code: '42883', message: 'operator does not exist: uuid = text' }),
    ).not.toMatch(/operator/);
  });
});

describe('prepareUpload', () => {
  it('refuses a file that is neither an image nor a PDF instead of uploading it', async () => {
    const chosen = new File([Uint8Array.from([0x50, 0x4b])], 'stuff.zip', {
      type: 'application/zip',
    });
    await expect(prepareUpload(chosen)).rejects.toThrow(/JPEG, PNG, WebP, GIF or PDF/);
  });
});
