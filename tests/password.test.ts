import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MIN,
  passwordChecks,
  passwordProblem,
  passwordReady,
} from '../src/lib/domain/password';

describe('the length a server enforces', () => {
  // Twelve is what app_trusted_complete_credential_action refuses below, and
  // what app_trusted_approve_own_credential's caller checks before it asks. A
  // drift here is a form that accepts what the database will not.
  it('is twelve', () => {
    expect(PASSWORD_MIN).toBe(8);
  });

  it('refuses anything shorter and says how much is needed', () => {
    expect(passwordProblem('')).toBe('Use at least 8 characters.');
    expect(passwordProblem('a'.repeat(PASSWORD_MIN - 1))).toBe('Use at least 8 characters.');
  });

  it('accepts a password of exactly the minimum, and longer', () => {
    expect(passwordProblem('a'.repeat(PASSWORD_MIN))).toBeNull();
    expect(passwordProblem('correct horse battery staple')).toBeNull();
  });

  // The length is the whole server rule: the other two checks are guidance, and
  // a server that refused on them would be refusing something it never said.
  it('says nothing about letters, digits or a confirmation', () => {
    expect(passwordProblem('............')).toBeNull();
  });
});

describe('the checks shown under the boxes', () => {
  it('reads in the order it is shown, and is empty of ticks at the start', () => {
    expect(passwordChecks('', '').map((check) => [check.label, check.passed])).toEqual([
      ['At least 8 characters', false],
      ['Mixes letters and numbers', false],
      ['Both entries match', false],
    ]);
  });

  it('does not call two empty boxes a match', () => {
    // Otherwise an untouched form shows a met check before anything is typed.
    expect(passwordChecks('', '')[2].passed).toBe(false);
  });

  it('wants both a letter and a digit', () => {
    expect(passwordChecks('lettersonlyhere', '')[1].passed).toBe(false);
    expect(passwordChecks('123456789012', '')[1].passed).toBe(false);
    expect(passwordChecks('letters12345', '')[1].passed).toBe(true);
  });

  it('turns the button on only once every check is met', () => {
    expect(passwordReady('shorty1', 'shorty1')).toBe(false);
    expect(passwordReady('lettersandmore', 'lettersandmore')).toBe(false);
    expect(passwordReady('letters12345', 'letters1234')).toBe(false);
    expect(passwordReady('letters12345', 'letters12345')).toBe(true);
  });
});
