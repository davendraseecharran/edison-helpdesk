'use client';

/**
 * The camera, as one component, wherever a code is read with it.
 *
 * The palette's one-shot scan, a workflow's run, the device check, the label
 * printer and the phone paired with a desktop all point a camera at a label,
 * and they used to be four copies of the same effect with four different
 * ideas of what a failure says. This is the one copy: it opens the camera,
 * reads with the browser's own `BarcodeDetector` or the WebAssembly decoder
 * (`loadDetector`, which is what puts a camera on an iPhone), and draws the
 * one frame everybody aims with.
 *
 * What the frame does, and why:
 *
 *   - Corner brackets mark where to hold the label. They arrive once, when
 *     the picture does, and snap in on every read — the eye is on the label,
 *     and the snap at the edge of vision says "got it, next".
 *   - A scan line sweeps the target while it is looking, so a still picture
 *     of a label does not read as a frozen camera.
 *   - A read flashes the frame and shows the code it read in a chip, and on a
 *     phone it buzzes (`haptic`), because the phone is at arm's length and
 *     nobody is reading its screen at that moment.
 *   - The torch, the other camera and the zoom are offered only when the
 *     track says it has them. Two fingers pinch the zoom too.
 *   - A camera that cannot start says which of six things went wrong and what
 *     to do about it, with "Try again" where trying again can help.
 *
 * Every track is stopped when the component goes, or the camera changes,
 * whatever caused it.
 */

import { useCallback, useEffect, useRef, useState, type ReactNode, type TouchEvent } from 'react';
import { Camera, Flashlight, FlashlightOff, RefreshCcw, SwitchCamera, X } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { useReducedMotion } from '@/components/ui/media';
import {
  CAMERA_PROBLEMS,
  clampZoom,
  pinchZoom,
  problemFromError,
  torchSupported,
  zoomLabel,
  zoomRange,
  type CameraProblem,
  type Facing,
  type ZoomRange,
} from '@/lib/scan/camera';
import { DETECTOR_FORMATS, DETECT_INTERVAL_MS, loadDetector, type BarcodeDetectorConstructor } from '@/lib/scan/detector';
import { DEDUPE_WINDOW_MS } from '@/lib/scan/relay';
import '@/styles/camera.css';

type Status = { kind: 'starting' } | { kind: 'running' } | { kind: 'problem'; problem: CameraProblem };

export interface CameraViewfinderProps {
  /** Given each code read. Return false to say it was refused, which skips the flash. */
  onCode: (code: string, format: string) => void | boolean;
  /** `once` stops after the first read (the palette); `continuous` keeps reading (a run). */
  mode?: 'once' | 'continuous';
  onClose?: () => void;
  /** Buzz on each read. Off where the page answers with its own feedback. */
  haptic?: boolean;
  /** Fill the container's height (a full-height sheet, the phone page). */
  fill?: boolean;
  /** One line under the frame. */
  note?: ReactNode;
  /** Target shape: wide for a barcode, square for an ID card's QR. */
  target?: 'barcode' | 'square';
  className?: string;
}

interface TrackControls {
  torch: boolean;
  zoom: ZoomRange | null;
}

function secureContext(): boolean {
  return typeof window === 'undefined' || window.isSecureContext !== false;
}

export function CameraViewfinder({
  onCode,
  mode = 'continuous',
  onClose,
  haptic = true,
  fill = false,
  note,
  target = 'barcode',
  className,
}: CameraViewfinderProps) {
  const reduced = useReducedMotion();
  const video = useRef<HTMLVideoElement | null>(null);
  const [mounted, setMounted] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'starting' });
  const [facing, setFacing] = useState<Facing>('environment');
  const [cameras, setCameras] = useState(0);
  const [controls, setControls] = useState<TrackControls>({ torch: false, zoom: null });
  const [torchOn, setTorchOn] = useState(false);
  const [zoom, setZoom] = useState<number | null>(null);
  const [hits, setHits] = useState(0);
  const [lastRead, setLastRead] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  const track = useRef<MediaStreamTrack | null>(null);
  const onCodeRef = useRef(onCode);
  const hapticRef = useRef(haptic);
  const pinch = useRef<{ distance: number; zoom: number } | null>(null);
  const zoomFrame = useRef(0);

  useEffect(() => {
    onCodeRef.current = onCode;
    hapticRef.current = haptic;
  }, [onCode, haptic]);

  const attach = useCallback((node: HTMLVideoElement | null) => {
    video.current = node;
    setMounted(node !== null);
  }, []);

  useEffect(() => {
    if (!mounted || !video.current) return;
    const element = video.current;
    let stream: MediaStream | null = null;
    let timer = 0;
    let stopped = false;
    let detecting = false;
    let last: { code: string; at: number } | null = null;

    function onEnded() {
      if (!stopped) setStatus({ kind: 'problem', problem: 'failed' });
    }

    async function run() {
      if (!navigator.mediaDevices?.getUserMedia) {
        setStatus({ kind: 'problem', problem: secureContext() ? 'unsupported' : 'insecure' });
        return;
      }
      // The decoder and the permission are asked for together: on a first
      // use the person is reading the prompt while the decoder downloads.
      const opening = navigator.mediaDevices.getUserMedia({
        audio: false,
        video: {
          facingMode: { ideal: facing },
          width: { ideal: 1280 },
          height: { ideal: 720 },
        },
      });
      let Detector: BarcodeDetectorConstructor;
      try {
        stream = await opening;
      } catch (error) {
        if (!stopped) setStatus({ kind: 'problem', problem: problemFromError(error, secureContext()) });
        return;
      }
      try {
        Detector = await loadDetector();
      } catch {
        stream.getTracks().forEach((one) => one.stop());
        if (!stopped) setStatus({ kind: 'problem', problem: 'decoder' });
        return;
      }
      if (stopped) {
        stream.getTracks().forEach((one) => one.stop());
        return;
      }

      const [videoTrack] = stream.getVideoTracks();
      track.current = videoTrack ?? null;
      videoTrack?.addEventListener('ended', onEnded);
      const capabilities = videoTrack?.getCapabilities?.() ?? {};
      const range = zoomRange(capabilities);
      setControls({ torch: torchSupported(capabilities), zoom: range });
      const settings = (videoTrack?.getSettings?.() ?? {}) as MediaTrackSettings & { zoom?: number };
      setZoom(range ? clampZoom(range, typeof settings.zoom === 'number' ? settings.zoom : range.min) : null);
      setTorchOn(false);

      element.srcObject = stream;
      try {
        await element.play();
      } catch {
        // Autoplay refused: the frame still paints once the stream is live.
      }
      if (stopped) return;
      setStatus({ kind: 'running' });

      // Labels are available only after permission; counted for the switch.
      navigator.mediaDevices
        .enumerateDevices?.()
        .then((devices) => {
          if (!stopped) setCameras(devices.filter((device) => device.kind === 'videoinput').length);
        })
        .catch(() => {});

      const detector = new Detector({ formats: DETECTOR_FORMATS });
      timer = window.setInterval(async () => {
        if (stopped || detecting || element.readyState < 2) return;
        detecting = true;
        try {
          const codes = await detector.detect(element);
          const found = codes.find((entry) => entry.rawValue.trim() !== '');
          if (!found || stopped) return;
          const code = found.rawValue.trim();
          const now = Date.now();
          // The same label still under the lens is one read, however long it
          // is held there: the window restarts every time it is seen again.
          if (last && last.code === code && now - last.at < DEDUPE_WINDOW_MS) {
            last.at = now;
            return;
          }
          last = { code, at: now };
          const accepted = onCodeRef.current(code, found.format);
          if (accepted === false) return;
          if (hapticRef.current) navigator.vibrate?.(30);
          setHits((count) => count + 1);
          setLastRead(code);
          if (mode === 'once') {
            stopped = true;
            window.clearInterval(timer);
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
      track.current?.removeEventListener('ended', onEnded);
      track.current = null;
      stream?.getTracks().forEach((one) => one.stop());
      element.srcObject = null;
    };
  }, [mounted, facing, attempt, mode]);

  function retry() {
    setStatus({ kind: 'starting' });
    setAttempt((count) => count + 1);
  }

  function flip() {
    setStatus({ kind: 'starting' });
    setFacing((current) => (current === 'environment' ? 'user' : 'environment'));
  }

  async function toggleTorch() {
    const current = track.current;
    if (!current) return;
    const next = !torchOn;
    try {
      await current.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
      setTorchOn(next);
    } catch {
      setControls((was) => ({ ...was, torch: false }));
    }
  }

  const applyZoom = useCallback(
    (value: number) => {
      const range = controls.zoom;
      const current = track.current;
      if (!range || !current) return;
      const next = clampZoom(range, value);
      setZoom(next);
      window.cancelAnimationFrame(zoomFrame.current);
      zoomFrame.current = window.requestAnimationFrame(() => {
        void current.applyConstraints({ advanced: [{ zoom: next } as MediaTrackConstraintSet] }).catch(() => {});
      });
    },
    [controls.zoom],
  );

  function distance(event: TouchEvent): number {
    const [a, b] = [event.touches[0], event.touches[1]];
    return Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
  }

  function onTouchStart(event: TouchEvent) {
    if (event.touches.length === 2 && controls.zoom && zoom !== null) {
      pinch.current = { distance: distance(event), zoom };
    }
  }

  function onTouchMove(event: TouchEvent) {
    if (event.touches.length !== 2 || !pinch.current || !controls.zoom) return;
    applyZoom(pinchZoom(controls.zoom, pinch.current.zoom, distance(event) / pinch.current.distance));
  }

  function onTouchEnd(event: TouchEvent) {
    if (event.touches.length < 2) pinch.current = null;
  }

  const problem = status.kind === 'problem' ? CAMERA_PROBLEMS[status.problem] : null;
  const running = status.kind === 'running';

  return (
    <div
      className={['cam', fill ? 'cam-fill' : '', className ?? ''].filter(Boolean).join(' ')}
      data-status={status.kind}
      data-target={target}
    >
      <div
        className="cam-frame"
        // A bottom sheet drags from anywhere; not from the picture, where two
        // fingers mean zoom.
        data-vaul-no-drag=""
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
      >
        <video
          ref={attach}
          className="cam-video"
          data-mirror={facing === 'user' || undefined}
          autoPlay
          playsInline
          muted
          aria-hidden="true"
        />

        {running ? (
          <div className="cam-reticle" aria-hidden="true">
            {/* Keyed by the read count: each read replays the snap. */}
            <span key={hits} className="cam-brackets" data-snap={hits > 0 || undefined}>
              <span className="cam-corner" data-corner="tl" />
              <span className="cam-corner" data-corner="tr" />
              <span className="cam-corner" data-corner="bl" />
              <span className="cam-corner" data-corner="br" />
            </span>
            {reduced ? null : <span className="cam-sweep" />}
          </div>
        ) : null}

        {hits > 0 ? <span key={`flash-${hits}`} className="cam-flash" aria-hidden="true" /> : null}
        {lastRead && running ? (
          <span key={`read-${hits}`} className="cam-read mono" aria-hidden="true">
            {lastRead}
          </span>
        ) : null}

        {status.kind === 'starting' ? (
          <p className="cam-wait">
            <Icon icon={Camera} size={18} />
            Starting the camera
          </p>
        ) : null}

        {problem ? (
          <div className="cam-problem" role="alert">
            <p className="cam-problem-title">{problem.title}</p>
            <p className="cam-problem-body">{problem.body}</p>
            {problem.retry ? (
              <Button size="sm" variant="secondary" icon={RefreshCcw} onClick={retry}>
                Try again
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="cam-controls">
          {running && controls.torch ? (
            <button
              type="button"
              className="cam-control pressable"
              aria-pressed={torchOn}
              aria-label={torchOn ? 'Turn the torch off' : 'Turn the torch on'}
              onClick={() => void toggleTorch()}
            >
              <Icon icon={torchOn ? Flashlight : FlashlightOff} size={18} />
            </button>
          ) : null}
          {cameras > 1 && status.kind !== 'starting' ? (
            <button
              type="button"
              className="cam-control pressable"
              aria-label={facing === 'environment' ? 'Use the front camera' : 'Use the back camera'}
              onClick={flip}
            >
              <Icon icon={SwitchCamera} size={18} />
            </button>
          ) : null}
        </div>

        {onClose ? (
          <button type="button" className="cam-control cam-close pressable" aria-label="Close the camera" onClick={onClose}>
            <Icon icon={X} size={18} />
          </button>
        ) : null}

        {running && controls.zoom && zoom !== null ? (
          <label className="cam-zoom">
            <span className="visually-hidden">Zoom</span>
            <input
              type="range"
              min={controls.zoom.min}
              max={controls.zoom.max}
              step={controls.zoom.step}
              value={zoom}
              onChange={(event) => applyZoom(Number(event.target.value))}
            />
            <span className="cam-zoom-value mono" aria-hidden="true">
              {zoomLabel(zoom)}
            </span>
          </label>
        ) : null}
      </div>
      {note && !problem ? <p className="cam-note">{note}</p> : null}
      <p className="visually-hidden" role="status">
        {running ? (lastRead ? `Read ${lastRead}.` : 'Camera on. Point it at a barcode.') : ''}
      </p>
    </div>
  );
}
