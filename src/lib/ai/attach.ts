import 'server-only';

/**
 * The one thing an assistant tool cannot do with a PostgREST call.
 *
 * Every other tool is a single RPC on the person's own client. Attaching a file
 * is not: the bytes have to reach a private bucket that carries no storage
 * policies at all, and the registry row is written by a function granted to the
 * service role alone. Both of those live behind `server-only` modules, and
 * `tools.ts` is imported by the unit suite, so the plumbing is INJECTED into the
 * tool context rather than imported by it. This module is that injection, and
 * the route is the only thing that wires it in.
 *
 * Nothing here is a shortcut around the browser's path. It asks the same
 * question (`app_can_attach`, in the person's own session), builds the path the
 * same way, uploads through the same one-path grant, and registers through the
 * same read-back-and-verify sequence — `verifyAndRegister`, shared with
 * `registerAttachmentAction` so the two cannot drift. The only difference is
 * `via: 'ai'`, which stamps the attribution columns and nothing else.
 */

import { randomUUID } from 'node:crypto';
import { revalidatePath } from 'next/cache';
import {
  attachmentPath,
  attachmentRefusal,
  sanitiseFilename,
  splitExtension,
  uniqueFilename,
} from '@/lib/attachments';
import {
  canAttach,
  createUploadGrant,
  removeObject,
  uploadToGrant,
  verifyAndRegister,
} from '@/lib/data/attachments';
import { AI_MODEL } from './responses-client';
import type { AttachmentPort } from './tools';

/**
 * What to call a picture that arrived with no extension.
 *
 * A phone's paste gives "image.png"; a drag from a screenshot tool sometimes
 * gives nothing at all, and `images.ts` falls back to the word "picture". The
 * stored name is what a person clicks on a ticket, and "picture" with no
 * extension tells them and their operating system nothing.
 */
const EXTENSIONS: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

function storedName(name: string, mime: string): string {
  const safe = sanitiseFilename(name);
  if (splitExtension(safe).extension !== '') return safe;
  return `${safe}${EXTENSIONS[mime] ?? ''}`;
}

export const assistantAttachments: AttachmentPort = {
  async attach({ actorId, ticketId, filename, mime, base64 }) {
    const target = { ticketId, deviceId: null };
    const name = storedName(filename, mime);
    const body = Buffer.from(base64, 'base64');

    // The same courtesy check the picker makes, so an oversized or wrong-typed
    // file is refused before anything is uploaded. The bucket and the
    // registration function ask again, and theirs are the answers that count.
    const refusal = attachmentRefusal({ name, type: mime, size: body.byteLength });
    if (refusal) return { ok: false, error: refusal };

    // Fail closed, in the person's own session: anything other than a plain yes
    // is a no, and the assistant gets the same no a click would.
    if (!(await canAttach(target))) {
      return { ok: false, error: 'You cannot attach a file to that ticket.' };
    }

    const path = attachmentPath('ticket', ticketId, uniqueFilename(name, randomUUID().slice(0, 8)));
    try {
      const grant = await createUploadGrant(path);
      await uploadToGrant(grant, body, mime);
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : 'That file could not be uploaded.',
      };
    }

    const registered = await verifyAndRegister({
      actorId,
      target,
      path,
      filename: name,
      via: 'ai',
      aiModel: AI_MODEL,
    });
    if ('error' in registered) return { ok: false, error: registered.error };

    // The ticket's own page gained a file and a history entry.
    revalidatePath(`/tickets/${ticketId}`);
    return {
      ok: true,
      id: registered.attachment.id,
      filename: registered.attachment.filename,
      bytes: registered.attachment.bytes,
    };
  },

  async removeObject(path) {
    await removeObject(path);
  },
};
