import 'server-only';

/**
 * One RPC call as the signed-in user, shaped as an action result.
 *
 * Shared by the directory and inventory actions. `actions.ts` keeps its own
 * private copy because a `'use server'` module may export nothing but actions;
 * this module is plain server code, so the helper can be imported by any of
 * them without becoming an endpoint itself.
 *
 * The actor check is a fast fail for a clearly unusable session; it is NOT the
 * security boundary. Every RPC re-derives identity, status and role inside the
 * database, and the list readers run under the caller's own row policies.
 */

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';
import type { ActionResult } from '@/lib/data/actions';

export async function callRpc(
  fn: string,
  args: Record<string, unknown>,
  message?: string,
): Promise<ActionResult> {
  const actor = await loadActor();
  if (actor.kind !== 'active') {
    return { ok: false, error: 'Your session is not able to make changes. Sign in again.' };
  }

  const supabase = await createClient();
  const { data, error } = await supabase.rpc(fn, args);
  if (error) {
    return { ok: false, error: error.message };
  }

  // Lists, counts and detail pages are all server-rendered, so one refresh
  // keeps every view consistent after a change.
  revalidatePath('/', 'layout');
  return { ok: true, id: typeof data === 'string' ? data : undefined, message };
}
