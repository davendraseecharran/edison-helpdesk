/** Intake rules: channel/owner enforcement, backdating, and validation. */

import { describe, expect, it } from 'vitest';
import { createTicket } from '../src/lib/domain/operations';
import type { TicketCategory } from '../src/lib/domain/types';
import { toDateKey } from '../src/lib/format';
import { contextFor, createdTicket, expectFail, expectOk, freshData, IDS, NOW } from './helpers';

const baseInput = {
  title: 'Smart board stuck on the setup screen',
  issue: 'The panel reboots into the initial setup wizard every morning.',
  priority: 'normal' as const,
  requesterName: 'Ms. Fairweather',
  location: 'Room 301',
};

describe('technician intake', () => {
  it('forces a walk-in owned by the creating technician', () => {
    const data = freshData();
    const result = createTicket(data, contextFor(IDS.priya), {
      ...baseInput,
      channel: 'walk_in',
      submittedOn: toDateKey(NOW),
    });
    const ticket = createdTicket(result);

    expect(ticket?.channel).toBe('walk_in');
    expect(ticket?.ownerId).toBe(IDS.priya);
    expect(ticket?.status).toBe('assigned');
    expect(ticket?.assignedAt).toBe(contextFor(IDS.priya).now);
    expect(ticket?.number).toBe('EDT-1012');
  });

  it('rejects a forged channel rather than silently correcting it', () => {
    const data = freshData();
    const error = expectFail(
      createTicket(data, contextFor(IDS.priya), {
        ...baseInput,
        channel: 'phone_call',
        submittedOn: toDateKey(NOW),
      }),
    );
    expect(error).toMatch(/only record walk-in/i);
  });

  it('rejects a technician assigning a new walk-in to someone else', () => {
    const data = freshData();
    const error = expectFail(
      createTicket(data, contextFor(IDS.priya), {
        ...baseInput,
        channel: 'walk_in',
        submittedOn: toDateKey(NOW),
        ownerId: IDS.sam,
      }),
    );
    expect(error).toMatch(/assign their walk-in tickets to themselves/i);
  });

  it('lets a technician add collaborators to their own walk-in', () => {
    const data = freshData();
    const result = createTicket(data, contextFor(IDS.priya), {
      ...baseInput,
      channel: 'walk_in',
      submittedOn: toDateKey(NOW),
      collaboratorIds: [IDS.dev],
    });
    const ticket = createdTicket(result);
    expect(ticket?.collaboratorIds).toEqual([IDS.dev]);
    expect(ticket?.ownerId).toBe(IDS.priya);
  });

  it('refuses intake from an account that has not completed setup', () => {
    const data = freshData();
    const error = expectFail(
      createTicket(data, contextFor(IDS.jordan), {
        ...baseInput,
        channel: 'walk_in',
        submittedOn: toDateKey(NOW),
      }),
    );
    expect(error).toMatch(/password setup/i);
  });
});

describe('admin intake', () => {
  it('routes to the Open Queue when no owner is chosen', () => {
    const data = freshData();
    const result = createTicket(data, contextFor(IDS.admin), {
      ...baseInput,
      channel: 'phone_call',
      submittedOn: toDateKey(NOW),
    });
    const ticket = createdTicket(result);
    expect(ticket?.ownerId).toBeNull();
    expect(ticket?.status).toBe('open');
    expect(ticket?.assignedAt).toBeNull();
    expect(ticket?.channel).toBe('phone_call');
  });

  it('assigns directly to a technician when one is chosen', () => {
    const data = freshData();
    const result = createTicket(data, contextFor(IDS.admin), {
      ...baseInput,
      channel: 'email',
      submittedOn: toDateKey(NOW),
      ownerId: IDS.sam,
    });
    const ticket = createdTicket(result);
    expect(ticket?.ownerId).toBe(IDS.sam);
    expect(ticket?.status).toBe('assigned');
  });

  it('keeps the real creation timestamp when the submission date is backdated', () => {
    const data = freshData();
    const context = contextFor(IDS.admin);
    const backdated = toDateKey(new Date(2026, 8, 3));
    const result = createTicket(data, context, {
      ...baseInput,
      channel: 'phone_call',
      submittedOn: backdated,
    });
    const next = expectOk(result);
    const ticket = createdTicket(result);

    expect(ticket?.submittedOn).toBe(backdated);
    expect(ticket?.createdAt).toBe(context.now);
    expect(ticket?.createdById).toBe(IDS.admin);

    const created = next.activity.filter(
      (event) => event.ticketId === ticket.id && event.kind === 'created',
    );
    expect(created).toHaveLength(1);
    expect(created[0]?.detail).toMatch(/backdated/i);
  });

  it('rejects a future submission date', () => {
    const data = freshData();
    const error = expectFail(
      createTicket(data, contextFor(IDS.admin), {
        ...baseInput,
        channel: 'phone_call',
        submittedOn: toDateKey(new Date(2026, 8, 30)),
      }),
    );
    expect(error).toMatch(/cannot be in the future/i);
  });

  it('rejects an owner whose account is not active', () => {
    const data = freshData();
    const error = expectFail(
      createTicket(data, contextFor(IDS.admin), {
        ...baseInput,
        channel: 'email',
        submittedOn: toDateKey(NOW),
        ownerId: IDS.alex,
      }),
    );
    expect(error).toMatch(/active technician/i);
  });
});

describe('intake validation', () => {
  it('requires a title and an issue', () => {
    const data = freshData();
    expect(
      expectFail(
        createTicket(data, contextFor(IDS.admin), {
          ...baseInput,
          title: '   ',
          channel: 'walk_in',
          submittedOn: toDateKey(NOW),
        }),
      ),
    ).toMatch(/title is required/i);

    expect(
      expectFail(
        createTicket(data, contextFor(IDS.admin), {
          ...baseInput,
          issue: '',
          channel: 'walk_in',
          submittedOn: toDateKey(NOW),
        }),
      ),
    ).toMatch(/describe the issue/i);
  });

  it('requires either a requester or an explicit unknown marker', () => {
    const data = freshData();
    const error = expectFail(
      createTicket(data, contextFor(IDS.admin), {
        title: baseInput.title,
        issue: baseInput.issue,
        priority: 'normal',
        channel: 'walk_in',
        submittedOn: toDateKey(NOW),
      }),
    );
    expect(error).toMatch(/requester/i);
  });

  it('accepts an explicitly unknown requester', () => {
    const data = freshData();
    const result = createTicket(data, contextFor(IDS.admin), {
      title: baseInput.title,
      issue: baseInput.issue,
      priority: 'normal',
      channel: 'walk_in',
      submittedOn: toDateKey(NOW),
      requesterUnknown: true,
    });
    const ticket = createdTicket(result);
    expect(ticket?.requesterUnknown).toBe(true);
    expect(ticket?.requesterId).toBeNull();
  });

  it('records devices with unknown serials and asset tags', () => {
    const data = freshData();
    const result = createTicket(data, contextFor(IDS.admin), {
      ...baseInput,
      channel: 'walk_in',
      submittedOn: toDateKey(NOW),
      devices: [
        { deviceType: 'Projector' },
        { deviceType: 'Laptop', serialNumber: '', assetTag: '', identifiersNotApplicable: true },
      ],
    });
    const next = expectOk(result);
    const created = createdTicket(result);
    const devices = next.deviceObservations.filter(
      (device) => device.ticketId === created.id,
    );
    expect(devices).toHaveLength(2);
    expect(devices[0]?.serialNumber).toBeNull();
    expect(devices[1]?.identifiersNotApplicable).toBe(true);
  });

  it('rejects a device entry with no device type', () => {
    const data = freshData();
    const error = expectFail(
      createTicket(data, contextFor(IDS.admin), {
        ...baseInput,
        channel: 'walk_in',
        submittedOn: toDateKey(NOW),
        devices: [{ deviceType: '  ' }],
      }),
    );
    expect(error).toMatch(/device type/i);
  });

  it('creates a minimal requester record when a new name is supplied', () => {
    const data = freshData();
    const before = data.requesters.length;
    const result = createTicket(data, contextFor(IDS.admin), {
      ...baseInput,
      channel: 'walk_in',
      submittedOn: toDateKey(NOW),
      requesterName: 'Mr. Quintero',
      requesterKind: 'staff',
      requesterDescriptor: 'Music',
    });
    const next = expectOk(result);
    expect(next.requesters).toHaveLength(before + 1);
    const ticket = createdTicket(result);
    const requester = next.requesters.find((entry) => entry.id === ticket.requesterId);
    expect(requester?.displayName).toBe('Mr. Quintero');
    expect(requester?.descriptor).toBe('Music');
  });

  it('files an uncategorised ticket as other rather than leaving it blank', () => {
    const data = freshData();
    const ticket = createdTicket(
      createTicket(data, contextFor(IDS.admin), {
        ...baseInput,
        channel: 'phone_call',
        submittedOn: toDateKey(NOW),
      }),
    );
    expect(ticket?.category).toBe('other');
  });

  it('records the category it was given', () => {
    const data = freshData();
    const ticket = createdTicket(
      createTicket(data, contextFor(IDS.admin), {
        ...baseInput,
        channel: 'phone_call',
        submittedOn: toDateKey(NOW),
        category: 'projector_display',
      }),
    );
    expect(ticket?.category).toBe('projector_display');
  });

  it('rejects a category outside the vocabulary instead of filing it as other', () => {
    const data = freshData();
    const error = expectFail(
      createTicket(data, contextFor(IDS.admin), {
        ...baseInput,
        channel: 'phone_call',
        submittedOn: toDateKey(NOW),
        // Cast because the whole point is a value TypeScript would refuse: the
        // check exists for a caller that is not type-checked at all.
        category: 'smartboard' as TicketCategory,
      }),
    );
    expect(error).toMatch(/choose a category/i);
    expect(data.tickets).toHaveLength(freshData().tickets.length);
  });

  it('leaves the original dataset untouched', () => {
    const data = freshData();
    const before = data.tickets.length;
    expectOk(
      createTicket(data, contextFor(IDS.admin), {
        ...baseInput,
        channel: 'walk_in',
        submittedOn: toDateKey(NOW),
      }),
    );
    expect(data.tickets).toHaveLength(before);
  });
});
