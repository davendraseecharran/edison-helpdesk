'use client';

/**
 * "Scan with your phone", inside the run rather than over it.
 *
 * The pairing dialog the device form uses is modal, which is right for one
 * serial number and wrong for a cart: the person at the laptop wants to watch
 * the list fill while somebody walks the room with the phone. So the same
 * relay (`useScanRelay`, over the same five RPCs) is drawn here as a panel: a
 * QR code until the phone has sent its first code, then one quiet line that
 * says it is connected, with the way to stop it.
 *
 * Opening starts a pairing and closing stops it, whatever closed it.
 */

import { useCallback, useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { QrCode } from '@/components/ui/QrCode';
import { Skeleton } from '@/components/ui/Skeleton';
import { useScanRelay } from '@/components/scan/useScanRelay';
import { endScanSessionAction, startScanSessionAction } from '@/lib/data/scan-actions';
import { isLoopbackUrl } from '@/lib/domain/records';
import '@/styles/scan.css';

type Pairing =
  | { kind: 'starting' }
  | { kind: 'ready'; id: string; url: string; qrSvg: string; expiresAt: string }
  | { kind: 'error'; error: string };

export interface PhonePairingProps {
  /** What the phone shows it is scanning for: "Load a cart: Cart 3". */
  label: string;
  onCode: (code: string) => void;
  onClose: () => void;
}

export function PhonePairing({ label, onCode, onClose }: PhonePairingProps) {
  const [pairing, setPairing] = useState<Pairing>({ kind: 'starting' });
  const [expired, setExpired] = useState(false);

  useEffect(() => {
    let cancelled = false;
    let started: string | null = null;
    void (async () => {
      try {
        const result = await startScanSessionAction(label.slice(0, 80));
        if (cancelled) {
          if (result.ok) void endScanSessionAction(result.id).catch(() => {});
          return;
        }
        if (!result.ok) {
          setPairing({ kind: 'error', error: result.error });
          return;
        }
        started = result.id;
        setPairing({ kind: 'ready', id: result.id, url: result.url, qrSvg: result.qrSvg, expiresAt: result.expiresAt });
      } catch {
        if (!cancelled) setPairing({ kind: 'error', error: 'The pairing could not be opened. Try again.' });
      }
    })();
    return () => {
      cancelled = true;
      if (started) void endScanSessionAction(started).catch(() => {});
    };
  }, [label]);

  const expiresAt = pairing.kind === 'ready' ? pairing.expiresAt : '';
  useEffect(() => {
    if (!expiresAt) return;
    const remaining = new Date(expiresAt).getTime() - Date.now();
    if (Number.isNaN(remaining)) return;
    const timer = window.setTimeout(() => setExpired(true), Math.max(0, remaining));
    return () => window.clearTimeout(timer);
  }, [expiresAt]);

  const deliver = useCallback((code: string) => onCode(code), [onCode]);
  const { events, transport } = useScanRelay(
    pairing.kind === 'ready' && !expired ? pairing.id : null,
    deliver,
  );
  const connected = events.length > 0;

  return (
    <section className="wf-pair" aria-label="Scan with your phone" data-connected={connected || undefined}>
      <div className="wf-pair-head">
        <p className="wf-pair-status" role="status">
          {pairing.kind === 'error'
            ? pairing.error
            : expired
              ? 'This pairing has run out. Close it and pair again.'
              : connected
                ? `Phone connected. ${events.length === 1 ? '1 code' : `${events.length} codes`} so far.`
                : 'Open this on your phone, then scan.'}
        </p>
        <Button variant="ghost" size="sm" icon={X} onClick={onClose}>
          Stop
        </Button>
      </div>
      {!connected && pairing.kind !== 'error' ? (
        pairing.kind === 'starting' ? (
          <div className="wf-pair-body">
            <Skeleton className="wf-pair-qr-skeleton" />
          </div>
        ) : (
          <div className="wf-pair-body">
            <QrCode svg={pairing.qrSvg} label={`QR code for ${pairing.url}`} size={148} />
            <div className="wf-pair-text">
              <p className="wf-pair-url mono">{pairing.url}</p>
              {isLoopbackUrl(pairing.url) ? (
                <p className="wf-pair-note">
                  This address only works on this computer. Set NEXT_PUBLIC_APP_ORIGIN to pair a phone.
                </p>
              ) : null}
              {transport === 'polling' ? (
                <p className="wf-pair-note">Each scan may take a second to arrive.</p>
              ) : null}
            </div>
          </div>
        )
      ) : null}
    </section>
  );
}
