import 'server-only';

/**
 * Authorized reads for forms.
 *
 * Signed-in reads are the SECURITY DEFINER functions on the caller's own
 * client, so a private form that is not theirs is simply not there. The one
 * anonymous read, `loadPublicForm`, goes through a client with no session at
 * all: the public page must see exactly what a stranger sees, even when the
 * person looking at it happens to be signed in.
 */

import { cache } from 'react';
import { createClient as createSupabaseClient } from '@supabase/supabase-js';
import { createClient } from '@/lib/supabase/server';
import { publicSupabaseConfig } from '@/lib/supabase/config';
import {
  fieldsFromJson,
  isFormState,
  responseVia,
  type FormAudience,
  type FormField,
  type FormResponseRow,
  type FormState,
} from '@/lib/domain/forms';

export interface FormSummary {
  id: string;
  slug: string;
  title: string;
  description: string;
  state: FormState;
  audience: FormAudience;
  responseCount: number;
  lastResponseAt: string | null;
  shared: boolean;
  mine: boolean;
  ownerName: string | null;
  groupName: string | null;
  updatedAt: string;
}

export interface FormDetail {
  id: string;
  slug: string;
  title: string;
  description: string;
  fields: FormField[];
  isOpen: boolean;
  closesAt: string | null;
  responseCap: number | null;
  audience: FormAudience;
  groupId: string | null;
  groupName: string | null;
  eventId: string | null;
  eventName: string | null;
  eventHeldOn: string | null;
  shared: boolean;
  mine: boolean;
  canOwn: boolean;
  ownerName: string | null;
  state: FormState;
  responseCount: number;
  updatedAt: string;
}

export interface PublicForm {
  slug: string;
  title: string;
  description: string;
  audience: FormAudience;
  state: FormState;
  closesAt: string | null;
  fields: FormField[];
}

function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function textOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

function audienceOf(value: unknown): FormAudience {
  return value === 'anyone' ? 'anyone' : 'directory';
}

function stateOf(value: unknown): FormState {
  return isFormState(value) ? value : 'closed';
}

export function mapFormDetail(row: Record<string, unknown>): FormDetail {
  return {
    id: text(row.id),
    slug: text(row.slug),
    title: text(row.title),
    description: text(row.description),
    fields: fieldsFromJson(row.fields),
    isOpen: row.is_open === true,
    closesAt: textOrNull(row.closes_at),
    responseCap: typeof row.response_cap === 'number' ? row.response_cap : null,
    audience: audienceOf(row.audience),
    groupId: textOrNull(row.group_id),
    groupName: textOrNull(row.group_name),
    eventId: textOrNull(row.event_id),
    eventName: textOrNull(row.event_name),
    eventHeldOn: textOrNull(row.event_held_on),
    shared: row.shared !== false,
    mine: row.mine === true,
    canOwn: row.can_own === true,
    ownerName: textOrNull(row.owner_name),
    state: stateOf(row.state),
    responseCount: Number(row.response_count ?? 0),
    updatedAt: text(row.updated_at),
  };
}

export async function loadForms(): Promise<FormSummary[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_list_forms');
  if (error || !Array.isArray(data)) return [];
  return (data as Record<string, unknown>[]).map((row) => ({
    id: text(row.id),
    slug: text(row.slug),
    title: text(row.title),
    description: text(row.description),
    state: stateOf(row.state),
    audience: audienceOf(row.audience),
    responseCount: Number(row.response_count ?? 0),
    lastResponseAt: textOrNull(row.last_response_at),
    shared: row.shared !== false,
    mine: row.mine === true,
    ownerName: textOrNull(row.owner_name),
    groupName: textOrNull(row.group_name),
    updatedAt: text(row.updated_at),
  }));
}

/**
 * One form, or null when there is none the caller may see. Memoised for the
 * render pass, so the shared layout and the page under it read it once.
 */
export const loadForm = cache(async (id: string): Promise<FormDetail | null> => {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return null;
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_get_form', { p_form: id });
  if (error || !data || typeof data !== 'object') return null;
  return mapFormDetail(data as Record<string, unknown>);
});

export function mapResponse(row: Record<string, unknown>): FormResponseRow {
  return {
    id: text(row.id),
    requesterId: textOrNull(row.requester_id),
    displayName: textOrNull(row.display_name),
    externalId: textOrNull(row.external_id),
    answers:
      row.answers && typeof row.answers === 'object' && !Array.isArray(row.answers)
        ? (row.answers as Record<string, unknown>)
        : {},
    changed: Array.isArray(row.changed) ? row.changed.map(String) : [],
    via: responseVia(row.via),
    submittedAt: text(row.submitted_at),
    recordedByName: textOrNull(row.recorded_by_name),
  };
}

export async function loadFormResponses(id: string): Promise<FormResponseRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc('app_form_responses', { p_form: id });
  if (error || !Array.isArray(data)) return [];
  return (data as Record<string, unknown>[]).map(mapResponse);
}

/** Records an export before it is served. False means do not serve it. */
export async function logFormExport(id: string, what: 'csv' | 'copy', count: number): Promise<boolean> {
  const supabase = await createClient();
  const { error } = await supabase.rpc('app_log_form_export', {
    p_form: id,
    p_what: what,
    p_count: count,
  });
  return !error;
}

/**
 * A client that is nobody: the anon key and no cookies. The public page and
 * the public actions use it so that what a respondent sees never depends on
 * whether the device happens to hold a helpdesk session.
 */
export function anonymousClient(headers: Record<string, string> = {}) {
  const { url, anonKey } = publicSupabaseConfig();
  return createSupabaseClient(url, anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers },
  });
}

export async function loadPublicForm(slug: string): Promise<PublicForm | null> {
  if (!/^[a-z0-9]{12}$/.test(slug)) return null;
  const { data, error } = await anonymousClient().rpc('app_public_form', { p_slug: slug });
  if (error || !data || typeof data !== 'object') return null;
  const row = data as Record<string, unknown>;
  return {
    slug: text(row.slug),
    title: text(row.title),
    description: text(row.description),
    audience: audienceOf(row.audience),
    state: stateOf(row.state),
    closesAt: textOrNull(row.closes_at),
    fields: fieldsFromJson(row.fields),
  };
}
