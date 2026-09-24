'use server';

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';
import type { ActionResult } from './actions';

/**
 * Writes last week's notice the first time this account opens the app in a
 * new week, and says whether it did. Never throws: a missed notice is not an
 * error anybody needs to see.
 */
export async function weeklyNudgeAction(): Promise<boolean> {
  try {
    const actor = await loadActor();
    if (actor.kind !== 'active') return false;
    const supabase = await createClient();
    const { data, error } = await supabase.rpc('app_weekly_summary_notify');
    if (error) return false;
    if (data === true) revalidatePath('/', 'layout');
    return data === true;
  } catch {
    return false;
  }
}

export async function setWeeklySummaryEmailAction(on: boolean): Promise<ActionResult> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('app_set_weekly_summary_email', { p_on: on });
  if (error) return { ok: false, error: 'That setting did not save. Try again.' };
  revalidatePath('/settings');
  return { ok: true, message: on ? 'The Monday email is on.' : 'The Monday email is off.' };
}
