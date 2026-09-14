'use client';

/**
 * "Scan with your phone": the desktop half of the pairing.
 *
 * A technician with a broken hardware scanner has a phone in their pocket.
 * This dialog draws a QR code, the phone opens it, and every barcode the
 * phone reads lands in the field that asked for it. The QR carries a session
 * id and nothing else — no token, no key. What authorizes the phone is that
 * it is signed in as the same person, which is the one thing a photograph of
 * a monitor cannot copy.
 *
 * Opening starts a session; closing stops it, whatever closed it, including a
 * navigation that unmounts the dialog. Sessions also run out on their own
 * after half an hour, so a dialog left open on a forgotten tab costs nothing.
 *
 * What a scan does depends on who asked for it, and the two are genuinely
 * different:
 *
 *   - `field` — the serial and asset-tag inputs, the device search. The code
 *     goes into the field and the dialog STAYS OPEN, because the next thing
 *     that happens is often another laptop off the same cart, and because a
 *     misread should be visible next to the field it filled.
 *   - `lookup` — the command palette. The code IS the search, so the first
 *     scan finishes the job: the dialog closes, the session stops, and the
 *     palette opens with the code as its query. Leaving the pairing open
 *     would also leave two modal surfaces fighting over the keyboard.
 */

import { useCallback, useEffect, useState } from 'react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { QrCode } from '@/components/ui/QrCode';
import { Skeleton } from '@/components/ui/Skeleton';
import { Orb } from '@/components/ai/Orb';
import {
  endScanSessionAction,
  startScanSessionAction,
  type StartScanResult,
} from '@/lib/data/scan-actions';
import { useScanRelay } from './useScanRelay';
import '@/styles/scan.css';

/** Who asked for the code. */
export type ScanTarget = 'lookup' | 'field';

/** How many recent codes the dialog keeps on screen. */
const RECENT_SHOWN = 5;

export interface ScanPairingDialogProps {
  open: boolean;
  /** What happens to a scan. `field` keeps scanning; `lookup` searches once. */
  target: ScanTarget;
  /** What the desktop is asking for, shown on the phone. */
  label?: string;
  onScan: (code: string) => void;
  onClose: () => void;
}

type Pairing =
  | { kind: 'starting' }
  | { kind: 'ready'; id: string; url: string; qrSvg: string; expiresAt: string }
  | { kind: 'error'; error: string };

export function ScanPairingDialog({
  open,
  target,
  label,
  onScan,
  onClose,
}: ScanPairingDialogProps) {
  const [pairing, setPairing] = useState<Pairing>({ kind: 'starting' });
  const [expired, setExpired] = useState(false);

  // Every opening is a fresh pairing, so the dialog goes back to its waiting
  // state in the render that opened it rather than in an effect afterwards:
  // one frame of the previous session's QR code would be a code that no
  // longer works.
  const request = open ? (label ?? '') : null;
  const [requestedFor, setRequestedFor] = useState<string | null>(null);
  if (requestedFor !== request) {
    setRequestedFor(request);
    setPairing({ kind: 'starting' });
    setExpired(false);
  }

  // One session per opening. The cleanup stops whatever this effect started,
  // including the session of a run React discarded, so a development
  // double-mount never leaves a pairing live behind the one on screen.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    let started: string | null = null;

    void (async () => {
      let result: StartScanResult;
      try {
        result = await startScanSessionAction(label);
      } catch {
        result = { ok: false, error: 'The pairing could not be opened. Try again.' };
      }
      if (cancelled) {
        if (result.ok) void endScanSessionAction(result.id).catch(() => {});
        return;
      }
      if (!result.ok) {
        setPairing({ kind: 'error', error: result.error });
        return;
      }
      started = result.id;
      setPairing({
        kind: 'ready',
        id: result.id,
        url: result.url,
        qrSvg: result.qrSvg,
        expiresAt: result.expiresAt,
      });
    })();

    return () => {
      cancelled = true;
      if (started) void endScanSessionAction(started).catch(() => {});
    };
  }, [open, label]);

  // The session's own half hour, reported rather than merely enforced: the
  // database refuses a late scan, and a technician holding a phone deserves
  // to know why nothing is arriving.
  const expiresAt = pairing.kind === 'ready' ? pairing.expiresAt : '';
  useEffect(() => {
    if (!expiresAt) return;
    const remaining = new Date(expiresAt).getTime() - Date.now();
    if (Number.isNaN(remaining)) return;
    // Zero is a real value here — a session that had already run out when the
    // dialog read it — and a zero-length timeout says so on the next tick
    // rather than during this render.
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [expiresAt]);

  const onCode = useCallback(
    (code: string) => {
      onScan(code);
      if (target === 'lookup') onClose();
    },
    [onScan, onClose, target],
  );

  const { events, transport } = useScanRelay(
    pairing.kind === 'ready' && !expired ? pairing.id : null,
    onCode,
  );

  const recent = events.slice(-RECENT_SHOWN).reverse();

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title="Scan with your phone"
      description="Open this on your phone, then point it at a barcode."
      className="scan-pairing"
      footer={
        <Button data-autofocus="" onClick={onClose}>
          Stop scanning
        </Button>
      }
    >
      {pairing.kind === 'starting' ? (
        <div className="scan-pairing-body">
          <Skeleton className="scan-qr-skeleton" />
          <Skeleton width="70%" />
        </div>
      ) : pairing.kind === 'error' ? (
        <p className="flash flash-error" role="alert">
          {pairing.error}
        </p>
      ) : (
        <div className="scan-pairing-body">
          <QrCode svg={pairing.qrSvg} label={`QR code for ${pairing.url}`} size={240} />
          <p className="scan-pairing-url mono">{pairing.url}</p>

          <p className="scan-pairing-wait">
            <Orb moment="pairing" size={20} label="Waiting for a scan" />
            <span>
              {expired
                ? 'This pairing has run out. Stop scanning, then start it again.'
                : 'Waiting for a scan.'}
            </span>
          </p>

          <div className="scan-pairing-recent">
            <h3 className="scan-pairing-recent-title">Scans</h3>
            {recent.length === 0 ? (
              <p className="scan-pairing-empty">Nothing yet.</p>
            ) : (
              <ul className="scan-pairing-list">
                {recent.map((event) => (
                  <li key={event.id} className="scan-pairing-code mono">
                    {event.code}
                  </li>
                ))}
              </ul>
            )}
            {/* Announced rather than shown twice: the list above is the record,
                this is what a screen reader hears the moment a code lands. */}
            <p className="visually-hidden" role="status">
              {recent.length > 0 ? `Scanned ${recent[0].code}` : ''}
            </p>
          </div>

          {transport === 'polling' ? (
            <p className="scan-pairing-note">
              Live updates are unavailable, so a scan takes a second or two to arrive.
            </p>
          ) : null}
        </div>
      )}
    </Dialog>
  );
}
