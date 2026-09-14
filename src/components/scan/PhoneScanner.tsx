'use client';

/**
 * The phone's half of the pairing: a camera, and a way to type.
 *
 * This is the one screen in the application designed for a phone held in one
 * hand while the other holds a laptop. The camera fills it, the controls sit
 * at the bottom where a thumb reaches, and every code that is read is sent
 * straight to the desktop field that asked for it.
 *
 * Two browsers, one page. Chrome on Android has `BarcodeDetector` and reads
 * the codes itself; Safari on iOS does not, and shipping a decoder to make up
 * for it would be a large library for a page that already has a better
 * answer — the same field a technician would want anyway when a label is
 * scratched. So "Type the code instead" is always on screen, not a fallback
 * that appears after a failure. It is the only control on this page that
 * works with no camera permission at all.
 *
 * What is NOT here is as deliberate: no lookup, no ticket, no record of any
 * kind. A phone that has been handed to somebody, or left on a bench, shows
 * a camera and the codes this session has sent. The session id in the URL is
 * not a credential — the phone is signed in as the same person or this page
 * does not render at all — and it stops accepting scans half an hour after
 * the desktop opened it, whatever anybody does with the tab.
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from 'react';
import { ScanLine } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import {
  endScanSessionAction,
  recordScanAction,
  scanSessionAction,
} from '@/lib/data/scan-actions';
import { SCAN_FORMATS, scanFormat, shouldSend, type LastScan } from '@/lib/scan/relay';
import '@/styles/scan.css';

/** Milliseconds between detection passes over the live frame. */
const SCAN_INTERVAL_MS = 250;
/** How often the phone asks whether the pairing is still live. */
const STATUS_POLL_MS = 10000;
/** How many codes the phone keeps on screen. */
const RECENT_SHOWN = 5;

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

/** What the pairing is doing, as this page understands it. */
type SessionState = 'active' | 'stopped' | 'expired' | 'gone';

/** What the camera is doing. */
type CameraState = 'off' | 'starting' | 'running' | 'unsupported' | 'refused' | 'failed';

const CAMERA_MESSAGE: Partial<Record<CameraState, string>> = {
  unsupported: 'This browser cannot read barcodes from the camera. Type the code instead.',
  refused: 'The camera is not available. Allow camera access in your browser, or type the code.',
  failed: 'The camera stopped. Try again, or type the code instead.',
};

const SESSION_MESSAGE: Record<Exclude<SessionState, 'active'>, string> = {
  stopped: 'This pairing has been stopped. Start a new one from the desktop.',
  expired: 'This pairing has run out. Start a new one from the desktop.',
  gone: 'This pairing is no longer available. Start a new one from the desktop.',
};

export interface PhoneScannerProps {
  session: string;
  /** What the desktop is asking for, as the desktop named it. */
  label: string | null;
  /** Whether the pairing was live when the page was rendered. */
  active: boolean;
  /** Set when the desktop had already stopped it. */
  stopped: boolean;
}

interface SentCode {
  key: string;
  code: string;
}

export function PhoneScanner({ session, label, active, stopped }: PhoneScannerProps) {
  const supported = useBarcodeSupport();
  const [state, setState] = useState<SessionState>(
    active ? 'active' : stopped ? 'stopped' : 'expired',
  );
  const [camera, setCamera] = useState<CameraState>(() => (active ? 'starting' : 'off'));
  const [sent, setSent] = useState<SentCode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [sending, setSending] = useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  /** The last code this phone sent, for the debounce. */
  const last = useRef<LastScan | null>(null);
  /** Bumped by "Try again" to restart the camera effect without `live` changing. */
  const [attempt, setAttempt] = useState(0);

  const live = state === 'active';

  /**
   * Sends one code, from the camera or from the field.
   *
   * The database is the authority on whether it may be sent at all, so its
   * refusal is what moves this page out of the scanning state: a stopped,
   * expired or full session each say so in their own words and each end the
   * same way, with a fresh pairing from the desktop.
   */
  const send = useCallback(
    async (code: string, format: string | null): Promise<boolean> => {
      const trimmed = code.trim();
      if (trimmed === '') return false;
      const result = await recordScanAction(session, trimmed, format);
      if (!result.ok) {
        setError(result.error ?? 'That code could not be sent. Try again.');
        // Whatever the reason, this pairing is not taking scans any more.
        void scanSessionAction(session).then((view) => {
          if (!view) setState('gone');
          else if (view.endedAt) setState('stopped');
          else if (!view.active) setState('expired');
        });
        return false;
      }
      setError(null);
      setSent((current) => [
        { key: `${Date.now()}:${current.length}`, code: trimmed },
        ...current,
      ].slice(0, RECENT_SHOWN));
      return true;
    },
    [session],
  );

  // A pairing that has ended has no camera, and that is settled in the render
  // that ended it rather than in an effect afterwards.
  const [cameraFor, setCameraFor] = useState(live);
  if (cameraFor !== live) {
    setCameraFor(live);
    setCamera(live ? 'starting' : 'off');
  }

  // The camera. Runs only while the pairing is live, and every track is
  // stopped when it is not, whatever stopped it: a phone that keeps its
  // camera light on after a session has ended is a phone people put away.
  // `attempt` has no meaning of its own — it exists so "Try again" can
  // restart this effect without `live` having changed.
  useEffect(() => {
    if (!live) return;
    const video = videoRef.current;
    const Detector = detectorConstructor();

    let stream: MediaStream | null = null;
    let timer = 0;
    let done = false;
    let detecting = false;
    let onVideoError: (() => void) | null = null;
    let tracks: MediaStreamTrack[] = [];

    // A track can end on its own — the camera unplugged, the OS revoking
    // permission mid-session, another app claiming the camera — with no
    // rejected promise anywhere to catch. Only these two events say so.
    function onTrackEnded() {
      if (!done) setCamera('failed');
    }

    async function run() {
      if (!video || !Detector || !navigator.mediaDevices?.getUserMedia) {
        setCamera('unsupported');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: 'environment' },
        });
      } catch {
        if (!done) setCamera('refused');
        return;
      }
      if (done || !video) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      video.srcObject = stream;
      onVideoError = () => {
        if (!done) setCamera('failed');
      };
      video.addEventListener('error', onVideoError);
      tracks = stream.getTracks();
      tracks.forEach((track) => track.addEventListener('ended', onTrackEnded));
      try {
        await video.play();
      } catch {
        // Autoplay refused: the frame still paints once the stream is live.
      }
      if (done) return;
      setCamera('running');

      const detector = new Detector!({ formats: [...SCAN_FORMATS] });
      timer = window.setInterval(async () => {
        if (done || detecting || !video || video.readyState < 2) return;
        detecting = true;
        try {
          const codes = await detector.detect(video);
          const found = codes.find((entry) => entry.rawValue.trim() !== '');
          if (found && !done) {
            const code = found.rawValue.trim();
            const now = Date.now();
            if (shouldSend(code, last.current, now)) {
              last.current = { code, at: now };
              // Felt before it is seen: the phone is at arm's length, pointed
              // at a label, and nobody is reading the screen at that moment.
              navigator.vibrate?.(30);
              const ok = await send(code, scanFormat(found.format));
              // A refused code is not remembered, so pointing at the same
              // label again after a fresh pairing works straight away.
              if (!ok) last.current = null;
            }
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
      done = true;
      window.clearInterval(timer);
      if (video && onVideoError) video.removeEventListener('error', onVideoError);
      tracks.forEach((track) => track.removeEventListener('ended', onTrackEnded));
      stream?.getTracks().forEach((track) => track.stop());
      if (video) video.srcObject = null;
    };
  }, [live, send, attempt]);

  // Is the pairing still live? Asked rather than assumed, because the desktop
  // may have pressed Stop, the half hour may have passed, or the tab may have
  // been asleep in a pocket since first period.
  useEffect(() => {
    if (!live) return;
    let stoppedPolling = false;
    const timer = window.setInterval(async () => {
      const view = await scanSessionAction(session);
      if (stoppedPolling) return;
      if (!view) setState('gone');
      else if (view.endedAt) setState('stopped');
      else if (!view.active) setState('expired');
    }, STATUS_POLL_MS);
    return () => {
      stoppedPolling = true;
      window.clearInterval(timer);
    };
  }, [live, session]);

  async function onType(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (sending || typed.trim() === '') return;
    setSending(true);
    // No format: the column's own meaning for a code that was not read by a
    // camera, which is exactly what this is.
    const ok = await send(typed, null);
    setSending(false);
    if (ok) setTyped('');
  }

  async function stop() {
    setSending(true);
    await endScanSessionAction(session);
    setSending(false);
    setState('stopped');
    setError(null);
  }

  /** Restarts the camera effect after a track ended or the video errored. */
  function retry() {
    setCamera('starting');
    setAttempt((count) => count + 1);
  }

  const cameraMessage = live ? CAMERA_MESSAGE[camera] : undefined;
  // Somewhere to point the camera: a live pairing, a browser that can read a
  // code, and a camera that has not already failed.
  const viewfinder = live && supported && camera !== 'refused' && camera !== 'failed';

  return (
    <div className="scan-phone" data-live={live || undefined}>
      <header className="scan-phone-head">
        <h1 className="scan-phone-title">Scan with your phone</h1>
        {/* The label is quoted rather than folded into a sentence: it is the
            desktop's own words for a field ("Asset tag", "Serial number"),
            and no phrasing reads correctly for every one of them. */}
        <p className="scan-phone-sub">
          {label ? `Codes go to “${label}” on your desktop.` : 'Codes go to your desktop.'}
        </p>
      </header>

      {/* The viewfinder exists only when there is something to see through
          it. A browser with no detector — Safari on iOS — would otherwise get
          a tall empty rectangle above the one control it can actually use,
          and a stopped pairing would get a picture of a ceiling. Everything
          those cases need to know is in the status line below. */}
      {viewfinder ? (
        <div className="scan-phone-view">
          <video
            ref={videoRef}
            className="scan-phone-video"
            autoPlay
            playsInline
            muted
            aria-hidden="true"
          />
          {camera === 'running' ? (
            <div className="scan-phone-reticle" aria-hidden="true">
              <Icon icon={ScanLine} size={28} />
            </div>
          ) : (
            <p className="scan-phone-placeholder">Starting the camera…</p>
          )}
        </div>
      ) : null}

      <div className="scan-phone-panel">
        <p className="scan-phone-status" role="status">
          {live
            ? camera === 'running'
              ? 'Point the camera at a barcode.'
              : (cameraMessage ?? 'Starting the camera…')
            : SESSION_MESSAGE[state as Exclude<SessionState, 'active'>]}
        </p>

        {live && camera === 'failed' ? (
          <Button variant="secondary" size="sm" onClick={retry}>
            Try again
          </Button>
        ) : null}

        {error ? (
          <p className="flash flash-error" role="alert">
            {error}
          </p>
        ) : null}

        <form className="scan-phone-type" onSubmit={onType}>
          <label className="scan-phone-label" htmlFor="scan-manual">
            Type the code instead
          </label>
          <div className="scan-phone-type-row">
            <input
              id="scan-manual"
              className="scan-phone-input mono"
              type="text"
              inputMode="text"
              autoComplete="off"
              autoCapitalize="characters"
              spellCheck={false}
              enterKeyHint="send"
              placeholder="DOE-LN0000001"
              value={typed}
              disabled={!live}
              onChange={(event) => setTyped(event.target.value)}
            />
            <Button
              type="submit"
              variant="primary"
              loading={sending}
              disabled={!live || typed.trim() === ''}
            >
              Send
            </Button>
          </div>
        </form>

        <div className="scan-phone-sent">
          <h2 className="scan-phone-sent-title">Sent</h2>
          {sent.length === 0 ? (
            <p className="scan-phone-empty">Nothing yet.</p>
          ) : (
            <ul className="scan-phone-list">
              {sent.map((entry) => (
                <li key={entry.key} className="scan-phone-code mono">
                  {entry.code}
                </li>
              ))}
            </ul>
          )}
        </div>

        <Button block onClick={() => void stop()} disabled={!live || sending}>
          Stop scanning
        </Button>
      </div>
    </div>
  );
}
