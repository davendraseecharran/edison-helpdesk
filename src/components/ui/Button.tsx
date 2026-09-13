'use client';

import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import Link from 'next/link';
import { LoaderCircle } from 'lucide-react';
import { Icon, type LucideIcon } from './Icon';

export type ButtonVariant = 'primary' | 'secondary' | 'ghost' | 'danger';
export type ButtonSize = 'sm' | 'md';

interface SharedProps {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Leading icon. With no children the button is icon-only and needs `aria-label`. */
  icon?: LucideIcon;
  /** Stretch to the container's width. */
  block?: boolean;
  className?: string;
  children?: ReactNode;
}

export interface ButtonProps
  extends SharedProps,
    Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'className' | 'children'> {
  /** Shows a spinner, announces busy state and blocks further presses. */
  loading?: boolean;
}

export function buttonClass({
  variant = 'secondary',
  size = 'md',
  block,
  iconOnly,
  className,
}: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  block?: boolean;
  iconOnly?: boolean;
  className?: string;
}): string {
  const parts = ['btn', `btn-${variant}`];
  if (size === 'sm') parts.push('btn-sm');
  if (block) parts.push('btn-block');
  if (iconOnly) parts.push('btn-icon');
  if (className) parts.push(className);
  return parts.join(' ');
}

/**
 * The one button.
 *
 * `primary` is the brass fill and there should be one per view at most; the
 * others are quiet. `loading` is the only state that changes the label area:
 * the spinner replaces the icon so the width barely moves.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, icon, block, className, children, loading = false, disabled, type, ...rest },
  ref,
) {
  const iconOnly = !children;
  const iconSize = size === 'sm' ? 16 : 18;
  return (
    <button
      ref={ref}
      type={type ?? 'button'}
      className={buttonClass({ variant, size, block, iconOnly, className })}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? (
        <Icon icon={LoaderCircle} size={iconSize} className="icon-spin" />
      ) : icon ? (
        <Icon icon={icon} size={iconSize} />
      ) : null}
      {children}
    </button>
  );
});

export interface ButtonLinkProps extends SharedProps {
  href: string;
  'aria-label'?: string;
  title?: string;
  prefetch?: boolean;
  /** Below 720px keep only the icon; the label becomes the accessible name. */
  collapseOnPhone?: boolean;
}

/** A link dressed as a button, for navigation that reads as an action. */
export function ButtonLink({
  href,
  variant,
  size,
  icon,
  block,
  className,
  children,
  collapseOnPhone,
  prefetch,
  ...rest
}: ButtonLinkProps) {
  const iconOnly = !children;
  const iconSize = size === 'sm' ? 16 : 18;
  const classes = buttonClass({
    variant,
    size,
    block,
    iconOnly,
    className: collapseOnPhone ? `btn-collapse ${className ?? ''}`.trim() : className,
  });
  return (
    <Link href={href} className={classes} prefetch={prefetch} {...rest}>
      {icon ? <Icon icon={icon} size={iconSize} /> : null}
      {collapseOnPhone ? <span className="btn-label">{children}</span> : children}
    </Link>
  );
}
