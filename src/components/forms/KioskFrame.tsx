'use client';

/**
 * The frame around a kiosk: what it is for, a way into full screen, and a way
 * out that nobody takes by accident.
 *
 * A device at a door is touched by everybody who walks past it, so leaving is
 * a press held for a second and a quarter — long enough that a brush or a
 * curious tap does nothing, short enough that the officer who set it up does
 * not have to hunt for anything. The ring fills while it is held, so the
 * person holding it can see it working; letting go early empties it. The
 * keyboard holds it the same way with Space or Enter.
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { LogOut, Maximize, Minimize } from 'lucide-react';
import { Icon } from '@/components/ui/Icon';
import '@/styles/forms.css';

const HOLD_MS = 1250;

function subscribeFullscreen(onChange: () => void): () => void {
  document.addEventListener('fullscreenchange', onChange);
  return () => document.removeEventListener('fullscreenchange', onChange);
}

function subscribeNothing(): () => void {
  return () => undefined;
}

export function KioskFrame({
  title,
  subtitle,
  exitHref,
  children,
}: {
  title: string;
  subtitle?: ReactNode;
  exitHref: string;
  children: ReactNode;
}) {
  const full = useSyncExternalStore(
    subscribeFullscreen,
    () => document.fullscreenElement !== null,
    () => false,
  );
  // False on the server and on a browser without the API (an iPhone), so the
  // button is only ever offered where it can work.
  const canFull = useSyncExternalStore(
    subscribeNothing,
    () => document.fullscreenEnabled === true,
    () => false,
  );

  async function toggleFull() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      // A browser that refuses (an iPhone, an embedded view) keeps the page as
      // it is, which is still a kiosk.
    }
  }

  return (
    <div className="kiosk">
      <header className="kiosk-bar">
        <div className="kiosk-bar-text">
          <p className="kiosk-bar-title">{title}</p>
          {subtitle ? <p className="kiosk-bar-sub">{subtitle}</p> : null}
        </div>
        <div className="kiosk-bar-actions">
          {canFull ? (
            <button type="button" className="kiosk-quiet-btn" onClick={() => void toggleFull()}>
              <Icon icon={full ? Minimize : Maximize} size={16} />
              {full ? 'Leave full screen' : 'Full screen'}
            </button>
          ) : null}
          <HoldToExit href={exitHref} />
        </div>
      </header>
      <main className="kiosk-main">{children}</main>
    </div>
  );
}

function HoldToExit({ href }: { href: string }) {
  const router = useRouter();
  const [holding, setHolding] = useState(false);
  const timer = useRef<number | null>(null);

  const cancel = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = null;
    setHolding(false);
  }, []);

  const start = useCallback(() => {
    if (timer.current !== null) return;
    setHolding(true);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      setHolding(false);
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
      router.push(href);
    }, HOLD_MS);
  }, [href, router]);

  useEffect(() => cancel, [cancel]);

  return (
    <button
      type="button"
      className={holding ? 'kiosk-exit kiosk-exit-holding' : 'kiosk-exit'}
      style={{ ['--hold-ms' as string]: `${HOLD_MS}ms` }}
      aria-label="Hold to leave the kiosk"
      aria-describedby="kiosk-exit-hint"
      onPointerDown={(event) => {
        event.preventDefault();
        start();
      }}
      onPointerUp={cancel}
      onPointerLeave={cancel}
      onPointerCancel={cancel}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        if ((event.key === ' ' || event.key === 'Enter') && !event.repeat) {
          event.preventDefault();
          start();
        }
      }}
      onKeyUp={(event) => {
        if (event.key === ' ' || event.key === 'Enter') cancel();
      }}
      onBlur={cancel}
    >
      <span className="kiosk-exit-fill" aria-hidden="true" />
      <Icon icon={LogOut} size={16} />
      <span>Hold to exit</span>
      <span id="kiosk-exit-hint" className="visually-hidden">
        Press and hold for about a second.
      </span>
    </button>
  );
}
