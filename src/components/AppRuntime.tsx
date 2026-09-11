'use client';

/**
 * Client runtime for the authenticated application.
 *
 * Replaces the M1 demo store. The differences that matter:
 *   - It holds no ticket dataset. Ticket data is server-rendered per request
 *     from the database under the caller's own RLS, so nothing authenticated is
 *     cached in a long-lived client store that could outlive a sign-out or an
 *     account change.
 *   - `run()` invokes a real server action and then refreshes the server data,
 *     so queues, counts and detail views all reflect the committed state.
 *   - One action at a time, so a double click cannot submit twice.
 */

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from 'react';
import { useRouter } from 'next/navigation';
import type { Account, Requester } from '@/lib/domain/types';
import type { ActorAccount } from '@/lib/auth/session';
import type { ActionResult } from '@/lib/data/actions';

export interface FlashMessage {
  kind: 'success' | 'error';
  text: string;
}

export interface AppRuntime {
  actor: ActorAccount;
  /** Minimal labels only: id, name, role, status. Never another account's email. */
  directory: Account[];
  /** Minimal requester records, for recording a walk-in. Not a directory. */
  requesters: Requester[];
  /** School-local (America/New_York) date, computed on the server. */
  today: string;
  pendingKey: string | null;
  flash: FlashMessage | null;
  dismissFlash: () => void;
  run: (key: string, action: () => Promise<ActionResult>) => Promise<ActionResult>;
}

const RuntimeContext = createContext<AppRuntime | null>(null);

export function AppRuntimeProvider({
  actor,
  directory,
  requesters,
  today,
  children,
}: {
  actor: ActorAccount;
  directory: Account[];
  requesters: Requester[];
  today: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [flash, setFlash] = useState<FlashMessage | null>(null);
  const [, startTransition] = useTransition();
  // Synchronous guard: React state updates are async, so two fast clicks could
  // both pass a state-based check before either re-render lands.
  const busy = useRef(false);

  const dismissFlash = useCallback(() => setFlash(null), []);

  const run = useCallback(
    async (key: string, action: () => Promise<ActionResult>): Promise<ActionResult> => {
      if (busy.current) {
        return { ok: false, error: 'Another change is saving. Try again in a moment.' };
      }
      busy.current = true;
      setPendingKey(key);
      setFlash(null);

      try {
        const result = await action();
        if (result.ok) {
          if (result.message) setFlash({ kind: 'success', text: result.message });
          // Pull fresh server data so every queue, badge and panel agrees with
          // what actually committed, including changes made by other people.
          startTransition(() => router.refresh());
        } else {
          setFlash({ kind: 'error', text: result.error ?? 'That change could not be saved.' });
        }
        return result;
      } catch {
        const error = 'That change could not be saved. Check your connection and try again.';
        setFlash({ kind: 'error', text: error });
        return { ok: false, error };
      } finally {
        busy.current = false;
        setPendingKey(null);
      }
    },
    [router],
  );

  const value = useMemo<AppRuntime>(
    () => ({ actor, directory, requesters, today, pendingKey, flash, dismissFlash, run }),
    [actor, directory, requesters, today, pendingKey, flash, dismissFlash, run],
  );

  return <RuntimeContext.Provider value={value}>{children}</RuntimeContext.Provider>;
}

export function useRuntime(): AppRuntime {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error('useRuntime must be used inside AppRuntimeProvider');
  return runtime;
}

/** The signed-in account, in the shape the approved panels already expect. */
export function useActorAccount(): Account {
  const { actor } = useRuntime();
  return useMemo<Account>(
    () => ({
      id: actor.id,
      displayName: actor.displayName,
      email: actor.email,
      role: actor.role,
      status: actor.status,
      createdAt: '',
      lastCredentialActionAt: null,
      lastCredentialActionKind: null,
    }),
    [actor],
  );
}
