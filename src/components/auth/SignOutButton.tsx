'use client';

import { useTransition } from 'react';
import { signOutAction } from '@/lib/auth/actions';

export function SignOutButton({ label = 'Sign out' }: { label?: string }) {
  const [pending, startTransition] = useTransition();

  return (
    <button
      type="button"
      className="btn btn-sm"
      disabled={pending}
      onClick={() => startTransition(() => signOutAction())}
    >
      {pending ? 'Signing out…' : label}
    </button>
  );
}
