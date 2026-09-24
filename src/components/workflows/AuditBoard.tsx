'use client';

/**
 * A room audit, as three piles.
 *
 * Found: on the room's list and seen. Missing: on the list and not seen yet.
 * Misplaced: seen here and recorded somewhere else. The three counts turn
 * over as each scan lands — Missing counting down while Found counts up is the
 * whole story of a walk-through — and the list under them shows whichever pile
 * is chosen.
 *
 * The two fixes a walk-through ends with are offered once it is finished, each
 * behind a confirmation that names the number: bring the misplaced machines'
 * records here, and mark the ones nobody saw as missing.
 */

import { useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { showToast } from '@/components/ui/shadcn/sonner';
import { bulkUpdateDevicesAction } from '@/lib/data/device-actions';
import { MISSING_STATUS } from '@/lib/domain/workflows';
import { chunk, type AuditDiff, type ExpectedDevice, type ScannedMachine } from '@/lib/workflows/session';
import { SettleNumber } from './SettleNumber';

type Pile = 'missing' | 'elsewhere' | 'found';
type Fix = 'move' | 'mark';

export interface AuditBoardProps {
  location: string;
  expectedCount: number;
  diff: AuditDiff;
  finished: boolean;
}

function machineMeta(device: { deviceType: string; model: string }): string {
  return [device.deviceType, device.model].filter(Boolean).join(' ');
}

export function AuditBoard({ location, expectedCount, diff, finished }: AuditBoardProps) {
  const [pile, setPile] = useState<Pile>('missing');
  const [confirm, setConfirm] = useState<Fix | null>(null);
  const [pending, setPending] = useState(false);
  const [applied, setApplied] = useState<Record<Fix, boolean>>({ move: false, mark: false });

  const counts = { found: diff.found.length, missing: diff.missing.length, elsewhere: diff.elsewhere.length };

  async function apply(fix: Fix) {
    const ids =
      fix === 'move' ? diff.elsewhere.map((one) => one.device.id) : diff.missing.map((one) => one.id);
    const patch = fix === 'move' ? { location } : { status: MISSING_STATUS };
    setPending(true);
    let changed = 0;
    let failure: string | null = null;
    for (const batch of chunk(ids)) {
      const result = await bulkUpdateDevicesAction(batch, patch);
      if (!result.ok) {
        failure = result.error ?? 'That did not go through.';
        break;
      }
      changed += result.count ?? batch.length;
    }
    setPending(false);
    setConfirm(null);
    if (failure) {
      showToast('error', changed > 0 ? `${failure} ${changed} were changed before that.` : failure);
      return;
    }
    setApplied((current) => ({ ...current, [fix]: true }));
    showToast(
      'success',
      fix === 'move'
        ? `${changed === 1 ? '1 machine' : `${changed} machines`} now recorded in ${location}.`
        : `${changed === 1 ? '1 machine' : `${changed} machines`} marked ${MISSING_STATUS}.`,
    );
  }

  return (
    <section className="wf-audit" aria-label={`Audit of ${location}`}>
      <div className="wf-audit-counts">
        <div className="wf-audit-count" data-pile="found">
          <SettleNumber value={counts.found} className="wf-audit-number" />
          <span className="wf-audit-label">
            Found <span className="wf-audit-of">of {expectedCount}</span>
          </span>
        </div>
        <div className="wf-audit-count" data-pile="missing">
          <SettleNumber value={counts.missing} className="wf-audit-number" />
          <span className="wf-audit-label">Not seen yet</span>
        </div>
        <div className="wf-audit-count" data-pile="elsewhere">
          <SettleNumber value={counts.elsewhere} className="wf-audit-number" />
          <span className="wf-audit-label">Recorded elsewhere</span>
        </div>
      </div>
      <p className="visually-hidden" role="status">
        {`${counts.found} found, ${counts.missing} not seen, ${counts.elsewhere} recorded elsewhere.`}
      </p>

      {finished && (counts.elsewhere > 0 || counts.missing > 0) ? (
        <div className="wf-audit-fixes">
          {counts.elsewhere > 0 ? (
            <Button
              variant="secondary"
              disabled={applied.move}
              onClick={() => setConfirm('move')}
            >
              {applied.move ? 'Moved here' : `Move ${counts.elsewhere} here`}
            </Button>
          ) : null}
          {counts.missing > 0 ? (
            <Button
              variant="secondary"
              disabled={applied.mark}
              onClick={() => setConfirm('mark')}
            >
              {applied.mark ? `Marked ${MISSING_STATUS}` : `Mark ${counts.missing} ${MISSING_STATUS.toLowerCase()}`}
            </Button>
          ) : null}
        </div>
      ) : null}

      <div className="wf-audit-pick">
        <SegmentedControl<Pile>
          label="Show"
          size="sm"
          value={pile}
          onChange={setPile}
          options={[
            { value: 'missing', label: `Not seen ${counts.missing}` },
            { value: 'elsewhere', label: `Elsewhere ${counts.elsewhere}` },
            { value: 'found', label: `Found ${counts.found}` },
          ]}
        />
      </div>
      <AuditPile pile={pile} diff={diff} location={location} />

      <Dialog
        open={confirm !== null}
        onClose={() => (pending ? undefined : setConfirm(null))}
        title={
          confirm === 'move'
            ? `Record ${counts.elsewhere === 1 ? '1 machine' : `${counts.elsewhere} machines`} in ${location}?`
            : `Mark ${counts.missing === 1 ? '1 machine' : `${counts.missing} machines`} ${MISSING_STATUS.toLowerCase()}?`
        }
        description={
          confirm === 'move'
            ? 'Their location changes to this room. Holders and statuses stay as they are.'
            : `Their status changes to ${MISSING_STATUS}. Holders and locations stay as they are.`
        }
        footer={
          <>
            <Button onClick={() => setConfirm(null)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="primary" loading={pending} onClick={() => confirm && void apply(confirm)}>
              {confirm === 'move' ? 'Move them here' : `Mark ${MISSING_STATUS.toLowerCase()}`}
            </Button>
          </>
        }
      >
        <ul className="wf-audit-confirm-list">
          {(confirm === 'move' ? diff.elsewhere.map((one) => one.device) : diff.missing)
            .slice(0, 8)
            .map((device) => (
              <li key={device.id} className="mono">
                {device.label}
              </li>
            ))}
          {(confirm === 'move' ? counts.elsewhere : counts.missing) > 8 ? (
            <li className="wf-audit-confirm-more">
              and {(confirm === 'move' ? counts.elsewhere : counts.missing) - 8} more
            </li>
          ) : null}
        </ul>
      </Dialog>
    </section>
  );
}

function AuditPile({ pile, diff, location }: { pile: Pile; diff: AuditDiff; location: string }) {
  if (pile === 'missing') {
    if (diff.missing.length === 0) {
      return <p className="wf-list-empty">Everything recorded in {location} has been seen.</p>;
    }
    return (
      <ul className="wf-pile">
        {diff.missing.map((device: ExpectedDevice) => (
          <li key={device.id} className="wf-pile-row">
            <span className="mono">{device.label}</span>
            <span className="wf-pile-meta">
              {[machineMeta(device), device.state.holderName ? `with ${device.state.holderName}` : device.state.status]
                .filter(Boolean)
                .join(', ')}
            </span>
          </li>
        ))}
      </ul>
    );
  }
  const rows: ScannedMachine[] = pile === 'found' ? diff.found : diff.elsewhere;
  if (rows.length === 0) {
    return (
      <p className="wf-list-empty">
        {pile === 'found' ? 'Nothing scanned yet.' : `Nothing recorded somewhere other than ${location}.`}
      </p>
    );
  }
  return (
    <ul className="wf-pile">
      {rows.map((machine) => (
        <li key={machine.device.id} className="wf-pile-row">
          <span className="mono">{machine.device.label}</span>
          <span className="wf-pile-meta">
            {pile === 'elsewhere'
              ? machine.state.location?.trim()
                ? `Recorded in ${machine.state.location}`
                : 'No location on record'
              : machineMeta(machine.device)}
          </span>
        </li>
      ))}
    </ul>
  );
}
