/**
 * Google sign-in callback.
 *
 * Like `/auth/confirm`, this is a state-changing GET because a provider
 * redirect is necessarily a GET, and it is scoped just as narrowly:
 *
 *   - The only parameter read is `code`. There is no `next` or `redirect_to`,
 *     so there is no open redirect and no way to steer the flow by editing the
 *     URL. The destination is always this application's own /queue, and the app
 *     group's layout then routes the session by what the DATABASE says the
 *     account is — waiting for approval, declined, deactivated or active.
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

type LinkOutcome = 'existing' | 'invited' | 'requested' | 'unverified';

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

  // Use the configured origin: Next can normalize request.url from 127.0.0.1 to
  // localhost, which would strand host-only session cookies. Session cookies
  // are attached to the exact redirect response that is returned.
  const response = NextResponse.redirect(new URL('/queue', appOrigin()));
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

  // The function raises rather than returning a row for an unknown user, and
  // when the address already belongs to a different auth user. Every error is
  // one failed sign-in with one message.
  if (linkError) {
    await supabase.auth.signOut();
    return fail('1');
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

  // An account now exists for this identity in one of five states. Where the
  // person belongs is the app layout's decision, made from app_my_account().
  return response;
}
