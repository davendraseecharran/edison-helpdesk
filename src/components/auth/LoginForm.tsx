'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { signInAction } from '@/lib/auth/actions';
import { Field } from '@/components/Primitives';

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;
    setError(null);

    startTransition(async () => {
      const result = await signInAction(email, password);
      if (!result.ok) {
        setError(result.error ?? 'Sign-in failed.');
        setPassword('');
        return;
      }
      // The server decides where an authenticated identity belongs: an active
      // account goes to the queue, a restricted one to its own screen.
      router.replace('/queue');
      router.refresh();
    });
  }

  return (
    <form className="stack" onSubmit={onSubmit} noValidate>
      <Field label="Email" htmlFor="login-email">
        <input
          id="login-email"
          name="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          disabled={pending}
          onChange={(event) => setEmail(event.target.value)}
        />
      </Field>

      <Field label="Password" htmlFor="login-password" error={error}>
        <input
          id="login-password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          value={password}
          disabled={pending}
          aria-invalid={error ? 'true' : undefined}
          onChange={(event) => setPassword(event.target.value)}
        />
      </Field>

      <button type="submit" className="btn btn-primary btn-block" disabled={pending}>
        {pending ? 'Signing in…' : 'Sign in'}
      </button>
    </form>
  );
}
