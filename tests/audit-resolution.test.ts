import { describe, expect, it } from 'vitest';
import {
  blockedReason,
  elsewhereDecisionFor,
  initialDecisions,
  labelsById,
  missingDecisionFor,
  outcomeText,
  planAudit,
  resultsHeadline,
  type AuditDecisions,
} from '../src/lib/workflows/audit-resolution';
import type { ExpectedDevice, ScannedMachine } from '../src/lib/workflows/session';

function expected(tag: string, holder: string | null = null): ExpectedDevice {
  return {
    id: `id-${tag}`,
    label: tag,
    assetTag: tag,
    serialNumber: `S-${tag}`,
    externalId: `E-${tag}`,
    deviceType: 'Chromebook',
    manufacturer: 'Lenovo',
    model: '300e',
    state: {
      location: 'Room 204',
      status: holder ? 'Assigned' : 'Available',
      holderId: holder ? `person-${holder}` : null,
      holderName: holder,
      holderKind: holder ? 'student' : null,
    },
  };
}

function seen(tag: string, location: string | null): ScannedMachine {
  const { state, ...device } = expected(tag);
  return { device, state: { ...state, location } };
}

const diff = {
  missing: [expected('A'), expected('B'), expected('C'), expected('D', 'Juniper Vale')],
  elsewhere: [seen('X', 'Library'), seen('Y', null)],
};

function decided(changes: Partial<AuditDecisions>): AuditDecisions {
  return { ...initialDecisions(), ...changes };
}

describe('room audit decisions', () => {
  it('starts with every not-seen machine marked missing and every stray recorded here', () => {
    const decisions = initialDecisions();
    expect(missingDecisionFor(decisions, 'id-A')).toEqual({ kind: 'missing' });
    expect(elsewhereDecisionFor(decisions, 'id-X')).toBe('here');
    const plan = planAudit(diff, decisions, 'Room 204');
    expect(plan.summary).toEqual(['4 machines marked Missing', '2 machines recorded in Room 204']);
    expect(plan.changing).toBe(6);
    expect(plan.leaving).toBe(0);
    expect(plan.blocked).toEqual([]);
  });

  it('groups by what they become: one patch per status and per place, one call per deletion', () => {
    const decisions = decided({
      missingAll: { kind: 'status', status: 'In repair' },
      missing: {
        'id-B': { kind: 'move', location: 'Library' },
        'id-C': { kind: 'delete' },
        'id-D': { kind: 'leave' },
      },
      elsewhere: { 'id-Y': 'leave' },
    });
    const plan = planAudit(diff, decisions, 'Room 204');
    expect(plan.steps).toEqual([
      { kind: 'patch', patch: { status: 'In repair' }, ids: ['id-A'], label: 'set to In repair' },
      { kind: 'patch', patch: { location: 'Library' }, ids: ['id-B'], label: 'moved to Library' },
      { kind: 'patch', patch: { location: 'Room 204' }, ids: ['id-X'], label: 'moved to Room 204' },
      { kind: 'delete', id: 'id-C', label: 'C' },
    ]);
    expect(plan.summary).toEqual([
      '1 machine set to In repair',
      '1 machine recorded in Library',
      '1 machine recorded in Room 204',
      '1 record deleted',
      '2 machines left as they are',
    ]);
    expect(plan.changing).toBe(4);
  });

  it('a row that differs overrides the list, and a row reset follows the list again', () => {
    const decisions = decided({ missing: { 'id-A': { kind: 'leave' } } });
    expect(missingDecisionFor(decisions, 'id-A')).toEqual({ kind: 'leave' });
    expect(missingDecisionFor(decisions, 'id-B')).toEqual({ kind: 'missing' });
  });

  it('lets anybody who audits delete, but never a machine somebody has', () => {
    const deleteAll = decided({ missingAll: { kind: 'delete' } });
    const plan = planAudit(diff, deleteAll, 'Room 204');
    expect(plan.blocked).toEqual([
      { id: 'id-D', label: 'D', reason: 'With Juniper Vale. Return it first, or mark it Retired.' },
    ]);
  });

  it('asks for the text a decision needs before it can be applied', () => {
    expect(blockedReason({ kind: 'status', status: ' ' }, expected('A'))).toBe('Choose the status.');
    expect(blockedReason({ kind: 'move', location: '' }, expected('A'))).toBe('Say where it goes.');
    expect(blockedReason({ kind: 'status', status: 'Assigned' }, expected('A'))).toContain('Hand it out');
    expect(blockedReason({ kind: 'missing' }, expected('D', 'Juniper Vale'))).toBeNull();
  });

  it('with everything left, has nothing to apply', () => {
    const plan = planAudit(
      diff,
      decided({ missingAll: { kind: 'leave' }, elsewhereAll: 'leave' }),
      'Room 204',
    );
    expect(plan.steps).toEqual([]);
    expect(plan.changing).toBe(0);
    expect(plan.summary).toEqual(['6 machines left as they are']);
  });

  it('says what became of each machine, and sums it up honestly', () => {
    expect(outcomeText({ kind: 'patch', patch: { status: 'Missing' }, ids: [], label: '' })).toBe('Marked Missing');
    expect(outcomeText({ kind: 'patch', patch: { status: 'Retired' }, ids: [], label: '' })).toBe('Set to Retired');
    expect(outcomeText({ kind: 'patch', patch: { location: 'Library' }, ids: [], label: '' })).toBe('Recorded in Library');
    expect(outcomeText({ kind: 'delete', id: 'x', label: 'x' })).toBe('Record deleted');

    expect(resultsHeadline([{ id: 'a', label: 'A', text: '', ok: true }])).toBe('1 machine updated.');
    expect(
      resultsHeadline([
        { id: 'a', label: 'A', text: '', ok: true },
        { id: 'b', label: 'B', text: '', ok: false },
      ]),
    ).toBe('1 machine updated. 1 did not go through.');
    expect(resultsHeadline([{ id: 'b', label: 'B', text: '', ok: false }])).toBe('That change did not go through.');
    expect(labelsById(diff).get('id-X')).toBe('X');
  });
});
