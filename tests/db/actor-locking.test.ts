import { execFileSync, spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import {
  identity,
  ownedTicket,
  resignIn,
  rpcFails,
  rpcOk,
  signIn,
} from './support/harness';
import { resolveLocalStack } from './support/local-only';

// SQL sessions only hold deterministic transaction barriers and inspect locks.
// The ticket operations under test use real signed-in PostgREST clients.
const docker = existsSync('/Applications/Docker.app/Contents/Resources/bin/docker')
  ? '/Applications/Docker.app/Contents/Resources/bin/docker'
  : 'docker';
const psqlArgs = ['exec', '-i', 'supabase_db_edison-ticketing', 'psql',
  '-U', 'postgres', '-d', 'postgres', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1'];

function scalar(sql: string): string {
  resolveLocalStack();
  return execFileSync(docker, [...psqlArgs, '-c', sql], {
    encoding: 'utf8', timeout: 5_000, stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function sqlUuid(value: string): string {
  if (!/^[0-9a-f-]{36}$/i.test(value)) throw new Error('Expected a synthetic UUID');
  return `'${value}'`;
}

function transaction() {
  resolveLocalStack();
  const child = spawn(docker, psqlArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString(); });
  const exit = new Promise<void>((resolve) => child.once('close', () => resolve()));
  return {
    async query(sql: string) {
      const marker = `done_${randomUUID().replaceAll('-', '')}`;
      await new Promise<void>((resolve, reject) => {
        let output = '';
        const cleanup = () => {
          clearTimeout(timer);
          child.stdout.off('data', onData);
          child.off('close', onClose);
          child.off('error', onError);
        };
        const onData = (chunk: Buffer) => {
          output += chunk.toString();
          if (output.includes(marker)) { cleanup(); resolve(); }
        };
        const onClose = () => { cleanup(); reject(new Error(`SQL barrier exited: ${stderr}`)); };
        const onError = (error: Error) => { cleanup(); reject(error); };
        const timer = setTimeout(() => {
          cleanup(); reject(new Error('SQL barrier timed out'));
        }, 5_000);
        child.stdout.on('data', onData);
        child.once('close', onClose);
        child.once('error', onError);
        child.stdin.write(`${sql}\n\\echo ${marker}\n`);
      });
    },
    async close() {
      if (child.exitCode === null) child.stdin.end('rollback;\n\\q\n');
      await exit;
    },
  };
}

async function waitForLock(mode: 'ShareLock' | 'ExclusiveLock', granted: boolean) {
  await expect.poll(() => Number(scalar(`
    select count(*) from pg_locks
    where locktype = 'advisory' and classid = 1162103123 and objid = 1
      and objsubid = 2 and mode = '${mode}' and granted = ${granted};
  `)), { timeout: 5_000, interval: 40 }).toBeGreaterThan(0);
}

it('refuses a queued write after the deactivation transaction commits', async () => {
  const admin = await signIn('admin');
  const owner = await signIn('owner');
  const { ticketId } = await ownedTicket();
  const holder = transaction();
  let note: PromiseLike<unknown> | undefined;
  try {
    // Exercise the status RPC itself under an authenticated SQL role, holding
    // its transaction open so the REST writer must wait at the shared gate.
    const { data: verifiedClaims, error: claimsError } = await admin.auth.getClaims();
    if (claimsError || typeof verifiedClaims?.claims.session_id !== 'string') {
      throw new Error('Missing authenticated test session');
    }
    // Reproduce the real verified session identity, not a synthetic subject-only JWT.
    const session = sqlUuid(verifiedClaims.claims.session_id);
    await holder.query(`begin;
      set local role authenticated;
      select set_config('request.jwt.claims', json_build_object('sub', ${sqlUuid(identity('admin').id)}, 'session_id', ${session})::text, true);
      select set_config('request.jwt.claim.sub', ${sqlUuid(identity('admin').id)}, true);
      select public.app_set_account_status(${sqlUuid(identity('owner').id)}, 'inactive');`);
    const result = Promise.resolve(owner.rpc('app_add_note', {
      p_ticket: ticketId, p_body: 'Queued behind committed deactivation.',
    }));
    note = result;
    await waitForLock('ShareLock', false);
    await holder.query('commit;');
    expect((await result).error?.message).toMatch(/cannot access helpdesk records/i);
    const { data, error } = await admin.from('notes').select('id').eq('ticket_id', ticketId);
    expect(error).toBeNull();
    expect(data).toEqual([]);
  } finally {
    await holder.close();
    await note;
    // Restore even when an assertion fails, without exposing credentials.
    const account = await admin.from('app_accounts').select('status').eq('id', identity('owner').id).single();
    if (account.data?.status === 'inactive') {
      await rpcOk(admin, 'app_set_account_status', { p_account: identity('owner').id, p_status: 'active' });
      // M3: deactivation invalidated tokens minted before it; re-authenticate.
      await resignIn('owner');
    }
  }
});

it('lets an already authorized write finish before deactivation commits', async () => {
  const admin = await signIn('admin');
  const owner = await signIn('owner');
  const { ticketId } = await ownedTicket();
  const holder = transaction();
  let pending: Promise<unknown>[] = [];
  try {
    await holder.query(`begin; select id from public.tickets where id = ${sqlUuid(ticketId)} for update;`);
    const note = Promise.resolve(owner.rpc('app_add_note', {
      p_ticket: ticketId, p_body: 'Authorized before deactivation started.',
    }));
    pending = [note];
    await waitForLock('ShareLock', true);
    const deactivate = Promise.resolve(admin.rpc('app_set_account_status', {
      p_account: identity('owner').id, p_status: 'inactive',
    }));
    pending.push(deactivate);
    await waitForLock('ExclusiveLock', false);
    await holder.query('commit;');
    expect((await note).error).toBeNull();
    expect((await deactivate).error).toBeNull();
    const failure = await rpcFails(owner, 'app_add_note', {
      p_ticket: ticketId, p_body: 'Must fail after deactivation.',
    });
    expect(failure.message).toMatch(/cannot access helpdesk records/i);
    const { data, error } = await admin.from('notes').select('id').eq('ticket_id', ticketId);
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  } finally {
    await holder.close();
    await Promise.allSettled(pending);
    const account = await admin.from('app_accounts').select('status').eq('id', identity('owner').id).single();
    if (account.data?.status === 'inactive') {
      await rpcOk(admin, 'app_set_account_status', { p_account: identity('owner').id, p_status: 'active' });
      // M3: deactivation invalidated tokens minted before it; re-authenticate.
      await resignIn('owner');
    }
  }
});

it('keeps setup completion out of the ordinary account-status RPC', async () => {
  const admin = await signIn('admin');
  for (const status of ['active', 'inactive']) {
    const failure = await rpcFails(admin, 'app_set_account_status', {
      p_account: identity('pending').id, p_status: status,
    });
    expect(failure.message).toMatch(/password setup must complete/i);
  }
  const failure = await rpcFails(admin, 'app_set_account_status', {
    p_account: identity('owner').id, p_status: 'setup_pending',
  });
  expect(failure.message).toMatch(/separate trusted flow/i);
});

it('uses actual deactivation time even when the transaction started earlier', async () => {
  const admin = await signIn('admin');
  const {data, error} = await admin.auth.getClaims();
  if (error || typeof data?.claims.session_id !== 'string') throw new Error('Missing verified session');
  const result = scalar(`begin;
    set local role authenticated;
    select set_config('request.jwt.claims', json_build_object('sub', ${sqlUuid(identity('admin').id)}, 'session_id', ${sqlUuid(data.claims.session_id)})::text, true);
    select pg_sleep(0.05);
    select public.app_set_account_status(${sqlUuid(identity('owner').id)}, 'inactive');
    select sessions_valid_from > transaction_timestamp() from public.app_accounts where id = ${sqlUuid(identity('owner').id)};
    rollback;`);
  expect(result.split('\n').at(-1)).toBe('t');
});
