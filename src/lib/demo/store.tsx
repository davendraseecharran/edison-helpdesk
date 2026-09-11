'use client';

/**
 * ⚠️ TEST FIXTURE ONLY — NOT PART OF THE APPLICATION.
 *
 * This was the M1 prototype store. As of M3 no route, layout or component
 * imports it: the application authenticates against Supabase Auth and reads
 * persisted data through the database. It is retained solely because the
 * offline unit suite exercises its mutation-guard behaviour.
 *
 * It must never be reintroduced into the component tree. It performs no
 * authentication, and wiring it in as a fallback when configuration is missing
 * or login fails would be an authentication bypass.
 */

/**
 * Prototype-only state container.
 *
 * ⚠️ This is NOT authentication and NOT a database.
 *
 * - All data lives in React state in one browser tab. A reload discards every
 *   change and rebuilds the synthetic dataset; nothing is written to
 *   localStorage, sessionStorage, cookies, or any server.
 * - `signInAs` selects a demo identity from a labelled switcher. It checks no
 *   password, issues no token, and grants nothing. It exists so a reviewer can
 *   look at the admin, owner, collaborator and unrelated-technician views.
 * - The permission checks invoked here run in the browser and are therefore
 *   bypassable by anyone with developer tools. Real enforcement (Supabase Auth +
 *   row-level security + atomic claim/resolve) is milestone M2/M3 work.
 *
 * The `mutate` wrapper is shaped like an async server action so M2 can replace
 * its body with a real call without touching the views.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  Account,
  AccountId,
  HelpdeskData,
  OperationContext,
  OperationResult,
} from '../domain/types';
import { findAccount } from '../domain/permissions';
import { toDateKey } from '../format';
import { createDemoData } from './fixtures';
import { DemoMutationGuard } from './mutation-guard';

/** Simulated round-trip so loading and disabled states are reviewable. */
const SIMULATED_LATENCY_MS = 260;
/** Simulated first load so skeleton states are reviewable. */
const SIMULATED_BOOT_MS = 450;

export type DemoPhase = 'booting' | 'signed_out' | 'ready';

export interface FlashMessage {
  kind: 'success' | 'error';
  text: string;
}

type Mutation = (data: HelpdeskData, context: OperationContext) => OperationResult;

export interface DemoStore {
  phase: DemoPhase;
  data: HelpdeskData;
  actor: Account | null;
  /** Accounts offered by the demo switcher, including unusable ones. */
  demoAccounts: Account[];
  flash: FlashMessage | null;
  /** Key of the action currently running, for per-button pending states. */
  pendingKey: string | null;
  /** School-local `YYYY-MM-DD` used for "today" defaults. */
  today: string;
  signInAs: (accountId: AccountId) => void;
  signOut: () => void;
  resetDemoData: () => void;
  dismissFlash: () => void;
  /**
   * Runs a domain operation. Resolves with the result so forms can show field
   * errors; successes also raise a flash message.
   */
  mutate: (key: string, mutation: Mutation) => Promise<OperationResult>;
}

const DemoStoreContext = createContext<DemoStore | null>(null);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function DemoStoreProvider({ children }: { children: ReactNode }) {
  // Empty until the client mounts: the dataset is clock-dependent, and building
  // it after mount keeps server and client markup identical.
  const [data, setData] = useState<HelpdeskData | null>(null);
  const [phase, setPhase] = useState<DemoPhase>('booting');
  const [actorId, setActorId] = useState<AccountId | null>(null);
  const [flash, setFlash] = useState<FlashMessage | null>(null);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [today, setToday] = useState<string>('');
  const mounted = useRef(true);
  const [mutationGuard] = useState(() => new DemoMutationGuard());

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    const timer = setTimeout(() => {
      if (cancelled) return;
      setData(createDemoData(new Date()));
      setToday(toDateKey(new Date()));
      setPhase('signed_out');
    }, SIMULATED_BOOT_MS);

    return () => {
      cancelled = true;
      mounted.current = false;
      mutationGuard.invalidate();
      clearTimeout(timer);
    };
  }, [mutationGuard]);

  const signInAs = useCallback((nextActorId: AccountId) => {
    mutationGuard.invalidate();
    setPendingKey(null);
    setActorId(nextActorId);
    setPhase('ready');
    setFlash(null);
  }, [mutationGuard]);

  const signOut = useCallback(() => {
    mutationGuard.invalidate();
    setPendingKey(null);
    setActorId(null);
    setPhase('signed_out');
    setFlash(null);
  }, [mutationGuard]);

  const resetDemoData = useCallback(() => {
    mutationGuard.invalidate();
    setPendingKey(null);
    setData(createDemoData(new Date()));
    setToday(toDateKey(new Date()));
    setFlash({ kind: 'success', text: 'Demo data reset to the original synthetic dataset.' });
  }, [mutationGuard]);

  const dismissFlash = useCallback(() => {
    setFlash(null);
  }, []);

  const mutate = useCallback(
    async (key: string, mutation: Mutation): Promise<OperationResult> => {
      if (!data || !actorId) {
        return { ok: false, error: 'Select a demo user first.' };
      }
      // Synchronous guard: two panels can submit before React rerenders their
      // disabled states. Do not let both write snapshots captured by this render.
      const token = mutationGuard.begin();
      if (!token) return { ok: false, error: 'Another action is saving. Please try again.' };
      setPendingKey(key);
      setFlash(null);
      try {
        await sleep(SIMULATED_LATENCY_MS);
        if (!mounted.current || !mutationGuard.isCurrent(token)) {
          return { ok: false, error: 'Action cancelled because the demo session changed.' };
        }
        const context: OperationContext = {
          actorId,
          now: new Date().toISOString(),
          today: toDateKey(new Date()),
        };
        const result = mutation(data, context);
        if (result.ok) {
          setData(result.data);
          setToday(context.today);
          if (result.message) setFlash({ kind: 'success', text: result.message });
        } else {
          setFlash({ kind: 'error', text: result.error });
        }
        return result;
      } catch {
        const error = 'The action could not be saved. Please try again.';
        if (mounted.current && mutationGuard.isCurrent(token)) {
          setFlash({ kind: 'error', text: error });
        }
        return { ok: false, error };
      } finally {
        // A cancelled old request must not clear a newer request's pending state.
        if (mutationGuard.finish(token) && mounted.current) setPendingKey(null);
      }
    },
    [actorId, data, mutationGuard],
  );

  const value = useMemo<DemoStore>(() => {
    const safeData: HelpdeskData =
      data ??
      ({
        accounts: [],
        requesters: [],
        tickets: [],
        deviceObservations: [],
        notes: [],
        workLogs: [],
        activity: [],
        sequences: { ticketNumber: 0, entity: 0 },
      } satisfies HelpdeskData);

    return {
      phase,
      data: safeData,
      actor: findAccount(safeData, actorId),
      demoAccounts: safeData.accounts,
      flash,
      pendingKey,
      today,
      signInAs,
      signOut,
      resetDemoData,
      dismissFlash,
      mutate,
    };
  }, [
    data,
    phase,
    actorId,
    flash,
    pendingKey,
    today,
    signInAs,
    signOut,
    resetDemoData,
    dismissFlash,
    mutate,
  ]);

  return <DemoStoreContext.Provider value={value}>{children}</DemoStoreContext.Provider>;
}

export function useDemoStore(): DemoStore {
  const store = useContext(DemoStoreContext);
  if (!store) {
    throw new Error('useDemoStore must be used inside DemoStoreProvider');
  }
  return store;
}
