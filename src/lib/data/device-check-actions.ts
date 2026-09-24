'use server';

/**
 * The device check and the label printer, from the browser's side.
 *
 * Reads only, as the signed-in person. Like the scan loop's per-beep actions,
 * none of these revalidates anything: nothing changed, and a check is asked
 * as fast as a scanner beeps.
 */

import { loadActor } from '@/lib/auth/session';
import {
  checkCode,
  checkDeviceById,
  loadLabelDevices,
  loadLabelDevicesByCodes,
  type CodesResult,
} from '@/lib/data/device-check';
import type { CheckResult } from '@/lib/domain/device-check';
import { LABEL_DEVICE_CAP, type LabelDevice } from '@/lib/labels/layout';

const SIGNED_OUT = 'Sign in again to read the inventory.';

export async function checkDeviceAction(code: string): Promise<CheckResult> {
  const actor = await loadActor();
  if (actor.kind !== 'active') return { kind: 'error', code, message: SIGNED_OUT };
  try {
    return await checkCode(code.slice(0, 200));
  } catch {
    return { kind: 'error', code, message: 'That did not reach the helpdesk. Scan it again.' };
  }
}

/** The same card for a machine already chosen: after a choice of two, or after changing it. */
export async function checkDeviceByIdAction(id: string): Promise<CheckResult> {
  const actor = await loadActor();
  if (actor.kind !== 'active') return { kind: 'error', code: id, message: SIGNED_OUT };
  try {
    return await checkDeviceById(id);
  } catch {
    return { kind: 'error', code: id, message: 'That did not reach the helpdesk. Try again.' };
  }
}

export async function labelDevicesAction(ids: string[]): Promise<LabelDevice[]> {
  const actor = await loadActor();
  if (actor.kind !== 'active') return [];
  return loadLabelDevices(ids.slice(0, LABEL_DEVICE_CAP));
}

export async function labelDevicesByCodesAction(codes: string[]): Promise<CodesResult> {
  const actor = await loadActor();
  if (actor.kind !== 'active') return { found: [], unknown: codes, ambiguous: [] };
  return loadLabelDevicesByCodes(codes.slice(0, LABEL_DEVICE_CAP).map((code) => code.slice(0, 200)));
}
