'use server';

/**
 * The two things a stranger with a form link can do: say who they are, and
 * send their answers.
 *
 * Both run as NOBODY — the anon key, no cookies — whether or not the device
 * holds a helpdesk session, so the public page behaves the same for a student
 * on their phone and for an officer testing the link on their laptop.
 *
 * The client address is forwarded to the database as `x-edison-client`, where
 * it is hashed before it is counted: the throttle needs to tell callers apart,
 * and nothing needs to know who they were. The honeypot is checked here, and a
 * filled one is answered exactly like a success so a bot learns nothing.
 */

import { headers } from 'next/headers';
import { anonymousClient } from '@/lib/data/forms';
import {
  ANSWERS_MAX_BYTES,
  isRefusalReason,
  refusalMessage,
  stringMap,
  type Answers,
  type IdentifyResult,
  type SubmitResult,
} from '@/lib/domain/forms';

async function clientAddress(): Promise<string> {
  const incoming = await headers();
  const forwarded = incoming.get('x-forwarded-for')?.split(',')[0]?.trim();
  return forwarded || incoming.get('x-real-ip')?.trim() || 'unknown';
}

async function publicClient() {
  return anonymousClient({ 'x-edison-client': await clientAddress() });
}

function refused(reason: unknown): { ok: false; reason: ReturnType<typeof reasonOf>; message: string } {
  const why = reasonOf(reason);
  return { ok: false, reason: why, message: refusalMessage(why) };
}

function reasonOf(value: unknown) {
  return isRefusalReason(value) ? value : 'error';
}

function clean(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

export async function publicIdentifyAction(
  slug: string,
  email: string,
  externalId: string,
  honeypot: string,
): Promise<IdentifyResult> {
  // A filled honeypot is a form nobody read. It gets the same answer a wrong
  // identity does, so there is nothing to learn from filling it.
  if (clean(honeypot, 200) !== '') return refused('no_match');

  const client = await publicClient();
  const { data, error } = await client.rpc('app_public_form_identify', {
    p_slug: clean(slug, 40),
    p_email: clean(email, 320),
    p_external_id: clean(externalId, 80),
  });
  if (error || !data || typeof data !== 'object') return refused('error');

  const row = data as Record<string, unknown>;
  if (row.ok !== true) return refused(row.reason);
  return {
    ok: true,
    firstName: typeof row.first_name === 'string' ? row.first_name : '',
    already: row.already === true,
    prefill: stringMap(row.prefill),
    masked: stringMap(row.masked),
  };
}

export async function publicSubmitAction(
  slug: string,
  email: string,
  externalId: string,
  answers: Answers,
  honeypot: string,
): Promise<SubmitResult> {
  if (clean(honeypot, 200) !== '') return { ok: true, updated: false, firstName: null };

  if (!answers || typeof answers !== 'object' || Array.isArray(answers)) return refused('invalid');
  if (JSON.stringify(answers).length > ANSWERS_MAX_BYTES) {
    return { ok: false, reason: 'invalid', message: 'Those answers are too long to send.' };
  }

  const client = await publicClient();
  const { data, error } = await client.rpc('app_public_form_submit', {
    p_slug: clean(slug, 40),
    p_email: clean(email, 320),
    p_external_id: clean(externalId, 80),
    p_answers: answers,
  });
  if (error) {
    // The database refuses an answer with a sentence naming the question;
    // anything else is a failure the respondent can only retry.
    const sentence = error.code === '23514' ? error.message : refusalMessage('error');
    return { ok: false, reason: 'invalid', message: sentence };
  }
  if (!data || typeof data !== 'object') return refused('error');

  const row = data as Record<string, unknown>;
  if (row.ok !== true) return refused(row.reason);
  return {
    ok: true,
    updated: row.updated === true,
    firstName: typeof row.first_name === 'string' ? row.first_name : null,
  };
}
