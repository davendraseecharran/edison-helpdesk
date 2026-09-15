'use client';

/*
 * shadcn/ui's Tooltip, on Radix, wearing this product's class names.
 *
 * The browser has one of these already — the `title` attribute — and it is
 * unusable for an interface: it waits about a second, it draws in the
 * operating system's font on the operating system's ground, it cannot be
 * positioned, it disappears on its own after a few seconds, and it does not
 * appear for the keyboard at all. Radix's is a real one: it opens on hover and
 * on focus, it waits long enough that a cursor crossing the bar does not set
 * off a row of them and then skips the wait once one is already open, it
 * closes on Escape, it flips rather than leaving the window, and it is the
 * accessible description of the control it belongs to.
 *
 * No Tailwind utility survives here; the look is `components.css` against the
 * tokens.
 */

import * as React from 'react';
import { Tooltip as TooltipPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

function TooltipProvider({
  delayDuration = 400,
  skipDelayDuration = 300,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      skipDelayDuration={skipDelayDuration}
      {...props}
    />
  );
}

function Tooltip({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  return <TooltipPrimitive.Root data-slot="tooltip" {...props} />;
}

function TooltipTrigger({ ...props }: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />;
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Content
        data-slot="tooltip-content"
        sideOffset={sideOffset}
        className={cn('tooltip', className)}
        {...props}
      >
        {children}
      </TooltipPrimitive.Content>
    </TooltipPrimitive.Portal>
  );
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider };
