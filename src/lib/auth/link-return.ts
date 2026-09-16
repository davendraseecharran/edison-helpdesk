/**
 * The one hint the OAuth callback accepts about where a link started.
 *
 * `/auth/callback` reads exactly one query parameter — `code` — on purpose:
 * with no `next` in the URL there is nothing for an attacker to edit, and the
 * destination is chosen by this application from the account's own roles. That
 * is still right for a sign-in. Adding a Google identity from Settings is not a
 * sign-in, though: the person is already at their desk inside the application,
 * and landing them on the queue with nothing said is the one outcome that looks
 * like the link did not work.
 *
 * So the same shape the phone scanner uses carries the fact: an httpOnly cookie
 * set by the server action, read and cleared by the callback. It names no path.
 * It is a flag, and the destination it selects is the constant below — this
 * application's own settings screen and nothing else — so a cookie somebody
 * plants can do no more than send their own browser to their own settings.
 */

export const LINK_RETURN_COOKIE = 'edison-link-return';

/** The only destination the cookie can select. */
export const LINK_RETURN_PATH = '/settings?linked=1';
