/**
 * The Codex device-code sign-in, reimplemented against the open-source CLI.
 *
 * Every endpoint, field name and header below was read from openai/codex at
 * commit 36f0dbe796d9bb1a18a0fc0640ed08b3e1d54564 (main, 2026-09-13):
 *
 *   codex-rs/login/src/device_code_auth.rs
 *     POST {issuer}/api/accounts/deviceauth/usercode  {client_id}
 *          -> {device_auth_id, user_code, interval}   (interval is a STRING)
 *     POST {issuer}/api/accounts/deviceauth/token     {device_auth_id, user_code}
 *          -> 200 {authorization_code, code_challenge, code_verifier}
 *          -> 403 or 404 while the person has not finished in the browser
 *     redirect_uri = {issuer}/deviceauth/callback
 *   codex-rs/login/src/server.rs
 *     DEFAULT_ISSUER = "https://auth.openai.com"
 *     POST {issuer}/oauth/token, form encoded:
 *       grant_type=authorization_code&code=..&redirect_uri=..&client_id=..&code_verifier=..
 *          -> {id_token, access_token, refresh_token}
 *   codex-rs/login/src/auth/manager.rs
 *     CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann"   (line 1724)
 *     REFRESH_TOKEN_URL = "https://auth.openai.com/oauth/token"
 *     refresh: JSON {client_id, grant_type:"refresh_token", refresh_token}
 *          -> {id_token?, access_token?, refresh_token?}
 *   codex-rs/login/src/token_data.rs
 *     id-token claims: "https://api.openai.com/auth" -> {chatgpt_account_id,
 *     chatgpt_plan_type}; the address is the top-level `email`, falling back to
 *     "https://api.openai.com/profile" -> email.
 *
 * NOTE ON PKCE: this flow does NOT generate its own verifier. The device-auth
 * token endpoint hands back the `code_verifier` and `code_challenge` it already
 * bound to the browser session, and the exchange replays the verifier. That is
 * why there is no pkce helper here — inventing one would produce a verifier the
 * authorization code was never issued against.
 *
 * NOTE ON THE VERIFICATION URL: the CLI prints `{issuer}/codex/device`, which
 * is `https://auth.openai.com/codex/device`. The product spec pins the
 * chatgpt.com spelling, which is the address a person is told to type, so that
 * is what `CODEX_DEVICE_VERIFY_URL` holds and what the panel shows.
 */

export const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_AUTH_BASE = 'https://auth.openai.com';
export const CODEX_DEVICE_VERIFY_URL = 'https://chatgpt.com/codex/device';

const DEVICE_API_BASE = `${CODEX_AUTH_BASE}/api/accounts`;
const TOKEN_ENDPOINT = `${CODEX_AUTH_BASE}/oauth/token`;
const REDIRECT_URI = `${CODEX_AUTH_BASE}/deviceauth/callback`;

/** What the CLI falls back to, and the floor this applies to a server value. */
const DEFAULT_POLL_SECONDS = 5;
/** Access tokens come back with an hour of life; this is only the fallback. */
const DEFAULT_LIFETIME_SECONDS = 3600;

export interface CodexTokens {
  accessToken: string;
  refreshToken: string;
  idToken: string;
  /** ISO 8601. When the access token stops being accepted. */
  expiresAt: string;
}

export interface DeviceAuthStart {
  deviceAuthId: string;
  userCode: string;
  intervalSeconds: number;
  verifyUrl: string;
}

export type DeviceAuthPoll = { status: 'pending' } | { status: 'complete'; tokens: CodexTokens };

export interface CodexClaims {
  chatgptAccountId: string | null;
  email: string | null;
  planType: string | null;
}

/** A network failure and a refused request read the same way to the operator. */
export class CodexAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CodexAuthError';
  }
}

/**
 * Codex sends its originator and user agent on every call it makes. Matching
 * them is not a disguise — the account being used IS a ChatGPT account signing
 * in through the published device flow — it is what keeps the request
 * recognisable to the service instead of looking like an anonymous script.
 */
export const CODEX_ORIGINATOR = 'codex_cli_rs';
export const CODEX_USER_AGENT = `${CODEX_ORIGINATOR}/0.0.0 (Edison Helpdesk)`;

function authHeaders(contentType: string): Record<string, string> {
  return {
    'content-type': contentType,
    accept: 'application/json',
    originator: CODEX_ORIGINATOR,
    'user-agent': CODEX_USER_AGENT,
  };
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/** The service answers errors as `{error, error_description}` when it can. */
function describe(status: number, body: string): string {
  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    const detail = parsed.error_description ?? parsed.message ?? parsed.error;
    if (typeof detail === 'string' && detail.trim() !== '') return detail.trim();
  } catch {
    // Not JSON. Fall through to the status, rather than pasting HTML back.
  }
  return `ChatGPT sign-in failed with status ${status}.`;
}

export async function startDeviceAuth(signal?: AbortSignal): Promise<DeviceAuthStart> {
  const response = await fetch(`${DEVICE_API_BASE}/deviceauth/usercode`, {
    method: 'POST',
    headers: authHeaders('application/json'),
    body: JSON.stringify({ client_id: CODEX_CLIENT_ID }),
    signal,
    cache: 'no-store',
  });

  const body = await readBody(response);
  if (!response.ok) {
    if (response.status === 404) {
      throw new CodexAuthError(
        'ChatGPT is not offering device sign-in right now. Try again in a few minutes.',
      );
    }
    throw new CodexAuthError(describe(response.status, body));
  }

  let parsed: { device_auth_id?: unknown; user_code?: unknown; usercode?: unknown; interval?: unknown };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    throw new CodexAuthError('ChatGPT sent a sign-in response this build could not read.');
  }

  const deviceAuthId = typeof parsed.device_auth_id === 'string' ? parsed.device_auth_id : '';
  // The CLI accepts `user_code` or `usercode`; so does this.
  const userCode =
    typeof parsed.user_code === 'string'
      ? parsed.user_code
      : typeof parsed.usercode === 'string'
        ? parsed.usercode
        : '';
  if (deviceAuthId === '' || userCode === '') {
    throw new CodexAuthError('ChatGPT did not send a sign-in code. Try again.');
  }

  // `interval` arrives as a string in the CLI's deserializer, so both shapes are
  // read and anything unusable falls back rather than becoming a busy loop.
  const raw = typeof parsed.interval === 'string' ? Number(parsed.interval.trim()) : parsed.interval;
  const intervalSeconds =
    typeof raw === 'number' && Number.isFinite(raw) && raw > 0
      ? Math.max(DEFAULT_POLL_SECONDS, Math.ceil(raw))
      : DEFAULT_POLL_SECONDS;

  return { deviceAuthId, userCode, intervalSeconds, verifyUrl: CODEX_DEVICE_VERIFY_URL };
}

/**
 * ONE poll. The CLI loops here for fifteen minutes; this returns `pending` and
 * lets the browser drive the next attempt, so no request is held open and a
 * closed panel stops polling by itself.
 */
export async function pollDeviceAuth(
  deviceAuthId: string,
  userCode: string,
  signal?: AbortSignal,
): Promise<DeviceAuthPoll> {
  const response = await fetch(`${DEVICE_API_BASE}/deviceauth/token`, {
    method: 'POST',
    headers: authHeaders('application/json'),
    body: JSON.stringify({ device_auth_id: deviceAuthId, user_code: userCode }),
    signal,
    cache: 'no-store',
  });

  // 403 and 404 are "not finished in the browser yet" in the CLI, not failures.
  if (response.status === 403 || response.status === 404) {
    await readBody(response);
    return { status: 'pending' };
  }

  const body = await readBody(response);
  if (!response.ok) throw new CodexAuthError(describe(response.status, body));

  let parsed: { authorization_code?: unknown; code_verifier?: unknown };
  try {
    parsed = JSON.parse(body) as typeof parsed;
  } catch {
    throw new CodexAuthError('ChatGPT sent a sign-in response this build could not read.');
  }

  const code = typeof parsed.authorization_code === 'string' ? parsed.authorization_code : '';
  const verifier = typeof parsed.code_verifier === 'string' ? parsed.code_verifier : '';
  if (code === '' || verifier === '') {
    throw new CodexAuthError('ChatGPT approved the code but sent nothing to exchange. Try again.');
  }

  return { status: 'complete', tokens: await exchangeCode(code, verifier, signal) };
}

async function exchangeCode(
  code: string,
  codeVerifier: string,
  signal?: AbortSignal,
): Promise<CodexTokens> {
  const form = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: REDIRECT_URI,
    client_id: CODEX_CLIENT_ID,
    code_verifier: codeVerifier,
  });

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: authHeaders('application/x-www-form-urlencoded'),
    body: form.toString(),
    signal,
    cache: 'no-store',
  });

  const body = await readBody(response);
  if (!response.ok) throw new CodexAuthError(describe(response.status, body));
  return tokensFrom(body, null);
}

/**
 * Trades the refresh token for a new access token.
 *
 * The refresh endpoint takes JSON here, not a form — that asymmetry is in the
 * CLI too, and sending the wrong one is answered with a bare 400.
 */
export async function refreshTokens(tokens: CodexTokens, signal?: AbortSignal): Promise<CodexTokens> {
  if (tokens.refreshToken.trim() === '') {
    throw new CodexAuthError('That ChatGPT connection has no refresh token. Connect it again.');
  }

  const response = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: authHeaders('application/json'),
    body: JSON.stringify({
      client_id: CODEX_CLIENT_ID,
      grant_type: 'refresh_token',
      refresh_token: tokens.refreshToken,
    }),
    signal,
    cache: 'no-store',
  });

  const body = await readBody(response);
  if (!response.ok) throw new CodexAuthError(describe(response.status, body));
  // A refresh may return only an access token, so the previous values stand in.
  return tokensFrom(body, tokens);
}

function tokensFrom(body: string, previous: CodexTokens | null): CodexTokens {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(body) as Record<string, unknown>;
  } catch {
    throw new CodexAuthError('ChatGPT sent a token response this build could not read.');
  }

  const text = (key: string): string => (typeof parsed[key] === 'string' ? (parsed[key] as string) : '');
  const accessToken = text('access_token') || previous?.accessToken || '';
  const refreshToken = text('refresh_token') || previous?.refreshToken || '';
  const idToken = text('id_token') || previous?.idToken || '';

  if (accessToken === '' || refreshToken === '') {
    throw new CodexAuthError('ChatGPT did not return a usable token. Connect the account again.');
  }

  return { accessToken, refreshToken, idToken, expiresAt: expiryOf(parsed, accessToken) };
}

/**
 * When the access token stops working.
 *
 * `expires_in` is authoritative when the service sends it; otherwise the `exp`
 * claim on the access token is read, and only failing both does this fall back
 * to an hour. The fallback is deliberately short: guessing long would mean
 * sending a dead token and showing the operator a 401 instead of refreshing.
 */
function expiryOf(parsed: Record<string, unknown>, accessToken: string): string {
  const seconds = parsed.expires_in;
  if (typeof seconds === 'number' && Number.isFinite(seconds) && seconds > 0) {
    return new Date(Date.now() + seconds * 1000).toISOString();
  }

  const claims = jwtClaims(accessToken);
  const exp = claims?.exp;
  if (typeof exp === 'number' && Number.isFinite(exp) && exp > 0) {
    return new Date(exp * 1000).toISOString();
  }

  return new Date(Date.now() + DEFAULT_LIFETIME_SECONDS * 1000).toISOString();
}

/**
 * Reads a JWT's payload WITHOUT verifying it.
 *
 * That is safe here and nowhere else: the token was just received over TLS from
 * the endpoint that issued it, and nothing security-relevant is decided from
 * what it says. The claims are used to label the connection in the panel — an
 * address and a plan name — and the service, not this application, decides what
 * the token may do.
 */
function jwtClaims(jwt: string): Record<string, unknown> | null {
  const parts = jwt.split('.');
  if (parts.length < 2) return null;
  try {
    const json = Buffer.from(parts[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
    const parsed = JSON.parse(json) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

export function claimsFromToken(jwt: string): CodexClaims {
  const empty: CodexClaims = { chatgptAccountId: null, email: null, planType: null };
  const claims = jwtClaims(jwt);
  if (claims === null) return empty;

  const authClaim = claims['https://api.openai.com/auth'];
  const auth =
    authClaim !== null && typeof authClaim === 'object' && !Array.isArray(authClaim)
      ? (authClaim as Record<string, unknown>)
      : {};
  const profileClaim = claims['https://api.openai.com/profile'];
  const profile =
    profileClaim !== null && typeof profileClaim === 'object' && !Array.isArray(profileClaim)
      ? (profileClaim as Record<string, unknown>)
      : {};

  const text = (value: unknown): string | null =>
    typeof value === 'string' && value.trim() !== '' ? value.trim() : null;

  return {
    chatgptAccountId: text(auth.chatgpt_account_id),
    email: text(claims.email) ?? text(profile.email),
    planType: text(auth.chatgpt_plan_type),
  };
}
