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

/** Where `copy-zxing-wasm.cjs` puts the decoder, served by this deployment. */
const WASM_PATH = '/zxing_reader.wasm';

/**
 * The reader: the browser's own where it has one (Chrome on Android and
 * ChromeOS), otherwise a WebAssembly decoder fetched the first time the
 * camera opens — which is what puts the button on an iPhone. The two answer
 * the same interface, so nothing past this line knows which it got.
 */
async function loadDetector(): Promise<BarcodeDetectorConstructor> {
  const native = (window as unknown as { BarcodeDetector?: BarcodeDetectorConstructor })
    .BarcodeDetector;
  if (native) return native;
  const { BarcodeDetector, setZXingModuleOverrides } = await import('barcode-detector/ponyfill');
  setZXingModuleOverrides({
    locateFile: (file: string, prefix: string) => (file.endsWith('.wasm') ? WASM_PATH : prefix + file),
  });
  return BarcodeDetector as unknown as BarcodeDetectorConstructor;
}

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

/** Milliseconds between detection passes over the live frame. */
const SCAN_INTERVAL_MS = 250;

/**
 * The camera scan inside the palette input.
 *
 * Rendered wherever the browser can open a camera. The reading is done by the
 * browser's own `BarcodeDetector` where it has one (Chrome on Android and
 * ChromeOS) and by a WebAssembly decoder everywhere else, iPhones included,
 * loaded the first time the camera opens and never before. A browser with no
 * camera shows no button rather than a button that fails.
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
  const supported = useCameraSupport();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The dialog mounts its content a frame after `open` flips, so an effect
  // keyed on `open` alone ran before the <video> existed and gave up. The
  // callback ref notes the element and flips a flag the effect is keyed on,
  // so it runs once there is something to play into.
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoMounted, setVideoMounted] = useState(false);
  const attachVideo = useCallback((node: HTMLVideoElement | null) => {
    videoRef.current = node;
    setVideoMounted(node !== null);
  }, []);

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
    if (!open || !videoMounted) return;
    const mounted = videoRef.current;
    if (mounted === null) return;
    // Typed non-null once, for the closures below, which cannot see the guard.
    const target: HTMLVideoElement = mounted;

    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    let detecting = false;

    async function run() {
      // The decoder and the camera permission are asked for together; on a
      // first use the person is reading the permission prompt while the
      // decoder downloads.
      let Detector: BarcodeDetectorConstructor;
      try {
        const [loaded, opened] = await Promise.all([
          loadDetector(),
          navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }),
        ]);
        Detector = loaded;
        stream = opened;
      } catch {
        if (!stopped) {
          setError(
            'The camera could not be started. Allow camera access, check the connection, and try again.',
          );
        }
        return;
      }
      if (stopped) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      target.srcObject = stream;
      try {
        await target.play();
      } catch {
        // Autoplay refused: the frame still paints once the stream is live.
      }
      const detector = new Detector({ formats: FORMATS });
      timer = window.setInterval(async () => {
        if (stopped || detecting || target.readyState < 2) return;
        detecting = true;
        try {
          const codes = await detector.detect(target);
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
      target.srcObject = null;
    };
  }, [open, videoMounted, onDetect, close]);

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
          <video ref={attachVideo} className="scan-video" autoPlay playsInline muted />
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
