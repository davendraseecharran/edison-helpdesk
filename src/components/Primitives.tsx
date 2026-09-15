'use client';

/** Small shared building blocks: time display, empty states, skeletons, avatars, toasts. */

import { type ReactNode } from 'react';
import { Toaster } from '@/components/ui/shadcn/sonner';
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
 * The toast stack: what actions reported, bottom-right on a desktop and at the
 * top on a phone.
 *
 * Sonner underneath, through `ui/shadcn/sonner`. `Flash` stays the name and
 * stays where it was mounted, because what the shell wants at this point in
 * the tree is "the place messages appear", and that has not changed.
 */
export function Flash() {
  return <Toaster />;
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
