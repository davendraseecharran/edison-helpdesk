'use client';

/** Small shared building blocks: time display, empty states, skeletons, avatars. */

import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { useRuntime } from '@/components/AppRuntime';
import { Button } from '@/components/ui/Button';
import { LoadingRegion, Skeleton } from '@/components/ui/Skeleton';
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

export function Flash() {
  const { flash, dismissFlash } = useRuntime();
  if (!flash) return null;

  return (
    <div
      className={flash.kind === 'success' ? 'flash flash-success' : 'flash flash-error'}
      role={flash.kind === 'error' ? 'alert' : 'status'}
    >
      <span className="flash-text">{flash.text}</span>
      <Button variant="ghost" size="sm" icon={X} aria-label="Dismiss message" onClick={dismissFlash} />
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
