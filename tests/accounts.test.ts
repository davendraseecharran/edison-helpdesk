/**
 * Account administration rules, including the simulated credential actions.
 *
 * The key assertion here is a negative one: nothing in the data model ever holds
 * a setup/recovery link, a token, or a password.
 */

import { describe, expect, it } from 'vitest';
import {
  createTechnicianAccount,
  recordCredentialAction,
  setAccountStatus,
} from '../src/lib/domain/operations';
import { visibleTickets } from '../src/lib/domain/permissions';
import { liveTicketsOwnedBy } from '../src/lib/domain/selectors';
import { accountOf, contextFor, expectFail, expectOk, freshData, IDS } from './helpers';

describe('creating accounts', () => {
  it('creates technicians in a setup-pending state with no ticket access', () => {
    const data = freshData();
    const result = createTechnicianAccount(data, contextFor(IDS.admin), {
      displayName: 'Rowan Vale',
      email: 'Rowan.Vale@edison.example',
    });
    const next = expectOk(result);
    const created = next.accounts.find((account) => account.email === 'rowan.vale@edison.example');

    expect(created?.status).toBe('setup_pending');
    expect(created?.role).toBe('technician');
    expect(visibleTickets(next, created ?? null)).toHaveLength(0);
  });

  it('refuses account creation by a technician', () => {
    const data = freshData();
    const error = expectFail(
      createTechnicianAccount(data, contextFor(IDS.priya), {
        displayName: 'Rowan Vale',
        email: 'rowan.vale@edison.example',
      }),
    );
    expect(error).toMatch(/only an administrator/i);
  });

  it('validates the name and email and rejects duplicates', () => {
    const data = freshData();
    expect(
      expectFail(
        createTechnicianAccount(data, contextFor(IDS.admin), { displayName: ' ', email: 'a@b.co' }),
      ),
    ).toMatch(/technician name/i);
    expect(
      expectFail(
        createTechnicianAccount(data, contextFor(IDS.admin), {
          displayName: 'Rowan Vale',
          email: 'not-an-email',
        }),
      ),
    ).toMatch(/valid school email/i);
    expect(
      expectFail(
        createTechnicianAccount(data, contextFor(IDS.admin), {
          displayName: 'Duplicate',
          email: 'priya.raman@edison.example',
        }),
      ),
    ).toMatch(/already uses that email/i);
  });
});

describe('simulated credential actions', () => {
  it('records that a setup link was issued without storing any credential', () => {
    const data = freshData();
    const next = expectOk(
      recordCredentialAction(data, contextFor(IDS.admin), IDS.jordan, 'setup_issued'),
    );
    const jordan = accountOf(next, IDS.jordan);

    expect(jordan.lastCredentialActionKind).toBe('setup_issued');
    expect(jordan.lastCredentialActionAt).toBe(contextFor(IDS.admin).now);

    // No field anywhere holds a link, token, or password.
    const serialised = JSON.stringify(next);
    expect(serialised).not.toMatch(/token/i);
    expect(serialised).not.toMatch(/password/i);
    expect(serialised).not.toMatch(/https?:\/\//i);
  });

  it('does not offer a setup link for an account that already completed setup', () => {
    const data = freshData();
    const error = expectFail(
      recordCredentialAction(data, contextFor(IDS.admin), IDS.priya, 'setup_issued'),
    );
    expect(error).toMatch(/already completed setup/i);
  });

  it('refuses credentials for a deactivated account', () => {
    const data = freshData();
    const error = expectFail(
      recordCredentialAction(data, contextFor(IDS.admin), IDS.alex, 'recovery_issued'),
    );
    expect(error).toMatch(/reactivate the account/i);
  });

  it('refuses credential actions by a technician', () => {
    const data = freshData();
    const error = expectFail(
      recordCredentialAction(data, contextFor(IDS.priya), IDS.jordan, 'setup_issued'),
    );
    expect(error).toMatch(/only an administrator/i);
  });
});

describe('activation state', () => {
  it('revokes access immediately on deactivation while keeping history', () => {
    const data = freshData();
    const notesBefore = data.notes.filter((note) => note.authorId === IDS.priya);
    expect(notesBefore.length).toBeGreaterThan(0);

    const next = expectOk(setAccountStatus(data, contextFor(IDS.admin), IDS.priya, 'inactive'));
    const priya = accountOf(next, IDS.priya);

    expect(priya.status).toBe('inactive');
    expect(visibleTickets(next, priya)).toHaveLength(0);
    expect(next.notes.filter((note) => note.authorId === IDS.priya)).toEqual(notesBefore);
  });

  it('surfaces the live tickets that need reassignment', () => {
    const data = freshData();
    const live = liveTicketsOwnedBy(data, IDS.priya);
    expect(live.length).toBeGreaterThan(0);

    const result = setAccountStatus(data, contextFor(IDS.admin), IDS.priya, 'inactive');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.message).toMatch(/need reassignment/i);
    }
  });

  it('restores access when an account is reactivated', () => {
    const data = freshData();
    const next = expectOk(setAccountStatus(data, contextFor(IDS.admin), IDS.alex, 'active'));
    expect(visibleTickets(next, accountOf(next, IDS.alex)).length).toBeGreaterThan(0);
  });

  it('stops an administrator from changing their own status', () => {
    const data = freshData();
    const error = expectFail(
      setAccountStatus(data, contextFor(IDS.admin), IDS.admin, 'inactive'),
    );
    expect(error).toMatch(/your own account/i);
  });
});

describe('synthetic fixture hygiene', () => {
  it('uses only reserved example email addresses', () => {
    const data = freshData();
    for (const account of data.accounts) {
      expect(account.email.endsWith('@edison.example')).toBe(true);
    }
  });

  it('contains the spread of records the milestone asks to demonstrate', () => {
    const data = freshData();
    const statuses = new Set(data.tickets.map((ticket) => ticket.status));
    expect(statuses).toContain('open');
    expect(statuses).toContain('assigned');
    expect(statuses).toContain('in_progress');
    expect(statuses).toContain('waiting');
    expect(statuses).toContain('resolved');
    expect(statuses).toContain('cancelled');

    // A multi-device ticket and an unknown-requester ticket both exist.
    const deviceCounts = new Map<string, number>();
    for (const device of data.deviceObservations) {
      deviceCounts.set(device.ticketId, (deviceCounts.get(device.ticketId) ?? 0) + 1);
    }
    expect([...deviceCounts.values()].some((count) => count >= 3)).toBe(true);
    expect(data.tickets.some((ticket) => ticket.requesterUnknown)).toBe(true);
    expect(data.tickets.some((ticket) => ticket.location === null)).toBe(true);

    // Every role the review needs is represented.
    const accountStatuses = new Set(data.accounts.map((account) => account.status));
    expect(accountStatuses).toEqual(new Set(['active', 'setup_pending', 'inactive']));
    expect(data.accounts.filter((account) => account.role === 'admin')).toHaveLength(1);
  });
});
