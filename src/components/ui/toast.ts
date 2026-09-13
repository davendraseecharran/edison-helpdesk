/**
 * The toast queue, as a pure reducer.
 *
 * Time comes in with every action instead of being read from a clock, so the
 * reducer is deterministic and the component that owns the timer decides when
 * "now" is. A success toast leaves on its own five seconds after it appears;
 * the clock stops while the pointer or keyboard focus rests on a toast; an
 * error stays until it is dismissed, because it asks for a decision.
 *
 * A hold belongs to the toast it rests on. The browser sends no leave or blur
 * for an element that is removed, so when a toast goes (dismissed, expired,
 * or pushed out by the limit) its holds go with it, and the survivors' clocks
 * restart if that was the last one. Without this, closing a focused toast
 * would stop every other toast's clock for good.
 */

export type ToastKind = 'success' | 'error';

/** What is keeping the clock stopped. Both can apply at once. */
export type ToastHold = 'hover' | 'focus';

export interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  /**
   * Epoch milliseconds at which the toast leaves on its own. Null while the
   * clock is stopped, and always null for an error.
   */
  deadline: number | null;
  /**
   * Life left in milliseconds, kept while paused so resuming continues the
   * countdown rather than restarting it. Null for an error.
   */
  remaining: number | null;
}

/** One reason the clock is stopped, and the toast it rests on. */
export interface ToastHoldRecord {
  by: ToastHold;
  toast: number;
}

export interface ToastState {
  /** Oldest first. */
  toasts: Toast[];
  holds: ToastHoldRecord[];
  paused: boolean;
  nextId: number;
}

export type ToastAction =
  | { type: 'push'; kind: ToastKind; text: string; now: number }
  | { type: 'dismiss'; id: number; now: number }
  | { type: 'hold'; by: ToastHold; toast: number; now: number }
  | { type: 'release'; by: ToastHold; toast: number; now: number }
  | { type: 'expire'; now: number };

export const TOAST_LIFETIME_MS = 5_000;

/** The most toasts on screen at once; beyond this the oldest success goes. */
export const TOAST_LIMIT = 3;

export const initialToastState: ToastState = {
  toasts: [],
  holds: [],
  paused: false,
  nextId: 1,
};

/**
 * Drop the oldest success when the stack overflows. An error is only pushed
 * out by other errors: a message that asks for a decision must not vanish
 * behind two quick confirmations.
 */
function withinLimit(toasts: Toast[]): Toast[] {
  if (toasts.length <= TOAST_LIMIT) return toasts;
  const victim = toasts.find((toast) => toast.kind !== 'error') ?? toasts[0];
  return toasts.filter((toast) => toast !== victim);
}

function stopClock(toast: Toast, now: number): Toast {
  if (toast.deadline === null) return toast;
  return { ...toast, deadline: null, remaining: Math.max(0, toast.deadline - now) };
}

function startClock(toast: Toast, now: number): Toast {
  if (toast.remaining === null || toast.deadline !== null) return toast;
  return { ...toast, deadline: now + toast.remaining };
}

function sameHold(record: ToastHoldRecord, by: ToastHold, toast: number): boolean {
  return record.by === by && record.toast === toast;
}

/**
 * Settle a new list of toasts. Holds whose toast has gone are dropped, and if
 * that was the last hold the survivors' clocks restart from `now`.
 */
function withToasts(state: ToastState, toasts: Toast[], now: number): ToastState {
  const holds = state.holds.filter((hold) => toasts.some((toast) => toast.id === hold.toast));
  if (state.paused && holds.length === 0) {
    return {
      ...state,
      toasts: toasts.map((toast) => startClock(toast, now)),
      holds,
      paused: false,
    };
  }
  return { ...state, toasts, holds };
}

export function toastReducer(state: ToastState, action: ToastAction): ToastState {
  switch (action.type) {
    case 'push': {
      const lifetime = action.kind === 'error' ? null : TOAST_LIFETIME_MS;
      const deadline = lifetime === null || state.paused ? null : action.now + lifetime;
      const existing = state.toasts.find(
        (toast) => toast.kind === action.kind && toast.text === action.text,
      );
      if (existing) {
        // The same message again refreshes the one on screen instead of
        // stacking a duplicate.
        return {
          ...state,
          toasts: state.toasts.map((toast) =>
            toast === existing ? { ...toast, deadline, remaining: lifetime } : toast,
          ),
        };
      }
      const toast: Toast = {
        id: state.nextId,
        kind: action.kind,
        text: action.text,
        deadline,
        remaining: lifetime,
      };
      return withToasts(
        { ...state, nextId: state.nextId + 1 },
        withinLimit([...state.toasts, toast]),
        action.now,
      );
    }

    case 'dismiss': {
      const toasts = state.toasts.filter((toast) => toast.id !== action.id);
      return toasts.length === state.toasts.length ? state : withToasts(state, toasts, action.now);
    }

    case 'hold': {
      // A hold can only rest on a toast that is on the stack; one that arrives
      // for a toast already gone (its exit still playing) is ignored.
      if (!state.toasts.some((toast) => toast.id === action.toast)) return state;
      if (state.holds.some((hold) => sameHold(hold, action.by, action.toast))) return state;
      return {
        ...state,
        holds: [...state.holds, { by: action.by, toast: action.toast }],
        paused: true,
        toasts: state.paused
          ? state.toasts
          : state.toasts.map((toast) => stopClock(toast, action.now)),
      };
    }

    case 'release': {
      if (!state.holds.some((hold) => sameHold(hold, action.by, action.toast))) return state;
      const holds = state.holds.filter((hold) => !sameHold(hold, action.by, action.toast));
      if (holds.length > 0) return { ...state, holds };
      return {
        ...state,
        holds,
        paused: false,
        toasts: state.toasts.map((toast) => startClock(toast, action.now)),
      };
    }

    case 'expire': {
      const toasts = state.toasts.filter(
        (toast) => toast.deadline === null || toast.deadline > action.now,
      );
      return toasts.length === state.toasts.length ? state : withToasts(state, toasts, action.now);
    }
  }
}

/** The earliest deadline on the stack, for scheduling a single timer. Null when nothing will expire. */
export function nextDeadline(state: ToastState): number | null {
  let next: number | null = null;
  for (const toast of state.toasts) {
    if (toast.deadline !== null && (next === null || toast.deadline < next)) {
      next = toast.deadline;
    }
  }
  return next;
}
