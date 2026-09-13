'use client';

import { useId, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Button } from './Button';
import { useBodyScrollLock, useEscape, useFocusTrap } from './focus';
import { AnimatePresence, SpringSurface } from './Motion';

export interface OverlayProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** One line under the title, for context the body should not repeat. */
  description?: ReactNode;
  children: ReactNode;
  /** Actions pinned below the scrolling body. */
  footer?: ReactNode;
  /** Keep the title for assistive technology only. */
  hideTitle?: boolean;
  /** `sheet` slides in from an edge; `dialog` sits centred. */
  kind: 'sheet' | 'dialog';
  side?: 'right' | 'bottom';
  /** Extra class on the panel for one-off sizing. */
  className?: string;
}

function subscribeToNothing(): () => void {
  return () => {};
}

/**
 * The modal surface behind `Sheet` and `Dialog`.
 *
 * Renders into `document.body` so no ancestor's overflow or transform can
 * clip it. While open it traps focus, locks page scroll, closes on Escape or
 * a backdrop press, and on close hands focus back to the element that opened
 * it. Arrival and departure are `SpringSurface`'s one orchestrated moment:
 * the backdrop fades while the panel springs in from its edge (or a dialog
 * scales from 0.98), and `AnimatePresence` keeps the panel mounted just long
 * enough to leave the same way, faster. The focus trap and the scroll lock
 * hold until that exit completes, so the page behind does not scroll or take
 * focus while the surface is still visible. Under `prefers-reduced-motion`
 * both simply appear and disappear.
 *
 * While `open` is false the leaving surface shows the content of its last
 * open render, so a caller may clear the state that fed it in the same
 * update (`open={item !== null}` with children built from `item`) without
 * the panel emptying mid-exit.
 */
export function Overlay({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  hideTitle,
  kind,
  side = 'right',
  className,
}: OverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  // `present` outlives `open` by the length of the exit: it drops only once
  // `AnimatePresence` reports the surface gone.
  const [wasOpen, setWasOpen] = useState(open);
  const [exiting, setExiting] = useState(false);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) setExiting(true);
  }
  const present = open || exiting;

  useFocusTrap(panelRef, present);
  useBodyScrollLock(present);
  useEscape(open, onClose);

  // The portal exists only on the client, and only after hydration, so the
  // server and the hydrating render agree on rendering nothing here.
  const client = useSyncExternalStore(
    subscribeToNothing,
    () => true,
    () => false,
  );
  if (!client) return null;

  const panelClass = [
    'overlay-panel',
    kind === 'sheet' ? `sheet sheet-${side}` : 'dialog',
    className ?? '',
  ]
    .join(' ')
    .trim();

  return createPortal(
    <AnimatePresence onExitComplete={() => setExiting(false)}>
      {open ? (
        <SpringSurface
          key="surface"
          kind={kind}
          side={side}
          panelRef={panelRef}
          panelClassName={panelClass}
          onBackdropPress={onClose}
          panelProps={{
            role: 'dialog',
            'aria-modal': true,
            'aria-labelledby': titleId,
            'aria-describedby': description ? descriptionId : undefined,
            tabIndex: -1,
          }}
        >
          <header className={hideTitle ? 'overlay-head overlay-head-quiet' : 'overlay-head'}>
            <div className="overlay-head-text">
              <h2 id={titleId} className={hideTitle ? 'visually-hidden' : 'overlay-title'}>
                {title}
              </h2>
              {description ? (
                <p id={descriptionId} className="overlay-description">
                  {description}
                </p>
              ) : null}
            </div>
            <Button variant="ghost" icon={X} aria-label="Close" onClick={onClose} />
          </header>
          <div className="overlay-body">{children}</div>
          {footer ? <footer className="overlay-foot">{footer}</footer> : null}
        </SpringSurface>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
