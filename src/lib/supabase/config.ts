/**
 * Supabase configuration, validated once with a clear setup error.
 *
 * Missing configuration must produce an obvious failure, never a silent
 * fallback to demo data: the M1 prototype's in-memory store is not an
 * authentication fallback and must never stand in for a real backend.
 */

export interface PublicSupabaseConfig {
  url: string;
  anonKey: string;
}

export class ConfigurationError extends Error {
  constructor(missing: string[]) {
    super(
      `Supabase is not configured. Missing: ${missing.join(', ')}.\n` +
        'Copy .env.example to .env.local and fill in the local values from ' +
        '`npm run db:status`, then restart the dev server.',
    );
    this.name = 'ConfigurationError';
  }
}

/**
 * Client-safe configuration. Both values are public by design: the anon key is
 * shipped to the browser and is only useful in combination with row-level
 * security, which is what actually protects the data.
 */
export function publicSupabaseConfig(): PublicSupabaseConfig {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  const missing: string[] = [];
  if (!url) missing.push('NEXT_PUBLIC_SUPABASE_URL');
  if (!anonKey) missing.push('NEXT_PUBLIC_SUPABASE_ANON_KEY');
  if (missing.length > 0) throw new ConfigurationError(missing);

  return { url: url as string, anonKey: anonKey as string };
}

/**
 * Server-only service role key. Never import this from a client component: the
 * key bypasses row-level security entirely.
 */
export function serviceRoleKey(): string {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new ConfigurationError(['SUPABASE_SERVICE_ROLE_KEY']);
  return key;
}

/**
 * Absolute origin used to build auth callback links.
 *
 * Only this origin is ever used as a redirect target, so a setup or recovery
 * link can never be pointed at an attacker-chosen host by a query parameter.
 */
export function appOrigin(): string {
  const configured = process.env.NEXT_PUBLIC_APP_ORIGIN ?? 'http://127.0.0.1:3000';
  return configured.replace(/\/$/, '');
}
