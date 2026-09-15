'use client';

import type { ReactNode } from 'react';
import { X } from 'lucide-react';

import { Button } from './Button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from './shadcn/dialog';

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
 * The first focusable element is the right one to focus, unless the surface
 * says otherwise.
 *
 * `data-autofocus` is how a caller names the control somebody came here to
 * use: "Stop scanning" on the pairing dialog, the one field on a short form.
 * Without it Radix's own rule applies, which is the first focusable thing —
 * and that is usually the close button, which is the one control nobody opened
 * the surface to press.
 */
function focusPreferred(event: Event): void {
  const root = event.currentTarget as HTMLElement | null;
  const preferred = root?.querySelector<HTMLElement>('[data-autofocus]');
  if (!preferred) return;
  event.preventDefault();
  preferred.focus({ preventScroll: true });
}

/**
 * The modal surface behind `Sheet` and `Dialog`.
 *
 * Radix underneath, through shadcn. While it is open the rest of the document
 * is inert and hidden from assistive technology, the page behind keeps its
 * scroll position rather than jumping to the top, focus is trapped and handed
 * back to whatever opened it, and Escape and a press outside close it. None of
 * that is new behaviour — all of it is behaviour that used to be four hooks of
 * ours, each correct in the cases we had thought of.
 *
 * The moment is unchanged: the backdrop fades while the panel scales up from
 * 0.98, or slides in from its edge, and leaves the same way faster. It is CSS
 * on `data-state` now, so Radix holds the unmount until the exit has played;
 * the leaving surface therefore still shows the content of its last open
 * render, and a caller may clear the state that fed it in the same update.
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
  const panelClass = [kind === 'sheet' ? `sheet sheet-${side}` : 'dialog', className ?? '']
    .join(' ')
    .trim();

  /*
   * Radix names the panel by its title and warns when nothing describes it.
   * Its documented way to say "there is nothing more to add" is an explicit
   * `aria-describedby={undefined}`, which removes the attribute it would
   * otherwise point at its own description node. A hidden empty description is
   * not that: it leaves the pointer in place aimed at a node with no text, and
   * a reader that follows it hears the title and then silence.
   *
   * Spread rather than written as a prop, because to JSX `aria-describedby=
   * {undefined}` and leaving the prop out are the same thing, and the surface
   * that does have a description needs Radix's own value.
   */
  const undescribed = description ? {} : { 'aria-describedby': undefined };

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent
        kind={kind}
        className={panelClass}
        onOpenAutoFocus={focusPreferred}
        {...undescribed}
      >
        <header className={hideTitle ? 'overlay-head overlay-head-quiet' : 'overlay-head'}>
          <div className="overlay-head-text">
            <DialogTitle className={hideTitle ? 'visually-hidden' : undefined}>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </div>
          <DialogClose asChild>
            <Button variant="ghost" icon={X} aria-label="Close" />
          </DialogClose>
        </header>
        <div className="overlay-body">{children}</div>
        {footer ? <footer className="overlay-foot">{footer}</footer> : null}
      </DialogContent>
    </Dialog>
  );
}
