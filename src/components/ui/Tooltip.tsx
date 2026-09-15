'use client';

import type { ReactElement, ReactNode } from 'react';

import {
  Tooltip as TooltipRoot,
  TooltipContent,
  TooltipProvider as Provider,
  TooltipTrigger,
} from './shadcn/tooltip';

/**
 * The name of a control that shows only its icon.
 *
 * A tooltip is a label that arrived late, and that is the whole of its job
 * here: an icon-only button already carries its name for assistive technology
 * in `aria-label`, and this is the same name for somebody who can see the
 * button and does not recognise the glyph. It never carries anything that is
 * not also available another way, because it cannot be reached by touch.
 *
 * Its child is the trigger itself — a real button, not a wrapper around one —
 * so nothing changes about focus, layout or the press.
 */
export function Tooltip({
  label,
  side = 'bottom',
  children,
}: {
  label: ReactNode;
  side?: 'top' | 'right' | 'bottom' | 'left';
  children: ReactElement;
}) {
  return (
    <TooltipRoot>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={side}>{label}</TooltipContent>
    </TooltipRoot>
  );
}

/**
 * Mounted once around the application.
 *
 * It is what lets the second tooltip skip the wait the first one served: a
 * cursor moving along a row of icon buttons reads as one gesture, and making
 * it wait again at every stop is how a toolbar comes to feel slow.
 */
export function TooltipProvider({ children }: { children: ReactNode }) {
  return <Provider>{children}</Provider>;
}
