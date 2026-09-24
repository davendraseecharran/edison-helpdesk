'use client';

/**
 * The camera, kept open for a whole run.
 *
 * The palette's scan reads one code and closes; a cart is thirty, so this one
 * stays open in the page, above the list, and hands every new code to the run.
 * The same label held under the lens is sent once (the relay's own 1.5 second
 * rule, `shouldSend`); pointing at the next laptop sends the next. The frame
 * gives a brief ring when it reads something, so the person holding the phone
 * knows to move on before the list has answered.
 *
 * Every track is stopped when it closes, whatever closed it.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import {
  DETECTOR_FORMATS,
  DETECT_INTERVAL_MS,
  loadDetector,
  type BarcodeDetectorConstructor,
} from '@/lib/scan/detector';
import { shouldSend, type LastScan } from '@/lib/scan/relay';

export interface WorkflowCameraProps {
  onCode: (code: string) => void;
  onClose: () => void;
}

export function WorkflowCamera({ onCode, onClose }: WorkflowCameraProps) {
  const video = useRef<HTMLVideoElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reading, setReading] = useState(false);
  const [read, setRead] = useState(0);
  const onCodeRef = useRef(onCode);
  const last = useRef<LastScan | null>(null);

  useEffect(() => {
    onCodeRef.current = onCode;
  }, [onCode]);

  const attach = useCallback((node: HTMLVideoElement | null) => {
    video.current = node;
    setMounted(node !== null);
  }, []);

  useEffect(() => {
    if (!mounted || !video.current) return;
    const target = video.current;
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    let detecting = false;

    async function run() {
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
          setError('The camera could not be started. Allow camera access, or type the code instead.');
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
      setReading(true);
      const detector = new Detector({ formats: DETECTOR_FORMATS });
      timer = window.setInterval(async () => {
        if (stopped || detecting || target.readyState < 2) return;
        detecting = true;
        try {
          const codes = await detector.detect(target);
          const found = codes.find((entry) => entry.rawValue.trim() !== '');
          if (found && !stopped) {
            const code = found.rawValue.trim();
            const now = Date.now();
            if (shouldSend(code, last.current, now)) {
              last.current = { code, at: now };
              setRead((count) => count + 1);
              onCodeRef.current(code);
            }
          }
        } catch {
          // A frame that could not be read; the next one may.
        } finally {
          detecting = false;
        }
      }, DETECT_INTERVAL_MS);
    }

    void run();
    return () => {
      stopped = true;
      window.clearInterval(timer);
      stream?.getTracks().forEach((track) => track.stop());
      target.srcObject = null;
    };
  }, [mounted]);

  return (
    <div className="wf-camera">
      <div className="wf-camera-frame" data-reading={reading || undefined}>
        <video ref={attach} className="wf-camera-video" autoPlay playsInline muted aria-hidden="true" />
        {/* Keyed by the count, so each read restarts the ring's one pass. */}
        {read > 0 ? <span key={read} className="wf-camera-hit" aria-hidden="true" /> : null}
        {!reading && !error ? <p className="wf-camera-wait">Starting the camera…</p> : null}
        <Button
          variant="secondary"
          size="sm"
          icon={X}
          className="wf-camera-close"
          aria-label="Close the camera"
          onClick={onClose}
        />
      </div>
      {error ? (
        <p className="flash flash-error" role="alert">
          {error}
        </p>
      ) : (
        <p className="wf-camera-note">Hold each label in the frame until it ticks.</p>
      )}
    </div>
  );
}
