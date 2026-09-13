'use client';

/** Small shared building blocks: time display, empty states, skeletons, avatars, toasts. */

import { useEffect, type ReactNode } from 'react';
import { X } from 'lucide-react';
import { useRuntime } from '@/components/AppRuntime';
import { Button } from '@/components/ui/Button';
import { useReducedMotion } from '@/components/ui/media';
import { AnimatePresence, EASE_IN_FAST, EASE_OUT, INSTANT, motion } from '@/components/ui/Motion';
import { LoadingRegion, Skeleton } from '@/components/ui/Skeleton';
import { nextDeadline, type ToastHold } from '@/components/ui/toast';
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

export function TableSkeleton({ rows = 5 }: { rows?: number }) {
  return (
    <LoadingRegion label="Loading tickets">
      <div className="skeleton-rows">
        {Array.from({ length: rows }, (_, index) => (
          <div key={index} className="skeleton-row">
            <Skeleton width={72} />
            <Skeleton width="min(360px, 45%)" />
            <Skeleton width={88} />
            <Skeleton width={64} />
          </div>
        ))}
      </div>
    </LoadingRegion>
  );
}

/**
 * The toast stack: what actions reported, bottom-right on a desktop and above
 * the tabs on a phone.
 *
 * The queue itself is the runtime's (`toastReducer`); this component keeps
 * its clock. One timer is armed for the earliest deadline, and the clock
 * stops while the pointer or keyboard focus rests on the stack, so a message
 * cannot vanish while it is being read. A success leaves after five seconds;
 * an error stays until dismissed. Each toast keeps its live-region role, so
 * assistive technology hears a confirmation politely and an error at once.
 */
export function Flash() {
  const { toasts, dispatchToast } = useRuntime();
  const reduced = useReducedMotion();
  const deadline = nextDeadline(toasts);

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

  function hold(by: ToastHold) {
    dispatchToast({ type: 'hold', by, now: Date.now() });
  }

  function release(by: ToastHold) {
    dispatchToast({ type: 'release', by, now: Date.now() });
  }

  return (
    <div
      className="toasts"
      onPointerEnter={() => hold('hover')}
      onPointerLeave={() => release('hover')}
      onFocus={() => hold('focus')}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) release('focus');
      }}
    >
      <AnimatePresence initial={false}>
        {toasts.toasts.map((toast) => (
          <motion.div
            key={toast.id}
            className={toast.kind === 'success' ? 'toast toast-success' : 'toast toast-error'}
            role={toast.kind === 'error' ? 'alert' : 'status'}
            layout={reduced ? false : 'position'}
            initial={reduced ? false : { opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduced ? undefined : { opacity: 0, transition: EASE_IN_FAST }}
            transition={reduced ? INSTANT : EASE_OUT}
          >
            <span className="toast-text">{toast.text}</span>
            <Button
              variant="ghost"
              size="sm"
              icon={X}
              aria-label="Dismiss message"
              onClick={() => dispatchToast({ type: 'dismiss', id: toast.id })}
            />
          </motion.div>
        ))}
      </AnimatePresence>
    </div>
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
