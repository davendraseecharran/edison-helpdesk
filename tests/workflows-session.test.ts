import { describe, expect, it } from 'vitest';
import {
  answerRow,
  auditDiff,
  auditMachines,
  changeOf,
  chunk,
  countRows,
  failRow,
  findRepeat,
  formatElapsed,
  matchExpected,
  normaliseCode,
  parseScanAnswer,
  pendingRow,
  repeatRow,
  repeatsDevice,
  rowNote,
  sameLocation,
  setUndo,
  summaryText,
  undoQueue,
  type DeviceState,
  type ExpectedDevice,
  type ScanAnswer,
  type SessionRow,
  type WorkflowDevice,
} from '../src/lib/workflows/session';
import {
  defaultShortcutName,
  runCounts,
  scanTarget,
  shortcutError,
  targetFromParams,
  targetReady,
  workflowBySlug,
  workflowHref,
} from '../src/lib/domain/workflows';

function device(tag: string, id = `id-${tag}`): WorkflowDevice {
  return {
    id,
    label: tag,
    assetTag: tag,
    serialNumber: `SER-${tag}`,
    externalId: `DEV-${tag}`,
    deviceType: 'Chromebook',
    manufacturer: 'Lenovo',
    model: '300e',
  };
}

function state(location: string | null, extra: Partial<DeviceState> = {}): DeviceState {
  return { location, status: 'Available', holderId: null, holderName: null, holderKind: null, ...extra };
}

let seq = 0;
function row(code: string, targetKey = 'Cart 3'): SessionRow {
  seq += 1;
  return pendingRow(code, targetKey, 1000 + seq, `k${seq}`);
}

function done(code: string, from: string | null, to: string, targetKey = 'Cart 3'): SessionRow {
  return answerRow(row(code, targetKey), {
    outcome: 'done',
    code,
    device: device(code),
    before: state(from),
    after: state(to),
  });
}

describe('reading the database’s answer', () => {
  it('accepts each outcome and refuses a shape it does not know', () => {
    expect(parseScanAnswer({ outcome: 'unknown', code: 'X' })).toEqual({ outcome: 'unknown', code: 'X' });
    const answer = parseScanAnswer({
      outcome: 'done',
      code: 'DOE-1',
      device: device('DOE-1'),
      before: { location: null, status: 'Available', holderId: null },
      after: { location: 'Cart 3', status: 'Available', holderId: null },
    });
    expect(answer?.outcome).toBe('done');
    expect(parseScanAnswer({ outcome: 'done', code: 'X', device: device('X') })).toBeNull();
    expect(parseScanAnswer({ outcome: 'teleported', code: 'X' })).toBeNull();
    expect(parseScanAnswer(null)).toBeNull();
    expect(
      parseScanAnswer({ outcome: 'person', code: '240000123', person: { id: 'p', displayName: 'Juniper Vale' } }),
    ).toMatchObject({ outcome: 'person', person: { displayName: 'Juniper Vale', kind: 'student', holding: 0 } });
  });
});

describe('repeats', () => {
  it('folds case and space, and matches a machine by any of its three codes', () => {
    const first = done('doe-1', 'Library', 'Cart 3');
    expect(normaliseCode('  doe-1 ')).toBe('DOE-1');
    expect(findRepeat([first], ' DOE-1 ', 'Cart 3')?.key).toBe(first.key);
    expect(findRepeat([first], 'ser-doe-1', 'Cart 3')?.key).toBe(first.key);
    expect(findRepeat([first], 'DOE-2', 'Cart 3')).toBeNull();
  });

  it('counts a pending row and one that was already there, but not an undone one', () => {
    const waiting = row('DOE-5');
    expect(findRepeat([waiting], 'doe-5', 'Cart 3')?.key).toBe(waiting.key);

    const already = answerRow(row('DOE-6'), {
      outcome: 'already',
      code: 'DOE-6',
      device: device('DOE-6'),
      before: state('Cart 3'),
    });
    expect(findRepeat([already], 'DOE-6', 'Cart 3')).not.toBeNull();

    const undone = setUndo([done('DOE-7', 'Library', 'Cart 3')], `k${seq}`, 'undone');
    expect(findRepeat(undone, 'DOE-7', 'Cart 3')).toBeNull();

    const refused = failRow(row('DOE-8'), 'Only a NetRider or an administrator can change inventory.');
    expect(findRepeat([refused], 'DOE-8', 'Cart 3')).toBeNull();
  });

  it('is per target: the same laptop for the next student is not a repeat', () => {
    const forJuniper = done('DOE-9', null, 'x', 'person-juniper');
    expect(findRepeat([forJuniper], 'DOE-9', 'person-rowan')).toBeNull();
    expect(repeatsDevice([forJuniper], 'id-DOE-9', 'person-juniper', 'other')).toBe(true);
    expect(repeatsDevice([forJuniper], 'id-DOE-9', 'person-rowan', 'other')).toBe(false);
  });

  it('makes a repeat a skipped row that points at the machine it repeats', () => {
    const first = done('DOE-10', 'Library', 'Cart 3');
    const again = repeatRow(row('DOE-10'), first);
    expect(again.state).toBe('skipped');
    expect(again.skip).toBe('repeat');
    expect(again.device?.id).toBe(first.device?.id);
    expect(rowNote('move', again, { location: 'Cart 3', status: '' })).toBe('Scanned already. In Cart 3.');
  });
});

describe('counting and undo bookkeeping', () => {
  it('counts done, skipped and errors, leaves out people, and drops an undone row from done', () => {
    const a = done('A', 'Library', 'Cart 3');
    const b = done('B', 'Library', 'Cart 3');
    const skipped = answerRow(row('C'), { outcome: 'already', code: 'C', device: device('C'), before: state('Cart 3') });
    const unknown = answerRow(row('D'), { outcome: 'unknown', code: 'D' });
    const person = answerRow(row('240000123'), {
      outcome: 'person',
      code: '240000123',
      person: { id: 'p', displayName: 'Juniper Vale', kind: 'student', externalId: '240000123', holding: 0 },
    });
    let rows = [person, unknown, skipped, b, a, row('E')];
    expect(countRows(rows)).toEqual({ done: 2, skipped: 1, errors: 1, pending: 1, scanned: 5 });

    rows = setUndo(rows, a.key, 'undone');
    expect(countRows(rows).done).toBe(1);
  });

  it('walks undo-all newest first, retries a failed undo, and skips what cannot be undone', () => {
    const first = done('A', 'Library', 'Cart 3');
    const second = done('A', 'Cart 3', 'Cart 4');
    const skipped = answerRow(row('C'), { outcome: 'already', code: 'C', device: device('C'), before: state('Cart 3') });
    // Newest first, as the list keeps them.
    let rows = [skipped, second, first];
    expect(undoQueue(rows).map((one) => one.key)).toEqual([second.key, first.key]);

    rows = setUndo(rows, second.key, 'undone');
    rows = setUndo(rows, first.key, 'failed', 'A changed after the scan. Nothing was undone.');
    expect(undoQueue(rows).map((one) => one.key)).toEqual([first.key]);
    expect(rows.find((one) => one.key === first.key)?.undoMessage).toContain('Nothing was undone');

    const read = answerRow(row('F'), { outcome: 'found', code: 'F', device: device('F'), before: state('Room 204') });
    expect(read.undo).toBe('none');
    expect(undoQueue([read])).toEqual([]);
  });
});

describe('what a row says', () => {
  const target = { location: 'Cart 3', status: '' };

  it('shows a change as two values', () => {
    expect(changeOf('move', done('A', null, 'Cart 3'))).toEqual({ from: 'No location', to: 'Cart 3' });
    const handed = answerRow(row('B'), {
      outcome: 'done',
      code: 'B',
      device: device('B'),
      before: state('Cart 3'),
      after: state('Cart 3', { holderId: 'p', holderName: 'Juniper Vale', status: 'Assigned' }),
    });
    expect(changeOf('handout', handed)).toEqual({ from: 'Nobody', to: 'Juniper Vale' });
    const collected = answerRow(row('C'), {
      outcome: 'done',
      code: 'C',
      device: device('C'),
      before: state('Room 204', { holderName: 'Juniper Vale', status: 'Assigned' }),
      after: state('Returns bin'),
    });
    expect(changeOf('collect', collected)).toEqual({ from: 'Juniper Vale', to: 'Available, Returns bin' });
  });

  it('says why a row was skipped or refused, in plain words', () => {
    const already = answerRow(row('A'), { outcome: 'already', code: 'A', device: device('A'), before: state('Cart 3') });
    expect(rowNote('move', already, target)).toBe('Already in Cart 3.');
    const held = answerRow(row('B'), {
      outcome: 'held',
      code: 'B',
      device: device('B'),
      before: state(null, { holderName: 'Juniper Vale' }),
    });
    expect(rowNote('status', held, { location: '', status: 'In repair' })).toBe('With Juniper Vale. Collect it first.');
    expect(rowNote('move', answerRow(row('C'), { outcome: 'unknown', code: 'C' }), target)).toContain(
      'Not in the inventory',
    );
    expect(rowNote('move', failRow(row('D'), 'Nope.'), target)).toBe('Nope.');
    for (const line of [rowNote('move', already, target), rowNote('status', held, target)]) {
      expect(line).not.toMatch(/!|→/);
      expect(line.length).toBeLessThanOrEqual(70);
    }
  });

  it('writes a summary somebody can paste, oldest first, with no arrows', () => {
    const rows = [answerRow(row('B'), { outcome: 'unknown', code: 'B' }), done('A', 'Library', 'Cart 3')];
    const text = summaryText('move', target, rows, 247_000);
    expect(text.split('\n')[0]).toBe('Load a cart: Cart 3. 1 done, 1 error in 4:07.');
    expect(text.split('\n')[1]).toBe('A: Library to Cart 3');
    expect(text).not.toContain('→');
  });

  it('keeps a clock that reads in place', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(65_400)).toBe('1:05');
    expect(formatElapsed(3_730_000)).toBe('1:02:10');
    expect(formatElapsed(-5)).toBe('0:00');
  });
});

describe('room audit', () => {
  const expected: ExpectedDevice[] = [
    { ...device('A'), state: state('Room 204') },
    { ...device('B'), state: state('room 204 ') },
    { ...device('C'), state: state('Room 204') },
  ];

  it('matches a code from memory by any of a machine’s codes', () => {
    expect(matchExpected(expected, 'ser-b')?.id).toBe('id-B');
    expect(matchExpected(expected, 'dev-c')?.id).toBe('id-C');
    expect(matchExpected(expected, 'Z')).toBeNull();
    expect(sameLocation(' Room 204', 'room 204 ')).toBe(true);
    expect(sameLocation('', '')).toBe(false);
  });

  it('sorts what was seen into found, missing and misplaced', () => {
    const diff = auditDiff('Room 204', expected, [
      { device: device('A'), state: state('Room 204') },
      { device: device('A'), state: state('Room 204') },
      { device: device('X'), state: state('Cart 3') },
      // Arrived after the list was read: its own record says this room.
      { device: device('Y'), state: state('ROOM 204') },
      { device: device('Z'), state: state(null) },
    ]);
    expect(diff.found.map((one) => one.device.id)).toEqual(['id-A', 'id-Y']);
    expect(diff.missing.map((one) => one.id)).toEqual(['id-B', 'id-C']);
    expect(diff.elsewhere.map((one) => one.device.id)).toEqual(['id-X', 'id-Z']);
  });

  it('reads the machines out of an audit’s rows, oldest first', () => {
    const first = answerRow(row('A', 'Room 204'), { outcome: 'found', code: 'A', device: device('A'), before: state('Room 204') });
    const second = answerRow(row('X', 'Room 204'), { outcome: 'found', code: 'X', device: device('X'), before: state('Cart 3') });
    const unknown = answerRow(row('Q', 'Room 204'), { outcome: 'unknown', code: 'Q' } as ScanAnswer);
    expect(auditMachines([unknown, second, first]).map((one) => one.device.id)).toEqual(['id-A', 'id-X']);
  });

  it('batches ids for the bulk update', () => {
    expect(chunk(Array.from({ length: 450 }, (_, index) => index)).map((batch) => batch.length)).toEqual([200, 200, 50]);
  });
});

describe('workflows, named once', () => {
  it('round-trips a target through the URL', () => {
    const href = workflowHref('move', { location: 'Cart 3' });
    expect(href).toBe('/workflows/load-cart?location=Cart+3');
    expect(workflowBySlug('load-cart')?.kind).toBe('move');
    expect(workflowBySlug('teleport')).toBeNull();
    expect(targetFromParams({ location: ' Cart 3 ', status: ['In repair', 'x'] })).toEqual({
      location: 'Cart 3',
      status: 'In repair',
    });
  });

  it('knows when a target is enough to start', () => {
    expect(targetReady('move', { location: '', status: '' })).toBe(false);
    expect(targetReady('audit', { location: 'Room 204', status: '' })).toBe(true);
    expect(targetReady('status', { location: '', status: 'Assigned' })).toBe(false);
    expect(targetReady('collect', { location: '', status: '' })).toBe(true);
  });

  it('shapes the RPC target, defaulting a collection to the shelf', () => {
    expect(scanTarget('collect', { location: '', status: '' })).toEqual({ status: 'Available' });
    expect(scanTarget('collect', { location: 'Returns bin', status: 'In repair' })).toEqual({
      status: 'In repair',
      location: 'Returns bin',
    });
    expect(scanTarget('handout', { location: '', status: '' }, 'p1')).toEqual({ requester: 'p1' });
  });

  it('names a shortcut and checks one the way the database does', () => {
    expect(defaultShortcutName('move', { location: 'Cart 3', status: '' })).toBe('Load Cart 3');
    expect(defaultShortcutName('collect', { location: '', status: '' })).toBe('Collect as Available');
    expect(shortcutError({ name: 'x', kind: 'audit', location: '', status: '' })).toContain('location');
    expect(shortcutError({ name: 'x', kind: 'handout', location: '', status: '' })).toContain('Choose');
    expect(shortcutError({ name: 'Load Cart 3', kind: 'move', location: 'Cart 3', status: '' })).toBeNull();
    expect(runCounts({ kind: 'audit', done: 20, skipped: 3, errors: 0 })).toBe('20 found, 3 missing');
  });
});
