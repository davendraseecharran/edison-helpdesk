import 'server-only';

/**
 * Service-role client. Bypasses row-level security completely.
 *
 * Rules for every use of this module:
 *   1. Only for operations a user cannot perform on their own behalf: creating
 *      an auth user, generating a setup/recovery link, and calling the
 *      `app_trusted_*` functions that are granted to service_role alone.
 *   2. NEVER for reading or writing ticket data. Ticket access must stay with
 *      the user's own JWT so RLS decides visibility, rather than JavaScript
 *      filtering rows the database already handed over.
 *   3. Every caller must first verify a live session and a live admin status
 *      through the database, not from a cookie or a request body.
 */

import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import type { SupabaseClient } from '@supabase/supabase-js';
import { publicSupabaseConfig, serviceRoleKey } from './config';

/**
 * `headers` exists for one caller: the trusted attachment registration, which
 * has to say whether the upload was made by somebody's hands or by their
 * assistant. The database reads `x-edison-via` through `app_request_via()` and
 * stamps the attribution columns from it. It is a LABEL and never a permission:
 * this client already bypasses row-level security, and every caller has already
 * verified the actor through the database.
 */
export function adminClient(headers: Record<string, string> = {}): SupabaseClient {
  const { url } = publicSupabaseConfig();
  return createSupabaseClient(url, serviceRoleKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(Object.keys(headers).length > 0 ? { global: { headers } } : {}),
  });
}
