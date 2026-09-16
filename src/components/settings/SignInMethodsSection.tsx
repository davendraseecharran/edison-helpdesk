'use client';

/**
 * Sign-in methods: one account, and the two doors into it.
 *
 * The trap this section exists to close is the one nobody sees coming. Somebody
 * invited as `first.last@school` presses "Continue with Google" with a personal
 * address, and the helpdesk does the only safe thing it can: it makes a second
 * account and asks an administrator about it. Both accounts are real, neither is
 * the one they wanted, and the fix is an apology by email. Adding the other
 * method from INSIDE an account they are already signed in to cannot produce a
 * second account, so this is the screen where the two are joined.
 *
 * Google is added by the provider and the callback; a password is set here and
 * approved by the database. Neither row shows anything the reader did not
 * already know about themselves: the address of their own identity, and whether
 * they have a password.
 */

import { useId, useState } from 'react';
import { useFormStatus } from 'react-dom';
import { Check, Circle } from 'lucide-react';
import { useRuntime } from '@/components/AppRuntime';
import { Field } from '@/components/Primitives';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import {
  addGoogleIdentityAction,
  setOwnPasswordAction,
} from '@/lib/auth/sign-in-method-actions';
import { PASSWORD_MIN, passwordChecks, passwordReady } from '@/lib/domain/password';
import { SettingRow, SettingsSection } from './parts';

/** The mark drawn in the current colour, as on the sign-in page. */
function GoogleMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M21.35 11.1h-9.17v2.96h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.75h3.57c2.09-1.93 3.29-4.77 3.29-8.14 0-.35-.02-.68-.05-1a8.7 8.7 0 0 0-1.35.12ZM12.18 22c2.7 0 4.96-.9 6.61-2.43l-3.57-2.75c-.99.66-2.26 1.06-3.04 1.06-2.86 0-5.29-1.93-6.16-4.53H2.33v2.84A9.98 9.98 0 0 0 12.18 22ZM6.02 13.35a5.99 5.99 0 0 1 0-3.83V6.68H2.33a10 10 0 0 0 0 8.97l3.69-2.3ZM12.18 5.58c1.47 0 2.79.51 3.83 1.5l2.87-2.87C17.13 2.55 14.88 1.6 12.18 1.6c-3.9 0-7.27 2.24-8.9 5.5l3.69 2.84c.87-2.6 3.3-4.36 6.16-4.36Z" />
    </svg>
  );
}

/**
 * A plain form posting to a server action, so it works before hydration and
 * without JavaScript: the action asks the auth server for the URL and redirects
 * the browser to it. What comes back arrives at `/auth/callback`, and the
 * message — linked, or linking switched off — is on the page it returns to.
 */
function AddGoogleButton() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="secondary" loading={pending}>
      {pending ? null : <GoogleMark />}
      Add Google
    </Button>
  );
}

/**
 * The password form, opened by the row above it.
 *
 * It is closed until it is asked for, because it is the one control on this
 * screen that is not a setting — nothing here shows a password's value, and a
 * pair of empty boxes sitting open says otherwise. The failure is shown beside
 * the field rather than as a toast: it is about what was typed, and the toast
 * would leave five seconds later while the boxes stayed.
 */
function PasswordForm({
  id,
  hasPassword,
  onSaved,
}: {
  id: string;
  hasPassword: boolean;
  onSaved: () => void;
}) {
  const { pendingKey, run } = useRuntime();
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [error, setError] = useState<string | null>(null);
  const passwordId = useId();
  const confirmId = useId();

  const checks = passwordChecks(password, confirmation);
  const ready = passwordReady(password, confirmation);
  const saving = pendingKey === 'own-password';

  async function save() {
    if (!ready || saving) return;
    setError(null);
    const result = await run('own-password', () => setOwnPasswordAction(password), {
      inlineError: true,
    });
    setPassword('');
    setConfirmation('');
    if (!result.ok) {
      setError(result.error ?? 'The password could not be saved.');
      return;
    }
    onSaved();
  }

  /*
   * `method="post"` on a form whose submit JavaScript always intercepts, for
   * the same reason the sign-in form carries it: before React has hydrated a
   * press submits natively, and a GET would put the password in the address
   * bar, the history and the server log.
   */
  return (
    <form
      id={id}
      className="setting-password"
      method="post"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <Field label="New app password" htmlFor={passwordId} error={error}>
        <input
          id={passwordId}
          type="password"
          autoComplete="new-password"
          required
          value={password}
          disabled={saving}
          aria-invalid={error ? 'true' : undefined}
          onChange={(event) => {
            setPassword(event.target.value);
            setError(null);
          }}
        />
      </Field>

      <Field label="Confirm app password" htmlFor={confirmId}>
        <input
          id={confirmId}
          type="password"
          autoComplete="new-password"
          required
          value={confirmation}
          disabled={saving}
          onChange={(event) => {
            setConfirmation(event.target.value);
            setError(null);
          }}
        />
      </Field>

      <ul className="setting-checks" aria-label="Password requirements">
        {checks.map((check) => (
          <li
            key={check.label}
            className={check.passed ? 'setting-check setting-check-met' : 'setting-check'}
          >
            <Icon icon={check.passed ? Check : Circle} size={14} />
            {check.label}
            <span className="visually-hidden">{check.passed ? ' — met' : ' — not met'}</span>
          </li>
        ))}
      </ul>

      <Button type="submit" variant="secondary" loading={saving} disabled={!ready}>
        {hasPassword ? 'Change password' : 'Set password'}
      </Button>
    </form>
  );
}

export function SignInMethodsSection({
  googleEmail,
  hasPassword,
}: {
  googleEmail: string | null;
  hasPassword: boolean;
}) {
  const [open, setOpen] = useState(false);
  const formId = useId();

  return (
    <SettingsSection
      title="Sign-in methods"
      description="One account, two ways in. Add the second one before the day you need it."
    >
      <SettingRow
        label="Google"
        hint={
          googleEmail
            ? 'One press on the sign-in page.'
            : 'Sign in with one press, on any machine you are already signed in to.'
        }
      >
        {googleEmail ? (
          <span className="setting-value">Linked as {googleEmail}</span>
        ) : (
          <form action={addGoogleIdentityAction}>
            <AddGoogleButton />
          </form>
        )}
      </SettingRow>

      <SettingRow
        label="Password"
        hint={
          hasPassword
            ? 'Your address and this password sign you in when Google cannot.'
            : `A way in that does not need Google. At least ${PASSWORD_MIN} characters.`
        }
      >
        <Button
          variant="secondary"
          aria-expanded={open}
          aria-controls={formId}
          onClick={() => setOpen((shown) => !shown)}
        >
          {open ? 'Cancel' : hasPassword ? 'Change' : 'Set'}
        </Button>
      </SettingRow>

      {open ? (
        <PasswordForm id={formId} hasPassword={hasPassword} onSaved={() => setOpen(false)} />
      ) : null}
    </SettingsSection>
  );
}
