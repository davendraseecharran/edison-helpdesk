/**
 * Synthetic authenticated identities for the database suite.
 *
 * Every person, email and password here is invented. Emails use the reserved
 * `edison.example` domain; passwords are generated fresh on each run and never
 * written to a file or printed. No real school record is involved.
 *
 * Seeding uses the service role, which is a privileged setup path. It creates
 * auth users and account rows ONLY. It never performs a ticket operation whose
 * authorization is under test — those all run through real signed-in sessions.
 */

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { randomUUID } from 'node:crypto';
import type { LocalStack } from './local-only';

export type IdentityKey =
  | 'admin'
  | 'owner'
  | 'collaborator'
  | 'unrelated'
  | 'pending'
  | 'inactive'
  | 'pendingApproval'
  | 'denied';

export interface SeededIdentity {
  key: IdentityKey;
  id: string;
  email: string;
  password: string;
  displayName: string;
  role: 'admin' | 'technician';
  status: 'active' | 'inactive' | 'setup_pending' | 'pending_approval' | 'denied';
}

const PEOPLE: Array<Omit<SeededIdentity, 'id' | 'password'>> = [
  {
    key: 'admin',
    email: 'morgan.ellis@edison.example',
    displayName: 'Morgan Ellis',
    role: 'admin',
    status: 'active',
  },
  {
    key: 'owner',
    email: 'priya.raman@edison.example',
    displayName: 'Priya Raman',
    role: 'technician',
    status: 'active',
  },
  {
    key: 'collaborator',
    email: 'dev.okafor@edison.example',
    displayName: 'Dev Okafor',
    role: 'technician',
    status: 'active',
  },
  {
    key: 'unrelated',
    email: 'sam.whitaker@edison.example',
    displayName: 'Sam Whitaker',
    role: 'technician',
    status: 'active',
  },
  {
    key: 'pending',
    email: 'jordan.pike@edison.example',
    displayName: 'Jordan Pike',
    role: 'technician',
    status: 'setup_pending',
  },
  {
    key: 'inactive',
    email: 'alex.reyes@edison.example',
    displayName: 'Alex Reyes',
    role: 'technician',
    status: 'inactive',
  },
  // M5. Someone who signed in with Google without an invite and is waiting for
  // an administrator to decide.
  {
    key: 'pendingApproval',
    email: 'rowan.deleon@edison.example',
    displayName: 'Rowan De Leon',
    role: 'technician',
    status: 'pending_approval',
  },
  // M5. A request an administrator turned down. Kept as a seeded identity so
  // every suite can prove a denied account reaches nothing.
  {
    key: 'denied',
    email: 'noor.baptiste@edison.example',
    displayName: 'Noor Baptiste',
    role: 'technician',
    status: 'denied',
  },
];

export function serviceClient(stack: LocalStack): SupabaseClient {
  return createClient(stack.apiUrl, stack.serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/** Ephemeral password, comfortably over the configured 12-character minimum. */
function ephemeralPassword(): string {
  return `Ed-${randomUUID()}`;
}

export async function seedIdentities(stack: LocalStack): Promise<SeededIdentity[]> {
  const admin = serviceClient(stack);
  const seeded: SeededIdentity[] = [];

  const { data: existing, error: listError } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 200,
  });
  if (listError) {
    throw new Error(`Could not list auth users: ${listError.message}`);
  }

  for (const person of PEOPLE) {
    const password = ephemeralPassword();
    const prior = existing?.users.find((user) => user.email === person.email);
    let userId: string;

    if (prior) {
      // Re-seeding in place rather than deleting: an identity that already
      // authored tickets cannot be deleted, because history preservation is
      // exactly what the schema enforces.
      const { error } = await admin.auth.admin.updateUserById(prior.id, {
        password,
        email_confirm: true,
      });
      if (error) {
        throw new Error(`Could not re-seed auth user ${person.email}: ${error.message}`);
      }
      userId = prior.id;
    } else {
      const { data: created, error } = await admin.auth.admin.createUser({
        email: person.email,
        password,
        email_confirm: true,
      });
      if (error || !created.user) {
        throw new Error(`Could not seed auth user ${person.email}: ${error?.message}`);
      }
      userId = created.user.id;
    }

    const { error: accountError } = await admin.from('app_accounts').upsert(
      {
        id: userId,
        display_name: person.displayName,
        email: person.email,
        role: person.role,
        status: person.status,
      },
      { onConflict: 'id' },
    );
    if (accountError) {
      throw new Error(`Could not seed account ${person.email}: ${accountError.message}`);
    }

    seeded.push({ ...person, id: userId, password });
  }

  return seeded;
}

/**
 * Restores the seeded accounts to their intended role/status.
 *
 * Tests that deactivate an account call this so a later file starts from a known
 * state. Accounts are never deleted: ticket history holds references to them on
 * purpose, and that RESTRICT is part of what this suite proves.
 */
export async function restoreIdentityStates(
  stack: LocalStack,
  identities: SeededIdentity[],
): Promise<void> {
  const admin = serviceClient(stack);
  for (const identity of identities) {
    await admin
      .from('app_accounts')
      .update({ role: identity.role, status: identity.status })
      .eq('id', identity.id);
  }
}
