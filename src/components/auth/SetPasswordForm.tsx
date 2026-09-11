'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { completeCredentialAction } from '@/lib/auth/credential-actions';
import { Field } from '@/components/Primitives';

const MIN_LENGTH = 12;

export function SetPasswordForm({ isSetup }: { isSetup: boolean }) {
  const router = useRouter();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const checks = [
    { label: `At least ${MIN_LENGTH} characters`, passed: password.length >= MIN_LENGTH },
    {
      label: 'Mixes letters and numbers',
      passed: /[a-zA-Z]/.test(password) && /\d/.test(password),
    },
    { label: 'Both entries match', passed: password.length > 0 && password === confirmation },
  ];
  const ready = checks.every((check) => check.passed);

  function onSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    // Guard against a double submit changing the password twice.
    if (pending) return;
    setError(null);

    startTransition(async () => {
      const result = await completeCredentialAction(password, confirmation);
      setPassword('');
      setConfirmation('');
      if (!result.ok) {
        setError(result.error ?? 'The password could not be set.');
        return;
      }
      // Completion signs every session out, including this one, so the next
      // step is always a fresh sign-in with the new password.
      router.replace(`/login?setup=${result.purpose === 'setup' ? 'done' : 'recovered'}`);
      router.refresh();
    });
  }

  return (
    <form className="stack" onSubmit={onSubmit} noValidate>
      <Field label="New app password" htmlFor="setup-password" error={error}>
        <input
          id="setup-password"
          type="password"
          autoComplete="new-password"
          required
          value={password}
          disabled={pending}
          aria-invalid={error ? 'true' : undefined}
          onChange={(event) => {
            setPassword(event.target.value);
            setError(null);
          }}
        />
      </Field>

      <Field label="Confirm app password" htmlFor="setup-confirm">
        <input
          id="setup-confirm"
          type="password"
          autoComplete="new-password"
          required
          value={confirmation}
          disabled={pending}
          onChange={(event) => {
            setConfirmation(event.target.value);
            setError(null);
          }}
        />
      </Field>

      <ul className="stack-sm small" style={{ margin: 0, paddingLeft: 18 }}>
        {checks.map((check) => (
          <li key={check.label} className={check.passed ? 'muted' : 'subtle'}>
            <span aria-hidden="true">{check.passed ? '✓ ' : '· '}</span>
            {check.label}
            <span className="sr-only">{check.passed ? ' — met' : ' — not met'}</span>
          </li>
        ))}
      </ul>

      <button type="submit" className="btn btn-primary btn-block" disabled={pending || !ready}>
        {pending ? 'Saving…' : isSetup ? 'Set password and activate' : 'Change password'}
      </button>
    </form>
  );
}
