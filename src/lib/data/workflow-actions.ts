'use server';

/**
 * The scan loop, from the browser's side.
 *
 * Every call runs as the signed-in person, so the database re-derives the
 * actor, refuses a skills officer and writes both histories exactly as a
 * click does. Nothing here trusts a role from the browser.
 *
 * The per-beep actions deliberately do NOT call `revalidatePath`, which every
 * other inventory action does. A server action that revalidates re-renders the
 * page it was called from, and a cart is thirty beeps a minute; the run page
 * shows the database's own answer for each one, which is newer than any
 * re-render would be. The layout is refreshed once, when the run is finished.
 */

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';
import type { ActionResult } from '@/lib/data/actions';
import { loadWorkflowShortcuts } from '@/lib/data/workflows';
import {
  isWorkflowKind,
  shortcutError,
  type WorkflowKind,
  type WorkflowShortcut,
} from '@/lib/domain/workflows';
import {
  expectedFrom,
  parseScanAnswer,
  personFrom,
  stateFrom,
  type DeviceState,
  type ExpectedDevice,
  type ScanAnswer,
  type WorkflowPerson,
} from '@/lib/workflows/session';

const SIGN_IN_AGAIN = 'Your session is not able to make changes. Sign in again.';
const LOST = 'That did not reach the helpdesk. Nothing changed. Try again.';

export type ScanActionResult = { ok: true; answer: ScanAnswer } | { ok: false; error: string };

/**
 * One code, one job. No `loadActor()` round trip first: this is called once a
 * beep, and the RPC's own gate is the one that counts.
 */
export async function workflowScanAction(
  code: string,
  action: 'move' | 'status' | 'assign' | 'collect' | 'resolve',
  target: Record<string, string>,
): Promise<ScanActionResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_workflow_scan', {
    p_code: code,
    p_action: action,
    p_target: target,
  });
  if (error) return { ok: false, error: error.message || LOST };
  const answer = parseScanAnswer(data);
  return answer ? { ok: true, answer } : { ok: false, error: LOST };
}

export type UndoActionResult = { ok: true; state: DeviceState } | { ok: false; error: string };

export async function workflowUndoAction(
  deviceId: string,
  expect: DeviceState,
  restore: DeviceState,
): Promise<UndoActionResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_workflow_undo', {
    p_device: deviceId,
    p_expect: { location: expect.location, status: expect.status, holderId: expect.holderId },
    p_restore: { location: restore.location, status: restore.status, holderId: restore.holderId },
  });
  if (error) return { ok: false, error: error.message || LOST };
  const state = stateFrom((data as { state?: unknown } | null)?.state);
  return state ? { ok: true, state } : { ok: false, error: LOST };
}

export type LocationDevicesResult = { ok: true; devices: ExpectedDevice[] } | { ok: false; error: string };

/** What the inventory says is in one place. */
export async function workflowLocationDevicesAction(location: string): Promise<LocationDevicesResult> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_workflow_location_devices', { p_location: location });
  if (error) return { ok: false, error: error.message || LOST };
  const devices = (Array.isArray(data) ? data : [])
    .map(expectedFrom)
    .filter((device): device is ExpectedDevice => device !== null);
  return { ok: true, devices };
}

/** A card or a typed OSIS, staff id or email address, to exactly one person. */
export async function workflowFindPersonAction(code: string): Promise<WorkflowPerson | null> {
  if (code.trim() === '') return null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_workflow_find_person', { p_code: code });
  if (error) return null;
  return personFrom(data);
}

export interface FinishedRun {
  kind: WorkflowKind;
  label: string;
  location: string;
  status: string;
  done: number;
  skipped: number;
  errors: number;
  startedAt: string;
}

/**
 * The run, recorded for the hub. The one place the layout is refreshed: every
 * list that shows a machine is stale by the run's worth of changes.
 */
export async function recordWorkflowRunAction(run: FinishedRun): Promise<ActionResult> {
  if (!isWorkflowKind(run.kind)) return { ok: false, error: 'Choose which workflow ran.' };
  const supabase = await createClient();
  const { error } = await supabase.rpc('app_record_workflow_run', {
    p_kind: run.kind,
    p_label: run.label.slice(0, 120),
    p_location: run.location.slice(0, 120),
    p_status: run.status.slice(0, 120),
    p_done: run.done,
    p_skipped: run.skipped,
    p_errors: run.errors,
    p_started_at: run.startedAt,
  });
  revalidatePath('/', 'layout');
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Shortcuts
// ---------------------------------------------------------------------------

export async function listWorkflowShortcutsAction(): Promise<WorkflowShortcut[]> {
  const actor = await loadActor();
  if (actor.kind !== 'active') return [];
  return loadWorkflowShortcuts();
}

export interface ShortcutInput {
  id?: string | null;
  name: string;
  kind: string;
  location: string;
  status: string;
}

export async function saveWorkflowShortcutAction(input: ShortcutInput): Promise<ActionResult> {
  const invalid = shortcutError(input);
  if (invalid) return { ok: false, error: invalid };

  const actor = await loadActor();
  if (actor.kind !== 'active') return { ok: false, error: SIGN_IN_AGAIN };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_save_workflow_shortcut', {
    p_id: input.id ?? null,
    p_name: input.name.trim(),
    p_kind: input.kind,
    p_location: input.location.trim(),
    p_status: input.status.trim(),
    p_position: null,
  });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/workflows');
  const id = (data as { id?: unknown } | null)?.id;
  return {
    ok: true,
    id: typeof id === 'string' ? id : undefined,
    message: input.id ? 'Shortcut saved.' : `Saved as ${input.name.trim()}.`,
  };
}

export async function deleteWorkflowShortcutAction(id: string): Promise<ActionResult> {
  const actor = await loadActor();
  if (actor.kind !== 'active') return { ok: false, error: SIGN_IN_AGAIN };

  const supabase = await createClient();
  const { error } = await supabase.rpc('app_delete_workflow_shortcut', { p_id: id });
  if (error) return { ok: false, error: error.message };

  revalidatePath('/workflows');
  return { ok: true, message: 'Shortcut deleted.' };
}
