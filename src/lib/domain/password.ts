/**
 * What counts as a usable app password.
 *
 * One place, because three screens ask the same question: the setup and
 * recovery form reached from an administrator's link, the Settings row where an
 * account sets a password for itself, and the server actions behind both. The
 * bounds are the ones the trusted database flow enforces
 * (`app_trusted_complete_credential_action` refuses anything shorter than
 * twelve), so a person is told while they are typing rather than after a
 * refusal.
 *
 * The length is the only rule a server enforces. The other two checks are
 * guidance shown beside the box — a password made of twelve letters is weak
 * advice, not a refusal, and a confirmation that does not match is the reader's
 * own typing rather than a rule about passwords.
 */

export const PASSWORD_MIN = 8;

export interface PasswordCheck {
  label: string;
  passed: boolean;
}

/** The refusal a server returns, or null when the password may be saved. */
export function passwordProblem(password: string): string | null {
  if (password.length < PASSWORD_MIN) return `Use at least ${PASSWORD_MIN} characters.`;
  return null;
}

/** The list shown under the boxes, in the order it is read. */
export function passwordChecks(password: string, confirmation: string): PasswordCheck[] {
  return [
    { label: `At least ${PASSWORD_MIN} characters`, passed: password.length >= PASSWORD_MIN },
    {
      label: 'Mixes letters and numbers',
      passed: /[a-zA-Z]/.test(password) && /\d/.test(password),
    },
    { label: 'Both entries match', passed: password.length > 0 && password === confirmation },
  ];
}

/** Every check met, which is when the button turns on. */
export function passwordReady(password: string, confirmation: string): boolean {
  return passwordChecks(password, confirmation).every((check) => check.passed);
}
