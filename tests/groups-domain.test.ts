/**
 * The pure parts of a roster: what the register says back, and what the two
 * files look like.
 *
 * `markLine` is the sentence somebody reads between scans, so it is worth
 * pinning word for word: it names the person when there is one, names the
 * GROUP when they are not in it, and falls back to the code only when nobody
 * was found — which is the one case where the code is the only thing anybody
 * can act on.
 */

import { describe, expect, it } from 'vitest';
import { markLine, type MarkByKeyResult } from '../src/lib/domain/groups';
import {
  ATTENDANCE_COLUMNS,
  attendanceRow,
  fileStem,
  rosterColumns,
  rosterRow,
} from '../src/lib/data/group-csv';
import type { GroupField, GroupMember } from '../src/lib/data/groups';
import type { RollEntry } from '../src/lib/data/group-events';

function answer(overrides: Partial<MarkByKeyResult>): MarkByKeyResult {
  return { outcome: 'present', requesterId: 'r1', displayName: 'Alex Moreau', ...overrides };
}

describe('what the register says back', () => {
  it('names the person and stops', () => {
    expect(markLine(answer({}), 'Officers', '230020049')).toBe('Alex Moreau, present.');
  });

  it('says a second scan was a second scan', () => {
    expect(markLine(answer({ outcome: 'already' }), 'Officers', '230020049')).toBe(
      'Alex Moreau was already marked.',
    );
  });

  it('names the group somebody is not in, because that is the fix', () => {
    expect(markLine(answer({ outcome: 'not_member' }), 'Officers', '230020049')).toBe(
      'Alex Moreau is not in Officers.',
    );
  });

  it('falls back to the code only when nobody was found', () => {
    const line = markLine(
      answer({ outcome: 'no_match', requesterId: null, displayName: null }),
      'Officers',
      '2109999999',
    );
    expect(line).toBe('No match for "2109999999".');
  });

  it('says what to do about a name two people have', () => {
    const line = markLine(
      answer({ outcome: 'ambiguous', requesterId: null, displayName: null }),
      'Officers',
      'Nia Okonkwo',
    );
    expect(line).toContain('More than one person');
    expect(line).toContain('OSIS');
  });

  it('never shouts, and never apologises', () => {
    for (const outcome of ['present', 'already', 'not_member', 'no_match', 'ambiguous'] as const) {
      const line = markLine(answer({ outcome }), 'Officers', '230020049');
      expect(line).not.toContain('!');
      expect(line.toLowerCase()).not.toContain('sorry');
    }
  });
});

const FIELDS: GroupField[] = [
  { id: 'f1', name: 'Permission slip', position: 0, checkedCount: 1 },
  { id: 'f2', name: 'Dues', position: 1, checkedCount: 0 },
];

const MEMBER: GroupMember = {
  id: 'r1',
  displayName: 'Nia Okonkwo',
  kind: 'student',
  externalId: '230020049',
  email: 'nia@edison.example',
  groupLabel: '9A',
  note: 'Treasurer',
  addedAt: '2026-09-10T12:00:00.000Z',
};

describe('the roster file', () => {
  it('puts one column after the fixed six for every checklist column', () => {
    expect(rosterColumns(FIELDS)).toEqual([
      'Name',
      'Student or staff',
      'OSIS or staff ID',
      'Class or department',
      'Email',
      'Note',
      'Permission slip',
      'Dues',
    ]);
  });

  it('writes a tick as Yes and an unticked box as No, never as a blank', () => {
    const row = rosterRow(MEMBER, FIELDS, { r1: ['f1'] });
    expect(row).toEqual([
      'Nia Okonkwo',
      'Student',
      '230020049',
      '9A',
      'nia@edison.example',
      'Treasurer',
      'Yes',
      'No',
    ]);
    expect(row).toHaveLength(rosterColumns(FIELDS).length);
  });

  it('is all No for somebody with no marks at all', () => {
    expect(rosterRow(MEMBER, FIELDS, {}).slice(-2)).toEqual(['No', 'No']);
  });
});

describe('the attendance file', () => {
  const PRESENT: RollEntry = {
    id: 'r1',
    displayName: 'Nia Okonkwo',
    kind: 'student',
    externalId: '230020049',
    groupLabel: '9A',
    present: true,
    markedAt: '2026-09-16T18:05:00.000Z',
  };

  it('carries every member, present or not', () => {
    const present = attendanceRow(PRESENT);
    const absent = attendanceRow({ ...PRESENT, present: false, markedAt: null });
    expect(present[3]).toBe('Yes');
    expect(absent[3]).toBe('No');
    // An absentee has no time, which is a blank cell rather than a word.
    expect(absent[4]).toBeNull();
    expect(present).toHaveLength(ATTENDANCE_COLUMNS.length);
  });
});

describe('what the file is called', () => {
  it('folds a name to something a file system has no opinion about', () => {
    expect(fileStem('group', 'Regionals 2027 competitors')).toBe('group-regionals-2027-competitors');
    expect(fileStem('attendance', 'Officers / Weekly meeting')).toBe(
      'attendance-officers-weekly-meeting',
    );
  });

  it('falls back to the prefix rather than to a file called nothing', () => {
    expect(fileStem('group', '///')).toBe('group');
  });
});
