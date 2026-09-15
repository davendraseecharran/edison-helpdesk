import { describe, expect, it } from 'vitest';
import {
  executeTool,
  validateArgs,
  type AttachInput,
  type AttachOutcome,
  type AttachmentPort,
  type ToolContext,
  type ToolImage,
} from '../../src/lib/ai/tools';

/**
 * The assistant's attachment tools, with no database and no bucket.
 *
 * Every RPC is a recorded fake, so what these assert is the part this module
 * actually owns: which picture was meant, what is sent to which function, and
 * that a refusal happens BEFORE anything is called rather than after.
 */

const TICKET = '11111111-1111-4111-8111-111111111111';
const DEVICE = '22222222-2222-4222-8222-222222222222';
const FILE = '33333333-3333-4333-8333-333333333333';

/** A one-pixel PNG, as the composer would have encoded it. */
const PNG_BODY =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
const PNG = `data:image/png;base64,${PNG_BODY}`;

interface Call {
  fn: string;
  args: Record<string, unknown>;
}

function context(options: {
  images?: ToolImage[];
  attachments?: AttachmentPort | undefined;
  results?: Record<string, unknown>;
  omitPort?: boolean;
}): { ctx: ToolContext; calls: Call[]; attached: AttachInput[] } {
  const calls: Call[] = [];
  const attached: AttachInput[] = [];
  const removed: string[] = [];

  const port: AttachmentPort = options.attachments ?? {
    async attach(input): Promise<AttachOutcome> {
      attached.push(input);
      return { ok: true, id: FILE, filename: input.filename, bytes: 68 };
    },
    async removeObject(path) {
      removed.push(path);
    },
  };

  const ctx = {
    supabase: {
      rpc: async (fn: string, args: Record<string, unknown>) => {
        calls.push({ fn, args });
        const results = options.results ?? {};
        return { data: fn in results ? results[fn] : null, error: null };
      },
    },
    actor: { id: 'actor-1', displayName: 'Nia Example', roles: ['netrider'] },
    images: options.images ?? [],
    ...(options.omitPort === true ? {} : { attachments: port }),
  } as unknown as ToolContext;

  return { ctx, calls, attached };
}

const TICKET_DETAIL = { ticket: { number: 'EDT-1042', title: 'Projector will not wake' } };

describe('list_attachments', () => {
  it('refuses a call that names both a ticket and a device', async () => {
    const { ctx, calls } = context({});
    const result = await executeTool('list_attachments', { ticket: TICKET, device: DEVICE }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/either a ticket or a device/i);
    expect(calls).toEqual([]);
  });

  it('refuses a call that names neither', async () => {
    const { ctx, calls } = context({});
    const result = await executeTool('list_attachments', {}, ctx);
    expect(result.ok).toBe(false);
    expect(calls).toEqual([]);
  });

  it('reads one ticket’s files and leaves the storage path out of the result', async () => {
    const { ctx, calls } = context({
      results: {
        app_ticket_detail: TICKET_DETAIL,
        app_list_attachments: [
          {
            id: FILE,
            filename: 'cracked-screen.jpg',
            mime: 'image/jpeg',
            bytes: 2048,
            uploaded_at: '2026-09-15T12:00:00Z',
            path: 'ticket/secret/cracked-screen.jpg',
            performed_via: 'ai',
          },
        ],
      },
    });

    const result = await executeTool('list_attachments', { ticket: TICKET }, ctx);
    expect(result.ok).toBe(true);
    expect(calls.map((call) => call.fn)).toContain('app_list_attachments');
    const listed = calls.find((call) => call.fn === 'app_list_attachments');
    expect(listed?.args).toEqual({ p_ticket: TICKET, p_device: null });
    expect(JSON.stringify(result.result)).not.toContain('secret');
    expect(JSON.stringify(result.result)).toContain('2 KB');
    expect(result.summary).toContain('EDT-1042');
  });

  it('reads a device’s files through the device resolver', async () => {
    const { ctx, calls } = context({
      results: {
        app_get_inventory_device: { id: DEVICE, assetTag: 'EDI-0007' },
        app_list_attachments: [],
      },
    });
    const result = await executeTool('list_attachments', { device: DEVICE }, ctx);
    expect(result.ok).toBe(true);
    expect(calls.find((call) => call.fn === 'app_list_attachments')?.args).toEqual({
      p_ticket: null,
      p_device: DEVICE,
    });
  });
});

describe('attach_to_ticket', () => {
  const one: ToolImage = { name: 'cracked-screen.png', dataUrl: PNG };
  const two: ToolImage = { name: 'label.png', dataUrl: PNG };

  it('says plainly that a picture only lives for the turn it arrived in', async () => {
    const { ctx, attached } = context({ images: [], results: { app_ticket_detail: TICKET_DETAIL } });
    const result = await executeTool('attach_to_ticket', { ticket: TICKET }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/no pictures in this message/i);
    expect(attached).toEqual([]);
  });

  it('attaches the only picture without being told which', async () => {
    const { ctx, attached } = context({
      images: [one],
      results: { app_ticket_detail: TICKET_DETAIL },
    });
    const result = await executeTool('attach_to_ticket', { ticket: TICKET }, ctx);
    expect(result.ok).toBe(true);
    expect(attached).toHaveLength(1);
    expect(attached[0].ticketId).toBe(TICKET);
    expect(attached[0].mime).toBe('image/png');
    expect(attached[0].base64).toBe(PNG_BODY);
    // The actor is the verified session, never anything the model wrote.
    expect(attached[0].actorId).toBe('actor-1');
    expect(result.summary).toContain('EDT-1042');
  });

  it('asks which one rather than choosing when two were sent', async () => {
    const { ctx, attached } = context({
      images: [one, two],
      results: { app_ticket_detail: TICKET_DETAIL },
    });
    const result = await executeTool('attach_to_ticket', { ticket: TICKET }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/say which picture/i);
    expect(result.summary).toContain('cracked-screen.png');
    expect(attached).toEqual([]);
  });

  it('takes a position as well as a name', async () => {
    const byIndex = context({ images: [one, two], results: { app_ticket_detail: TICKET_DETAIL } });
    expect((await executeTool('attach_to_ticket', { ticket: TICKET, picture: '2' }, byIndex.ctx)).ok).toBe(
      true,
    );
    expect(byIndex.attached[0].filename).toBe('label.png');

    const byName = context({ images: [one, two], results: { app_ticket_detail: TICKET_DETAIL } });
    expect(
      (await executeTool('attach_to_ticket', { ticket: TICKET, picture: 'cracked' }, byName.ctx)).ok,
    ).toBe(true);
    expect(byName.attached[0].filename).toBe('cracked-screen.png');
  });

  it('refuses a position that is not there, naming what is', async () => {
    const { ctx, attached } = context({
      images: [one],
      results: { app_ticket_detail: TICKET_DETAIL },
    });
    const result = await executeTool('attach_to_ticket', { ticket: TICKET, picture: '4' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('cracked-screen.png');
    expect(attached).toEqual([]);
  });

  it('refuses a picture whose bytes are not one of the stored types', async () => {
    const { ctx, attached } = context({
      images: [{ name: 'notes.txt', dataUrl: 'data:text/plain;base64,aGVsbG8=' }],
      results: { app_ticket_detail: TICKET_DETAIL },
    });
    const result = await executeTool('attach_to_ticket', { ticket: TICKET }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/JPEG, PNG, WebP, GIF or PDF/);
    expect(attached).toEqual([]);
  });

  it('passes the storage refusal through in the words it was written in', async () => {
    const { ctx } = context({
      images: [one],
      results: { app_ticket_detail: TICKET_DETAIL },
      attachments: {
        async attach() {
          return { ok: false, error: 'You cannot attach a file to that ticket.' };
        },
        async removeObject() {},
      },
    });
    const result = await executeTool('attach_to_ticket', { ticket: TICKET }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toBe('You cannot attach a file to that ticket.');
  });

  it('says so rather than throwing where files cannot be uploaded at all', async () => {
    const { ctx } = context({
      images: [one],
      omitPort: true,
      results: { app_ticket_detail: TICKET_DETAIL },
    });
    const result = await executeTool('attach_to_ticket', { ticket: TICKET }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/attachments panel/i);
  });

  it('needs a ticket', () => {
    const checked = validateArgs('attach_to_ticket', { picture: '1' });
    expect(checked.ok).toBe(false);
    expect(checked.error).toMatch(/needs ticket/);
  });
});

describe('remove_attachment', () => {
  it('refuses anything that is not an id, without reaching the database', async () => {
    const { ctx, calls } = context({});
    const result = await executeTool('remove_attachment', { attachment_id: 'the photo' }, ctx);
    expect(result.ok).toBe(false);
    expect(result.summary).toMatch(/list_attachments/);
    expect(calls).toEqual([]);
  });

  it('lets the database decide, then removes the object it named', async () => {
    const paths: string[] = [];
    const { ctx, calls } = context({
      results: { app_delete_attachment: 'ticket/abc/cracked-screen-1a2b3c4d.jpg' },
      attachments: {
        async attach() {
          throw new Error('remove_attachment must not upload anything');
        },
        async removeObject(path) {
          paths.push(path);
        },
      },
    });

    const result = await executeTool('remove_attachment', { attachment_id: FILE }, ctx);
    expect(result.ok).toBe(true);
    expect(calls).toEqual([{ fn: 'app_delete_attachment', args: { p_id: FILE } }]);
    expect(paths).toEqual(['ticket/abc/cracked-screen-1a2b3c4d.jpg']);
  });
});
