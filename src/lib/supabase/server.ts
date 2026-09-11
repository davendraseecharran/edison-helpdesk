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
  });
}
