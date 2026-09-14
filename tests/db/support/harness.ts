/**
 * Test-side helpers: real signed-in sessions, error assertions, and small
 * builders for arranging ticket state.
 *
 * Every client here is an ordinary anon-key client that has signed in with a
 * password, so requests carry a real user JWT and are subject to RLS exactly as
 * the application will be. The service-role client is used only to arrange
 * identities or to read raw rows when a test needs ground truth.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { inject } from 'vitest';
import type { LocalStack } from './local-only';
import type { IdentityKey, SeededIdentity } from './identities';

export type { IdentityKey, SeededIdentity };

export function stack(): LocalStack {
  return inject('stack');
}

export function identities(): SeededIdentity[] {
  return inject('identities');
}

export function identity(key: IdentityKey): SeededIdentity {
  const found = identities().find((entry) => entry.key === key);
  if (!found) throw new Error(`No seeded identity "${key}"`);
  return found;
}

/** An anonymous client: no session, only the public anon key. */
export function anonClient(): SupabaseClient {
  const local = stack();
  return createClient(local.apiUrl, local.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export function adminServiceClient(): SupabaseClient {
  const local = stack();
  return createClient(local.apiUrl, local.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const sessions = new Map<IdentityKey, SupabaseClient>();

/** Signs in as a synthetic identity and caches the authenticated client. */
export async function signIn(key: IdentityKey): Promise<SupabaseClient> {
  const cached = sessions.get(key);
  if (cached) return cached;

  const person = identity(key);
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({
    email: person.email,
    password: person.password,
  });
  if (error) {
    throw new Error(`Could not sign in as ${key}: ${error.message}`);
  }
  sessions.set(key, client);
  return client;
}

/**
 * A brand-new signed-in client, not shared with other tests. Needed for genuine
 * concurrency (two independent connections) and for proving that an ALREADY
 * open session loses access the moment its account is deactivated.
 */
export async function freshSession(key: IdentityKey): Promise<SupabaseClient> {
  const person = identity(key);
  const client = anonClient();
  const { error } = await client.auth.signInWithPassword({
    email: person.email,
    password: person.password,
  });
  if (error) throw new Error(`Could not sign in as ${key}: ${error.message}`);
  return client;
}

/**
 * A signed-in client whose every request carries extra HTTP headers.
 *
 * PostgREST publishes the request headers to SQL as `request.headers`, which is
 * how the database learns that a call was made on an operator's behalf by an AI
 * assistant. Headers are attached at client construction because supabase-js has
 * no per-call header hook for `.rpc()`; the client is deliberately NOT cached,
 * so one test's headers can never leak into another's.
 */
export async function signInWithHeaders(
  key: IdentityKey,
  headers: Record<string, string>,
): Promise<SupabaseClient> {
  const local = stack();
  const person = identity(key);
  const client = createClient(local.apiUrl, local.anonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers },
  });
  const { error } = await client.auth.signInWithPassword({
    email: person.email,
    password: person.password,
  });
  if (error) throw new Error(`Could not sign in as ${key}: ${error.message}`);
  return client;
}

export function forgetSessions(): void {
  sessions.clear();
}

/**
 * Signs in again after an account's sessions were invalidated.
 *
 * From M3 onward, deactivation and completed setup/recovery move the account's
 * `sessions_valid_from` cutoff forward, so every access token minted before that
 * instant is refused by the database. A cached client therefore cannot be reused
 * across such an event: the caller must obtain a genuinely new token, which is
 * exactly what a real browser has to do.
 */
export async function resignIn(key: IdentityKey): Promise<SupabaseClient> {
  sessions.delete(key);
  // JWT `iat` is whole seconds and the cutoff comparison is strictly greater, so
  // a token minted during the same second as the invalidation is refused too.
  // Crossing the second boundary is what a real user's retry does; waiting here
  // keeps the test deterministic instead of racing the clock.
  await waitForNextSecond();
  return signIn(key);
}

/** Sleeps until the wall clock passes into the next whole second. */
export async function waitForNextSecond(): Promise<void> {
  const now = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 1000 - (now % 1000) + 25));
}

// --- RPC helpers -----------------------------------------------------------

export interface RpcFailure {
  message: string;
  code: string;
}

/** Calls an RPC and requires it to succeed, surfacing the database error if not. */
export async function rpcOk<T = unknown>(
  client: SupabaseClient,
  fn: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const { data, error } = await client.rpc(fn, args);
  if (error) {
    throw new Error(`Expected ${fn} to succeed but it failed: ${error.message}`);
  }
  return data as T;
}

/** Calls an RPC and requires it to fail, returning the database error. */
export async function rpcFails(
  client: SupabaseClient,
  fn: string,
  args: Record<string, unknown> = {},
): Promise<RpcFailure> {
  const { error } = await client.rpc(fn, args);
  if (!error) {
    throw new Error(`Expected ${fn} to fail, but it succeeded.`);
  }
  return { message: error.message, code: error.code ?? '' };
}

/** The single message used for both missing and invisible ticket ids. */
export const UNAVAILABLE = 'That ticket is not available to this account.';
export const UNAVAILABLE_TO_CLAIM = 'That ticket is not available to claim.';

// --- Ticket builders -------------------------------------------------------

export interface NewTicketOptions {
  title?: string;
  issue?: string;
  channel?: 'walk_in' | 'email' | 'phone_call';
  priority?: 'low' | 'normal' | 'high' | 'urgent';
  submittedOn?: string;
  /** A staff or student row in the district directory. */
  requesterId?: string | null;
  requesterUnknown?: boolean;
  location?: string;
  ownerId?: string | null;
  collaboratorIds?: string[];
  devices?: Array<Record<string, unknown>>;
}

function rpcArgs(options: NewTicketOptions): Record<string, unknown> {
  return {
    p_title: options.title ?? 'Projector will not display',
    p_issue: options.issue ?? 'Reported during first period; podium laptop shows no signal.',
    p_channel: options.channel ?? 'walk_in',
    p_priority: options.priority ?? 'normal',
    p_submitted_on: options.submittedOn ?? null,
    p_requester_id: options.requesterId ?? null,
    // The directory is the district's, so a ticket names somebody who is
    // already in it or says plainly that there is nobody to name.
    p_requester_unknown: options.requesterUnknown ?? options.requesterId == null,
    p_location: options.location ?? 'Room 212',
    p_owner_id: options.ownerId ?? null,
    p_collaborator_ids: options.collaboratorIds ?? [],
    p_devices: options.devices ?? [],
  };
}

/** Creates a ticket through the real RPC as the given identity. */
export async function createTicketAs(
  key: IdentityKey,
  options: NewTicketOptions = {},
): Promise<string> {
  const client = await signIn(key);
  return rpcOk<string>(client, 'app_create_ticket', rpcArgs(options));
}

/** Admin-created, unassigned: the standard Open Queue arrangement. */
export async function openTicket(options: NewTicketOptions = {}): Promise<string> {
  return createTicketAs('admin', { channel: 'phone_call', ...options });
}

/**
 * A ticket owned by `owner` with `collaborator` helping, arranged only through
 * real authenticated calls so no test depends on privileged setup.
 */
export async function ownedTicket(
  options: NewTicketOptions = {},
): Promise<{ ticketId: string }> {
  const ticketId = await openTicket(options);
  const owner = await signIn('owner');
  await rpcOk(owner, 'app_claim_ticket', { p_ticket: ticketId });
  return { ticketId };
}

export async function collaborativeTicket(): Promise<{ ticketId: string }> {
  const { ticketId } = await ownedTicket();
  const owner = await signIn('owner');
  await rpcOk(owner, 'app_add_collaborator', {
    p_ticket: ticketId,
    p_account: identity('collaborator').id,
  });
  return { ticketId };
}

/** Raw row read with the service role, for ground-truth assertions. */
export async function rawTicket(ticketId: string): Promise<Record<string, unknown>> {
  const { data, error } = await adminServiceClient()
    .from('tickets')
    .select('*')
    .eq('id', ticketId)
    .single();
  if (error) throw new Error(`Could not read ticket ${ticketId}: ${error.message}`);
  return data as Record<string, unknown>;
}

export async function rawEvents(ticketId: string): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await adminServiceClient()
    .from('activity_events')
    .select('*')
    .eq('ticket_id', ticketId)
    .order('at', { ascending: true });
  if (error) throw new Error(`Could not read events: ${error.message}`);
  return (data ?? []) as Array<Record<string, unknown>>;
}

export function eventKinds(events: Array<Record<string, unknown>>): string[] {
  return events.map((event) => String(event.kind));
}

// --- Directory and inventory fixtures ---------------------------------------

/**
 * One person in the district directory, and one machine in its inventory.
 *
 * Both are arranged with the service role rather than through app_save_person
 * and app_save_inventory_device, for the same reason identities are: a fixture
 * is setup, not the thing under test, and a test that has to be an
 * administrator to arrange a student cannot then prove what a NetRider may do
 * with one. The tests that DO test those writers call them directly.
 *
 * Names are invented and every address is on edison.example: no real student
 * or staff record appears anywhere in this suite.
 */
export async function seedRequester(
  kind: 'staff' | 'student',
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; displayName: string; externalId: string }> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
  const externalId = kind === 'student' ? `9${suffix.replace(/\D/g, '0').slice(0, 8)}` : `t.${suffix}`;
  const displayName = kind === 'student' ? `Synthetic Student ${suffix}` : `Synthetic Staff ${suffix}`;
  const { data, error } = await adminServiceClient()
    .from('requesters')
    .insert({
      display_name: displayName,
      kind,
      external_id: externalId,
      source_external_id: externalId,
      email: `${suffix}@edison.example`,
      // requesters.created_by is NOT NULL: a record in the directory was put
      // there by somebody. The seeded administrator stands in for the import.
      created_by: identity('admin').id,
      ...overrides,
    })
    .select('id, display_name, external_id')
    .single();
  if (error) throw new Error(`Could not seed a ${kind} requester: ${error.message}`);
  const row = data as { id: string; display_name: string; external_id: string };
  return { id: row.id, displayName: row.display_name, externalId: row.external_id };
}

export async function seedInventoryDevice(
  overrides: Record<string, unknown> = {},
): Promise<{ id: string; externalId: string; assetTag: string; serialNumber: string }> {
  const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 12).toUpperCase();
  const row = {
    external_id: `DEV-${suffix}`,
    device_type: 'Chromebook',
    manufacturer: 'Lenovo',
    model: '300e',
    serial_number: `SER-${suffix}`,
    asset_tag: `DOE-${suffix}`,
    status: 'Available',
    location: 'Cart 4',
    ...overrides,
  };
  const { data, error } = await adminServiceClient()
    .from('inventory_devices')
    .insert(row)
    .select('id, external_id, asset_tag, serial_number')
    .single();
  if (error) throw new Error(`Could not seed an inventory device: ${error.message}`);
  const saved = data as {
    id: string;
    external_id: string;
    asset_tag: string;
    serial_number: string;
  };
  return {
    id: saved.id,
    externalId: saved.external_id,
    assetTag: saved.asset_tag,
    serialNumber: saved.serial_number,
  };
}

/** The catalogue tuple intake holds a named manufacturer to. */
export async function seedCatalogEntry(
  deviceType: string,
  manufacturer: string,
  model: string,
): Promise<void> {
  const { error } = await adminServiceClient()
    .from('device_catalog')
    .upsert({ device_type: deviceType, manufacturer, model }, { onConflict: 'device_type,manufacturer,model' });
  if (error) throw new Error(`Could not seed a catalogue entry: ${error.message}`);
}

/** Raw inventory row, for ground-truth assertions. */
export async function rawDevice(deviceId: string): Promise<Record<string, unknown>> {
  const { data, error } = await adminServiceClient()
    .from('inventory_devices')
    .select('*')
    .eq('id', deviceId)
    .single();
  if (error) throw new Error(`Could not read device ${deviceId}: ${error.message}`);
  return data as Record<string, unknown>;
}

/** Every record event on one entity, newest last. */
export async function rawRecordEvents(
  entityType: string,
  entityId: string,
): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await adminServiceClient()
    .from('record_events')
    .select('*')
    .eq('entity_type', entityType)
    .eq('entity_id', entityId)
    .order('at', { ascending: true });
  if (error) throw new Error(`Could not read record events: ${error.message}`);
  return (data ?? []) as Array<Record<string, unknown>>;
}

/** Every inventory_events audit row on one entity, newest last. */
export async function rawInventoryEvents(
  entity: 'student' | 'staff' | 'device',
  entityId: string,
): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await adminServiceClient()
    .from('inventory_events')
    .select('*')
    .eq('entity', entity)
    .eq('entity_id', entityId)
    .order('at', { ascending: true });
  if (error) throw new Error(`Could not read inventory events: ${error.message}`);
  return (data ?? []) as Array<Record<string, unknown>>;
}

// --- School-local dates ----------------------------------------------------

/**
 * The school-local (America/New_York) calendar date, matching app_today() in the
 * database. Tests must not use UTC dates: after 20:00 EDT the UTC date is
 * already tomorrow, which the "no future date" rule correctly rejects.
 */
export function schoolToday(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

export function schoolDateOffset(days: number): string {
  const base = new Date(`${schoolToday()}T12:00:00Z`);
  base.setUTCDate(base.getUTCDate() + days);
  return base.toISOString().slice(0, 10);
}
