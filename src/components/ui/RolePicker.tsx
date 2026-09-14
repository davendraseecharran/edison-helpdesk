'use client';

/**
 * Choosing what an account may do.
 *
 * A role is a set, so this is a group of checkboxes rather than a segmented
 * control: an account can be an administrator AND a skills officer, and the
 * two are not alternatives. The last chip cannot be cleared, because an
 * account with no role could sign in and reach nothing, which is a state the
 * database refuses anyway — refusing it here means the person finds out while
 * they are still looking at the control rather than after they press save.
 *
 * Checkbox semantics, not buttons: each chip is a real `<input type="checkbox">`
 * so the set reads correctly to a screen reader and to keyboard navigation,
 * with the chip itself as the visible control.
 */

import { ACCOUNT_ROLES, ROLE_DESCRIPTIONS, ROLE_LABELS, type AccountRole } from '@/lib/auth/roles';

export function RolePicker({
  label,
  value,
  onChange,
  disabled = false,
  idPrefix,
}: {
  /** Accessible name for the group. */
  label: string;
  value: readonly AccountRole[];
  onChange: (roles: AccountRole[]) => void;
  disabled?: boolean;
  /** Distinguishes two pickers on one screen. */
  idPrefix: string;
}) {
  const chosen = ACCOUNT_ROLES.filter((role) => value.includes(role));
  const onlyOne = chosen.length === 1;

  function toggle(role: AccountRole) {
    const next = chosen.includes(role)
      ? chosen.filter((entry) => entry !== role)
      : ACCOUNT_ROLES.filter((entry) => entry === role || chosen.includes(entry));
    if (next.length === 0) return;
    onChange(next);
  }

  return (
    <div className="role-picker" role="group" aria-label={label}>
      {ACCOUNT_ROLES.map((role) => {
        const checked = chosen.includes(role);
        // The last remaining role stays checked and is disabled rather than
        // silently ignoring the click, so the reason is visible.
        const locked = checked && onlyOne;
        const id = `${idPrefix}-${role}`;
        return (
          <label key={role} className="role-chip" htmlFor={id} title={ROLE_DESCRIPTIONS[role]}>
            <input
              id={id}
              type="checkbox"
              checked={checked}
              disabled={disabled || locked}
              onChange={() => toggle(role)}
            />
            <span className="role-chip-text">{ROLE_LABELS[role]}</span>
          </label>
        );
      })}
    </div>
  );
}
