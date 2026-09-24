'use server';

/**
 * Google Forms in, and a sheet of responses in.
 *
 * Reading a link is the one place the helpdesk fetches a page somebody named,
 * and it does so through `fetchGoogleFormDraft`, which only ever asks Google's
 * own form addresses, rebuilt from the id. Everything that writes is one of
 * the SECURITY DEFINER functions on the signed-in user's own client:
 * `app_create_form`, `app_match_form_respondents`, `app_import_form_responses`.
 */

import { revalidatePath } from 'next/cache';
import { createClient } from '@/lib/supabase/server';
import { loadActor } from '@/lib/auth/session';
import type { ActionResult } from '@/lib/data/actions';
import { callRpc } from '@/lib/data/rpc';
import { fetchGoogleFormDraft } from '@/lib/google-forms/fetch';
import { readImportInput, type GoogleReadResult } from '@/lib/domain/google-forms';
import {
  RESPONSE_IMPORT_BATCH,
  type ResponseBatchResult,
  type ResponsePayload,
  type RowIdentity,
  type RowMatch,
} from '@/lib/domain/form-response-import';
import type { FormAudience, FormField } from '@/lib/domain/forms';

const SESSION_ENDED = 'Your session is not able to make changes. Sign in again.';

/** A pasted Google Form link or the script's JSON, read into a draft. */
export async function readGoogleFormAction(pasted: string): Promise<GoogleReadResult> {
  const actor = await loadActor();
  if (actor.kind !== 'active') return { ok: false, reason: 'invalid', message: SESSION_ENDED };
  const input = readImportInput(typeof pasted === 'string' ? pasted.slice(0, 400_000) : '');
  if (input.kind === 'draft') return { ok: true, draft: input.draft };
  if (input.kind === 'unreadable') return { ok: false, reason: 'invalid', message: input.message };
  return fetchGoogleFormDraft(input.link);
}

export async function createImportedFormAction(form: {
  title: string;
  description: string;
  audience: FormAudience;
  fields: FormField[];
}): Promise<ActionResult> {
  return callRpc(
    'app_create_form',
    {
      p_title: form.title,
      p_description: form.description,
      p_fields: form.fields,
      p_audience: form.audience === 'anyone' ? 'anyone' : 'directory',
    },
    'Form imported. Check the questions, then share it.',
  );
}

/** Who each row names, for the preview. Null when the lookup was refused. */
export async function matchRespondentsAction(formId: string, rows: RowIdentity[]): Promise<RowMatch[] | null> {
  const actor = await loadActor();
  if (actor.kind !== 'active' || !Array.isArray(rows)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_match_form_respondents', {
    p_form: formId,
    p_rows: rows.slice(0, 1000).map((row) => ({
      email: row.email,
      external_id: row.external_id,
      name: row.name,
    })),
  });
  if (error || !Array.isArray(data)) return null;
  return (data as Array<Record<string, unknown>>).map((row) => ({
    state: row.state === 'match' ? 'match' : row.state === 'ambiguous' ? 'ambiguous' : 'none',
    personId: typeof row.person_id === 'string' ? row.person_id : null,
    displayName: typeof row.display_name === 'string' ? row.display_name : null,
  }));
}

/** One batch of rows, already read and checked by the dialog. */
export async function importResponsesAction(formId: string, rows: ResponsePayload[]): Promise<ResponseBatchResult> {
  if (!Array.isArray(rows) || rows.length === 0) return { ok: false, error: 'There are no rows to import.', rows: [] };
  if (rows.length > RESPONSE_IMPORT_BATCH) {
    return { ok: false, error: `Import at most ${RESPONSE_IMPORT_BATCH} rows at a time.`, rows: [] };
  }
  const actor = await loadActor();
  if (actor.kind !== 'active') return { ok: false, error: SESSION_ENDED, rows: [] };

  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_import_form_responses', { p_form: formId, p_rows: rows });
  if (error) return { ok: false, error: error.message, rows: [] };

  revalidatePath('/', 'layout');
  return {
    ok: true,
    rows: (Array.isArray(data) ? (data as Array<Record<string, unknown>>) : []).map((row) => ({
      index: Number(row.row_index),
      outcome:
        row.outcome === 'made' || row.outcome === 'updated' || row.outcome === 'skipped' ? row.outcome : 'refused',
      message: typeof row.message === 'string' ? row.message : null,
    })),
  };
}
