'use client';

/** Small shared building blocks: time display, empty states, skeletons, avatars, toasts. */

import { useEffect, type Dispatch, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useToasts } from '@/components/AppRuntime';
import { Button } from '@/components/ui/Button';
import { useReducedMotion } from '@/components/ui/media';
import { AnimatePresence, INSTANT, motion } from '@/components/ui/Motion';
import { nextDeadline, type Toast, type ToastAction, type ToastHold } from '@/components/ui/toast';
import { useNow } from '@/lib/useNow';
import { formatAge, formatDateTime, formatRelative, initialsOf } from '@/lib/format';

/**
 * Renders an absolute timestamp on the server and switches to a relative one
 * after mount, so hydration never has to match two different clocks.
 */
export function TimeAgo({ iso, mode = 'relative' }: { iso: string; mode?: 'relative' | 'age' }) {
  const now = useNow();
  const absolute = formatDateTime(iso);
  const text =
    now === null
      ? absolute
      : mode === 'age'
        ? formatAge(iso, now)
        : formatRelative(iso, now);

  return (
    <time dateTime={iso} title={absolute}>
      {text}
    </time>
  );
}

export function Avatar({ name, size = 'sm' }: { name: string; size?: 'sm' | 'md' }) {
  return (
    <span className={size === 'md' ? 'avatar avatar-md' : 'avatar'} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}

export function EmptyState({
  title,
  children,
  action,
}: {
  title: string;
  children?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <p className="empty-title">{title}</p>
      {children ? <p className="empty-body">{children}</p> : null}
      {action ? <div className="empty-action">{action}</div> : null}
    </div>
  );
}

/**
 * The toast stack: what actions reported, bottom-right on a desktop and above
 * the tabs on a phone.
 *
 * The queue itself is the runtime's (`toastReducer`); this component keeps
 * its clock. One timer is armed for the earliest deadline, and the clock
 * stops while the pointer or keyboard focus rests on a toast, so a message
 * cannot vanish while it is being read. Each hold names its toast, so the
 * reducer can let go of it when that toast leaves; the browser sends no
 * blur or leave for an element that is unmounted. A success leaves after
 * five seconds; an error stays until dismissed. The container is a polite
 * live region that is always mounted, so insertions are announced, and each
 * toast keeps its own role so an error is heard at once.
 */
export function Flash() {
  const { toasts, dispatchToast } = useToasts();
  const reduced = useReducedMotion();
  const deadline = nextDeadline(toasts);

  /*
   * A message nobody is looking at has not been read. Switching to another tab
   * stops every clock and coming back starts them again from where they
   * stopped, so "Ticket resolved." is still on screen a minute later rather
   * than having expired into an empty corner. The initial dispatch covers the
   * case where the page was restored into a background tab.
   */
  useEffect(() => {
    function sync(): void {
      dispatchToast({
        type: document.visibilityState === 'hidden' ? 'hide' : 'show',
        now: Date.now(),
      });
    }
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, [dispatchToast]);

  useEffect(() => {
    if (deadline === null) return;
    // Expire at the deadline the timer was armed for, not at whatever the
    // wall clock reads when it fires: a timer that lands a millisecond short
    // would otherwise remove nothing and never be re-armed.
    const timer = window.setTimeout(
      () => dispatchToast({ type: 'expire', now: deadline }),
      Math.max(0, deadline - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [deadline, dispatchToast]);

  return (
    <div className="toasts" aria-live="polite">
      <AnimatePresence initial={false}>
        {toasts.toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} reduced={reduced} dispatch={dispatchToast} />
        ))}
      </AnimatePresence>
    </div>
  );
}

/*
 * A toast is the one surface in the product that arrives unasked, so it is
 * also the one allowed to take its time arriving: 300ms up and out of a blur,
 * 200ms away again.
 */
const TOAST_IN = { duration: 0.3, ease: 'easeOut' } as const;
const TOAST_OUT = { duration: 0.2, ease: 'easeOut' } as const;

/** One toast: its text, its close button, and the holds it puts on the clock. */
function ToastItem({
  toast,
  reduced,
  dispatch,
}: {
  toast: Toast;
  reduced: boolean;
  dispatch: Dispatch<ToastAction>;
}) {
  function hold(by: ToastHold) {
    dispatch({ type: 'hold', by, toast: toast.id, now: Date.now() });
  }

  function release(by: ToastHold) {
    dispatch({ type: 'release', by, toast: toast.id, now: Date.now() });
  }

  return (
    <motion.div
      className={toast.kind === 'success' ? 'toast toast-success' : 'toast toast-error'}
      role={toast.kind === 'error' ? 'alert' : 'status'}
      layout={reduced ? false : 'position'}
      /*
       * A toast rises from below the corner it lives in and resolves out of a
       * soft blur, over 300ms — slow enough to be noticed arriving, which is
       * the whole job. It leaves in 200ms, because a message that has been
       * read should not make anybody wait for it; an exit as slow as its
       * entrance reads as the interface being reluctant.
       */
      initial={reduced ? false : { opacity: 0, y: 16, filter: 'blur(2px)' }}
      animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
      exit={reduced ? undefined : { opacity: 0, y: 8, transition: TOAST_OUT }}
      transition={reduced ? INSTANT : TOAST_IN}
      onPointerEnter={() => hold('hover')}
      onPointerLeave={() => release('hover')}
      onFocus={() => hold('focus')}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) release('focus');
      }}
    >
      <span className="toast-text">{toast.text}</span>
      <Button
        variant="ghost"
        size="sm"
        icon={X}
        aria-label="Dismiss message"
        onClick={() => dispatch({ type: 'dismiss', id: toast.id, now: Date.now() })}
      />
    </motion.div>
  );
}

export function PageHeader({
  title,
  description,
  actions,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="page-header">
      <div className="page-header-text">
        <h1>{title}</h1>
        {description ? <p>{description}</p> : null}
      </div>
      {actions ? <div className="btn-row">{actions}</div> : null}
    </div>
  );
}

export function Field({
  label,
  htmlFor,
  optional,
  hint,
  error,
  children,
  className,
}: {
  label: string;
  htmlFor: string;
  optional?: boolean;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={className ? `field ${className}` : 'field'}>
      <label className="field-label" htmlFor={htmlFor}>
        {label}
        {optional ? <span className="field-optional">optional</span> : null}
      </label>
      {children}
      {hint ? <span className="field-hint">{hint}</span> : null}
      {error ? (
        <span className="field-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
