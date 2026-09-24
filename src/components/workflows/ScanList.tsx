'use client';

/**
 * The run so far, newest first.
 *
 * One row a code: the machine, what changed (two values and a mark between
 * them), or why nothing did, and an Undo for a row that changed something.
 * The row arriving is the one piece of motion here — it answers the beep —
 * and it is eight pixels and a fade, gone under reduced motion.
 */

import { memo } from 'react';
import { ArrowRight, Check, CircleAlert, Minus, UserRound } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import type { WorkflowKind, WorkflowTarget } from '@/lib/domain/workflows';
import { changeOf, rowNote, type SessionRow } from '@/lib/workflows/session';

export interface ScanListProps {
  kind: WorkflowKind;
  target: WorkflowTarget;
  rows: readonly SessionRow[];
  personName?: string;
  onUndo: (key: string) => void;
  /** An audit's rows say which pile a machine went on, not what changed. */
  describe?: (row: SessionRow) => string | null;
  empty: string;
}

export function ScanList({ kind, target, rows, personName, onUndo, describe, empty }: ScanListProps) {
  if (rows.length === 0) {
    return <p className="wf-list-empty">{empty}</p>;
  }
  return (
    <ol className="wf-list" aria-label="Scans, newest first">
      {rows.map((row) => (
        <ScanRow
          key={row.key}
          kind={kind}
          target={target}
          row={row}
          personName={personName}
          onUndo={onUndo}
          describe={describe}
        />
      ))}
    </ol>
  );
}

const ScanRow = memo(function ScanRow({
  kind,
  target,
  row,
  personName,
  onUndo,
  describe,
}: {
  kind: WorkflowKind;
  target: WorkflowTarget;
  row: SessionRow;
  personName?: string;
  onUndo: (key: string) => void;
  describe?: (row: SessionRow) => string | null;
}) {
  const undone = row.undo === 'undone';
  const tone = row.state === 'pending' ? 'pending' : undone ? 'undone' : row.state;

  if (row.state === 'person') {
    return (
      <li className="wf-row" data-tone="person">
        <span className="wf-row-mark" aria-hidden="true">
          <Icon icon={UserRound} size={16} weight="medium" />
        </span>
        <span className="wf-row-main">
          <span className="wf-row-title">{row.person?.displayName}</span>
          <span className="wf-row-note">
            {row.person?.kind === 'staff' ? 'Staff' : 'Student'}
            {row.person?.externalId ? (
              <>
                , <span className="mono">{row.person.externalId}</span>
              </>
            ) : null}
            . Scan what they are taking.
          </span>
        </span>
      </li>
    );
  }

  const change = undone ? null : changeOf(kind, row);
  const described = describe ? describe(row) : null;
  const note = row.state === 'pending' ? 'Checking…' : undone ? 'Undone. Back as it was.' : described ?? rowNote(kind, row, target, personName);
  const meta = row.device ? [row.device.deviceType, row.device.model].filter(Boolean).join(' ') : '';

  return (
    <li className="wf-row" data-tone={tone}>
      <span className="wf-row-mark" aria-hidden="true">
        {row.state === 'pending' ? (
          <span className="wf-row-dot" />
        ) : row.state === 'done' && !undone ? (
          <Icon icon={Check} size={16} weight="bold" />
        ) : row.state === 'error' ? (
          <Icon icon={CircleAlert} size={16} weight="medium" />
        ) : (
          <Icon icon={Minus} size={16} weight="medium" />
        )}
      </span>
      <span className="wf-row-main">
        <span className="wf-row-title">
          <span className="mono">{row.device?.label ?? row.code}</span>
          {meta ? <span className="wf-row-meta">{meta}</span> : null}
        </span>
        {change ? (
          <span className="wf-row-change">
            <span className="wf-row-from">{change.from}</span>
            <Icon icon={ArrowRight} size={14} className="wf-row-arrow" />
            <span className="wf-row-to">{change.to}</span>
          </span>
        ) : null}
        {note ? <span className="wf-row-note">{note}</span> : null}
        {row.undo === 'failed' && row.undoMessage ? (
          <span className="wf-row-note wf-row-bad" role="alert">
            {row.undoMessage}
          </span>
        ) : null}
      </span>
      {row.state === 'done' && (row.undo === 'available' || row.undo === 'failed' || row.undo === 'pending') ? (
        <Button
          variant="ghost"
          size="sm"
          className="wf-row-undo"
          loading={row.undo === 'pending'}
          onClick={() => onUndo(row.key)}
          aria-label={`Undo ${row.device?.label ?? row.code}`}
        >
          Undo
        </Button>
      ) : null}
    </li>
  );
});
