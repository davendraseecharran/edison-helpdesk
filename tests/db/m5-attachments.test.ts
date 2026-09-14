/**
 * M5 attachments: the registry that says which uploaded file belongs to which
 * ticket or device, and who put it there.
 *
 * The bytes themselves live in a PRIVATE storage bucket that no client role can
 * reach. There are deliberately no storage policies: every download is a signed
 * URL the server issues after it has decided the caller may have one, so the
 * only thing a session can do is ask this registry. That makes these rules the
 * whole of attachment security.
 *
 * Three of them are proven here.
 *
 *   1. Attaching follows the CONTRIBUTOR rule for tickets — the owner, a
 *      collaborator or an administrator, and never on a closed ticket — and the
 *      ACTIVE ACCOUNT rule for devices, because a device is shared inventory
 *      rather than one technician's work.
 *   2. A row names exactly one parent, and its stored path has to live under
 *      that parent. A path that points somewhere else is refused, so a registry
 *      row can never hand out a signed URL for a file belonging to a record the
 *      caller may not see.
 *   3. Reading is ordinary row-level security: ticket attachments are visible
 *      exactly where the ticket is, device attachments to any active account.
 *      Closing a ticket stops new uploads but never hides the ones already
 *      there.
 *
 * Reading and removing are still session calls, and are tested as such. WRITING
 * is not: a registry row promises that an object exists in the bucket at that
 * path, is one of five types and is that many bytes, and nothing in the
 * database can check any of it. So registration moved behind the one caller
 * that can — the upload endpoint, which holds the service role, reads the
 * stored object back, and calls `app_trusted_register_attachment` with the
 * account it has already verified. `app_register_attachment` is superseded and
 * no longer reachable from a session; the trusted function is not reachable
 * from one either. Both facts are proven below, and every arrangement in this
 * file goes the way the server goes.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';
import {
  adminServiceClient,
  anonClient,
  collaborativeTicket,
  identity,
  openTicket,
  ownedTicket,
  rpcFails,
  rpcOk,
  signIn,
  type IdentityKey,
} from './support/harness';

/** insufficient_privilege, check_violation and no_data_found, as PostgREST reports them. */
const REFUSED = '42501';
const REJECTED = '23514';
const MISSING = 'P0002';

let service: SupabaseClient;
let admin: SupabaseClient;
let owner: SupabaseClient;
let helper: SupabaseClient;
let unrelated: SupabaseClient;
let pending: SupabaseClient;
let denied: SupabaseClient;

/** Fresh identifiers per run, so a re-run against an un-reset database still passes. */
const RUN_TAG = String(Math.floor(Math.random() * 9000) + 1000);
let sequence = 0;

function nextName(extension = 'png'): string {
  sequence += 1;
  return `photo-${RUN_TAG}-${sequence}.${extension}`;
}

interface AttachmentRow {
  id: string;
  ticket_id: string | null;
  device_id: string | null;
  path: string;
  filename: string;
  mime: string;
  bytes: number;
  uploaded_by: string;
  uploaded_at: string;
}

interface RegisterOptions {
  ticket?: string | null;
  device?: string | null;
  path?: string;
  filename?: string;
  mime?: string;
  bytes?: number;
}

function registerArgs(options: RegisterOptions): Record<string, unknown> {
  const filename = options.filename ?? nextName();
  const parentPrefix = options.ticket
    ? `ticket/${options.ticket}/`
    : options.device
      ? `device/${options.device}/`
      : '';
  return {
    p_ticket: options.ticket ?? null,
    p_device: options.device ?? null,
    p_path: options.path ?? `${parentPrefix}${filename}`,
    p_filename: filename,
    p_mime: options.mime ?? 'image/png',
    p_bytes: options.bytes ?? 24_576,
  };
}

/**
 * Which person each signed-in client is.
 *
 * The upload endpoint verifies a live session and then hands the trusted
 * function that account's id, so a test that wants to register "as the owner"
 * has to do the same. Keeping the tests written in terms of a CLIENT means the
 * session half of every case — who may see the ticket, who may remove the file
 * — still reads the way it always did.
 */
const actorKeys = new Map<SupabaseClient, IdentityKey>();

function actorOf(client: SupabaseClient): string {
  const key = actorKeys.get(client);
  if (!key) throw new Error('That client was never signed in by this suite.');
  return identity(key).id;
}

/** Registration exactly as the upload endpoint performs it. */
function trustedArgs(actor: string | null, options: RegisterOptions): Record<string, unknown> {
  return { p_actor: actor, ...registerArgs(options) };
}

async function register(client: SupabaseClient, options: RegisterOptions): Promise<string> {
  return rpcOk<string>(
    service,
    'app_trusted_register_attachment',
    trustedArgs(actorOf(client), options),
  );
}

async function registerFails(client: SupabaseClient, options: RegisterOptions) {
  return rpcFails(
    service,
    'app_trusted_register_attachment',
    trustedArgs(actorOf(client), options),
  );
}

async function listAttachments(
  client: SupabaseClient,
  args: Record<string, unknown>,
): Promise<AttachmentRow[]> {
  return rpcOk<AttachmentRow[]>(client, 'app_list_attachments', args);
}

/** Ground truth straight from the table, bypassing every read path under test. */
async function rawAttachment(id: string): Promise<AttachmentRow | null> {
  const { data, error } = await service.from('attachments').select('*').eq('id', id).maybeSingle();
  if (error) throw new Error(`Could not read attachment ${id}: ${error.message}`);
  return (data ?? null) as AttachmentRow | null;
}

async function ticketEvents(ticketId: string): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await service
    .from('activity_events')
    .select('*')
    .eq('ticket_id', ticketId)
    .order('at', { ascending: true });
  if (error) throw new Error(`Could not read ticket history: ${error.message}`);
  return (data ?? []) as Array<Record<string, unknown>>;
}

async function deviceEvents(deviceId: string): Promise<Array<Record<string, unknown>>> {
  const { data, error } = await service
    .from('record_events')
    .select('*')
    .eq('entity_type', 'device')
    .eq('entity_id', deviceId)
    .order('at', { ascending: true });
  if (error) throw new Error(`Could not read device history: ${error.message}`);
  return (data ?? []) as Array<Record<string, unknown>>;
}

function kinds(events: Array<Record<string, unknown>>): string[] {
  return events.map((event) => String(event.kind));
}

/** A device nobody is holding, unique to this call. */
async function newDevice(): Promise<string> {
  sequence += 1;
  return rpcOk<string>(owner, 'app_upsert_device', {
    p_device: {
      serial_number: `AT${RUN_TAG}${String(sequence).padStart(4, '0')}`,
      model: 'ThinkPad L13',
    },
  });
}

beforeAll(async () => {
  service = adminServiceClient();
  [admin, owner, helper, unrelated, pending, denied] = await Promise.all([
    signIn('admin'),
    signIn('owner'),
    signIn('collaborator'),
    signIn('unrelated'),
    signIn('pending'),
    signIn('denied'),
  ]);
  const keys: Array<[SupabaseClient, IdentityKey]> = [
    [admin, 'admin'],
    [owner, 'owner'],
    [helper, 'collaborator'],
    [unrelated, 'unrelated'],
    [pending, 'pending'],
    [denied, 'denied'],
  ];
  for (const [client, key] of keys) actorKeys.set(client, key);
});

describe('attaching a file to a ticket', () => {
  it('lets the owner attach to their own ticket and records it in the history', async () => {
    const { ticketId } = await ownedTicket();
    const filename = nextName();

    const id = await register(owner, { ticket: ticketId, filename });

    const row = await rawAttachment(id);
    expect(row?.ticket_id).toBe(ticketId);
    expect(row?.device_id).toBeNull();
    expect(row?.filename).toBe(filename);
    expect(row?.mime).toBe('image/png');
    expect(row?.bytes).toBe(24_576);
    expect(row?.uploaded_by).toBe(identity('owner').id);
    expect(row?.path).toBe(`ticket/${ticketId}/${filename}`);

    const events = await ticketEvents(ticketId);
    expect(kinds(events)).toContain('attachment_added');
    const added = events.find((event) => event.kind === 'attachment_added');
    expect(String(added?.summary)).toContain(filename);
    expect(String(added?.summary)).toMatch(/^Attached /);
    expect(added?.actor_id).toBe(identity('owner').id);
  });

  it('lets a collaborator attach to a ticket they are helping with', async () => {
    const { ticketId } = await collaborativeTicket();

    const id = await register(helper, { ticket: ticketId });

    const row = await rawAttachment(id);
    expect(row?.uploaded_by).toBe(identity('collaborator').id);
  });

  it("lets an administrator attach to anyone's ticket", async () => {
    const { ticketId } = await ownedTicket();

    const id = await register(admin, { ticket: ticketId });

    const row = await rawAttachment(id);
    expect(row?.uploaded_by).toBe(identity('admin').id);
  });

  it('refuses a technician who is neither the owner nor a collaborator', async () => {
    const { ticketId } = await ownedTicket();

    const failure = await registerFails(unrelated, { ticket: ticketId });

    expect(failure.code).toBe(REFUSED);
    expect(failure.message).toMatch(/not available to this account|owner, a collaborator/i);
  });

  it('refuses an account that has not finished setup and one that was denied', async () => {
    const { ticketId } = await ownedTicket();

    const notSetUp = await registerFails(pending, { ticket: ticketId });
    expect(notSetUp.code).toBe(REFUSED);
    expect(notSetUp.message).toMatch(/cannot access helpdesk records/i);

    const refused = await registerFails(denied, { ticket: ticketId });
    expect(refused.code).toBe(REFUSED);
    expect(refused.message).toMatch(/cannot access helpdesk records/i);
  });

  it('refuses a new attachment on a closed ticket, and says how to reopen it', async () => {
    const { ticketId } = await ownedTicket();
    await rpcOk(owner, 'app_resolve_ticket', {
      p_ticket: ticketId,
      p_solution: 'Replaced the display cable.',
    });

    const failure = await registerFails(owner, { ticket: ticketId });

    expect(failure.code).toBe(REFUSED);
    expect(failure.message).toMatch(/closed/i);
    expect(failure.message).toMatch(/reopen/i);
  });

  it('refuses a ticket id that does not exist', async () => {
    const failure = await registerFails(owner, {
      ticket: '00000000-0000-4000-8000-000000000000',
    });
    expect(failure.code).toBe(REFUSED);
    expect(failure.message).toMatch(/not available to this account/i);
  });
});

describe('attaching a file to a device', () => {
  it('lets any active technician attach to shared inventory', async () => {
    const deviceId = await newDevice();
    const filename = nextName();

    const id = await register(unrelated, { device: deviceId, filename });

    const row = await rawAttachment(id);
    expect(row?.device_id).toBe(deviceId);
    expect(row?.ticket_id).toBeNull();
    expect(row?.uploaded_by).toBe(identity('unrelated').id);
    expect(row?.path).toBe(`device/${deviceId}/${filename}`);

    const events = await deviceEvents(deviceId);
    expect(kinds(events)).toContain('attachment_added');
    expect(String(events.find((event) => event.kind === 'attachment_added')?.summary)).toContain(
      filename,
    );
  });

  it('refuses an account that has not finished setup', async () => {
    const deviceId = await newDevice();

    const failure = await registerFails(pending, { device: deviceId });

    expect(failure.code).toBe(REFUSED);
    expect(failure.message).toMatch(/cannot access helpdesk records/i);
  });

  it('refuses a device that is not in the inventory', async () => {
    const failure = await registerFails(owner, {
      device: '00000000-0000-4000-8000-000000000001',
    });
    expect(failure.code).toBe(MISSING);
    expect(failure.message).toMatch(/not in the inventory/i);
  });
});

describe('what an attachment row is allowed to say', () => {
  it('refuses a file that names both a ticket and a device, and one that names neither', async () => {
    const { ticketId } = await ownedTicket();
    const deviceId = await newDevice();

    const both = await rpcFails(service, 'app_trusted_register_attachment', {
      p_actor: actorOf(owner),
      p_ticket: ticketId,
      p_device: deviceId,
      p_path: `ticket/${ticketId}/${nextName()}`,
      p_filename: nextName(),
      p_mime: 'image/png',
      p_bytes: 1024,
    });
    expect(both.code).toBe(REJECTED);
    expect(both.message).toMatch(/ticket or .*device/i);

    const neither = await rpcFails(service, 'app_trusted_register_attachment', {
      p_actor: actorOf(owner),
      p_ticket: null,
      p_device: null,
      p_path: `ticket/${ticketId}/${nextName()}`,
      p_filename: nextName(),
      p_mime: 'image/png',
      p_bytes: 1024,
    });
    expect(neither.code).toBe(REJECTED);
    expect(neither.message).toMatch(/ticket or .*device/i);
  });

  it('refuses a file type the bucket does not accept', async () => {
    const { ticketId } = await ownedTicket();

    const failure = await registerFails(owner, {
      ticket: ticketId,
      mime: 'application/zip',
      filename: nextName('zip'),
    });

    expect(failure.code).toBe(REJECTED);
    expect(failure.message).toMatch(/JPEG, PNG, WebP, GIF or PDF/i);
  });

  it('accepts every type the bucket does accept', async () => {
    const { ticketId } = await ownedTicket();
    for (const mime of ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']) {
      const id = await register(owner, { ticket: ticketId, mime });
      expect((await rawAttachment(id))?.mime).toBe(mime);
    }
  });

  it('refuses an empty file and one over eight megabytes', async () => {
    const { ticketId } = await ownedTicket();

    const empty = await registerFails(owner, { ticket: ticketId, bytes: 0 });
    expect(empty.code).toBe(REJECTED);
    expect(empty.message).toMatch(/empty/i);

    const oversize = await registerFails(owner, { ticket: ticketId, bytes: 8_388_609 });
    expect(oversize.code).toBe(REJECTED);
    expect(oversize.message).toMatch(/8 MB/i);

    // The last byte that still fits is accepted.
    const id = await register(owner, { ticket: ticketId, bytes: 8_388_608 });
    expect((await rawAttachment(id))?.bytes).toBe(8_388_608);
  });

  it('refuses a path that does not live under the record it names', async () => {
    const { ticketId } = await ownedTicket();
    const other = await openTicket();
    const deviceId = await newDevice();

    const wrongParent = await registerFails(owner, {
      ticket: ticketId,
      path: `ticket/${other}/${nextName()}`,
    });
    expect(wrongParent.code).toBe(REJECTED);
    expect(wrongParent.message).toContain(`ticket/${ticketId}/`);

    const wrongKind = await registerFails(owner, {
      ticket: ticketId,
      path: `device/${deviceId}/${nextName()}`,
    });
    expect(wrongKind.code).toBe(REJECTED);
    expect(wrongKind.message).toContain(`ticket/${ticketId}/`);

    const bare = await registerFails(owner, { ticket: ticketId, path: `ticket/${ticketId}/` });
    expect(bare.code).toBe(REJECTED);

    const nothing = await registerFails(owner, { ticket: ticketId, path: '   ' });
    expect(nothing.code).toBe(REJECTED);
  });

  it('refuses a path that tries to climb out of its folder', async () => {
    const { ticketId } = await ownedTicket();

    const failure = await registerFails(owner, {
      ticket: ticketId,
      path: `ticket/${ticketId}/../${nextName()}`,
    });

    expect(failure.code).toBe(REJECTED);
    expect(failure.message).toMatch(/\.\./);
  });

  it('refuses a file with no name', async () => {
    const { ticketId } = await ownedTicket();

    const failure = await rpcFails(service, 'app_trusted_register_attachment', {
      p_actor: actorOf(owner),
      p_ticket: ticketId,
      p_device: null,
      p_path: `ticket/${ticketId}/${nextName()}`,
      p_filename: '   ',
      p_mime: 'image/png',
      p_bytes: 1024,
    });

    expect(failure.code).toBe(REJECTED);
    expect(failure.message).toMatch(/name/i);
  });

  it('refuses the same stored path twice', async () => {
    const { ticketId } = await ownedTicket();
    const filename = nextName();
    await register(owner, { ticket: ticketId, filename });

    const failure = await registerFails(owner, { ticket: ticketId, filename });

    expect(failure.message).toMatch(/already been attached/i);
    expect(failure.message).not.toMatch(/duplicate key|attachments_path_key/i);
  });
});

describe('registration is the server’s job alone', () => {
  /**
   * A session cannot write a registry row by either door. That is the whole
   * point of the change: the three fields that describe the file are the ones
   * the database cannot verify, so only the caller that has seen the stored
   * object may supply them.
   */
  const CLOSED = /permission denied|does not exist|schema cache/i;

  it('no longer lets any session call app_register_attachment', async () => {
    const { ticketId } = await ownedTicket();
    const args = registerArgs({ ticket: ticketId });

    for (const client of [owner, admin, unrelated, anonClient()]) {
      const failure = await rpcFails(client, 'app_register_attachment', args);
      expect(failure.message).toMatch(CLOSED);
    }

    // And nothing was written by any of those attempts.
    expect(await listAttachments(owner, { p_ticket: ticketId })).toHaveLength(0);
  });

  it('does not let a session reach the trusted function either, not even an admin', async () => {
    const { ticketId } = await ownedTicket();

    for (const client of [owner, admin, anonClient()]) {
      const failure = await rpcFails(
        client,
        'app_trusted_register_attachment',
        trustedArgs(identity('admin').id, { ticket: ticketId }),
      );
      expect(failure.message).toMatch(CLOSED);
    }

    expect(await listAttachments(owner, { p_ticket: ticketId })).toHaveLength(0);
  });

  it('judges the actor it is given rather than believing the server about them', async () => {
    const { ticketId } = await ownedTicket();

    // A technician who is neither the owner nor a collaborator: the same
    // refusal they would have met in their own session.
    const refused = await rpcFails(
      service,
      'app_trusted_register_attachment',
      trustedArgs(identity('unrelated').id, { ticket: ticketId }),
    );
    expect(refused.code).toBe(REFUSED);
    expect(refused.message).toMatch(/not available to this account|owner, a collaborator/i);

    // An account that has not finished setup, and one nobody has approved.
    for (const key of ['pending', 'denied'] as const) {
      const restricted = await rpcFails(
        service,
        'app_trusted_register_attachment',
        trustedArgs(identity(key).id, { ticket: ticketId }),
      );
      expect(restricted.code).toBe(REFUSED);
      expect(restricted.message).toMatch(/cannot access helpdesk records/i);
    }

    // An actor id that names nobody, and none at all.
    for (const actor of ['00000000-0000-4000-8000-000000000003', null]) {
      const nobody = await rpcFails(
        service,
        'app_trusted_register_attachment',
        trustedArgs(actor, { ticket: ticketId }),
      );
      expect(nobody.code).toBe(REFUSED);
      expect(nobody.message).toMatch(/cannot access helpdesk records/i);
    }

    expect(await listAttachments(owner, { p_ticket: ticketId })).toHaveLength(0);
  });

  it('registers for the owner, attributed to them and recorded in their history', async () => {
    const { ticketId } = await ownedTicket();
    const filename = nextName();

    const id = await rpcOk<string>(
      service,
      'app_trusted_register_attachment',
      trustedArgs(identity('owner').id, { ticket: ticketId, filename }),
    );

    const row = await rawAttachment(id);
    expect(row?.uploaded_by).toBe(identity('owner').id);
    expect(row?.path).toBe(`ticket/${ticketId}/${filename}`);
    // The owner sees it in their own session, through ordinary row-level
    // security: the trusted write did not create a row only the server can read.
    expect((await listAttachments(owner, { p_ticket: ticketId })).map((a) => a.id)).toEqual([id]);

    const added = (await ticketEvents(ticketId)).find((e) => e.kind === 'attachment_added');
    expect(added?.actor_id).toBe(identity('owner').id);
    // Attribution stays a statement about the person, not about the service
    // role that carried the write.
    expect(added?.performed_via).toBe('user');
  });
});

describe('who may attach', () => {
  it('answers the same question the register call asks', async () => {
    const { ticketId } = await ownedTicket();
    const deviceId = await newDevice();

    expect(await rpcOk(owner, 'app_can_attach', { p_ticket: ticketId, p_device: null })).toBe(true);
    expect(await rpcOk(admin, 'app_can_attach', { p_ticket: ticketId, p_device: null })).toBe(true);
    expect(await rpcOk(unrelated, 'app_can_attach', { p_ticket: ticketId, p_device: null })).toBe(
      false,
    );
    expect(await rpcOk(unrelated, 'app_can_attach', { p_ticket: null, p_device: deviceId })).toBe(
      true,
    );
    expect(await rpcOk(pending, 'app_can_attach', { p_ticket: null, p_device: deviceId })).toBe(
      false,
    );
    // Exactly one parent, always.
    expect(await rpcOk(owner, 'app_can_attach', { p_ticket: ticketId, p_device: deviceId })).toBe(
      false,
    );
    expect(await rpcOk(owner, 'app_can_attach', { p_ticket: null, p_device: null })).toBe(false);
  });

  it('turns false once the ticket is closed', async () => {
    const { ticketId } = await ownedTicket();
    expect(await rpcOk(owner, 'app_can_attach', { p_ticket: ticketId, p_device: null })).toBe(true);

    await rpcOk(owner, 'app_resolve_ticket', {
      p_ticket: ticketId,
      p_solution: 'Swapped the projector lamp.',
    });

    expect(await rpcOk(owner, 'app_can_attach', { p_ticket: ticketId, p_device: null })).toBe(false);
  });
});

describe('listing attachments', () => {
  it("shows a ticket's files to the people who can see the ticket, and to nobody else", async () => {
    const { ticketId } = await collaborativeTicket();
    const filename = nextName();
    await register(owner, { ticket: ticketId, filename });

    expect((await listAttachments(owner, { p_ticket: ticketId })).map((row) => row.filename)).toEqual(
      [filename],
    );
    expect(await listAttachments(helper, { p_ticket: ticketId })).toHaveLength(1);
    expect(await listAttachments(admin, { p_ticket: ticketId })).toHaveLength(1);

    expect(await listAttachments(unrelated, { p_ticket: ticketId })).toHaveLength(0);
    expect(await listAttachments(pending, { p_ticket: ticketId })).toHaveLength(0);
    expect(await listAttachments(denied, { p_ticket: ticketId })).toHaveLength(0);
  });

  it("shows a device's files to any active account and to no restricted one", async () => {
    const deviceId = await newDevice();
    await register(owner, { device: deviceId });

    expect(await listAttachments(unrelated, { p_device: deviceId })).toHaveLength(1);
    expect(await listAttachments(helper, { p_device: deviceId })).toHaveLength(1);
    expect(await listAttachments(pending, { p_device: deviceId })).toHaveLength(0);
    expect(await listAttachments(denied, { p_device: deviceId })).toHaveLength(0);
  });

  it('keeps showing the files on a closed ticket', async () => {
    const { ticketId } = await ownedTicket();
    await register(owner, { ticket: ticketId });
    await rpcOk(owner, 'app_resolve_ticket', {
      p_ticket: ticketId,
      p_solution: 'Reseated the memory module.',
    });

    expect(await listAttachments(owner, { p_ticket: ticketId })).toHaveLength(1);
  });

  it('returns nothing when neither parent is named, and nothing when both are', async () => {
    const { ticketId } = await ownedTicket();
    const deviceId = await newDevice();
    await register(owner, { ticket: ticketId });

    expect(await listAttachments(owner, {})).toHaveLength(0);
    expect(
      await listAttachments(owner, { p_ticket: ticketId, p_device: deviceId }),
    ).toHaveLength(0);
  });

  it('is closed to an anonymous caller', async () => {
    const failure = await rpcFails(anonClient(), 'app_list_attachments', { p_ticket: null });
    expect(failure.message).toMatch(/permission denied|function|schema cache/i);
  });
});

describe('removing an attachment', () => {
  it('lets the person who uploaded it take it back, and reports the stored path', async () => {
    const { ticketId } = await ownedTicket();
    const filename = nextName();
    const id = await register(owner, { ticket: ticketId, filename });

    const path = await rpcOk<string>(owner, 'app_delete_attachment', { p_id: id });

    expect(path).toBe(`ticket/${ticketId}/${filename}`);
    expect(await rawAttachment(id)).toBeNull();

    const events = await ticketEvents(ticketId);
    expect(kinds(events)).toContain('attachment_removed');
    expect(String(events.find((event) => event.kind === 'attachment_removed')?.summary)).toContain(
      filename,
    );
  });

  it('refuses another technician who did not upload it', async () => {
    const { ticketId } = await collaborativeTicket();
    const id = await register(owner, { ticket: ticketId });

    const failure = await rpcFails(helper, 'app_delete_attachment', { p_id: id });

    expect(failure.code).toBe(REFUSED);
    expect(failure.message).toMatch(/attached this file|administrator/i);
    expect(await rawAttachment(id)).not.toBeNull();
  });

  it("lets an administrator remove anyone's attachment", async () => {
    const { ticketId } = await ownedTicket();
    const id = await register(owner, { ticket: ticketId });

    await rpcOk(admin, 'app_delete_attachment', { p_id: id });

    expect(await rawAttachment(id)).toBeNull();
  });

  it('removes a device attachment and records it against the device', async () => {
    const deviceId = await newDevice();
    const filename = nextName();
    const id = await register(owner, { device: deviceId, filename });

    const path = await rpcOk<string>(owner, 'app_delete_attachment', { p_id: id });

    expect(path).toBe(`device/${deviceId}/${filename}`);
    expect(kinds(await deviceEvents(deviceId))).toContain('attachment_removed');
  });

  it("makes removal on a closed ticket an administrator's decision", async () => {
    const { ticketId } = await ownedTicket();
    const id = await register(owner, { ticket: ticketId });
    await rpcOk(owner, 'app_resolve_ticket', {
      p_ticket: ticketId,
      p_solution: 'Replaced the keyboard.',
    });

    const refused = await rpcFails(owner, 'app_delete_attachment', { p_id: id });
    expect(refused.code).toBe(REFUSED);
    expect(refused.message).toMatch(/closed/i);
    expect(await rawAttachment(id)).not.toBeNull();

    await rpcOk(admin, 'app_delete_attachment', { p_id: id });
    expect(await rawAttachment(id)).toBeNull();
  });

  it('tells a technician who cannot see the ticket nothing about the file', async () => {
    const { ticketId } = await ownedTicket();
    const id = await register(owner, { ticket: ticketId });

    const failure = await rpcFails(unrelated, 'app_delete_attachment', { p_id: id });

    expect(failure.code).toBe(MISSING);
    expect(failure.message).toMatch(/no longer available/i);
    expect(await rawAttachment(id)).not.toBeNull();
  });

  it('refuses an attachment id that does not exist', async () => {
    const failure = await rpcFails(owner, 'app_delete_attachment', {
      p_id: '00000000-0000-4000-8000-000000000002',
    });
    expect(failure.code).toBe(MISSING);
    expect(failure.message).toMatch(/no longer available/i);
  });
});

describe('the registry is not writable from a session', () => {
  it('refuses INSERT, UPDATE and DELETE straight to the table, even for an admin', async () => {
    const { ticketId } = await ownedTicket();
    const id = await register(owner, { ticket: ticketId });

    const insert = await admin.from('attachments').insert({
      ticket_id: ticketId,
      path: `ticket/${ticketId}/forged.png`,
      filename: 'forged.png',
      mime: 'image/png',
      bytes: 10,
      uploaded_by: identity('admin').id,
    });
    expect(insert.error?.message).toMatch(/permission denied|violates row-level security/i);

    const update = await admin.from('attachments').update({ filename: 'renamed.png' }).eq('id', id);
    expect(update.error?.message).toMatch(/permission denied/i);

    const remove = await admin.from('attachments').delete().eq('id', id);
    expect(remove.error?.message).toMatch(/permission denied/i);

    expect(await rawAttachment(id)).not.toBeNull();
  });

  it('shows an anonymous caller nothing', async () => {
    const { data, error } = await anonClient().from('attachments').select('id');
    expect(error?.message ?? '').toMatch(/permission denied|^$/i);
    expect(data ?? []).toHaveLength(0);
  });
});
