'use client';

/**
 * One run of scans: the engine every workflow shares.
 *
 * Codes arrive from three places — the keyboard wedge, the camera, a paired
 * phone — and all of them come through `submit`. Each becomes a row at once,
 * so the list answers the beep before the database does, and the requests go
 * out ONE AT A TIME, in the order the codes were read. Scanners are faster
 * than round trips; a queue keeps "the same label twice in a second" one
 * change rather than a race between two, and keeps the list in the order the
 * NetRider actually worked.
 *
 * The rules — what is a repeat, what counts, what undo walks — are
 * `src/lib/workflows/session.ts`. This hook only sequences them.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  workflowFindPersonAction,
  workflowScanAction,
  workflowUndoAction,
} from '@/lib/data/workflow-actions';
import { scanAction, scanTarget, type WorkflowKind, type WorkflowTarget } from '@/lib/domain/workflows';
import {
  feedback,
  soundPreferenceSnapshot,
  subscribeSoundPreference,
  writeSoundPreference,
} from '@/lib/workflows/feedback';
import {
  answerRow,
  failRow,
  findRepeat,
  matchExpected,
  pendingRow,
  repeatRow,
  repeatsDevice,
  replaceRow,
  setUndo,
  undoQueue,
  type ExpectedDevice,
  type SessionRow,
  type WorkflowPerson,
} from '@/lib/workflows/session';

const OFFLINE = 'That did not reach the helpdesk. Nothing changed. Scan it again.';

export interface ScanSession {
  rows: SessionRow[];
  person: WorkflowPerson | null;
  sound: boolean;
  setSound: (on: boolean) => void;
  submit: (code: string) => void;
  choosePerson: (person: WorkflowPerson | null) => void;
  undo: (key: string) => Promise<void>;
  undoAll: () => Promise<void>;
  undoingAll: boolean;
  /** A fresh run: no rows, nobody chosen. */
  reset: () => void;
  /** The last row that arrived, for the screen reader's line and the cart. */
  latest: SessionRow | null;
}

let counter = 0;
function nextKey(): string {
  counter += 1;
  return `scan-${Date.now().toString(36)}-${counter}`;
}

export function useScanSession({
  kind,
  target,
  expected,
}: {
  kind: WorkflowKind;
  target: WorkflowTarget;
  /** An audit's room list. Codes on it are answered from memory. */
  expected: readonly ExpectedDevice[];
}): ScanSession {
  const [rows, setRows] = useState<SessionRow[]>([]);
  const [person, setPerson] = useState<WorkflowPerson | null>(null);
  const [undoingAll, setUndoingAll] = useState(false);

  // The latest values, for the queue's closures, which outlive a render.
  const rowsRef = useRef<SessionRow[]>([]);
  const personRef = useRef<WorkflowPerson | null>(null);
  const soundRef = useRef(true);
  const queue = useRef<Promise<void>>(Promise.resolve());

  // The server has no localStorage and says "on"; the browser reads the
  // switch after hydration without a second render pass of its own.
  const sound = useSyncExternalStore(subscribeSoundPreference, soundPreferenceSnapshot, () => true);
  useEffect(() => {
    soundRef.current = sound;
  }, [sound]);

  const setSound = useCallback((on: boolean) => {
    soundRef.current = on;
    writeSoundPreference(on);
  }, []);

  /** Every change to the list goes through here, so the ref never lags. */
  const update = useCallback((next: (current: SessionRow[]) => SessionRow[]) => {
    rowsRef.current = next(rowsRef.current);
    setRows(rowsRef.current);
  }, []);

  const choosePerson = useCallback((next: WorkflowPerson | null) => {
    personRef.current = next;
    setPerson(next);
  }, []);

  const targetKey = useCallback(
    () => (kind === 'handout' ? `person:${personRef.current?.id ?? ''}` : 'target'),
    [kind],
  );

  const settle = useCallback((row: SessionRow) => {
    if (row.state === 'done' || row.state === 'person') feedback('done', soundRef.current);
    else if (row.state === 'skipped') feedback('skipped', soundRef.current);
    else if (row.state === 'error') feedback('error', soundRef.current);
  }, []);

  const submit = useCallback(
    (raw: string) => {
      const code = raw.trim();
      if (code === '') return;
      const key = nextKey();
      const row = pendingRow(code, targetKey(), Date.now(), key);

      // A hand-out with nobody chosen yet: the code is the person.
      if (kind === 'handout' && !personRef.current) {
        update((current) => [row, ...current]);
        queue.current = queue.current.then(async () => {
          let found: WorkflowPerson | null = null;
          try {
            found = await workflowFindPersonAction(code);
          } catch {
            found = null;
          }
          if (found) {
            choosePerson(found);
            const answered = { ...row, state: 'person' as const, person: found };
            update((current) => replaceRow(current, key, () => answered));
            settle(answered);
          } else {
            const refused = failRow(row, 'Nobody has that ID. Scan the card again, or search by name.');
            update((current) => replaceRow(current, key, () => refused));
            settle(refused);
          }
        });
        return;
      }

      const repeat = findRepeat(rowsRef.current, code, row.targetKey);
      if (repeat) {
        const skipped = repeatRow(row, repeat);
        update((current) => [skipped, ...current]);
        settle(skipped);
        return;
      }

      // An audit's machine that is on the room's list needs no round trip.
      if (kind === 'audit') {
        const known = matchExpected(expected, code);
        if (known) {
          const { state, ...device } = known;
          const answered = answerRow(row, { outcome: 'found', code, device, before: state });
          update((current) => [answered, ...current]);
          settle(answered);
          return;
        }
      }

      update((current) => [row, ...current]);
      const payload = scanTarget(kind, target, personRef.current?.id ?? null);
      queue.current = queue.current.then(async () => {
        let next: SessionRow;
        try {
          const result = await workflowScanAction(code, scanAction(kind), payload);
          if (!result.ok) {
            next = failRow(row, result.error);
          } else if (result.answer.outcome === 'person') {
            choosePerson(result.answer.person);
            next = answerRow(row, result.answer);
          } else {
            next = answerRow(row, result.answer);
            // The same machine by another of its codes: one machine, one row.
            if (
              next.device &&
              (next.state === 'done' || next.state === 'skipped') &&
              next.undo !== 'available' &&
              repeatsDevice(rowsRef.current, next.device.id, row.targetKey, key)
            ) {
              next = { ...next, state: 'skipped', skip: 'repeat' };
            }
          }
        } catch {
          next = failRow(row, OFFLINE);
        }
        update((current) => replaceRow(current, key, () => next));
        settle(next);
      });
    },
    [kind, target, expected, targetKey, update, choosePerson, settle],
  );

  const undoOne = useCallback(
    async (key: string): Promise<boolean> => {
      const row = rowsRef.current.find((one) => one.key === key);
      if (!row || row.state !== 'done' || !row.device || !row.before || !row.after) return false;
      if (row.undo !== 'available' && row.undo !== 'failed') return false;
      update((current) => setUndo(current, key, 'pending'));
      try {
        const result = await workflowUndoAction(row.device.id, row.after, row.before);
        if (result.ok) {
          update((current) => setUndo(current, key, 'undone'));
          return true;
        }
        update((current) => setUndo(current, key, 'failed', result.error));
      } catch {
        update((current) => setUndo(current, key, 'failed', OFFLINE));
      }
      return false;
    },
    [update],
  );

  const undo = useCallback(
    async (key: string) => {
      // After whatever is still in flight, so an undo never overtakes the scan
      // it is undoing.
      await queue.current;
      const ok = await undoOne(key);
      feedback(ok ? 'skipped' : 'error', soundRef.current);
    },
    [undoOne],
  );

  const undoAll = useCallback(async () => {
    setUndoingAll(true);
    await queue.current;
    let failed = false;
    for (const row of undoQueue(rowsRef.current)) {
      if (!(await undoOne(row.key))) failed = true;
    }
    setUndoingAll(false);
    feedback(failed ? 'error' : 'skipped', soundRef.current);
  }, [undoOne]);

  const reset = useCallback(() => {
    queue.current = Promise.resolve();
    rowsRef.current = [];
    setRows([]);
    personRef.current = null;
    setPerson(null);
  }, []);

  return {
    reset,
    rows,
    person,
    sound,
    setSound,
    submit,
    choosePerson,
    undo,
    undoAll,
    undoingAll,
    latest: rows[0] ?? null,
  };
}
