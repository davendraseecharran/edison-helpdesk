/**
 * The scan session, with nothing around it.
 *
 * Every workflow is the same loop: a code arrives, it becomes a row, the row
 * is answered, and a row that changed something can be put back. What a row
 * says, when a code is a repeat, what counts as done, skipped or refused, what
 * "undo all" walks, and how an audit's three piles are worked out are rules
 * rather than renderings, so they live here — pure, dependency-free and
 * unit-tested — and the screen only draws them.
 *
 * Rows are kept NEWEST FIRST, because that is how the list shows them and how
 * "undo all" should walk them: last change first, so a machine scanned twice
 * ends where it started.
 */

import { isRecord, textOf } from '@/lib/guards';
import {
  COLLECT_DEFAULT_STATUS,
  targetLabel,
  workflowFor,
  type WorkflowKind,
  type WorkflowTarget,
} from '@/lib/domain/workflows';

// ---------------------------------------------------------------------------
// What the database answers
// ---------------------------------------------------------------------------

export interface WorkflowDevice {
  id: string;
  label: string;
  assetTag: string;
  serialNumber: string;
  externalId: string;
  deviceType: string;
  manufacturer: string;
  model: string;
}

/**
 * Where a machine is, what state it is in and who has it: raw, nulls kept,
 * because undo sends this back and the database compares it exactly.
 */
export interface DeviceState {
  location: string | null;
  status: string | null;
  holderId: string | null;
  holderName: string | null;
  holderKind: string | null;
}

export interface WorkflowPerson {
  id: string;
  displayName: string;
  kind: 'student' | 'staff';
  externalId: string;
  /** How many machines they hold right now. */
  holding: number;
}

export type ScanAnswer =
  | { outcome: 'done'; code: string; device: WorkflowDevice; before: DeviceState; after: DeviceState }
  | { outcome: 'already' | 'held' | 'found'; code: string; device: WorkflowDevice; before: DeviceState }
  | { outcome: 'unknown' | 'ambiguous'; code: string }
  | { outcome: 'person'; code: string; person: WorkflowPerson };

function nullableText(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

export function deviceFrom(value: unknown): WorkflowDevice | null {
  if (!isRecord(value)) return null;
  const id = textOf(value.id);
  if (id === '') return null;
  return {
    id,
    label: textOf(value.label) || 'Unlabelled device',
    assetTag: textOf(value.assetTag),
    serialNumber: textOf(value.serialNumber),
    externalId: textOf(value.externalId),
    deviceType: textOf(value.deviceType),
    manufacturer: textOf(value.manufacturer),
    model: textOf(value.model),
  };
}

export function stateFrom(value: unknown): DeviceState | null {
  if (!isRecord(value)) return null;
  return {
    location: nullableText(value.location),
    status: nullableText(value.status),
    holderId: nullableText(value.holderId),
    holderName: nullableText(value.holderName),
    holderKind: nullableText(value.holderKind),
  };
}

export function personFrom(value: unknown): WorkflowPerson | null {
  if (!isRecord(value)) return null;
  const id = textOf(value.id);
  if (id === '') return null;
  return {
    id,
    displayName: textOf(value.displayName) || 'Unnamed person',
    kind: value.kind === 'staff' ? 'staff' : 'student',
    externalId: textOf(value.externalId),
    holding: typeof value.holding === 'number' ? value.holding : 0,
  };
}

/** The RPC's JSON, checked. Null for anything that is not one of its shapes. */
export function parseScanAnswer(value: unknown): ScanAnswer | null {
  if (!isRecord(value)) return null;
  const code = textOf(value.code);
  switch (value.outcome) {
    case 'unknown':
    case 'ambiguous':
      return { outcome: value.outcome, code };
    case 'person': {
      const person = personFrom(value.person);
      return person ? { outcome: 'person', code, person } : null;
    }
    case 'already':
    case 'held':
    case 'found': {
      const device = deviceFrom(value.device);
      const before = stateFrom(value.before);
      return device && before ? { outcome: value.outcome, code, device, before } : null;
    }
    case 'done': {
      const device = deviceFrom(value.device);
      const before = stateFrom(value.before);
      const after = stateFrom(value.after);
      return device && before && after ? { outcome: 'done', code, device, before, after } : null;
    }
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

/**
 * What became of one code.
 *
 *   pending  — sent, not answered yet
 *   done     — the machine changed, and can be put back
 *   skipped  — already done, a repeat of this session, or held by somebody
 *   error    — nothing matched, two things matched, or the database refused
 *   person   — during a hand-out: the code was the next person's card
 */
export type RowState = 'pending' | 'done' | 'skipped' | 'error' | 'person';

export type SkipReason = 'already' | 'repeat' | 'held';
export type ErrorReason = 'unknown' | 'ambiguous' | 'failed';
export type UndoState = 'none' | 'available' | 'pending' | 'undone' | 'failed';

export interface SessionRow {
  key: string;
  /** The code as it was read, trimmed. */
  code: string;
  /** Milliseconds since the epoch. */
  at: number;
  /** Which target the row was scanned against: a hand-out's person changes mid-run. */
  targetKey: string;
  state: RowState;
  skip?: SkipReason;
  error?: ErrorReason;
  /** The database's own sentence, for a refusal. */
  message?: string;
  device?: WorkflowDevice;
  before?: DeviceState;
  after?: DeviceState;
  person?: WorkflowPerson;
  undo: UndoState;
  undoMessage?: string;
}

/** Codes compare trimmed and folded, exactly as the database folds them. */
export function normaliseCode(code: string): string {
  return code.trim().toUpperCase();
}

/** Every code a machine answers to: its tag, its serial and its inventory id. */
export function deviceCodes(device: Pick<WorkflowDevice, 'assetTag' | 'serialNumber' | 'externalId'>): string[] {
  return [device.assetTag, device.serialNumber, device.externalId]
    .map(normaliseCode)
    .filter((code) => code !== '');
}

export function pendingRow(code: string, targetKey: string, at: number, key: string): SessionRow {
  return { key, code: code.trim(), at, targetKey, state: 'pending', undo: 'none' };
}

/**
 * The earlier row this code repeats, if it does.
 *
 * A repeat is a code this session has already dealt with FOR THE SAME TARGET:
 * the same label read twice, or a machine read once by its tag and again by
 * its serial. Only rows that left the machine where the target wants it
 * count — a done row not since undone, or one the database said was already
 * there. An undone row does not: scanning it again means "do it after all".
 * A row still pending counts too, so a label read twice in one second is one
 * change, not a race between two.
 */
export function findRepeat(rows: readonly SessionRow[], code: string, targetKey: string): SessionRow | null {
  const wanted = normaliseCode(code);
  if (wanted === '') return null;
  for (const row of rows) {
    if (row.targetKey !== targetKey) continue;
    const counts =
      row.state === 'pending' ||
      (row.state === 'done' && row.undo !== 'undone') ||
      (row.state === 'skipped' && row.skip === 'already');
    if (!counts) continue;
    if (normaliseCode(row.code) === wanted) return row;
    if (row.device && deviceCodes(row.device).includes(wanted)) return row;
  }
  return null;
}

/** A repeat, as its own row: skipped, pointing at the machine it repeats. */
export function repeatRow(row: SessionRow, of: SessionRow): SessionRow {
  return {
    ...row,
    state: 'skipped',
    skip: 'repeat',
    device: of.device,
    before: of.after ?? of.before,
    undo: 'none',
  };
}

/**
 * A device answer for a machine that an earlier row of this session already
 * handled, by another of its codes. The code check in `findRepeat` catches a
 * label read twice; this catches the tag read after the serial.
 */
export function repeatsDevice(rows: readonly SessionRow[], deviceId: string, targetKey: string, key: string): boolean {
  return rows.some(
    (row) =>
      row.key !== key &&
      row.targetKey === targetKey &&
      row.device?.id === deviceId &&
      ((row.state === 'done' && row.undo !== 'undone') || (row.state === 'skipped' && row.skip === 'already')),
  );
}

/** One answer, folded into the row that was waiting for it. */
export function answerRow(row: SessionRow, answer: ScanAnswer): SessionRow {
  switch (answer.outcome) {
    case 'done':
      return {
        ...row,
        state: 'done',
        device: answer.device,
        before: answer.before,
        after: answer.after,
        undo: 'available',
      };
    case 'already':
      return { ...row, state: 'skipped', skip: 'already', device: answer.device, before: answer.before };
    case 'held':
      return { ...row, state: 'skipped', skip: 'held', device: answer.device, before: answer.before };
    case 'found':
      // An audit's read. It changed nothing, so it is "done" only in the sense
      // that the scan landed; there is nothing to put back.
      return { ...row, state: 'done', device: answer.device, before: answer.before, undo: 'none' };
    case 'person':
      return { ...row, state: 'person', person: answer.person };
    case 'unknown':
      return { ...row, state: 'error', error: 'unknown' };
    case 'ambiguous':
      return { ...row, state: 'error', error: 'ambiguous' };
  }
}

/** The database refused, or the network did. The sentence is the database's. */
export function failRow(row: SessionRow, message: string): SessionRow {
  return { ...row, state: 'error', error: 'failed', message };
}

/** Rows with one row replaced by key. */
export function replaceRow(rows: readonly SessionRow[], key: string, next: (row: SessionRow) => SessionRow): SessionRow[] {
  return rows.map((row) => (row.key === key ? next(row) : row));
}

export function setUndo(
  rows: readonly SessionRow[],
  key: string,
  undo: UndoState,
  undoMessage?: string,
): SessionRow[] {
  return replaceRow(rows, key, (row) => ({ ...row, undo, undoMessage }));
}

export interface SessionCounts {
  done: number;
  skipped: number;
  errors: number;
  pending: number;
  /** Every code read, people's cards excepted. */
  scanned: number;
}

/** Done means changed and still changed: an undone row is no longer done. */
export function countRows(rows: readonly SessionRow[]): SessionCounts {
  const counts: SessionCounts = { done: 0, skipped: 0, errors: 0, pending: 0, scanned: 0 };
  for (const row of rows) {
    if (row.state === 'person') continue;
    counts.scanned += 1;
    if (row.state === 'pending') counts.pending += 1;
    else if (row.state === 'done' && row.undo !== 'undone') counts.done += 1;
    else if (row.state === 'skipped') counts.skipped += 1;
    else if (row.state === 'error') counts.errors += 1;
  }
  return counts;
}

/**
 * What "undo all" walks: every row that changed a machine and has not been
 * put back, newest first — so a machine moved twice is put back through both
 * steps in reverse, and ends where the run found it.
 */
export function undoQueue(rows: readonly SessionRow[]): SessionRow[] {
  return rows.filter((row) => row.state === 'done' && (row.undo === 'available' || row.undo === 'failed'));
}

// ---------------------------------------------------------------------------
// What a row says
// ---------------------------------------------------------------------------

function holderText(state: DeviceState | undefined): string {
  return state?.holderName ?? 'Nobody';
}

function locationText(state: DeviceState | undefined): string {
  const location = state?.location?.trim();
  return location ? location : 'No location';
}

function statusText(state: DeviceState | undefined): string {
  const status = state?.status?.trim();
  return status ? status : 'No status';
}

/**
 * The change, as two values the row draws with a mark between them. Never a
 * sentence with an arrow in it: the mark is the row's, not the copy's.
 */
export function changeOf(kind: WorkflowKind, row: SessionRow): { from: string; to: string } | null {
  if (row.state !== 'done' || !row.before || !row.after) return null;
  const { before, after } = row;
  switch (kind) {
    case 'move':
      return { from: locationText(before), to: locationText(after) };
    case 'status':
      return { from: statusText(before), to: statusText(after) };
    case 'handout':
      return { from: holderText(before), to: holderText(after) };
    case 'collect': {
      const from = before.holderName ?? statusText(before);
      const place = after.location && after.location !== before.location ? `, ${after.location}` : '';
      return { from, to: `${statusText(after)}${place}` };
    }
    case 'audit':
      return null;
  }
}

/** Why a row was skipped or refused, in a NetRider's words. */
export function rowNote(kind: WorkflowKind, row: SessionRow, target: WorkflowTarget, person?: string): string {
  if (row.state === 'error') {
    if (row.error === 'unknown') return 'Not in the inventory. Check the label and scan again.';
    if (row.error === 'ambiguous') return 'Two machines share this code. Scan the other label.';
    return row.message ?? 'That did not go through. Nothing changed.';
  }
  if (row.state === 'skipped') {
    if (row.skip === 'held') {
      return `With ${holderText(row.before)}. Collect it first.`;
    }
    const place = row.before;
    switch (kind) {
      case 'move':
      case 'audit':
        return row.skip === 'repeat'
          ? `Scanned already. In ${targetLabel(kind, target)}.`
          : `Already in ${locationText(place)}.`;
      case 'status':
        return row.skip === 'repeat' ? 'Scanned already.' : `Already ${statusText(place)}.`;
      case 'handout':
        return row.skip === 'repeat'
          ? 'Scanned already for this person.'
          : `Already with ${person ?? holderText(place)}.`;
      case 'collect':
        return row.skip === 'repeat'
          ? 'Scanned already.'
          : `Not out. Already ${statusText(place)}${place?.location ? ` in ${place.location}` : ''}.`;
    }
  }
  if (row.state === 'done' && kind === 'move' && row.before?.holderName) {
    return `Still with ${row.before.holderName}.`;
  }
  return '';
}

/** "4:07", "1:02:10". Tabular: the clock ticks in place. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return hours > 0 ? `${hours}:${pad(minutes)}:${pad(seconds)}` : `${minutes}:${pad(seconds)}`;
}

/** "Load a cart: Cart 3. 28 done, 2 skipped, 1 error in 4:07." Then one line per machine. */
export function summaryText(
  kind: WorkflowKind,
  target: WorkflowTarget,
  rows: readonly SessionRow[],
  elapsedMs: number,
): string {
  const counts = countRows(rows);
  const label = targetLabel(kind, target) || (kind === 'collect' ? COLLECT_DEFAULT_STATUS : '');
  const title = label ? `${workflowFor(kind).title}: ${label}` : workflowFor(kind).title;
  const parts = [`${counts.done} done`];
  if (counts.skipped > 0) parts.push(`${counts.skipped} skipped`);
  if (counts.errors > 0) parts.push(`${counts.errors} ${counts.errors === 1 ? 'error' : 'errors'}`);
  const lines = [`${title}. ${parts.join(', ')} in ${formatElapsed(elapsedMs)}.`];

  // Oldest first, as the run happened.
  for (const row of [...rows].reverse()) {
    if (row.state === 'pending') continue;
    if (row.state === 'person') {
      lines.push(`Next: ${row.person?.displayName ?? row.code}`);
      continue;
    }
    const name = row.device?.label ?? row.code;
    if (row.state === 'done' && row.undo === 'undone') {
      lines.push(`${name}: undone`);
      continue;
    }
    const change = changeOf(kind, row);
    if (change) lines.push(`${name}: ${change.from} to ${change.to}`);
    else if (kind === 'audit' && row.state === 'done') {
      lines.push(
        sameLocation(row.before?.location, target.location)
          ? `${name}: found`
          : `${name}: seen here, recorded in ${locationText(row.before)}`,
      );
    } else lines.push(`${name}: ${rowNote(kind, row, target) || 'done'}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Room audit: three piles
// ---------------------------------------------------------------------------

/** One machine the inventory says is in the room. */
export interface ExpectedDevice extends WorkflowDevice {
  state: DeviceState;
}

export function expectedFrom(value: unknown): ExpectedDevice | null {
  if (!isRecord(value)) return null;
  const device = deviceFrom(value);
  const state = stateFrom(value.state);
  return device && state ? { ...device, state } : null;
}

/** Two locations are the same room when they match trimmed and folded. */
export function sameLocation(a: string | null | undefined, b: string | null | undefined): boolean {
  const left = (a ?? '').trim().toLowerCase();
  return left !== '' && left === (b ?? '').trim().toLowerCase();
}

/**
 * A code, matched against the room's own list without a round trip. Most of
 * an audit's scans are machines that are where they should be, and those are
 * answered from memory.
 */
export function matchExpected(expected: readonly ExpectedDevice[], code: string): ExpectedDevice | null {
  const wanted = normaliseCode(code);
  if (wanted === '') return null;
  return expected.find((device) => deviceCodes(device).includes(wanted)) ?? null;
}

export interface ScannedMachine {
  device: WorkflowDevice;
  state: DeviceState;
}

export interface AuditDiff {
  /** Recorded here and seen here. */
  found: ScannedMachine[];
  /** Recorded here and not seen. */
  missing: ExpectedDevice[];
  /** Seen here and recorded somewhere else, or nowhere. */
  elsewhere: ScannedMachine[];
}

/**
 * The three piles.
 *
 * A machine seen in the room counts as found when the room's list has it, or
 * when its own record already says this room (it arrived after the list was
 * read). Everything else seen is misplaced. Everything on the list not seen is
 * missing. A machine seen twice is one machine.
 */
export function auditDiff(
  location: string,
  expected: readonly ExpectedDevice[],
  scanned: readonly ScannedMachine[],
): AuditDiff {
  const expectedIds = new Set(expected.map((device) => device.id));
  const seen = new Map<string, ScannedMachine>();
  for (const machine of scanned) {
    if (!seen.has(machine.device.id)) seen.set(machine.device.id, machine);
  }

  const found: ScannedMachine[] = [];
  const elsewhere: ScannedMachine[] = [];
  for (const machine of seen.values()) {
    if (expectedIds.has(machine.device.id) || sameLocation(machine.state.location, location)) {
      found.push(machine);
    } else {
      elsewhere.push(machine);
    }
  }
  const missing = expected.filter((device) => !seen.has(device.id));
  return { found, missing, elsewhere };
}

/** The scanned machines of an audit's rows, oldest first. */
export function auditMachines(rows: readonly SessionRow[]): ScannedMachine[] {
  const machines: ScannedMachine[] = [];
  for (const row of [...rows].reverse()) {
    if (row.state === 'done' && row.device && row.before) {
      machines.push({ device: row.device, state: row.before });
    }
  }
  return machines;
}

/** Ids in batches the bulk RPC accepts. */
export function chunk<T>(items: readonly T[], size = 200): T[][] {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size) batches.push(items.slice(index, index + size));
  return batches;
}
