'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { signInAction } from '@/lib/auth/actions';
import { Field } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';

/**
 * `next` is the page a phone was trying to reach before it was asked to sign
 * in. The login page has already checked it; the action checks it again and
 * returns what it decided, so this component never chooses a destination.
 */
export function LoginForm({ next }: { next?: string }) {
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
      const result = await signInAction(email, password, next);
      if (!result.ok) {
        setError(result.error ?? 'Sign-in failed.');
        setPassword('');
        return;
      }
      // The server decides where an authenticated identity belongs: an active
      // account goes to the queue (or back to the scanner page it came from),
      // a restricted one to its own screen.
      router.replace(result.next ?? '/queue');
      router.refresh();
    });
  }

  return (
    <form className="auth-form" onSubmit={onSubmit} noValidate>
      <Field label="School email" htmlFor="login-email">
        <input
          id="login-email"
          name="email"
          type="email"
          autoComplete="username"
          required
          value={email}
          disabled={pending}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="first.last@edison.example"
        />
      </Field>

      <Field label="App password" htmlFor="login-password" error={error}>
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

      <Button type="submit" variant="primary" block loading={pending} className="auth-submit">
        Sign in
      </Button>
    </form>
  );
}
