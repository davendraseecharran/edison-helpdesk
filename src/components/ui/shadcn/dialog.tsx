'use client';

/*
 * shadcn/ui's Dialog, on Radix, wearing this product's class names.
 *
 * A modal surface is the one place where a hand-rolled implementation is
 * almost right and quietly wrong, and ours was: it trapped focus with a Tab
 * handler, which does not stop a screen reader's own cursor from reading the
 * page behind; it locked scrolling with `overflow: hidden`, which loses the
 * scroll position on iOS; and it left the rest of the document reachable to
 * assistive technology. Radix does all three properly — the page behind is
 * `aria-hidden` and inert while the surface is open, the scroll lock keeps the
 * position, focus returns to whatever opened it, and Escape and a press
 * outside are the library's rather than two of our own listeners.
 *
 * What stays ours: the markup inside, every class, and the motion — the
 * backdrop fades while the panel scales up or slides in from its edge, on the
 * same durations and curves as before, now in CSS against `data-state` so
 * Radix can hold the unmount until the exit has finished.
 */

import * as React from 'react';
import { Dialog as DialogPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

function Dialog({ ...props }: React.ComponentProps<typeof DialogPrimitive.Root>) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />;
}

function DialogTrigger({ ...props }: React.ComponentProps<typeof DialogPrimitive.Trigger>) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />;
}

function DialogPortal({ ...props }: React.ComponentProps<typeof DialogPrimitive.Portal>) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />;
}

function DialogClose({ ...props }: React.ComponentProps<typeof DialogPrimitive.Close>) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />;
}

function DialogOverlay({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Overlay>) {
  return (
    <DialogPrimitive.Overlay
      data-slot="dialog-overlay"
      className={cn('overlay-backdrop', className)}
      {...props}
    />
  );
}

function DialogContent({
  className,
  children,
  kind = 'dialog',
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Content> & {
  /** `dialog` sits centred; `sheet` arrives from an edge. */
  kind?: 'dialog' | 'sheet';
}) {
  return (
    <DialogPortal>
      {/* The layer both halves live in. It is always mounted and takes no
          pointer events of its own, so it cannot swallow a press once the
          surface inside it has gone. */}
      <div className="overlay" data-kind={kind}>
        <DialogOverlay />
        <DialogPrimitive.Content
          data-slot="dialog-content"
          className={cn('overlay-panel', className)}
          {...props}
        >
          {children}
        </DialogPrimitive.Content>
      </div>
    </DialogPortal>
  );
}

function DialogTitle({ className, ...props }: React.ComponentProps<typeof DialogPrimitive.Title>) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn('overlay-title', className)}
      {...props}
    />
  );
}

function DialogDescription({
  className,
  ...props
}: React.ComponentProps<typeof DialogPrimitive.Description>) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn('overlay-description', className)}
      {...props}
    />
  );
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
};
