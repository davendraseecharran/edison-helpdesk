import 'server-only';

/**
 * Outbound mail, over Resend's HTTP API.
 *
 * Two rules shape this module:
 *
 *   1. It never throws. Email is a convenience here, not a security control —
 *      an invite is a row in the database, not a link in a message — so a
 *      missing key or a provider outage must degrade to "copy this text and
 *      send it yourself", never to a failed administrative action.
 *   2. It never logs, returns or otherwise exposes the API key. The failure
 *      messages it does return come from the provider's response body, which
 *      contains no credential.
 *
 * No SDK: one fetch to one documented endpoint is smaller than a dependency.
 */

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export type MailResult =
  | { ok: true }
  | { ok: false; reason: 'not_configured' | 'failed'; message?: string };

const ENDPOINT = 'https://api.resend.com/emails';
const TIMEOUT_MS = 10_000;

export async function sendMail({ to, subject, text, html }: MailMessage): Promise<MailResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.MAIL_FROM;

  // Not configured is a distinct, expected state: the deployment simply has no
  // mail set up, and the caller shows the message for hand-delivery instead.
  if (!apiKey || !from) return { ok: false, reason: 'not_configured' };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from, to: [to], subject, text, ...(html ? { html } : {}) }),
      signal: controller.signal,
      cache: 'no-store',
    });

    if (response.ok) return { ok: true };

    // Read the body defensively: a gateway error is often not JSON at all.
    let message: string | undefined;
    try {
      const body = (await response.json()) as { message?: string; error?: string } | null;
      message = body?.message ?? body?.error;
    } catch {
      message = undefined;
    }
    return { ok: false, reason: 'failed', message: message ?? `Mail provider returned ${response.status}.` };
  } catch (error) {
    const aborted = error instanceof Error && error.name === 'AbortError';
    return {
      ok: false,
      reason: 'failed',
      message: aborted ? 'The mail provider did not answer in time.' : 'The mail provider could not be reached.',
    };
  } finally {
    clearTimeout(timer);
  }
}
