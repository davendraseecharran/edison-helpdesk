'use client';

import { useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { Button } from './Button';
import { useBodyScrollLock, useEscape, useFocusTrap } from './focus';

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

/**
 * The modal surface behind `Sheet` and `Dialog`.
 *
 * Renders into `document.body` so no ancestor's overflow or transform can
 * clip it. While open it traps focus, locks page scroll, closes on Escape or
 * a backdrop press, and on close hands focus back to the element that opened
 * it. The 120ms entrance is the only motion; `base.css` removes it under
 * `prefers-reduced-motion`.
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

  useFocusTrap(panelRef, open);
  useBodyScrollLock(open);
  useEscape(open, onClose);

  if (!open || typeof document === 'undefined') return null;

  const panelClass = [
    'overlay-panel',
    kind === 'sheet' ? `sheet sheet-${side}` : 'dialog',
    className ?? '',
  ]
    .join(' ')
    .trim();

  return createPortal(
    <div className="overlay" data-kind={kind}>
      <div className="overlay-backdrop" onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className={panelClass}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
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
      </div>
    </div>,
    document.body,
  );
}
