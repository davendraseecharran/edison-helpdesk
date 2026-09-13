/**
 * The toast queue, as a pure reducer.
 *
 * Time comes in with every action instead of being read from a clock, so the
 * reducer is deterministic and the component that owns the timer decides when
 * "now" is. A success toast leaves on its own five seconds after it appears;
 * the clock stops while the pointer or keyboard focus rests on the stack; an
 * error stays until it is dismissed, because it asks for a decision.
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

export interface ToastState {
  /** Oldest first. */
  toasts: Toast[];
  holds: ToastHold[];
  paused: boolean;
  nextId: number;
}

export type ToastAction =
  | { type: 'push'; kind: ToastKind; text: string; now: number }
  | { type: 'dismiss'; id: number }
  | { type: 'hold'; by: ToastHold; now: number }
  | { type: 'release'; by: ToastHold; now: number }
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

/** Nothing can be hovered or focused once the stack is empty, so no hold survives it. */
function settle(state: ToastState, toasts: Toast[]): ToastState {
  if (toasts.length === 0) return { ...state, toasts, holds: [], paused: false };
  return { ...state, toasts };
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
      return {
        ...state,
        nextId: state.nextId + 1,
        toasts: withinLimit([...state.toasts, toast]),
      };
    }

    case 'dismiss': {
      const toasts = state.toasts.filter((toast) => toast.id !== action.id);
      return toasts.length === state.toasts.length ? state : settle(state, toasts);
    }

    case 'hold': {
      if (state.holds.includes(action.by)) return state;
      return {
        ...state,
        holds: [...state.holds, action.by],
        paused: true,
        toasts: state.paused
          ? state.toasts
          : state.toasts.map((toast) => stopClock(toast, action.now)),
      };
    }

    case 'release': {
      if (!state.holds.includes(action.by)) return state;
      const holds = state.holds.filter((hold) => hold !== action.by);
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
      return toasts.length === state.toasts.length ? state : settle(state, toasts);
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
