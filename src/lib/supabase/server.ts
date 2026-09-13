import 'server-only';

/**
 * Server-side Supabase client bound to the request's cookies.
 *
 * Requests made with this client carry the signed-in user's JWT, so row-level
 * security applies exactly as it does for any other caller. Ticket reads and
 * writes must always go through here — never through the service-role client —
 * so the database stays the thing that decides what a user may see.
 */

import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import type { SupabaseClient } from '@supabase/supabase-js';
import { publicSupabaseConfig } from './config';

export async function createClient(): Promise<SupabaseClient> {
  return createClientWithHeaders();
}

/**
 * The same cookie-bound client, with extra headers on every request it makes.
 *
 * This exists for one caller: the assistant's tool executor, which sends
 * `x-edison-via: ai` and `x-edison-ai-model` so the database can record that a
 * change was made through somebody's AI rather than by their hands. It is the
 * SAME client in every other respect — same cookies, same JWT, same row-level
 * security — because attribution must never become a way to widen access. The
 * headers say how a change was made; the session still says who made it, and
 * `app_request_via()` fails closed to 'user' for anything it does not recognise.
 */
export async function createClientWithHeaders(
  headers: Record<string, string> = {},
): Promise<SupabaseClient> {
  const { url, anonKey } = publicSupabaseConfig();
  const cookieStore = await cookies();

  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component, where cookies are read-only. The
          // proxy refreshes sessions, so ignoring this is safe and expected.
        }
      },
    },
    ...(Object.keys(headers).length > 0 ? { global: { headers } } : {}),
  });
}
