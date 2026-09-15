'use client';

import type { ReactNode } from 'react';
import { X } from 'lucide-react';
import { Button } from './Button';
import { Overlay } from './Overlay';
import {
  Drawer,
  DrawerContent,
  DrawerDescription,
  DrawerTitle,
} from './shadcn/drawer';

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
 * A sheet from the bottom is a drawer, and a drawer on a phone is something
 * you drag. That is why this one is vaul underneath (through shadcn's Drawer,
 * ported to our tokens): it takes the finger with it, it has the velocity
 * threshold that makes a flick dismiss and a slow drag return, it damps at the
 * boundary instead of tearing, and it carries a handle that says all of that
 * before anybody touches it. Ours slid on a spring and ignored the finger
 * entirely, which on a touch screen is the difference between a surface and a
 * picture of one.
 *
 * From the right it is still `Overlay`: nothing drags a desktop side panel, and
 * the focus trap, the scroll lock and the exit animation there are already what
 * they should be.
 *
 * Both close on Escape and on a press outside, and hand focus back to whatever
 * opened them.
 */
export function Sheet({ side = 'right', ...rest }: SheetProps) {
  if (side === 'bottom') return <BottomSheet {...rest} />;
  return <Overlay kind="sheet" side="right" {...rest} />;
}

function BottomSheet({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  hideTitle,
  className,
}: Omit<SheetProps, 'side'>) {
  const undescribed = description ? {} : { 'aria-describedby': undefined };

  return (
    <Drawer
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
      // The page behind does not shrink away. It is a scale on the whole
      // document, and on a long list it reads as the screen flinching.
      shouldScaleBackground={false}
    >
      {/* Not `.overlay-panel`: that class places a Radix surface, and here vaul
          does the placing — the panel is what the drag moves. `.sheet` is the
          look the two share; `.sheet-bottom` is the edge this one arrives
          from. */}
      <DrawerContent
        className={className ? `sheet-bottom ${className}` : 'sheet-bottom'}
        /* Radix, under vaul, names the panel by its title and warns when
           nothing describes it. An explicit `undefined` is its documented way
           to say there is nothing more to add; a hidden empty description
           leaves the pointer aimed at a node with no text. */
        {...undescribed}
      >
        <header className={hideTitle ? 'overlay-head overlay-head-quiet' : 'overlay-head'}>
          <div className="overlay-head-text">
            <DrawerTitle className={hideTitle ? 'visually-hidden' : undefined}>{title}</DrawerTitle>
            {description ? <DrawerDescription>{description}</DrawerDescription> : null}
          </div>
          <Button variant="ghost" icon={X} aria-label="Close" onClick={onClose} />
        </header>
        <div className="overlay-body">{children}</div>
        {footer ? <footer className="overlay-foot">{footer}</footer> : null}
      </DrawerContent>
    </Drawer>
  );
}
