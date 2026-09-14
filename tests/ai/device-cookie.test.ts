import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

/**
 * `startCodexAuthAction` / `pollCodexAuthAction`, exercised through the real
 * seal/open above. The only way to reach them is `cookies()`, which needs a
 * live request outside a test, so `next/headers` is swapped for an in-memory
 * jar; everything else the module touches on the way (the session, the Codex
 * HTTP calls) is stubbed.
 */
const cookieJar = vi.hoisted(() => new Map<string, string>());
const startDeviceAuthMock = vi.hoisted(() => vi.fn());
const pollDeviceAuthMock = vi.hoisted(() => vi.fn());

vi.mock('server-only', () => ({}));

vi.mock('next/headers', () => ({
  cookies: async () => ({
    get: (name: string) =>
      cookieJar.has(name) ? { name, value: cookieJar.get(name) as string } : undefined,
    set: (name: string, value: string) => {
      cookieJar.set(name, value);
    },
    delete: (name: string) => {
      cookieJar.delete(name);
    },
  }),
}));

vi.mock('../../src/lib/auth/session', () => ({
  activeAccount: async () => ({
    id: ACCOUNT,
    displayName: 'Pat Example',
    email: 'pat@edison.example',
    role: 'technician',
    status: 'active',
    credentialActionPending: false,
    sessionIsCurrent: true,
  }),
}));

vi.mock('../../src/lib/supabase/server', () => ({
  createClient: async () => {
    throw new Error('not used by the device-auth actions under test');
  },
}));

vi.mock('../../src/lib/ai/codex-auth', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/lib/ai/codex-auth')>();
  return { ...actual, startDeviceAuth: startDeviceAuthMock, pollDeviceAuth: pollDeviceAuthMock };
});

const { pollCodexAuthAction, startCodexAuthAction } = await import('../../src/lib/ai/ai-actions');

describe('the device auth actions', () => {
  beforeEach(() => {
    cookieJar.clear();
    startDeviceAuthMock.mockReset();
    pollDeviceAuthMock.mockReset();
    vi.stubEnv('AI_TOKEN_KEY', KEY);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('starts a pairing and returns no device auth id for the browser to hold', async () => {
    startDeviceAuthMock.mockResolvedValue({
      deviceAuthId: 'server-issued-id',
      userCode: 'ABCD-1234',
      intervalSeconds: 5,
      verifyUrl: 'https://chatgpt.com/codex/device',
    });

    const result = await startCodexAuthAction();

    expect(result.ok).toBe(true);
    expect(result.start?.deviceAuthId).toBe('');
  });

  it('ignores a client-supplied device id when polling; the cookie decides', async () => {
    startDeviceAuthMock.mockResolvedValue({
      deviceAuthId: 'server-issued-id',
      userCode: 'ABCD-1234',
      intervalSeconds: 5,
      verifyUrl: 'https://chatgpt.com/codex/device',
    });
    pollDeviceAuthMock.mockResolvedValue({ status: 'pending' });

    await startCodexAuthAction();
    // pollCodexAuthAction no longer even accepts an id from the caller; the
    // cookie `startCodexAuthAction` just wrote is what pollDeviceAuth sees.
    const polled = await pollCodexAuthAction('ABCD-1234');

    expect(polled).toEqual({ ok: true, status: 'pending' });
    expect(pollDeviceAuthMock).toHaveBeenCalledWith('server-issued-id', 'ABCD-1234');
  });
});
