/**
 * Setup and recovery link callback.
 *
 * This is the one state-changing GET in the application, and it exists because
 * an emailed/handed-over link is necessarily a GET. It is narrowly scoped:
 *
 *   - The only accepted parameter is `token_hash`. There is no `redirect_to`,
 *     `next`, or `type` parameter, so there is no open redirect and no way to
 *     steer the flow by editing the URL. The destination is always this app's
 *     own /set-password page, and the app-level purpose is read from the stored
 *     grant rather than the query string.
 *   - The token is exchanged immediately and the browser is redirected to a
 *     clean URL, so the credential does not linger in history or get forwarded
 *     in a Referer header (also suppressed by the header below).
 *   - Exchanging the link yields a RESTRICTED session: the account is either
 *     still setup_pending, or has credential_action_pending set, and the
 *     database refuses all helpdesk access in both cases until setup completes.
 */

import { NextResponse, type NextRequest } from 'next/server';
import { createHash } from 'node:crypto';
import { createServerClient } from '@supabase/ssr';
import { appOrigin, publicSupabaseConfig } from '@/lib/supabase/config';
import { adminClient } from '@/lib/supabase/admin';

function failure(reason: string): NextResponse {
  const url = new URL('/login', appOrigin());
  url.searchParams.set('linkError', reason);
  const response = NextResponse.redirect(url);
  response.headers.set('Referrer-Policy', 'no-referrer');
  return response;
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const tokenHash = request.nextUrl.searchParams.get('token_hash');
  if (!tokenHash || tokenHash.length < 16 || tokenHash.length > 512) {
    // Malformed or absent: fail closed, and say nothing about any account.
    return failure('invalid');
  }

  // Use the configured link origin: Next can normalize request.url from
  // 127.0.0.1 to localhost, which would strand host-only session cookies.
  // Keep exchanged session cookies on the exact redirect response returned.
  const response = NextResponse.redirect(new URL('/set-password', appOrigin()));
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
    for (const cookie of response.cookies.getAll()) redirect.cookies.set(cookie);
    redirect.headers.set('Cache-Control', 'no-store');
    return redirect;
  };

  // Both setup and recovery links are provider `recovery` tokens; an `invite`
  // link cannot be generated for an already-registered user. Expiry, replay and
  // supersession are all enforced here by the provider.
  const { data, error } = await supabase.auth.verifyOtp({
    type: 'recovery',
    token_hash: tokenHash,
  });

  if (error || !data.user || !data.session) {
    return fail('invalid');
  }

  // Record that the link was exchanged, and read the purpose from the stored
  // grant. An account with no live grant cannot proceed even with a valid
  // provider token, so a link issued outside this flow grants nothing.
  const { data: claims, error: claimsError } = await supabase.auth.getClaims(data.session.access_token);
  if (claimsError || typeof claims?.claims.session_id !== 'string') {
    await supabase.auth.signOut();
    return fail('invalid');
  }
  const { error: verifyError } = await adminClient().rpc('app_trusted_verify_grant', {
    p_account: data.user.id,
    p_digest: createHash('sha256').update(tokenHash).digest('hex'),
    p_session: claims.claims.session_id,
  });
  if (verifyError) {
    await supabase.auth.signOut();
    return fail('expired');
  }

  return response;
}
