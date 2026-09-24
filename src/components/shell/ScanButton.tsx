'use client';

import { useCallback, useState, useSyncExternalStore } from 'react';
import { ScanLine } from 'lucide-react';
import { CameraViewfinder } from '@/components/scan/CameraViewfinder';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { usePhone } from '@/components/ui/media';
import { Sheet } from '@/components/ui/Sheet';

function subscribeToNothing(): () => void {
  return () => {};
}

/** Whether this browser can open a camera at all. False on the server. */
function useCameraSupport(): boolean {
  return useSyncExternalStore(
    subscribeToNothing,
    () => typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices?.getUserMedia),
    () => false,
  );
}

/**
 * The camera scan inside the palette input.
 *
 * Rendered wherever the browser can open a camera. The frame is
 * `CameraViewfinder`: the browser's own `BarcodeDetector` where it has one and
 * the WebAssembly decoder everywhere else, iPhones included, loaded the first
 * time the camera opens and never before; the torch, the other camera and the
 * zoom when the camera has them; and a plain sentence when it cannot start. A
 * browser with no camera shows no button rather than a button that fails.
 *
 * On a desktop it is a dialog; on a phone a full-height sheet, because the
 * picture is the whole point of it there. The first code read is handed to
 * `onDetect` and the surface closes. What becomes of that code is the caller's
 * to decide — `src/lib/scan/route.ts` asks the inventory about it before the
 * search does — and this component deliberately does not know. Every track is
 * stopped on close, whatever closed it. The phone-as-scanner relay for a
 * desktop session is separate.
 */
export function ScanButton({
  onDetect,
  onOpenChange,
}: {
  /** Given the code, as read. The caller decides where it goes. */
  onDetect: (code: string) => void;
  /** Reports the surface opening and closing, so the palette can yield Escape to it. */
  onOpenChange?: (open: boolean) => void;
}) {
  const supported = useCameraSupport();
  const phone = usePhone();
  const [open, setOpen] = useState(false);

  const close = useCallback(() => {
    setOpen(false);
    onOpenChange?.(false);
  }, [onOpenChange]);

  function start() {
    setOpen(true);
    onOpenChange?.(true);
  }

  const read = useCallback(
    (code: string) => {
      onDetect(code);
      close();
    },
    [onDetect, close],
  );

  if (!supported) return null;

  const frame = open ? (
    <CameraViewfinder mode="once" onCode={read} fill={phone} note="An asset tag, a serial number or a QR code." />
  ) : null;

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        icon={ScanLine}
        className="palette-scan"
        aria-label="Scan a barcode"
        title="Scan a barcode"
        onClick={start}
      />
      {phone ? (
        <Sheet side="bottom" open={open} onClose={close} title="Scan a barcode" className="camera-sheet">
          {frame}
        </Sheet>
      ) : (
        <Dialog
          open={open}
          onClose={close}
          title="Scan a barcode"
          description="Point the camera at an asset tag, serial number or QR code."
          className="scan-dialog"
          footer={<Button onClick={close}>Cancel</Button>}
        >
          {frame}
        </Dialog>
      )}
    </>
  );
}
