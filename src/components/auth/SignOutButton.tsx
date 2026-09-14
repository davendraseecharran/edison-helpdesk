'use client';

import { useTransition } from 'react';
import { signOutAction } from '@/lib/auth/actions';
import { Button, type ButtonSize } from '@/components/ui/Button';

/**
 * Sign out, wherever it appears.
 *
 * `size` exists because this button sits in two kinds of place. In the account
 * menu and the phone navigation sheet it is one small item among several, so
 * `sm` is right. On the restricted and pending screens it is the only action
 * on the page — and on the restricted one it stands beside a 40px primary
 * link, where a 32px button read as the lesser of two choices rather than as
 * the same kind of thing. Those pass `md`.
 */
export function SignOutButton({
  label = 'Sign out',
  size = 'sm',
}: {
  label?: string;
  size?: ButtonSize;
}) {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      size={size}
      loading={pending}
      onClick={() => startTransition(() => signOutAction())}
    >
      {pending ? 'Signing out…' : label}
    </Button>
  );
}
