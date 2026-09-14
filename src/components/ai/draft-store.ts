'use client';

/**
 * The message you were typing, kept across the connection round trip.
 *
 * Linking a ChatGPT account means reading a code off the screen, opening
 * chatgpt.com in another tab, typing it, and coming back. Whatever was in the
 * composer has to survive that, or the flow ends with somebody retyping the
 * sentence that sent them there — which is exactly the moment they decide the
 * assistant is not worth it.
 *
 * `sessionStorage`, keyed by account. Session rather than local because a draft
 * is not a document: it belongs to this sitting at this desk, and a half-typed
 * question should not be waiting on the screen a week later. Keyed by account
 * because a shared NetRider machine has several people through it in a day, and
 * one person's half-written question is not another person's business.
 *
 * Every call is wrapped: a browser with storage disabled, a private window, a
 * quota that is full — none of those is a reason for the composer to throw. The
 * failure mode is that a draft is not kept, which is what happened before.
 */

const PREFIX = 'edison.ai.draft.';

/** Long enough for any real question; short enough that storage cannot be filled. */
export const DRAFT_MAX_LENGTH = 4000;

function keyFor(accountId: string): string {
  return `${PREFIX}${accountId}`;
}

/** What this account was typing, or an empty string. Safe on the server. */
export function readDraft(accountId: string): string {
  if (typeof window === 'undefined' || accountId === '') return '';
  try {
    const value = window.sessionStorage.getItem(keyFor(accountId));
    return typeof value === 'string' ? value.slice(0, DRAFT_MAX_LENGTH) : '';
  } catch {
    return '';
  }
}

/** Keeps the draft. An empty draft removes the key rather than storing one. */
export function writeDraft(accountId: string, text: string): void {
  if (typeof window === 'undefined' || accountId === '') return;
  try {
    if (text.trim() === '') window.sessionStorage.removeItem(keyFor(accountId));
    else window.sessionStorage.setItem(keyFor(accountId), text.slice(0, DRAFT_MAX_LENGTH));
  } catch {
    // Storage refused. The draft still lives in the component's own state for
    // as long as this page does; only the round trip loses it.
  }
}

export function clearDraft(accountId: string): void {
  writeDraft(accountId, '');
}
