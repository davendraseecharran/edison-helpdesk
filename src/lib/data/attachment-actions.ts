'use server';

/**
 * Attachments: the four calls a browser makes, and the order they go in.
 *
 *   1. `requestUploadAction` — the database is asked whether this person may
 *      attach a file HERE, in their own session. If it says yes the server
 *      builds the path (the browser never chooses one) and mints a signed
 *      upload URL good for that one path and nothing else.
 *   2. The browser PUTs the file to that URL. It has no other access to the
 *      bucket: the bucket is private and carries no storage policies at all.
 *   3. `registerAttachmentAction` — the server reads the stored object BACK,
 *      size from the bucket and type from the file's own first bytes, and
 *      writes the registry row from that. This is why registration is
 *      service-role-only: the size and the content type in the registry are
 *      facts about the file, not claims about it.
 *   4. `attachmentUrlAction` / `deleteAttachmentAction` — both begin in the
 *      user's own session, so row-level security decides whether the row exists
 *      at all before the service role is used to touch the object.
 *
 * The shape of that is deliberate. The registry is the whole of attachment
 * authorization, because the bytes can only ever be reached through a URL the
 * server signs after the database has agreed. So nothing here trusts a path, a
 * size, a type or an actor from the browser: the path is rebuilt, the size is
 * re-read, the type is read out of the bytes, and the actor comes from the
 * verified session.
 */

import { revalidatePath } from 'next/cache';
import { randomUUID } from 'node:crypto';
import { activeAccount } from '@/lib/auth/session';
import { createClient } from '@/lib/supabase/server';
import {
  attachmentPath,
  attachmentRefusal,
  sanitiseFilename,
  uniqueFilename,
  type Attachment,
} from '@/lib/attachments';
import {
  canAttach,
  createUploadGrant,
  loadAttachments,
  loadVisibleAttachment,
  parentOf,
  registryMessage,
  removeObject,
  signedDownloadUrl,
  storageMessage,
  verifyAndRegister,
  type AttachmentTarget,
} from '@/lib/data/attachments';
import type { ActionResult } from '@/lib/data/actions';

/** Every action answers in this shape: what happened, or what went wrong. */
export type AttachmentResult<T> = ({ ok: true } & T) | { ok: false; error: string };

const SIGN_IN_AGAIN = 'Your session is not able to make changes. Sign in again.';
const NOT_ALLOWED = 'You cannot attach a file to that record. Refresh the page and try again.';
const GONE = 'That attachment is no longer available.';

/**
 * The one page this file belongs to.
 *
 * An attachment appears on its record and nowhere else — the queue counts no
 * files and no badge changes — so re-rendering that page is the whole of what a
 * new or removed file affects. The paths match the links: a record is reached
 * by its id, not by its number.
 */
function revalidateRecord(target: AttachmentTarget): void {
  const parent = parentOf(target);
  if (!parent) return;
  revalidatePath(`/${parent.kind === 'ticket' ? 'tickets' : 'devices'}/${parent.id}`);
}

/* --- Reading -------------------------------------------------------------- */

export interface AttachmentListing {
  attachments: Attachment[];
  /** Whether to offer the upload control. The database's answer, not a guess. */
  canAttach: boolean;
}

/**
 * The panel's first call: the files, and whether this person may add one.
 *
 * Both halves come from the database under the caller's own row-level
 * security, so a ticket they may not see yields an empty list and no upload
 * control — the same answer as a ticket with no files, which is the point.
 */
export async function listAttachmentsAction(
  target: AttachmentTarget,
): Promise<AttachmentResult<AttachmentListing>> {
  const actor = await activeAccount();
  if (!actor) return { ok: false, error: SIGN_IN_AGAIN };
  if (!parentOf(target)) return { ok: false, error: NOT_ALLOWED };

  const [attachments, mayAttach] = await Promise.all([loadAttachments(target), canAttach(target)]);
  return { ok: true, attachments, canAttach: mayAttach };
}

/* --- Uploading ------------------------------------------------------------ */

export interface UploadRequest extends AttachmentTarget {
  filename: string;
  mime: string;
  bytes: number;
}

export interface UploadGrantResult {
  /** Where the file will live. The browser sends this back to register it. */
  path: string;
  token: string;
  signedUrl: string;
  /** The name the registry will show, already sanitised. */
  filename: string;
}

/**
 * Permission to upload one file to one path.
 *
 * The path is built here, from the record the database has just agreed to, so a
 * browser can neither choose where its file lands nor point a registry row at
 * somebody else's folder. A short token goes before the extension because a
 * phone names every photograph it takes the same thing, and two technicians
 * photographing two different cracks on one ticket must not collide on
 * `IMG_0001.jpg`; the registry still stores the name a person recognises.
 *
 * The size and type checks here are a courtesy — they let the browser refuse a
 * file while the picker is still open. The bucket and the registration RPC ask
 * the same questions again, and theirs are the answers that count.
 */
export async function requestUploadAction(
  request: UploadRequest,
): Promise<AttachmentResult<UploadGrantResult>> {
  const actor = await activeAccount();
  if (!actor) return { ok: false, error: SIGN_IN_AGAIN };

  const parent = parentOf(request);
  if (!parent) return { ok: false, error: NOT_ALLOWED };

  const filename = sanitiseFilename(request.filename);
  const refusal = attachmentRefusal({
    name: filename,
    type: request.mime,
    size: request.bytes,
  });
  if (refusal) return { ok: false, error: refusal };

  // Fail closed: the question is asked in the user's own session, and anything
  // other than a plain yes is a no.
  if (!(await canAttach(request))) return { ok: false, error: NOT_ALLOWED };

  const path = attachmentPath(
    parent.kind,
    parent.id,
    uniqueFilename(filename, randomUUID().slice(0, 8)),
  );

  try {
    const grant = await createUploadGrant(path);
    return { ok: true, ...grant, filename };
  } catch (error) {
    return { ok: false, error: storageMessage(error instanceof Error ? error.message : undefined) };
  }
}

export interface RegisterRequest extends AttachmentTarget {
  /** The path `requestUploadAction` issued, returned unchanged. */
  path: string;
  /** The display name. Sanitised again here; the path is what is load-bearing. */
  filename?: string;
}

/**
 * Records the file now that it is in the bucket.
 *
 * The order matters. The object is read back FIRST, so the row describes what
 * storage holds rather than what the browser said it was sending, and if the
 * upload never landed there is nothing to register. If the database then
 * refuses the row — a ticket resolved while the file was in flight, say — the
 * object is deleted again, because an object with no row is unreachable and
 * would sit in the bucket forever.
 */
export async function registerAttachmentAction(
  request: RegisterRequest,
): Promise<AttachmentResult<{ attachment: Attachment }>> {
  const actor = await activeAccount();
  if (!actor) return { ok: false, error: SIGN_IN_AGAIN };

  // The read-back, the signature check and the registry write are the same
  // sequence whoever sent the bytes, so they live in one place; `via` is left
  // unset, which is this action's whole claim about attribution: a browser
  // upload is somebody's own hands.
  const registered = await verifyAndRegister({
    actorId: actor.id,
    target: { ticketId: request.ticketId ?? null, deviceId: request.deviceId ?? null },
    path: request.path,
    filename: request.filename,
  });
  if ('error' in registered) return { ok: false, error: registered.error };

  // The history gained an event, so the record's own page needs re-reading.
  revalidateRecord(request);
  return { ok: true, attachment: registered.attachment };
}

/* --- Reading one file ----------------------------------------------------- */

/**
 * A link to one file, good for sixty seconds.
 *
 * Visibility is decided by row-level security on the registry, in the caller's
 * own session: an attachment on a ticket they may not see does not exist as far
 * as this call is concerned, so the service role is only ever asked to sign a
 * path the database has already handed over.
 *
 * Sixty seconds is enough to load a thumbnail or open a file and short enough
 * that a link copied out of the page is useless anywhere else by the time it is
 * pasted. Anything shown for longer than that asks again.
 */
export async function attachmentUrlAction(
  id: string,
  download = false,
): Promise<AttachmentResult<{ url: string; filename: string; mime: string }>> {
  const actor = await activeAccount();
  if (!actor) return { ok: false, error: SIGN_IN_AGAIN };

  const attachment = await loadVisibleAttachment(id);
  if (!attachment) return { ok: false, error: GONE };

  const url = await signedDownloadUrl(
    attachment.path,
    download ? { download: attachment.filename } : {},
  );
  if (!url) return { ok: false, error: GONE };

  return { ok: true, url, filename: attachment.filename, mime: attachment.mime };
}

/* --- Removing ------------------------------------------------------------- */

/**
 * Removes one attachment: the row first, then the object.
 *
 * `app_delete_attachment` runs in the caller's own session and decides
 * everything — the uploader or an administrator, an administrator only once the
 * ticket is closed, and "no longer available" for a file on a ticket they
 * cannot see — then returns the path. The row going first is deliberate: a
 * crash in between leaves an untidy bucket, whereas the other order would leave
 * a listed file that cannot be opened.
 */
export async function deleteAttachmentAction(id: string): Promise<ActionResult> {
  const actor = await activeAccount();
  if (!actor) return { ok: false, error: SIGN_IN_AGAIN };

  // Read the row before it goes: its record is the page that needs re-rendering
  // afterwards, and by then there is nothing left to ask.
  const attachment = await loadVisibleAttachment(id);

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_delete_attachment', { p_id: id });
  if (error) return { ok: false, error: registryMessage(error) };

  if (typeof data === 'string' && data !== '') {
    await removeObject(data);
  }

  if (attachment) {
    revalidateRecord({ ticketId: attachment.ticketId, deviceId: attachment.deviceId });
  }
  return { ok: true, message: 'Attachment removed.' };
}
