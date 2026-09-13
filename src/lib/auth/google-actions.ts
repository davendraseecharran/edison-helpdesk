'use server';

/**
 * Google sign-in.
 *
 * This action only starts the flow. It decides nothing about access: the
 * provider proves which address the person controls, and the database decides
 * what that address is worth (an invite, a request awaiting review, or an
 * account that already exists) in `app_trusted_link_identity`, called from
 * `/auth/callback`.
 *
 * The callback URL is built from this application's own configured origin, so a
 * request body or query string can never steer the provider at another host.
 */

import { redirect } from 'next/navigation';
import { createClient } from '@/lib/supabase/server';
import { appOrigin, publicSupabaseConfig } from '@/lib/supabase/config';

/**
 * Is the provider actually turned on for this deployment?
 *
 * `signInWithOAuth` builds its URL locally and never asks, so on a deployment
 * with no Google credentials the browser would be sent to the auth server only
 * to meet a bare 400 page. Asking first costs one local request and turns that
 * dead end into the login page's own notice.
 *
 * Returns null when the question could not be answered, which is treated as
 * "carry on": a flaky probe must not block a sign-in that would have worked.
 */
async function googleProviderEnabled(): Promise<boolean | null> {
  const { url, anonKey } = publicSupabaseConfig();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(new URL('/auth/v1/settings', url), {
      headers: { apikey: anonKey },
      cache: 'no-store',
      signal: controller.signal,
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { external?: Record<string, boolean> };
    const enabled = body.external?.google;
    return typeof enabled === 'boolean' ? enabled : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export async function signInWithGoogleAction(): Promise<never> {
  if ((await googleProviderEnabled()) === false) redirect('/login?oauthError=1');

  const supabase = await createClient();

  const { data, error } = await supabase.auth.signInWithOAuth({
    provider: 'google',
    options: {
      redirectTo: new URL('/auth/callback', appOrigin()).toString(),
      // Always show the account chooser. Shared and lab machines are the normal
      // case here, so silently reusing whichever Google session the browser
      // happens to hold would sign the wrong person in.
      queryParams: { prompt: 'select_account' },
    },
  });

  // The PKCE verifier has been written to a cookie by this point; without a URL
  // there is nothing to send the browser to, and the login page says so.
  if (error || !data?.url) redirect('/login?oauthError=1');

  redirect(data.url);
}
