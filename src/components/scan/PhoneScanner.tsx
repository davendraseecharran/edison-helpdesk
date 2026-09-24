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
 * the codes itself; Safari on iOS does not, and gets the WebAssembly decoder
 * the rest of the application uses (`CameraViewfinder`, `loadDetector`),
 * fetched the first time the camera opens. "Type the code instead" is still
 * always on screen, not a fallback that appears after a failure: a scratched
 * label needs it, and it is the only control on this page that works with no
 * camera permission at all.
 *
 * What is NOT here is as deliberate: no lookup, no ticket, no record of any
 * kind. A phone that has been handed to somebody, or left on a bench, shows
 * a camera and the codes this session has sent. The session id in the URL is
 * not a credential — the phone is signed in as the same person or this page
 * does not render at all — and it stops accepting scans half an hour after
 * the desktop opened it, whatever anybody does with the tab.
 */

import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Button } from '@/components/ui/Button';
import {
  endScanSessionAction,
  recordScanAction,
  scanSessionAction,
} from '@/lib/data/scan-actions';
import { scanFormat } from '@/lib/scan/relay';
import { CameraViewfinder } from './CameraViewfinder';
import '@/styles/scan.css';

/** How often the phone asks whether the pairing is still live. */
const STATUS_POLL_MS = 10000;
/** How many codes the phone keeps on screen. */
const RECENT_SHOWN = 5;

/** What the pairing is doing, as this page understands it. */
type SessionState = 'active' | 'stopped' | 'expired' | 'gone';

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
  const [state, setState] = useState<SessionState>(
    active ? 'active' : stopped ? 'stopped' : 'expired',
  );
  const [sent, setSent] = useState<SentCode[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [sending, setSending] = useState(false);

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

      {/* The viewfinder exists only while the pairing is live: a stopped
          pairing would get a picture of a ceiling. The frame says for itself
          when the camera cannot start, and why. */}
      {live ? (
        <CameraViewfinder
          className="scan-phone-view"
          fill
          haptic
          onCode={(code, format) => {
            // Felt before it is seen (the frame buzzes): the phone is at arm's
            // length, pointed at a label, and nobody is reading its screen.
            void send(code, scanFormat(format));
          }}
          note="Hold each label in the frame until it ticks. It goes straight to your desktop."
        />
      ) : null}

      <div className="scan-phone-panel">
        {live ? null : (
          <p className="scan-phone-status" role="status">
            {SESSION_MESSAGE[state as Exclude<SessionState, 'active'>]}
          </p>
        )}

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
