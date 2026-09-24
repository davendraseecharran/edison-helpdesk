import 'server-only';

import { createClient } from '@/lib/supabase/server';
import { parseSummary, type WeeklySummary } from '@/lib/domain/summary';

/** The caller's week in review, or null when it could not be read. */
export async function loadWeeklySummary(weekStart: string | null): Promise<WeeklySummary | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_weekly_summary', { p_week_start: weekStart });
  if (error) {
    console.error(`app_weekly_summary failed (${error.code ?? 'no code'})`);
    return null;
  }
  return parseSummary(data);
}

/** Whether this account gets the Monday email. Default on; the row may not exist yet. */
export async function loadWeeklySummaryEmail(): Promise<boolean> {
  const supabase = await createClient();
  const { data } = await supabase.from('account_preferences').select('weekly_summary_email').maybeSingle();
  const value = (data as { weekly_summary_email?: unknown } | null)?.weekly_summary_email;
  return typeof value === 'boolean' ? value : true;
}

/** Whether this deployment can send mail at all (Resend key and a sender). */
export function mailConfigured(): boolean {
  return Boolean(process.env.RESEND_API_KEY && process.env.MAIL_FROM);
}
