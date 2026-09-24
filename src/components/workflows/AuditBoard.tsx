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
 * What to do about the two piles that did not add up is decided once the
 * walk-through is finished, machine by machine, in `AuditResolution`.
 */

import { useState } from 'react';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import type { AuditDiff, ExpectedDevice, ScannedMachine } from '@/lib/workflows/session';
import { SettleNumber } from './SettleNumber';

type Pile = 'missing' | 'elsewhere' | 'found';

export interface AuditBoardProps {
  location: string;
  expectedCount: number;
  diff: AuditDiff;
}

function machineMeta(device: { deviceType: string; model: string }): string {
  return [device.deviceType, device.model].filter(Boolean).join(' ');
}

export function AuditBoard({ location, expectedCount, diff }: AuditBoardProps) {
  const [pile, setPile] = useState<Pile>('missing');
  const counts = { found: diff.found.length, missing: diff.missing.length, elsewhere: diff.elsewhere.length };

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
