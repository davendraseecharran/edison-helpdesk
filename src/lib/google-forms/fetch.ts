/**
 * The one network call behind "Import from Google Forms": a public Google
 * Form's page, read by the server.
 *
 * A server that fetches a URL a person pasted is a server that can be pointed
 * at anything, so this is narrow on purpose:
 *
 *   - Only two hosts, and never the pasted text itself. `googleFormLink`
 *     rebuilds an `https://docs.google.com/forms/...` or `https://forms.gle/...`
 *     address from the form's id; nothing else of what was pasted is used.
 *   - Redirects are followed by hand, at most three, and each one is rebuilt
 *     the same way. `forms.gle` may send the request on to a form on
 *     docs.google.com and nowhere else; a redirect to Google's sign-in page is
 *     the answer "this form needs a sign-in", which the screen turns into the
 *     Apps Script route.
 *   - No cookies, no credentials, no referrer. Eight seconds for the whole
 *     chain, three megabytes of page, and the body is read as a stream so a
 *     bigger one is cut off rather than buffered.
 *   - Nothing on the page is run: the JSON is found by bracket counting and
 *     parsed as JSON (`extractLoadData`).
 *
 * Not `server-only`, because the assistant's tool registry imports it and the
 * unit suite imports that; it never runs in a browser, which could not make
 * the request anyway.
 */

import {
  GOOGLE_PAGE_MAX_BYTES,
  draftFromLoadData,
  extractLoadData,
  googleFormLink,
  looksLikeSignIn,
  redirectTarget,
  type FormDraft,
} from '@/lib/domain/google-forms';

export type GoogleFetchResult =
  | { ok: true; draft: FormDraft }
  | { ok: false; reason: 'invalid' | 'signin' | 'not_found' | 'unreadable' | 'too_large' | 'unreachable'; message: string };

const TIMEOUT_MS = 8000;
const MAX_HOPS = 3;

export const GOOGLE_FETCH_MESSAGES = {
  signin:
    'This form needs a Google sign-in, so the helpdesk cannot read it from outside. Use the script below instead.',
  not_found: 'Google says there is no form at that link. Check it is the link people answer the form at.',
  unreadable: 'That page is not a form the helpdesk can read. Use the script below instead.',
  too_large: 'That page is larger than a form. Check the link.',
  unreachable: 'Google did not answer in time. Try again, or use the script below.',
} as const;

async function readCapped(response: Response): Promise<string | null> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (declared > GOOGLE_PAGE_MAX_BYTES) return null;
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > GOOGLE_PAGE_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const joined = new Uint8Array(total);
  let at = 0;
  for (const chunk of chunks) {
    joined.set(chunk, at);
    at += chunk.byteLength;
  }
  return new TextDecoder('utf-8').decode(joined);
}

/**
 * The draft of the form at a pasted link. `fetcher` is the global fetch in
 * production and a stub in the tests.
 */
export async function fetchGoogleFormDraft(
  pasted: string,
  fetcher: typeof fetch = fetch,
): Promise<GoogleFetchResult> {
  const link = googleFormLink(pasted);
  if (!link.ok) return { ok: false, reason: 'invalid', message: link.error };

  const deadline = AbortSignal.timeout(TIMEOUT_MS);
  let url = link.url;
  let fromShortLink = link.short;

  for (let hop = 0; hop <= MAX_HOPS; hop += 1) {
    let response: Response;
    try {
      response = await fetcher(url, {
        method: 'GET',
        redirect: 'manual',
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
        signal: deadline,
        headers: {
          accept: 'text/html',
          'accept-language': 'en-US,en;q=0.8',
          'user-agent': 'Mozilla/5.0 (compatible; EdisonHelpdesk/1.0; form import)',
        },
      });
    } catch {
      return { ok: false, reason: 'unreachable', message: GOOGLE_FETCH_MESSAGES.unreachable };
    }

    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) return { ok: false, reason: 'unreadable', message: GOOGLE_FETCH_MESSAGES.unreadable };
      const next = redirectTarget(location, url);
      if (next.kind === 'signin') return { ok: false, reason: 'signin', message: GOOGLE_FETCH_MESSAGES.signin };
      if (next.kind === 'refused') {
        return {
          ok: false,
          reason: 'invalid',
          message: fromShortLink
            ? 'That forms.gle link does not lead to a Google Form.'
            : 'Google sent the request somewhere other than a form.',
        };
      }
      url = next.url;
      fromShortLink = false;
      continue;
    }

    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: 'not_found', message: GOOGLE_FETCH_MESSAGES.not_found };
    }
    if (response.status === 401 || response.status === 403) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: 'signin', message: GOOGLE_FETCH_MESSAGES.signin };
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return { ok: false, reason: 'unreachable', message: GOOGLE_FETCH_MESSAGES.unreachable };
    }

    let html: string | null;
    try {
      html = await readCapped(response);
    } catch {
      return { ok: false, reason: 'unreachable', message: GOOGLE_FETCH_MESSAGES.unreachable };
    }
    if (html === null) return { ok: false, reason: 'too_large', message: GOOGLE_FETCH_MESSAGES.too_large };

    const data = extractLoadData(html);
    const draft = data === null ? null : draftFromLoadData(data);
    if (draft) return { ok: true, draft };
    if (looksLikeSignIn(html)) return { ok: false, reason: 'signin', message: GOOGLE_FETCH_MESSAGES.signin };
    return { ok: false, reason: 'unreadable', message: GOOGLE_FETCH_MESSAGES.unreadable };
  }

  return { ok: false, reason: 'unreadable', message: GOOGLE_FETCH_MESSAGES.unreadable };
}
