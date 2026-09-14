import { describe, expect, it } from 'vitest';
import { DEVICE_COOKIE_MAX_AGE, openDeviceAuth, sealDeviceAuth } from '../../src/lib/ai/device-cookie';

/** Fixed 32-byte keys, so a failure is reproducible. */
const KEY = Buffer.alloc(32, 7).toString('base64');
const OTHER_KEY = Buffer.alloc(32, 9).toString('base64');

const ACCOUNT = '11111111-1111-4111-8111-111111111111';
const OTHER_ACCOUNT = '22222222-2222-4222-8222-222222222222';
const ID = 'device-auth-abc123';
const NOW = Date.UTC(2026, 8, 13, 9, 0, 0);

describe('the device auth cookie', () => {
  it('opens to the id it sealed, for the account that sealed it', () => {
    const sealed = sealDeviceAuth(ACCOUNT, ID, NOW, KEY);
    expect(openDeviceAuth(sealed, ACCOUNT, NOW, KEY)).toBe(ID);
  });

  it('never shows the id in the cookie value', () => {
    expect(sealDeviceAuth(ACCOUNT, ID, NOW, KEY)).not.toContain(ID);
  });

  it('refuses a cookie copied into another account’s session', () => {
    const sealed = sealDeviceAuth(ACCOUNT, ID, NOW, KEY);
    expect(openDeviceAuth(sealed, OTHER_ACCOUNT, NOW, KEY)).toBeNull();
  });

  it('refuses a cookie this key did not seal', () => {
    const sealed = sealDeviceAuth(ACCOUNT, ID, NOW, OTHER_KEY);
    expect(openDeviceAuth(sealed, ACCOUNT, NOW, KEY)).toBeNull();
  });

  it('refuses an edited cookie rather than returning rubbish', () => {
    const sealed = sealDeviceAuth(ACCOUNT, ID, NOW, KEY);
    const [version, nonce, body] = sealed.split('.');
    const bytes = Buffer.from(body, 'base64');
    bytes[0] ^= 0xff;
    expect(openDeviceAuth(`${version}.${nonce}.${bytes.toString('base64')}`, ACCOUNT, NOW, KEY)).toBeNull();
  });

  it('refuses a ticket older than the fifteen minutes the code lives', () => {
    const sealed = sealDeviceAuth(ACCOUNT, ID, NOW, KEY);
    const limit = DEVICE_COOKIE_MAX_AGE * 1000;
    expect(openDeviceAuth(sealed, ACCOUNT, NOW + limit, KEY)).toBe(ID);
    expect(openDeviceAuth(sealed, ACCOUNT, NOW + limit + 1, KEY)).toBeNull();
  });

  it('refuses a ticket stamped in the future', () => {
    const sealed = sealDeviceAuth(ACCOUNT, ID, NOW, KEY);
    expect(openDeviceAuth(sealed, ACCOUNT, NOW - 1, KEY)).toBeNull();
  });

  it('refuses no cookie at all', () => {
    expect(openDeviceAuth(undefined, ACCOUNT, NOW, KEY)).toBeNull();
    expect(openDeviceAuth('', ACCOUNT, NOW, KEY)).toBeNull();
    expect(openDeviceAuth('not-an-envelope', ACCOUNT, NOW, KEY)).toBeNull();
  });
});
