/**
 * Envelope encryption for the one secret this application stores on somebody's
 * behalf: the OAuth token set for their linked ChatGPT account.
 *
 * The database deliberately cannot read it. `ai_connections` has row-level
 * security on and no policies at all, and the column holds only what this file
 * produced, so a leaked database dump is a pile of AES-256-GCM ciphertext and a
 * leaked `AI_TOKEN_KEY` on its own opens nothing.
 *
 * Envelope: `v1.<base64 nonce>.<base64 ciphertext||tag>`
 *
 *   * GCM, so a payload that was edited anywhere FAILS to decrypt rather than
 *     returning plausible-looking rubbish. The 16-byte tag is appended to the
 *     ciphertext rather than carried in a fourth part, because the two always
 *     travel together and splitting them invites a caller to drop one.
 *   * A fresh 12-byte nonce per call — the size GCM is specified for, and the
 *     reason two encryptions of the same tokens never produce the same string.
 *   * The version prefix exists so a future key rotation or cipher change can
 *     be recognised instead of guessed at.
 *
 * There is no `server-only` import here on purpose: nothing in this module
 * touches a request, and the unit suite has to be able to import it. It is
 * reached only from `connections.ts`, which IS server-only.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 'v1';
const KEY_BYTES = 32;
const NONCE_BYTES = 12;
const TAG_BYTES = 16;

/** The name is in the message because the fix is always "set this variable". */
const MISSING = 'AI_TOKEN_KEY is not set, so the assistant cannot store a connection.';
const WRONG_SIZE = `AI_TOKEN_KEY has to decode to exactly ${KEY_BYTES} bytes. Generate one with: openssl rand -base64 32`;

/**
 * Base64 that survives a round trip.
 *
 * `Buffer.from(value, 'base64')` silently ignores anything it does not
 * recognise, so "not a key at all" decodes to a short buffer rather than
 * failing. Re-encoding and comparing is what turns that into an error.
 */
function decodeBase64(value: string): Buffer | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const bytes = Buffer.from(trimmed, 'base64');
  if (bytes.length === 0) return null;
  // Compare without padding so both `=`-padded and unpadded input is accepted.
  const strip = (text: string) => text.replace(/=+$/, '');
  if (strip(bytes.toString('base64')) !== strip(trimmed)) return null;
  return bytes;
}

function readKey(keyB64: string | undefined): Buffer {
  if (keyB64 === undefined || keyB64.trim() === '') throw new Error(MISSING);
  const bytes = decodeBase64(keyB64);
  if (bytes === null || bytes.length !== KEY_BYTES) throw new Error(WRONG_SIZE);
  return bytes;
}

/**
 * Whether the assistant may run at all.
 *
 * The feature is gated on the key rather than on a separate flag: without a key
 * there is nowhere to put a connection, so an enabled-but-keyless deployment
 * would only be able to fail later and less clearly.
 */
export function aiEnabled(): boolean {
  try {
    readKey(process.env.AI_TOKEN_KEY);
    return true;
  } catch {
    return false;
  }
}

export function encryptJson(value: unknown, keyB64 = process.env.AI_TOKEN_KEY): string {
  const key = readKey(keyB64);
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(value), 'utf8')),
    cipher.final(),
    cipher.getAuthTag(),
  ]);
  return `${VERSION}.${nonce.toString('base64')}.${body.toString('base64')}`;
}

export function decryptJson<T>(payload: string, keyB64 = process.env.AI_TOKEN_KEY): T {
  const key = readKey(keyB64);
  const parts = payload.split('.');
  if (parts.length !== 3) throw new Error('That stored connection is not in a shape this build can read.');

  const [version, nonceB64, bodyB64] = parts;
  if (version !== VERSION) throw new Error(`Unknown stored connection version "${version}".`);

  const nonce = decodeBase64(nonceB64);
  const body = decodeBase64(bodyB64);
  if (nonce === null || nonce.length !== NONCE_BYTES) throw new Error('That stored connection has no usable nonce.');
  if (body === null || body.length <= TAG_BYTES) throw new Error('That stored connection has no usable ciphertext.');

  const tag = body.subarray(body.length - TAG_BYTES);
  const ciphertext = body.subarray(0, body.length - TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  // `final()` throws when the tag does not verify, which is the whole point.
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString('utf8')) as T;
}
