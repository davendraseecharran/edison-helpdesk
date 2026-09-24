'use server';

/**
 * Everything that changes a form, and the kiosk's two calls.
 *
 * Every write is one of the SECURITY DEFINER functions on the signed-in
 * user's own client, so who may do what is the database's to decide. The
 * builder's autosave does not go through `callRpc`: that helper revalidates
 * the whole layout, and a page re-rendered on every keystroke's save is a page
 * that is always a little behind the person typing in it.
 */

import QRCode from 'qrcode';
import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';
import { appOrigin } from '@/lib/supabase/config';
import type { ActionResult } from '@/lib/data/actions';
import { callRpc } from '@/lib/data/rpc';
import { loadForm, logFormExport } from '@/lib/data/forms';
import {
  ANSWERS_MAX_BYTES,
  FORM_TEMPLATES,
  stringMap,
  templateFields,
  type Answers,
  type EventChoice,
  type FormField,
  type FormSettingsInput,
  type FormShareResult,
  type FormTemplateKey,
  type KioskIdentifyResult,
  type SubmitResult,
} from '@/lib/domain/forms';

const SESSION_ENDED = 'Your session is not able to make changes. Sign in again.';

export async function createFormAction(template: FormTemplateKey, title: string): Promise<ActionResult> {
  const chosen = FORM_TEMPLATES.find((entry) => entry.key === template) ?? FORM_TEMPLATES[2];
  return callRpc(
    'app_create_form',
    {
      p_title: title.trim() || chosen.title,
      p_description: chosen.description,
      p_fields: templateFields(chosen),
      p_audience: chosen.audience,
    },
    'Form created.',
  );
}

/** The builder's autosave. No toast and no refresh: the status line is the answer. */
export async function saveFormAction(
  id: string,
  title: string,
  description: string,
  fields: FormField[],
): Promise<ActionResult> {
  const actor = await loadActor();
  if (actor.kind !== 'active') return { ok: false, error: SESSION_ENDED };
  const supabase = await createClient();
  const { error } = await supabase.rpc('app_save_form', {
    p_form: id,
    p_title: title,
    p_description: description,
    p_fields: fields,
  });
  if (error) return { ok: false, error: error.message };
  return { ok: true };
}

export async function saveFormSettingsAction(id: string, settings: FormSettingsInput): Promise<ActionResult> {
  return callRpc(
    'app_save_form_settings',
    {
      p_form: id,
      p_is_open: settings.isOpen,
      p_closes_at: settings.closesAt,
      p_response_cap: settings.responseCap,
      p_audience: settings.audience,
      p_group: settings.groupId,
      p_event: settings.eventId,
      p_shared: settings.shared,
    },
    'Settings saved.',
  );
}

export async function setFormOpenAction(id: string, open: boolean): Promise<ActionResult> {
  return callRpc(
    'app_set_form_open',
    { p_form: id, p_open: open },
    open ? 'Form opened. It takes responses again.' : 'Form closed. It takes no new responses.',
  );
}

export async function deleteFormAction(id: string): Promise<ActionResult> {
  return callRpc('app_delete_form', { p_form: id }, 'Form deleted.');
}

export async function deleteFormResponseAction(responseId: string): Promise<ActionResult> {
  return callRpc('app_delete_form_response', { p_response: responseId }, 'Response deleted.');
}

/**
 * The public link and its QR code, drawn on the server so `qrcode` stays out
 * of the browser bundle — the same arrangement as the scan pairing.
 */
export async function formShareAction(id: string): Promise<FormShareResult> {
  const actor = await loadActor();
  if (actor.kind !== 'active') return { ok: false, error: SESSION_ENDED };
  const form = await loadForm(id);
  if (!form) return { ok: false, error: 'There is no form at this address.' };
  const url = new URL(`/f/${form.slug}`, appOrigin()).toString();
  const qrSvg = await QRCode.toString(url, { type: 'svg', margin: 0, errorCorrectionLevel: 'M' });
  return { ok: true, url, qrSvg, kioskPath: `/kiosk/forms/${form.id}` };
}

/** Records a copy for Google Sheets before the page puts it on the clipboard. */
export async function logFormCopyAction(id: string, count: number): Promise<boolean> {
  const actor = await loadActor();
  if (actor.kind !== 'active') return false;
  return logFormExport(id, 'copy', count);
}

/** A group's events, for the settings picker once a group is chosen. */
export async function groupEventsAction(groupId: string): Promise<EventChoice[]> {
  const actor = await loadActor();
  if (actor.kind !== 'active' || groupId === '') return [];
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_list_group_events', { p_group: groupId });
  if (error || !Array.isArray(data)) return [];
  return (data as Array<Record<string, unknown>>).map((row) => ({
    id: String(row.id),
    name: String(row.name),
    heldOn: String(row.held_on),
  }));
}

// ---------------------------------------------------------------------------
// The kiosk
// ---------------------------------------------------------------------------

export async function kioskIdentifyAction(formId: string, key: string): Promise<KioskIdentifyResult> {
  const actor = await loadActor();
  if (actor.kind !== 'active') return { outcome: 'error', message: SESSION_ENDED };
  const value = key.trim();
  if (value === '') return { outcome: 'no_match', message: 'Scan your ID or type your OSIS.' };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_form_kiosk_identify', { p_form: formId, p_key: value });
  if (error || !data || typeof data !== 'object') {
    return { outcome: 'error', message: error?.message ?? 'That did not go through. Try again.' };
  }
  const row = data as Record<string, unknown>;
  if (row.outcome === 'match' && typeof row.requester_id === 'string') {
    return {
      outcome: 'match',
      requesterId: row.requester_id,
      firstName: typeof row.first_name === 'string' ? row.first_name : '',
      already: row.already === true,
      prefill: stringMap(row.prefill),
      masked: stringMap(row.masked),
    };
  }
  if (row.outcome === 'closed') return { outcome: 'closed', message: 'This form is closed.' };
  if (row.outcome === 'ambiguous') {
    return { outcome: 'ambiguous', message: 'More than one person matches. Scan your ID or type your OSIS.' };
  }
  return { outcome: 'no_match', message: 'We could not find that ID. Try again, or ask at the table.' };
}

export async function kioskSubmitAction(
  formId: string,
  requesterId: string | null,
  answers: Answers,
): Promise<SubmitResult> {
  const actor = await loadActor();
  if (actor.kind !== 'active') return { ok: false, reason: 'error', message: SESSION_ENDED };
  if (JSON.stringify(answers).length > ANSWERS_MAX_BYTES) {
    return { ok: false, reason: 'invalid', message: 'Those answers are too long to take.' };
  }
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_form_kiosk_submit', {
    p_form: formId,
    p_requester: requesterId,
    p_answers: answers,
  });
  if (error) return { ok: false, reason: 'invalid', message: error.message };
  const row = (data ?? {}) as Record<string, unknown>;
  return {
    ok: true,
    updated: row.updated === true,
    firstName: typeof row.first_name === 'string' ? row.first_name : null,
  };
}
