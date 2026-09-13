'use client';

import type { ReactNode } from 'react';
import { Overlay } from './Overlay';

export interface SheetProps {
  open: boolean;
  onClose: () => void;
  /** `right` for desktop detail and filters; `bottom` for phone menus. */
  side?: 'right' | 'bottom';
  title: string;
  description?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  hideTitle?: boolean;
  className?: string;
}

/**
 * A panel that slides in from an edge and takes over until dismissed.
 *
 * Focus is trapped, Escape and the backdrop close it, and the page behind
 * stops scrolling. Use it for secondary flows that should not lose the
 * page underneath: filters, the phone "More" menu, a quick lookup.
 */
export function Sheet({ side = 'right', ...rest }: SheetProps) {
  return <Overlay kind="sheet" side={side} {...rest} />;
}
