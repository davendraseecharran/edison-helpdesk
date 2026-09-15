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
 *   - What an action reports back becomes a toast, raised in the same event as
 *     the result. The stack itself is Sonner's and lives outside React state,
 *     so a message arriving, pausing or expiring re-renders nothing here.
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
import type { Account } from '@/lib/domain/types';
import type { ActorAccount } from '@/lib/auth/session';
import type { ActionResult } from '@/lib/data/actions';
import type { SavedView } from '@/lib/domain/saved-views';
import { showToast } from '@/components/ui/shadcn/sonner';
import { say } from '@/lib/voice/moments';
import type { ToastKind } from '@/components/ui/toast';

export interface AppRuntime {
  actor: ActorAccount;
  /** Minimal labels only: id, name, role, status. Never another account's email. */
  directory: Account[];
  /** Minimal requester records, for recording a walk-in. Not a directory. */
  /** School-local (America/New_York) date, computed on the server. */
  today: string;
  /** Filter sets this account named, from `account_preferences`. Newest first. */
  savedViews: SavedView[];
  pendingKey: string | null;
  /** Show a message outside `run()`, for example after a client-side check. */
  notify: (kind: ToastKind, text: string) => void;
  /**
   * Run one server action with the shared busy guard, refresh on success, and
   * report the outcome.
   *
   * `inlineError` is for a caller that shows the failure itself, beside the
   * field it belongs to. The same sentence in two places at once is not twice
   * as clear: the toast draws the eye away from the field it is about, and it
   * leaves five seconds later while the real message stays, so the reader is
   * told twice and then told nothing. Success is still announced — there is no
   * field for "saved" to appear beside.
   */
  run: (
    key: string,
    action: () => Promise<ActionResult>,
    options?: { inlineError?: boolean },
  ) => Promise<ActionResult>;
}

const RuntimeContext = createContext<AppRuntime | null>(null);

export function AppRuntimeProvider({
  actor,
  directory,
  today,
  savedViews,
  children,
}: {
  actor: ActorAccount;
  directory: Account[];
  today: string;
  savedViews?: SavedView[];
  children: ReactNode;
}) {
  const router = useRouter();
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  // Synchronous guard: React state updates are async, so two fast clicks could
  // both pass a state-based check before either re-render lands.
  const busy = useRef(false);

  const notify = useCallback((kind: ToastKind, text: string) => showToast(kind, text), []);

  const run = useCallback(
    async (
      key: string,
      action: () => Promise<ActionResult>,
      options?: { inlineError?: boolean },
    ): Promise<ActionResult> => {
      if (busy.current) {
        return { ok: false, error: 'Another change is saving. Try again in a moment.' };
      }
      busy.current = true;
      setPendingKey(key);

      try {
        const result = await action();
        if (result.ok) {
          if (result.message) notify('success', result.message);
          // Pull fresh server data so every queue, badge and panel agrees with
          // what actually committed, including changes made by other people.
          startTransition(() => router.refresh());
        } else {
          // The database says what happened whenever it can. `error.generic` is
          // the line for when it cannot: it says the same two things every
          // unexplained failure has to say — it did not go through, and nothing
          // changed. The seeds pin the variant so the generic error is not a
          // different sentence each time it happens.
          if (!options?.inlineError) {
            notify('error', result.error ?? say('error.generic', { seed: 0 }));
          }
        }
        return result;
      } catch {
        // A request that never arrived is the one case where "check your
        // connection" is advice rather than noise.
        const error = say('error.generic', { seed: 2 });
        // A request that never arrived has no field to belong to, so this one
        // is announced even when the caller places its own errors.
        notify('error', error);
        return { ok: false, error };
      } finally {
        busy.current = false;
        setPendingKey(null);
      }
    },
    [router, notify],
  );

  const views = useMemo(() => savedViews ?? [], [savedViews]);
  const value = useMemo<AppRuntime>(
    () => ({ actor, directory, today, savedViews: views, pendingKey, notify, run }),
    [actor, directory, today, views, pendingKey, notify, run],
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
