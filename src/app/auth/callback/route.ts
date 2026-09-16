/**
 * Google sign-in callback.
 *
 * Like `/auth/confirm`, this is a state-changing GET because a provider
 * redirect is necessarily a GET, and it is scoped just as narrowly:
 *
 *   - The only parameter read is `code`. There is still no `next` or
 *     `redirect_to` in the URL, so there is no open redirect and no way to
 *     steer the flow by editing it. The destination is one of this
 *     application's own landings, chosen from the account's roles once
 *     linking succeeds, and the app group's layout then routes the session by
 *     what the DATABASE says the account is — waiting for approval, declined,
 *     deactivated or active.
 *   - There are two exceptions, and neither travels through the URL either.
 *     The phone scanner: `signInWithGoogleAction` writes an httpOnly cookie
 *     holding a path it has already checked against `isScanPath`; this route
 *     reads it, checks it AGAIN, clears it, and will go nowhere but
 *     `/scan/<uuid>` on this origin. A cookie an attacker could plant is
 *     still only able to name that one shape of page, which is a page of this
 *     application that shows the visitor's own pairing or nothing at all.
 *     And adding Google to an account that already exists:
 *     `addGoogleIdentityAction` writes a one-use httpOnly FLAG, which names no
 *     path at all. It selects one constant — `LINK_RETURN_PATH`, this
 *     application's own settings screen — and only on the `existing` outcome,
 *     which is the only outcome a link from inside an account can have.
 *   - The code is exchanged immediately and the browser is redirected to a
 *     clean URL, so the credential does not linger in history or leak through a
 *     Referer header (also suppressed below).
 *   - Linking is done by `app_trusted_link_identity`, which is executable by
 *     the service role alone. It reads auth.users/auth.identities itself rather
 *     than trusting anything passed in, and it is the only thing that decides
 *     whether a verified address becomes an account, a request, or nothing.
 *
 * Any failure ends the session. A half-signed-in browser holding a provider
 * session with no helpdesk account is exactly the state that produces confusing
 * "why can I see nothing" reports, so it is never left behind.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { appOrigin, publicSupabaseConfig } from '@/lib/supabase/config';
import { adminClient } from '@/lib/supabase/admin';
import { isScanPath, SCAN_NEXT_COOKIE } from '@/lib/scan/relay';
import { landingPath, normalizeRoles } from '@/lib/auth/roles';
import { LINK_RETURN_COOKIE, LINK_RETURN_PATH } from '@/lib/auth/link-return';

type LinkOutcome = 'existing' | 'invited' | 'requested' | 'unverified';

/**
 * `app_trusted_link_identity` raising `access_requests_full`, as PostgREST
 * reports it. Fifty outstanding requests is the bound; see
 * 20260914101400_m5_access_request_cap.sql.
 */
const REQUESTS_FULL = 'P9003';

function failure(reason: string): NextResponse {
  const url = new URL('/login', appOrigin());
  url.searchParams.set('oauthError', reason);
  const response = NextResponse.redirect(url);
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('Cache-Control', 'no-store');
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const code = request.nextUrl.searchParams.get('code');

  // A provider error (including "provider is not enabled") comes back here with
  // no code at all. Fail closed and say nothing about any account.
  if (!code || code.length < 16 || code.length > 1024) {
    return failure('1');
  }

  // Where the sign-in was headed before it was interrupted. Checked here, not
  // trusted from the cookie: the same allow-list the action applied on the way
  // out, applied again on the way in. This still wins over anything the
  // account's roles would otherwise pick.
  const asked = request.cookies.get(SCAN_NEXT_COOKIE)?.value;
  const scanLanding = isScanPath(asked) ? asked : null;

  // Whether this arrival is somebody adding Google from Settings rather than
  // signing in. A flag, not a path: see `link-return.ts`. The scanner still
  // wins, because a phone that was opening a pairing has somewhere to be.
  const linkReturn = request.cookies.get(LINK_RETURN_COOKIE)?.value === '1';

  // Use the configured origin: Next can normalize request.url from 127.0.0.1 to
  // localhost, which would strand host-only session cookies. Session cookies
  // are attached to the exact redirect response that is returned. '/queue' is
  // only the placeholder used while the session is still being established;
  // an ordinary sign-in is re-routed by role below.
  const response = NextResponse.redirect(new URL(scanLanding ?? '/queue', appOrigin()));
  // One sign-in, one use: cleared whether or not they were honoured.
  response.cookies.delete(SCAN_NEXT_COOKIE);
  response.cookies.delete(LINK_RETURN_COOKIE);
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('Cache-Control', 'no-store');

  const config = publicSupabaseConfig();
  const supabase = createServerClient(config.url, config.anonKey, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookies) => {
        for (const { name, value, options } of cookies) {
          request.cookies.set(name, value);
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  const fail = (reason: string) => {
    const redirect = failure(reason);
    // Carry the cookie writes made during exchange and sign-out, so the browser
    // is left holding no session rather than a stale one.
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    return redirect;
  };

  const { data, error } = await supabase.auth.exchangeCodeForSession(code);
  if (error || !data.user || !data.session) {
    return fail('1');
  }

  const { data: linked, error: linkError } = await adminClient().rpc('app_trusted_link_identity', {
    p_user: data.user.id,
  });

  // The function raises rather than returning a row for an unknown user, when
  // the address already belongs to a different auth user, and when the waiting
  // list is full. The full list is the one refusal worth its own sentence,
  // because the person can do nothing but wait and an administrator can fix it
  // in a minute; everything else is one failed sign-in with one message.
  if (linkError) {
    await supabase.auth.signOut();
    const full =
      linkError.code === REQUESTS_FULL || linkError.message?.includes('access_requests_full');
    return fail(full ? 'full' : '1');
  }

  const outcome = (Array.isArray(linked) ? linked[0]?.outcome : undefined) as
    | LinkOutcome
    | undefined;

  if (outcome === 'unverified') {
    await supabase.auth.signOut();
    return fail('unverified');
  }
  if (outcome !== 'existing' && outcome !== 'invited' && outcome !== 'requested') {
    await supabase.auth.signOut();
    return fail('1');
  }

  // The same redirect, to one of this application's own paths, carrying the
  // cookie writes made during the exchange.
  const landing = (path: string): NextResponse => {
    const redirected = NextResponse.redirect(new URL(path, appOrigin()));
    for (const cookie of response.cookies.getAll()) redirected.cookies.set(cookie);
    redirected.headers.set('Referrer-Policy', 'no-referrer');
    redirected.headers.set('Cache-Control', 'no-store');
    return redirected;
  };

  // Somebody adding Google to the account they are already signed in to. The
  // outcome is `existing` because the account was here before the identity was;
  // any other outcome means this was not the link it claimed to be, and it is
  // routed as an ordinary sign-in instead.
  if (linkReturn && scanLanding === null && outcome === 'existing') {
    return landing(LINK_RETURN_PATH);
  }

  // An account now exists for this identity in one of five states. Whether it
  // may be here at all — pending, denied, unlinked — is still the app layout's
  // decision, made from its own app_my_account() read. This is only choosing
  // between the two landings an account with a decided set of roles gets: a
  // skills officer with no queue should not land in one just to be bounced to
  // /people a moment later.
  if (scanLanding === null) {
    const { data: rows } = await supabase.rpc('app_my_account');
    const row = Array.isArray(rows) ? (rows[0] as { roles?: unknown } | undefined) : undefined;
    const destination = landingPath(normalizeRoles(row?.roles));
    if (destination !== '/queue') return landing(destination);
  }

  return response;
}
