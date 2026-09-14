'use client';

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { ScanLine } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';

/** What the shape detection API reads: the formats asset tags, serials and labels come in. */
const FORMATS = ['code_128', 'code_39', 'ean_13', 'ean_8', 'upc_a', 'qr_code', 'data_matrix'];

interface DetectedBarcode {
  rawValue: string;
  format: string;
}

interface BarcodeDetectorLike {
  detect(source: HTMLVideoElement): Promise<DetectedBarcode[]>;
}

type BarcodeDetectorConstructor = new (options?: { formats?: string[] }) => BarcodeDetectorLike;

function detectorConstructor(): BarcodeDetectorConstructor | undefined {
  return (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector;
}

function subscribeToNothing(): () => void {
  return () => {};
}

/** Whether this browser can read barcodes from the camera. False on the server. */
function useBarcodeSupport(): boolean {
  return useSyncExternalStore(
    subscribeToNothing,
    () => 'BarcodeDetector' in window,
    () => false,
  );
}

/** Milliseconds between detection passes over the live frame. */
const SCAN_INTERVAL_MS = 250;

/**
 * The camera scan inside the palette input.
 *
 * Rendered only where `BarcodeDetector` exists (Chrome on Android and
 * ChromeOS, which is what the helpdesk's phones and Chromebooks run), so a
 * browser that cannot scan shows no button rather than a button that fails.
 * The dialog holds the rear camera's preview; the first code read is handed to
 * `onDetect` and the dialog closes. What becomes of that code is the caller's
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
  /** Reports the dialog opening and closing, so the palette can yield Escape to it. */
  onOpenChange?: (open: boolean) => void;
}) {
  const supported = useBarcodeSupport();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const videoRef = useRef<HTMLVideoElement>(null);

  const close = useCallback(() => {
    setOpen(false);
    onOpenChange?.(false);
  }, [onOpenChange]);

  function start() {
    setError(null);
    setOpen(true);
    onOpenChange?.(true);
  }

  useEffect(() => {
    if (!open) return;
    const video = videoRef.current;
    const Detector = detectorConstructor();
    if (!video || !Detector || !navigator.mediaDevices?.getUserMedia) {
      setError('This browser cannot scan. Type the tag instead.');
      return;
    }

    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    let detecting = false;

    async function run() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
      } catch {
        if (!stopped) setError('The camera could not be started. Allow camera access and try again.');
        return;
      }
      if (stopped || !video) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      video.srcObject = stream;
      try {
        await video.play();
      } catch {
        // Autoplay refused: the frame still paints once the stream is live.
      }
      const detector = new Detector!({ formats: FORMATS });
      timer = window.setInterval(async () => {
        if (stopped || detecting || !video || video.readyState < 2) return;
        detecting = true;
        try {
          const codes = await detector.detect(video);
          const code = codes.find((entry) => entry.rawValue.trim() !== '');
          if (code && !stopped) {
            stopped = true;
            onDetect(code.rawValue.trim());
            close();
          }
        } catch {
          // A frame that could not be read; the next one may.
        } finally {
          detecting = false;
        }
      }, SCAN_INTERVAL_MS);
    }

    void run();

    return () => {
      stopped = true;
      window.clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
      if (video) video.srcObject = null;
    };
  }, [open, onDetect, close]);

  if (!supported) return null;

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
      <Dialog
        open={open}
        onClose={close}
        title="Scan a barcode"
        description="Point the camera at an asset tag, serial number or QR code."
        className="scan-dialog"
        footer={<Button onClick={close}>Cancel</Button>}
      >
        <div className="scan-frame">
          <video ref={videoRef} className="scan-video" autoPlay playsInline muted />
        </div>
        {error ? (
          <p className="scan-error" role="alert">
            {error}
          </p>
        ) : null}
      </Dialog>
    </>
  );
}
