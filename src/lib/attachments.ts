/**
 * The pure rules behind attachments: what a file may be called, where it is
 * stored, and how big it is allowed to get.
 *
 * Nothing here touches the network, the browser or the database, so the shape
 * of a stored path can be tested without either. That matters more than usual,
 * because the path is a security boundary: `app_trusted_register_attachment`
 * refuses any path that does not sit directly under the record it names, and
 * refuses `..` anywhere in it, so a file attached to one ticket can never be
 * handed out as a file belonging to another. This module is what makes the
 * server's path agree with that rule before the database has to say no.
 *
 * The four constants are deliberately duplicated in three places — here, the
 * `attachments` bucket, and the registration RPC. Each refuses independently.
 */

/** A file belongs to one ticket or one device. Never both, never neither. */
export type AttachmentParentKind = 'ticket' | 'device';

/**
 * Which record a call is about. Exactly one field is ever set: the RPCs treat
 * both or neither as a malformed question and fail closed, and so does every
 * caller here.
 */
export interface AttachmentTarget {
  ticketId?: string | null;
  deviceId?: string | null;
}

/** The five types the bucket accepts. */
export const ATTACHMENT_MIME_TYPES = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'application/pdf',
] as const;

export type AttachmentMime = (typeof ATTACHMENT_MIME_TYPES)[number];

/** 8 MiB, the bucket's own limit and the table's check constraint. */
export const ATTACHMENT_MAX_BYTES = 8 * 1024 * 1024;

/** What the file picker offers, and what the drop zone will take. */
export const ATTACHMENT_ACCEPT = [...ATTACHMENT_MIME_TYPES, '.heic', '.heif'].join(',');

/** One registry row, as the screens read it. */
export interface Attachment {
  id: string;
  ticketId: string | null;
  deviceId: string | null;
  path: string;
  filename: string;
  mime: string;
  bytes: number;
  uploadedBy: string;
  uploadedAt: string;
  /** Defaults to `user` for rows written before attribution existed. */
  performedVia?: 'user' | 'ai';
  /** Model that assisted, when `performedVia` is `ai`. */
  aiModel?: string | null;
}

export function isAllowedMime(mime: string): mime is AttachmentMime {
  return (ATTACHMENT_MIME_TYPES as readonly string[]).includes(mime.trim().toLowerCase());
}

export function isImageMime(mime: string): boolean {
  return mime.trim().toLowerCase().startsWith('image/');
}

/**
 * Longest stored name. The database caps the filename at 255 characters, and a
 * shorter cap here leaves room for the unique suffix without ever reaching it.
 */
const MAX_NAME = 120;

/**
 * A file name that is safe to put in a URL, a path and a heading.
 *
 * Everything outside `A-Za-z0-9._-` becomes a hyphen rather than being dropped,
 * so two different names cannot silently collapse into one. Directory parts are
 * discarded outright: a browser that hands over `../../secrets/key.pem` — or a
 * Windows `C:\\Users\\…\\photo.jpg` — is naming a file, not a place.
 */
export function sanitiseFilename(name: string): string {
  // The last segment of whatever was handed over, on either slash.
  const base = String(name ?? '')
    .split(/[/\\]/)
    .pop()!
    .trim();

  const cleaned = base
    // Control characters would survive the class below as their own bytes.
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    // "..", "...", and any run of dots become one. The registration RPC refuses
    // a path containing "..", and one dot is all a name ever needs.
    .replace(/\.{2,}/g, '.')
    .replace(/-{2,}/g, '-')
    // A hyphen that ended up against the dot is the trace of a bracket or a
    // space somebody typed before the extension: `cracked screen (front).jpg`
    // should come out as `cracked-screen-front.jpg`, not `…-front-.jpg`.
    .replace(/-*\.-*/g, '.')
    // A leading dot hides the file; a leading or trailing hyphen reads as a
    // mistake. Trailing dots are meaningless on every filesystem that matters.
    .replace(/^[.\-]+/, '')
    .replace(/[.\-]+$/, '');

  if (cleaned === '') return 'attachment';
  if (cleaned.length <= MAX_NAME) return cleaned;

  // Too long: keep the extension, because it is what tells a person (and their
  // operating system) what the file is.
  const { stem, extension } = splitExtension(cleaned);
  const room = Math.max(1, MAX_NAME - extension.length);
  return `${stem.slice(0, room).replace(/[.\-]+$/, '') || 'attachment'}${extension}`;
}

/** `photo.final.jpg` → `{ stem: 'photo.final', extension: '.jpg' }`. */
export function splitExtension(name: string): { stem: string; extension: string } {
  const dot = name.lastIndexOf('.');
  // A leading dot is not an extension, and neither is a dot with nothing after
  // it or an "extension" long enough to be prose.
  if (dot <= 0 || dot === name.length - 1 || name.length - dot > 12) {
    return { stem: name, extension: '' };
  }
  return { stem: name.slice(0, dot), extension: name.slice(dot) };
}

/**
 * The object key for one file: `<kind>/<record id>/<name>`.
 *
 * The prefix is not decoration. It is the same string the registration RPC
 * rebuilds from the parent the row names and insists the path starts with, so
 * a row can never point at a file belonging to a record the caller may not see.
 */
export function attachmentPath(kind: AttachmentParentKind, id: string, name: string): string {
  return `${kind}/${id}/${sanitiseFilename(name)}`;
}

/**
 * The same name with a short token before the extension.
 *
 * Stored paths are unique, and a phone names every photograph it takes the same
 * thing: two technicians photographing two different cracks on one ticket would
 * otherwise collide on `IMG_0001.jpg` and the second would be told the file had
 * already been attached, which is both wrong and unhelpful. The token goes in
 * the PATH only — the registry keeps the name the person recognises.
 */
export function uniqueFilename(name: string, token: string): string {
  const safe = sanitiseFilename(name);
  const suffix = sanitiseFilename(token) || 'x';
  const { stem, extension } = splitExtension(safe);
  const room = Math.max(1, MAX_NAME - extension.length - suffix.length - 1);
  return `${stem.slice(0, room).replace(/[.\-]+$/, '') || 'attachment'}-${suffix}${extension}`;
}

/** "2.4 MB", "812 KB", "940 bytes". Sizes are read at a glance, not audited. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return 'Unknown size';
  if (bytes < 1024) return `${Math.round(bytes)} ${bytes === 1 ? 'byte' : 'bytes'}`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/**
 * Why a chosen file cannot be attached, or null when it can.
 *
 * The browser asks this before it uploads anything, so a file that is going to
 * be refused is refused in front of the person while they still have the picker
 * open. The bucket and the registration RPC ask the same questions again.
 */
export function attachmentRefusal(file: { name: string; type: string; size: number }): string | null {
  if (file.size <= 0) {
    return 'That file is empty. Choose a file with contents and try again.';
  }
  if (file.size > ATTACHMENT_MAX_BYTES) {
    return 'Attachments are limited to 8 MB. Compress the file and try again.';
  }
  if (!isAllowedMime(file.type)) {
    return 'Attach a JPEG, PNG, WebP, GIF or PDF.';
  }
  return null;
}

/**
 * How many bytes from the front of a file are enough to recognise it. WebP is
 * the longest of the five: `RIFF`, four bytes of length, then `WEBP`.
 */
export const MIME_SIGNATURE_BYTES = 12;

function startsWith(head: Uint8Array, bytes: number[], offset = 0): boolean {
  if (head.length < offset + bytes.length) return false;
  return bytes.every((byte, index) => head[offset + index] === byte);
}

/**
 * Which of the five types a file really is, from its first bytes.
 *
 * A content type is a claim: the browser sends one with the upload and storage
 * records what it was told, so a `.pdf` full of something else is recorded as a
 * PDF unless somebody looks. These five all begin with a fixed signature, and
 * looking is one comparison. Anything else — including a file too short to have
 * a signature — comes back null, which the server treats as a refusal.
 */
export function sniffMime(head: Uint8Array): AttachmentMime | null {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  // 'GIF87a' and 'GIF89a'.
  if (startsWith(head, [0x47, 0x49, 0x46, 0x38]) && (head[4] === 0x37 || head[4] === 0x39) && head[5] === 0x61) {
    return 'image/gif';
  }
  // 'RIFF' …four bytes of length… 'WEBP'.
  if (startsWith(head, [0x52, 0x49, 0x46, 0x46]) && startsWith(head, [0x57, 0x45, 0x42, 0x50], 8)) {
    return 'image/webp';
  }
  if (startsWith(head, [0x25, 0x50, 0x44, 0x46, 0x2d])) return 'application/pdf';
  return null;
}
