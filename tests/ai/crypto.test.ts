import { describe, expect, it } from 'vitest';
import { aiEnabled, decryptJson, encryptJson } from '../../src/lib/ai/crypto';

/**
 * A 32-byte key, written out as base64 the way `openssl rand -base64 32` emits
 * it. Fixed rather than random so a failure is reproducible.
 */
const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');

describe('encryptJson and decryptJson', () => {
  it('round trips an object', () => {
    const value = { accessToken: 'a.b.c', refreshToken: 'r', expiresAt: '2026-09-13T00:00:00.000Z' };
    const payload = encryptJson(value, KEY);
    expect(decryptJson<typeof value>(payload, KEY)).toEqual(value);
  });

  it('writes the documented v1 envelope', () => {
    const payload = encryptJson({ a: 1 }, KEY);
    const parts = payload.split('.');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toBe('v1');
    // 12-byte nonce, 16 bytes of tag appended to the ciphertext.
    expect(Buffer.from(parts[1], 'base64')).toHaveLength(12);
    expect(Buffer.from(parts[2], 'base64').length).toBeGreaterThan(16);
  });

  it('uses a fresh nonce every time, so the same value never repeats', () => {
    expect(encryptJson({ a: 1 }, KEY)).not.toBe(encryptJson({ a: 1 }, KEY));
  });

  it('refuses a payload whose ciphertext was edited', () => {
    const payload = encryptJson({ secret: 'value' }, KEY);
    const [version, iv, body] = payload.split('.');
    const bytes = Buffer.from(body, 'base64');
    bytes[0] ^= 0xff;
    const tampered = `${version}.${iv}.${bytes.toString('base64')}`;
    expect(() => decryptJson(tampered, KEY)).toThrow();
  });

  it('refuses a payload whose nonce was edited', () => {
    const payload = encryptJson({ secret: 'value' }, KEY);
    const [version, iv, body] = payload.split('.');
    const bytes = Buffer.from(iv, 'base64');
    bytes[0] ^= 0xff;
    const tampered = `${version}.${bytes.toString('base64')}.${body}`;
    expect(() => decryptJson(tampered, KEY)).toThrow();
  });

  it('refuses a payload encrypted under a different key', () => {
    const payload = encryptJson({ secret: 'value' }, KEY);
    expect(() => decryptJson(payload, OTHER_KEY)).toThrow();
  });

  it('refuses an unknown envelope version', () => {
    const payload = encryptJson({ a: 1 }, KEY).replace(/^v1\./, 'v2.');
    expect(() => decryptJson(payload, KEY)).toThrow(/version/i);
  });

  it('refuses a payload that is not three parts', () => {
    expect(() => decryptJson('v1.onlytwo', KEY)).toThrow();
  });

  it('refuses a key that is not 32 bytes', () => {
    const short = Buffer.alloc(16, 1).toString('base64');
    expect(() => encryptJson({ a: 1 }, short)).toThrow(/32 bytes/i);
  });

  it('refuses a missing key', () => {
    expect(() => encryptJson({ a: 1 }, undefined)).toThrow(/AI_TOKEN_KEY/);
  });
});

describe('aiEnabled', () => {
  const original = process.env.AI_TOKEN_KEY;

  function withKey(value: string | undefined, run: () => void) {
    if (value === undefined) delete process.env.AI_TOKEN_KEY;
    else process.env.AI_TOKEN_KEY = value;
    try {
      run();
    } finally {
      if (original === undefined) delete process.env.AI_TOKEN_KEY;
      else process.env.AI_TOKEN_KEY = original;
    }
  }

  it('is false with no key', () => {
    withKey(undefined, () => expect(aiEnabled()).toBe(false));
  });

  it('is false with a key that is the wrong length', () => {
    withKey(Buffer.alloc(31, 1).toString('base64'), () => expect(aiEnabled()).toBe(false));
  });

  it('is false with a key that is not base64', () => {
    withKey('not base64 !!!!', () => expect(aiEnabled()).toBe(false));
  });

  it('is true with a 32-byte key', () => {
    withKey(KEY, () => expect(aiEnabled()).toBe(true));
  });
});
