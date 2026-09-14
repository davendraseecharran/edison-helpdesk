import 'server-only';

/**
 * Authorized attachment reads, and the small amount of storage plumbing the
 * server needs to go with them.
 *
 * Two clients appear here and they are not interchangeable.
 *
 *   - The REGISTRY is read with the signed-in user's own client, so
 *     `app_list_attachments` (SECURITY INVOKER) runs under their row-level
 *     security and the database decides which files exist as far as they are
 *     concerned. A ticket's attachments are visible exactly where the ticket
 *     is; a caller who may not see the ticket gets an empty list, which is the
 *     same answer as a ticket with no files, deliberately.
 *
 *   - The BYTES are reached with the service role, because they have to be: the
 *     `attachments` bucket is private and carries no storage policies at all,
 *     so no session can list, read or write an object in it. Every function
 *     below that uses the service role is called only after the registry has
 *     already said yes, and none of them takes a path from the browser without
 *     the database having agreed to it first.
 *
 * That division is the whole design. The registry is the authorization; the
 * bucket is only where the file happens to sit.
 */

import { createClient } from '@/lib/supabase/server';
import { adminClient } from '@/lib/supabase/admin';
import { MIME_SIGNATURE_BYTES, type Attachment, type AttachmentTarget } from '@/lib/attachments';

export type { AttachmentTarget };

export const ATTACHMENT_BUCKET = 'attachments';

/**
 * How long a download link lives. Long enough to click, short enough that a
 * link copied out of the page is useless by the time it is pasted anywhere.
 */
export const SIGNED_URL_SECONDS = 60;

interface AttachmentRow {
  id: string;
  ticket_id: string | null;
  device_id: string | null;
  path: string;
  filename: string;
  mime: string;
  bytes: number;
  uploaded_by: string;
  uploaded_at: string;
}

function mapAttachment(row: AttachmentRow): Attachment {
  return {
    id: row.id,
    ticketId: row.ticket_id,
    deviceId: row.device_id,
    path: row.path,
    filename: row.filename,
    mime: row.mime,
    bytes: row.bytes,
    uploadedBy: row.uploaded_by,
    uploadedAt: row.uploaded_at,
  };
}

/**
 * Exactly one parent, resolved once so every caller asks the database the same
 * question. Both or neither is a malformed request, and the RPCs treat it as
 * one; catching it here means the server never sends it.
 */
export function parentOf(
  target: AttachmentTarget,
): { kind: 'ticket' | 'device'; id: string } | null {
  const ticketId = target.ticketId ?? null;
  const deviceId = target.deviceId ?? null;
  if ((ticketId === null) === (deviceId === null)) return null;
  return ticketId !== null
    ? { kind: 'ticket', id: ticketId }
    : { kind: 'device', id: deviceId as string };
}

function rpcArgs(target: AttachmentTarget): Record<string, unknown> {
  return { p_ticket: target.ticketId ?? null, p_device: target.deviceId ?? null };
}

/** The files on one ticket or one device, oldest first. Empty when not visible. */
export async function loadAttachments(target: AttachmentTarget): Promise<Attachment[]> {
  if (!parentOf(target)) return [];
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_list_attachments', rpcArgs(target));
  if (error) return [];
  return ((data ?? []) as AttachmentRow[]).map(mapAttachment);
}

/** One attachment the caller may see, or null. Used before minting a link. */
export async function loadAttachment(
  id: string,
  target: AttachmentTarget,
): Promise<Attachment | null> {
  const rows = await loadAttachments(target);
  return rows.find((row) => row.id === id) ?? null;
}

/**
 * The visible attachment with this id, found without being told which record it
 * belongs to.
 *
 * `app_list_attachments` needs a parent, and a signed-URL request carries only
 * an attachment id, so this reads the table directly — still with the user's
 * own client, so the `attachments_select_visible` policy is what decides
 * whether the row exists. An attachment on a ticket the caller may not see is
 * simply not there.
 */
export async function loadVisibleAttachment(id: string): Promise<Attachment | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from('attachments')
    .select('id, ticket_id, device_id, path, filename, mime, bytes, uploaded_by, uploaded_at')
    .eq('id', id)
    .maybeSingle();
  if (error || !data) return null;
  return mapAttachment(data as AttachmentRow);
}

/** Whether this caller may add a file here, asked of the database, not guessed. */
export async function canAttach(target: AttachmentTarget): Promise<boolean> {
  if (!parentOf(target)) return false;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_can_attach', rpcArgs(target));
  // Fail closed: an error is not permission.
  if (error) return false;
  return data === true;
}

/* --- The bucket ---------------------------------------------------------- */

function bucket() {
  return adminClient().storage.from(ATTACHMENT_BUCKET);
}

export interface UploadGrant {
  path: string;
  token: string;
  signedUrl: string;
}

/**
 * A one-off URL the browser may PUT one file to, and nothing else.
 *
 * The grant is for one exact path, which the server built from the record the
 * database has already said this person may attach to. It is not a key to the
 * bucket: it cannot list, cannot read, and cannot write anywhere else.
 */
export async function createUploadGrant(path: string): Promise<UploadGrant> {
  const { data, error } = await bucket().createSignedUploadUrl(path);
  if (error || !data) {
    throw new Error(storageMessage(error?.message));
  }
  return { path: data.path, token: data.token, signedUrl: data.signedUrl };
}

export interface StoredObject {
  bytes: number;
  mime: string;
}

/**
 * What storage actually accepted, read back from the bucket.
 *
 * This is the reason registration is server-side at all: the SIZE recorded in
 * the registry comes from HERE, never from what the browser said it was about
 * to upload, so a row cannot promise a 24 KiB PNG that is really an 8 MiB
 * something else.
 *
 * The content type is weaker evidence. Storage repeats the type the uploader
 * declared; it does not open the file. `readObjectHead` below is what turns
 * that claim into a fact, and registration refuses anything whose first bytes
 * disagree with it.
 *
 * `info` is the direct question; not every storage version answers it, so a
 * listing of the containing folder is the fallback. Both report the object the
 * bucket holds.
 */
export async function readStoredObject(path: string): Promise<StoredObject | null> {
  const info = await bucket().info(path);
  if (!info.error && info.data) {
    const size = Number(info.data.size);
    const mime = String(info.data.contentType ?? '');
    if (Number.isFinite(size) && size > 0 && mime !== '') return { bytes: size, mime };
  }

  const slash = path.lastIndexOf('/');
  const folder = slash < 0 ? '' : path.slice(0, slash);
  const name = slash < 0 ? path : path.slice(slash + 1);
  const listing = await bucket().list(folder, { search: name, limit: 100 });
  if (listing.error || !listing.data) return null;

  const found = listing.data.find((entry) => entry.name === name);
  const metadata = found?.metadata as { size?: number; mimetype?: string } | undefined;
  if (!found || !metadata) return null;

  const size = Number(metadata.size);
  const mime = String(metadata.mimetype ?? '');
  if (!Number.isFinite(size) || size <= 0 || mime === '') return null;
  return { bytes: size, mime };
}

/**
 * The first bytes of a stored object, for a signature check.
 *
 * The download is taken as a stream and dropped as soon as there are enough
 * bytes to recognise the file, so an 8 MB PDF costs one chunk rather than a
 * round trip for the whole thing. Null when the object cannot be read at all,
 * which registration treats the same way as a file it cannot recognise.
 */
export async function readObjectHead(
  path: string,
  count = MIME_SIGNATURE_BYTES,
): Promise<Uint8Array | null> {
  const { data, error } = await bucket().download(path).asStream();
  if (error || !data) return null;

  const reader = data.getReader();
  const head = new Uint8Array(count);
  let filled = 0;
  try {
    while (filled < count) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value as Uint8Array;
      const take = Math.min(count - filled, chunk.length);
      head.set(chunk.subarray(0, take), filled);
      filled += take;
    }
  } catch {
    return null;
  } finally {
    // Nothing else wants the rest of the file.
    void reader.cancel().catch(() => {});
  }

  return filled === 0 ? null : head.subarray(0, filled);
}

/** A short-lived link to one object. The caller has already earned it. */
export async function signedDownloadUrl(
  path: string,
  options: { download?: string } = {},
): Promise<string | null> {
  const { data, error } = await bucket().createSignedUrl(
    path,
    SIGNED_URL_SECONDS,
    options.download ? { download: options.download } : undefined,
  );
  if (error || !data) return null;
  return data.signedUrl;
}

/**
 * Deletes the object. Best effort on purpose: `app_delete_attachment` removes
 * the row first and returns the path, so a failure here leaves an untidy bucket
 * rather than a registry row whose file has gone.
 */
export async function removeObject(path: string): Promise<void> {
  await bucket().remove([path]);
}

/* --- Trusted registration ------------------------------------------------ */

export interface RegisterInput {
  /** The account the server verified. Never a value the browser supplied. */
  actorId: string;
  target: AttachmentTarget;
  path: string;
  filename: string;
  /** Read back from the stored object's own bytes, not claimed by the uploader. */
  mime: string;
  bytes: number;
}

/**
 * Writes the registry row for an object that is already in the bucket.
 *
 * `app_trusted_register_attachment` is granted to the service role alone and
 * re-derives everything except the actor id: it reloads that account, refuses
 * it unless it is active and not mid-recovery, applies the contributor rule to
 * the locked ticket, and checks the type, the size and the path prefix again.
 * Passing an actor in is only safe because of that, and because the id comes
 * from `activeAccount()` rather than from a form field.
 */
export async function registerAttachment(
  input: RegisterInput,
): Promise<{ id: string } | { error: string }> {
  const { data, error } = await adminClient().rpc('app_trusted_register_attachment', {
    p_actor: input.actorId,
    p_ticket: input.target.ticketId ?? null,
    p_device: input.target.deviceId ?? null,
    p_path: input.path,
    p_filename: input.filename,
    p_mime: input.mime,
    p_bytes: input.bytes,
  });
  if (error) return { error: error.message };
  return { id: data as string };
}

/**
 * What to say when one of the attachment RPCs refuses.
 *
 * The RPCs raise sentences meant for the person at the screen — "Only the
 * person who attached this file, or an administrator, can remove it." — and
 * mark each one with an errcode. Anything else PostgREST hands back describes
 * the plumbing rather than the decision, and is no use to a technician, so it
 * becomes the one sentence that tells them what to do next.
 */
export function registryMessage(error: { code?: string | null; message?: string | null }): string {
  // no_data_found and insufficient_privilege: the two the RPCs raise on purpose.
  const deliberate = error.code === 'P0002' || error.code === '42501';
  const said = (error.message ?? '').trim();
  if (deliberate && said !== '') return said;
  return 'That change could not be saved. Refresh the page and try again.';
}

/**
 * Storage errors are written for developers. Two of them a technician can act
 * on, and the rest become one sentence that says what to do next.
 */
export function storageMessage(raw: string | undefined): string {
  const text = (raw ?? '').toLowerCase();
  if (text.includes('bucket not found')) {
    return 'File storage is not set up on this server yet. Tell an administrator.';
  }
  if (text.includes('mime') || text.includes('content type')) {
    return 'Attach a JPEG, PNG, WebP, GIF or PDF.';
  }
  if (text.includes('maximum allowed size') || text.includes('too large')) {
    return 'Attachments are limited to 8 MB. Compress the file and try again.';
  }
  return 'That file could not be uploaded. Check your connection and try again.';
}
