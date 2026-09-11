'use client';

/**
 * Browser Supabase client. Used only for interactive auth calls (sign-in,
 * password update, sign-out) where the SDK needs to own the session cookies.
 * Ticket data is never fetched here — it comes from server components and
 * server actions, so nothing authenticated is cached in a shared client bundle.
 */

import { createBrowserClient } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { publicSupabaseConfig } from './config';

let client: SupabaseClient | null = null;

export function browserClient(): SupabaseClient {
  if (client) return client;
  const { url, anonKey } = publicSupabaseConfig();
  client = createBrowserClient(url, anonKey);
  return client;
}
