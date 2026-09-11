/** Claiming, collaboration, resolution, and admin lifecycle actions. */

import { describe, expect, it } from 'vitest';
import {
  addCollaborator,
  addNote,
  cancelTicket,
  claimTicket,
  logWork,
  removeCollaborator,
  reassignTicket,
  reopenTicket,
  resolveTicket,
  setPriority,
} from '../src/lib/domain/operations';
import { canViewTicket } from '../src/lib/domain/permissions';
import { closedHistory, myTickets, openQueue, summariseTime } from '../src/lib/domain/selectors';
import { toDateKey } from '../src/lib/format';
import {
  accountOf,
  contextFor,
  expectFail,
  expectOk,
  freshData,
  IDS,
  NOW,
  ticketByNumber,
} from './helpers';

function idOf(data: ReturnType<typeof freshData>, number: string): string {
  return ticketByNumber(data, number).id;
}

describe('claiming', () => {
  it('moves a ticket out of the Open Queue and into the claimer’s queue', () => {
    const data = freshData();
    const target = idOf(data, 'EDT-1001');
    const next = expectOk(claimTicket(data, contextFor(IDS.sam), target));

    const claimed = next.tickets.find((ticket) => ticket.id === target);
    expect(claimed?.ownerId).toBe(IDS.sam);
    expect(claimed?.status).toBe('assigned');
    expect(claimed?.assignedAt).toBe(contextFor(IDS.sam).now);

    const sam = accountOf(next, IDS.sam);
    expect(openQueue(next, sam).map((ticket) => ticket.number)).not.toContain('EDT-1001');
    expect(myTickets(next, sam).map((ticket) => ticket.number)).toContain('EDT-1001');

    // It also leaves every other technician's open queue.
    const priya = accountOf(next, IDS.priya);
    expect(openQueue(next, priya).map((ticket) => ticket.number)).not.toContain('EDT-1001');
    expect(canViewTicket(claimed!, priya)).toBe(false);

    expect(
      next.activity.filter((event) => event.ticketId === target && event.kind === 'claimed'),
    ).toHaveLength(1);
  });

  it('rejects a second claim and names the current owner', () => {
    const data = freshData();
    const target = idOf(data, 'EDT-1001');
    const afterFirst = expectOk(claimTicket(data, contextFor(IDS.sam), target));

    // Simulates the losing side of a race. Real single-winner behaviour must be
    // guaranteed by the database in M2; this only checks the rule and message.
    const error = expectFail(claimTicket(afterFirst, contextFor(IDS.priya), target));
    expect(error).toMatch(/already claimed by Sam Whitaker/i);
  });

  it('cannot claim a ticket that already has an owner, and says who owns it', () => {
    const data = freshData();
    const error = expectFail(claimTicket(data, contextFor(IDS.sam), idOf(data, 'EDT-1004')));
    // The plan requires the loser of a claim race to see the updated owner, so
    // this single message names the owner even though the ticket has left Sam's
    // queue. Nothing else discloses an unrelated ticket.
    expect(error).toMatch(/already claimed by Priya Raman/i);
  });

  it('keeps an unclaimable ticket indistinguishable from a missing one', () => {
    const data = freshData();
    // EDT-1011 is cancelled and unowned; a technician must learn nothing about it.
    const cancelled = expectFail(claimTicket(data, contextFor(IDS.sam), idOf(data, 'EDT-1011')));
    const missing = expectFail(claimTicket(data, contextFor(IDS.sam), 'tkt_does_not_exist'));
    expect(cancelled).toMatch(/not available/i);
    expect(cancelled).toBe(missing);
  });

  it('refuses a claim from an inactive account', () => {
    const data = freshData();
    const error = expectFail(claimTicket(data, contextFor(IDS.alex), idOf(data, 'EDT-1001')));
    expect(error).toMatch(/inactive/i);
  });
});

describe('collaboration', () => {
  it('lets the owner add a collaborator who then sees the ticket', () => {
    const data = freshData();
    const target = idOf(data, 'EDT-1004');
    const next = expectOk(addCollaborator(data, contextFor(IDS.priya), target, IDS.sam));

    const ticket = next.tickets.find((entry) => entry.id === target)!;
    expect(ticket.collaboratorIds).toContain(IDS.sam);
    expect(canViewTicket(ticket, accountOf(next, IDS.sam))).toBe(true);
  });

  it('does not let an uninvolved technician add themselves', () => {
    const data = freshData();
    const error = expectFail(
      addCollaborator(data, contextFor(IDS.sam), idOf(data, 'EDT-1004'), IDS.sam),
    );
    expect(error).toMatch(/not available/i);
  });

  it('does not let a collaborator manage the collaborator list', () => {
    const data = freshData();
    // Dev collaborates on EDT-1005 but does not own it.
    const error = expectFail(
      addCollaborator(data, contextFor(IDS.dev), idOf(data, 'EDT-1005'), IDS.sam),
    );
    expect(error).toMatch(/primary owner or an administrator/i);
  });

  it('revokes future access on removal but keeps past attribution', () => {
    const data = freshData();
    const target = idOf(data, 'EDT-1005');
    const notesBefore = data.notes.filter(
      (note) => note.ticketId === target && note.authorId === IDS.dev,
    );
    expect(notesBefore.length).toBeGreaterThan(0);

    const next = expectOk(removeCollaborator(data, contextFor(IDS.priya), target, IDS.dev));
    const ticket = next.tickets.find((entry) => entry.id === target)!;

    expect(ticket.collaboratorIds).not.toContain(IDS.dev);
    expect(canViewTicket(ticket, accountOf(next, IDS.dev))).toBe(false);

    // The note and its author are untouched.
    const notesAfter = next.notes.filter(
      (note) => note.ticketId === target && note.authorId === IDS.dev,
    );
    expect(notesAfter).toEqual(notesBefore);
    expect(
      next.activity.some(
        (event) => event.ticketId === target && event.kind === 'collaborator_removed',
      ),
    ).toBe(true);
  });
});

describe('notes and priority', () => {
  it('moves an untouched assignment to In progress on the first note', () => {
    const data = freshData();
    const target = idOf(data, 'EDT-1004');
    expect(ticketByNumber(data, 'EDT-1004').status).toBe('assigned');

    const next = expectOk(addNote(data, contextFor(IDS.priya), target, 'Checked the adapter.'));
    expect(next.tickets.find((entry) => entry.id === target)?.status).toBe('in_progress');
  });

  it('rejects a blank note', () => {
    const data = freshData();
    const error = expectFail(addNote(data, contextFor(IDS.priya), idOf(data, 'EDT-1004'), '   '));
    expect(error).toMatch(/write the note/i);
  });

  it('refuses notes from an uninvolved technician', () => {
    const data = freshData();
    const error = expectFail(
      addNote(data, contextFor(IDS.sam), idOf(data, 'EDT-1004'), 'Let me help.'),
    );
    expect(error).toMatch(/not available/i);
  });

  it('logs a priority change as an activity event', () => {
    const data = freshData();
    const target = idOf(data, 'EDT-1004');
    const next = expectOk(setPriority(data, contextFor(IDS.priya), target, 'urgent'));

    expect(next.tickets.find((entry) => entry.id === target)?.priority).toBe('urgent');
    const events = next.activity.filter(
      (event) => event.ticketId === target && event.kind === 'priority_changed',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.summary).toMatch(/from Normal to Urgent/);
  });

  it('rejects setting the priority it already has', () => {
    const data = freshData();
    const error = expectFail(
      setPriority(data, contextFor(IDS.priya), idOf(data, 'EDT-1004'), 'normal'),
    );
    expect(error).toMatch(/already Normal/i);
  });
});

describe('resolution', () => {
  const solution = 'Replaced the HDMI cable at the podium and confirmed the display works.';

  it('lets the primary owner resolve without any time entry', () => {
    const data = freshData();
    const target = idOf(data, 'EDT-1004');
    const next = expectOk(resolveTicket(data, contextFor(IDS.priya), target, solution));
    const ticket = next.tickets.find((entry) => entry.id === target)!;

    expect(ticket.status).toBe('resolved');
    expect(ticket.solution).toBe(solution);
    expect(ticket.resolvedById).toBe(IDS.priya);
    expect(ticket.resolvedAt).toBe(contextFor(IDS.priya).now);

    const time = summariseTime(next, target);
    expect(time.recorded).toBe(false);
    expect(time.totalMinutes).toBe(0);
  });

  it('lets a collaborator resolve while preserving the primary owner', () => {
    const data = freshData();
    const target = idOf(data, 'EDT-1005');
    const before = ticketByNumber(data, 'EDT-1005');
    expect(before.ownerId).toBe(IDS.priya);
    expect(before.collaboratorIds).toContain(IDS.dev);

    const next = expectOk(resolveTicket(data, contextFor(IDS.dev), target, solution));
    const ticket = next.tickets.find((entry) => entry.id === target)!;

    expect(ticket.status).toBe('resolved');
    expect(ticket.ownerId).toBe(IDS.priya);
    expect(ticket.resolvedById).toBe(IDS.dev);

    const events = next.activity.filter(
      (event) => event.ticketId === target && event.kind === 'resolved',
    );
    expect(events).toHaveLength(1);
    expect(events[0]?.summary).toMatch(/Dev Okafor resolved the ticket \(owner Priya Raman\)/);
  });

  it('rejects a blank or trivial solution', () => {
    const data = freshData();
    const target = idOf(data, 'EDT-1004');
    expect(expectFail(resolveTicket(data, contextFor(IDS.priya), target, '   '))).toMatch(
      /solution is required/i,
    );
    expect(expectFail(resolveTicket(data, contextFor(IDS.priya), target, 'ok'))).toMatch(
      /describe the solution/i,
    );
  });

  it('refuses resolution by an uninvolved technician', () => {
    const data = freshData();
    const error = expectFail(resolveTicket(data, contextFor(IDS.sam), idOf(data, 'EDT-1004'), solution));
    expect(error).toMatch(/not available/i);
  });

  it('produces exactly one completion event when resolution is attempted twice', () => {
    const data = freshData();
    // EDT-1005 is owned by Priya with Dev collaborating, so the second attempt
    // comes from someone who genuinely has access rather than being filtered out.
    const target = idOf(data, 'EDT-1005');
    const next = expectOk(resolveTicket(data, contextFor(IDS.priya), target, solution));

    const second = expectFail(resolveTicket(next, contextFor(IDS.dev), target, 'Another fix.'));
    expect(second).toMatch(/already resolved by Priya Raman/i);
    expect(
      next.activity.filter((event) => event.ticketId === target && event.kind === 'resolved'),
    ).toHaveLength(1);
  });

  it('keeps resolved work in history with authorship intact', () => {
    const data = freshData();
    const priya = accountOf(data, IDS.priya);
    const history = closedHistory(data, priya);
    const resolved = history.find((ticket) => ticket.number === 'EDT-1008')!;

    expect(resolved.resolvedById).toBe(IDS.dev);
    expect(resolved.ownerId).toBe(IDS.priya);
    const authors = new Set(
      data.notes.filter((note) => note.ticketId === resolved.id).map((note) => note.authorId),
    );
    expect(authors).toEqual(new Set([IDS.priya, IDS.dev]));
  });
});

describe('optional time tracking', () => {
  it('totals person-time across contributors', () => {
    const data = freshData();
    const target = idOf(data, 'EDT-1005');
    const time = summariseTime(data, target);

    // 35 minutes from Priya plus 25 from Dev is 60 technician-minutes.
    expect(time.recorded).toBe(true);
    expect(time.totalMinutes).toBe(60);
    expect(time.byContributor).toHaveLength(2);
  });

  it('distinguishes unlogged work from zero minutes', () => {
    const data = freshData();
    const time = summariseTime(data, idOf(data, 'EDT-1010'));
    expect(time.recorded).toBe(false);
    expect(time.totalMinutes).toBe(0);
  });

  it('allows a contributor to record time after resolution', () => {
    const data = freshData();
    const target = idOf(data, 'EDT-1008');
    expect(ticketByNumber(data, 'EDT-1008').status).toBe('resolved');

    const next = expectOk(
      logWork(data, contextFor(IDS.priya), target, {
        workDate: toDateKey(NOW),
        minutes: 15,
        description: 'Follow-up check the next morning',
      }),
    );
    const time = summariseTime(next, target);
    expect(time.totalMinutes).toBe(35);
    expect(time.byContributor.map((entry) => entry.accountId)).toContain(IDS.priya);
  });

  it('rejects invalid minute values and future dates', () => {
    const data = freshData();
    const target = idOf(data, 'EDT-1004');
    expect(
      expectFail(
        logWork(data, contextFor(IDS.priya), target, { workDate: toDateKey(NOW), minutes: 0 }),
      ),
    ).toMatch(/greater than zero/i);
    expect(
      expectFail(
        logWork(data, contextFor(IDS.priya), target, { workDate: toDateKey(NOW), minutes: 12.5 }),
      ),
    ).toMatch(/whole minutes/i);
    expect(
      expectFail(
        logWork(data, contextFor(IDS.priya), target, {
          workDate: toDateKey(new Date(2026, 8, 30)),
          minutes: 10,
        }),
      ),
    ).toMatch(/future/i);
  });
});

describe('administrator lifecycle actions', () => {
  it('reassigns while keeping the history and demoting nothing silently', () => {
    const data = freshData();
    const target = idOf(data, 'EDT-1004');
    const next = expectOk(reassignTicket(data, contextFor(IDS.admin), target, IDS.sam));
    const ticket = next.tickets.find((entry) => entry.id === target)!;

    expect(ticket.ownerId).toBe(IDS.sam);
    expect(canViewTicket(ticket, accountOf(next, IDS.priya))).toBe(false);
    expect(
      next.activity.filter((event) => event.ticketId === target && event.kind === 'assigned').length,
    ).toBeGreaterThanOrEqual(2);
  });

  it('returns a ticket to the Open Queue', () => {
    const data = freshData();
    const target = idOf(data, 'EDT-1004');
    const next = expectOk(reassignTicket(data, contextFor(IDS.admin), target, null));
    const ticket = next.tickets.find((entry) => entry.id === target)!;

    expect(ticket.ownerId).toBeNull();
    expect(ticket.status).toBe('open');
    expect(openQueue(next, accountOf(next, IDS.sam)).map((entry) => entry.number)).toContain(
      'EDT-1004',
    );
    expect(
      next.activity.some(
        (event) => event.ticketId === target && event.kind === 'returned_to_queue',
      ),
    ).toBe(true);
  });

  it('refuses reassignment by a technician', () => {
    const data = freshData();
    const error = expectFail(
      reassignTicket(data, contextFor(IDS.priya), idOf(data, 'EDT-1004'), IDS.sam),
    );
    expect(error).toMatch(/only an administrator/i);
  });

  it('reopens a resolved ticket with a reason and keeps prior history', () => {
    const data = freshData();
    const target = idOf(data, 'EDT-1008');
    const eventsBefore = data.activity.filter((event) => event.ticketId === target).length;

    expect(
      expectFail(reopenTicket(data, contextFor(IDS.admin), target, '  ')),
    ).toMatch(/needs a reason/i);

    const next = expectOk(
      reopenTicket(data, contextFor(IDS.admin), target, 'Fault returned the next morning.'),
    );
    const ticket = next.tickets.find((entry) => entry.id === target)!;

    expect(ticket.status).toBe('assigned');
    expect(ticket.ownerId).toBe(IDS.priya);
    expect(ticket.resolvedAt).toBeNull();
    expect(ticket.resolvedById).toBeNull();
    // The recorded solution and the original resolution event both survive.
    expect(ticket.solution).toMatch(/district root certificate/i);
    expect(
      next.activity.filter((event) => event.ticketId === target && event.kind === 'resolved'),
    ).toHaveLength(1);
    expect(next.activity.filter((event) => event.ticketId === target).length).toBe(
      eventsBefore + 1,
    );
  });

  it('refuses reopening by a technician', () => {
    const data = freshData();
    const error = expectFail(
      reopenTicket(data, contextFor(IDS.priya), idOf(data, 'EDT-1008'), 'Please reopen.'),
    );
    expect(error).toMatch(/only an administrator/i);
  });

  it('cancels with a reason without recording a resolution', () => {
    const data = freshData();
    const target = idOf(data, 'EDT-1001');
    expect(expectFail(cancelTicket(data, contextFor(IDS.admin), target, ''))).toMatch(
      /needs a reason/i,
    );

    const next = expectOk(
      cancelTicket(data, contextFor(IDS.admin), target, 'Requester resolved it themselves.'),
    );
    const ticket = next.tickets.find((entry) => entry.id === target)!;

    expect(ticket.status).toBe('cancelled');
    expect(ticket.cancelReason).toMatch(/resolved it themselves/i);
    expect(ticket.resolvedAt).toBeNull();
    expect(ticket.resolvedById).toBeNull();
  });
});
