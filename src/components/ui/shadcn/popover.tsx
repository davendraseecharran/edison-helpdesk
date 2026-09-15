'use client';

/*
 * shadcn/ui's Popover, on Radix, wearing this product's class names.
 *
 * The two in this product — the account panel and the notifications list —
 * were each a `role="dialog"` with a focus trap, an Escape listener and an
 * outside-press listener wired by hand, and each had to remember to carry
 * `aria-modal` so the shell's shortcut guard would leave the keyboard alone.
 * Radix is the same contract written once: it traps focus, returns it to the
 * trigger, dismisses on Escape and on a press outside, flips or shifts rather
 * than leaving the window, and reports the corner it grew from. The guard is
 * told by `data-keyboard-owner`, which is the attribute it already looks for
 * and is truer than `aria-modal` on a surface that is not a dialog.
 */

import * as React from 'react';
import { Popover as PopoverPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

function Popover({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Root>) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />;
}

function PopoverTrigger({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Trigger>) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />;
}

function PopoverAnchor({ ...props }: React.ComponentProps<typeof PopoverPrimitive.Anchor>) {
  return <PopoverPrimitive.Anchor data-slot="popover-anchor" {...props} />;
}

function PopoverContent({
  className,
  align = 'end',
  sideOffset = 6,
  ...props
}: React.ComponentProps<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        data-slot="popover-content"
        data-keyboard-owner=""
        align={align}
        sideOffset={sideOffset}
        className={cn('menu', className)}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

export { Popover, PopoverAnchor, PopoverContent, PopoverTrigger };
