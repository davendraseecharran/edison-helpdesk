'use client';

/**
 * The button that offers a phone to one field.
 *
 * It sits beside the input it fills — the serial number, the asset tag, a
 * device search — and knows which one it is, so the pairing dialog can tell
 * the phone what the desktop is waiting for. That matters: a technician
 * filling in a device record opens this twice, once for each identifier, and
 * the phone is the only screen they are looking at while they do it.
 *
 * The code is handed back through a prop rather than written into the DOM.
 * Every one of these fields is a controlled React input, and setting `value`
 * from outside would be overwritten by the next render; the owner's own
 * setter is the only thing that actually changes a controlled field.
 */

import { useCallback, useState } from 'react';
import { Smartphone } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { ScanPairingDialog } from './ScanPairingDialog';
import '@/styles/scan.css';

export interface ScanTargetButtonProps {
  /** What this field is, in sentence case: "Serial number", "Asset tag". */
  label: string;
  /** Given the scanned code, as read. */
  onScan: (code: string) => void;
  disabled?: boolean;
  className?: string;
}

export function ScanTargetButton({ label, onScan, disabled, className }: ScanTargetButtonProps) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        icon={Smartphone}
        className={className ? `scan-target ${className}` : 'scan-target'}
        aria-label={`Scan ${label.toLowerCase()} with your phone`}
        title={`Scan ${label.toLowerCase()} with your phone`}
        disabled={disabled}
        onClick={() => setOpen(true)}
      />
      <ScanPairingDialog
        open={open}
        target="field"
        label={label}
        onScan={onScan}
        onClose={close}
      />
    </>
  );
}
