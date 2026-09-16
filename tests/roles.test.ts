/**
 * The pure role helpers.
 *
 * These decide what a screen offers, never what the database allows, so the
 * cases that matter are the ones a person would get wrong: a role set arriving
 * in the old spelling, a set arriving out of order, and the difference between
 * "holds netrider" and "may work tickets".
 */

import { describe, expect, it } from 'vitest';
import {
  ACCOUNT_ROLES,
  canEditInventory,
  canWorkDirectory,
  canWorkTickets,
  canonicalRoles,
  hasRole,
  isAdmin,
  landingPath,
  normalizeRoles,
  rolesOfRow,
  roleLabel,
  rolesLabel,
  sameRoles,
} from '../src/lib/auth/roles';

describe('normalizeRoles', () => {
  it('reads the old technician spelling as netrider', () => {
    expect(normalizeRoles(['technician'])).toEqual(['netrider']);
    expect(normalizeRoles(['technician', 'skills_officer'])).toEqual(['netrider', 'skills_officer']);
  });

  it('puts a set in chip order and drops duplicates', () => {
    expect(normalizeRoles(['skills_officer', 'admin', 'admin'])).toEqual([
      'admin',
      'skills_officer',
    ]);
  });

  it('reads an old row, which has only the single role, as what that role said', () => {
    expect(rolesOfRow(undefined, 'admin')).toEqual(['admin']);
    expect(rolesOfRow(null, 'technician')).toEqual(['netrider']);
    expect(rolesOfRow(['skills_officer'], 'technician')).toEqual(['skills_officer']);
  });

  it('falls back to netrider rather than inventing a role-less account', () => {
    // The database's CHECK makes an empty set impossible, so anything empty
    // here is a read that went wrong. Showing a person with no role at all
    // would hide that; showing the least privileged real role does not.
    expect(normalizeRoles(null)).toEqual(['netrider']);
    expect(normalizeRoles([])).toEqual(['netrider']);
    expect(normalizeRoles(['wizard'])).toEqual(['netrider']);
    expect(normalizeRoles('admin')).toEqual(['admin']);
  });
});

describe('predicates', () => {
  it('reads one role out of the set', () => {
    expect(hasRole(['netrider', 'skills_officer'], 'skills_officer')).toBe(true);
    expect(hasRole(['netrider'], 'admin')).toBe(false);
  });

  it('treats an administrator as somebody who works tickets', () => {
    expect(canWorkTickets(['admin'])).toBe(true);
    expect(canWorkTickets(['netrider'])).toBe(true);
    expect(canWorkTickets(['admin', 'skills_officer'])).toBe(true);
    expect(canWorkTickets(['skills_officer'])).toBe(false);
  });

  it('lets every role work the directory, and only a ticket worker edit inventory', () => {
    for (const role of ACCOUNT_ROLES) {
      expect(canWorkDirectory([role])).toBe(true);
    }
    expect(canEditInventory(['skills_officer'])).toBe(false);
    expect(canEditInventory(['netrider'])).toBe(true);
  });

  it('is an administrator only when admin is in the set', () => {
    expect(isAdmin(['admin', 'netrider'])).toBe(true);
    expect(isAdmin(['netrider', 'skills_officer'])).toBe(false);
  });

  it('lands a skills officer on the directory and everybody else on Today', () => {
    expect(landingPath(['skills_officer'])).toBe('/people');
    expect(landingPath(['netrider'])).toBe('/today');
    expect(landingPath(['admin'])).toBe('/today');
    expect(landingPath(['netrider', 'skills_officer'])).toBe('/today');
  });
});

describe('labels and comparison', () => {
  it('never shows the internal technician spelling', () => {
    expect(roleLabel('netrider')).toBe('NetRider');
    expect(roleLabel('admin')).toBe('Administrator');
    expect(roleLabel('skills_officer')).toBe('Skills officer');
  });

  it('reads a set as a sentence', () => {
    expect(rolesLabel(['netrider'])).toBe('NetRider');
    expect(rolesLabel(['skills_officer', 'admin'])).toBe('Administrator and Skills officer');
    expect(rolesLabel(ACCOUNT_ROLES)).toBe('Administrator, NetRider and Skills officer');
  });

  it('compares sets by content rather than by order', () => {
    expect(sameRoles(['admin', 'netrider'], ['netrider', 'admin'])).toBe(true);
    expect(sameRoles(['admin'], ['admin', 'netrider'])).toBe(false);
    expect(canonicalRoles(['skills_officer', 'admin'])).toEqual(['admin', 'skills_officer']);
  });
});
