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
      {/* Not `.overlay-panel`: that class positions the surface itself, and
          here vaul does the positioning — it is what the drag moves. The
          drawer keeps its own layout and takes only the look. */}
      <DrawerContent className={className ? `sheet sheet-bottom ${className}` : 'sheet sheet-bottom'}>
        <header className={hideTitle ? 'overlay-head overlay-head-quiet' : 'overlay-head'}>
          <div className="overlay-head-text">
            <DrawerTitle className={hideTitle ? 'visually-hidden' : 'overlay-title'}>
              {title}
            </DrawerTitle>
            {description ? (
              <DrawerDescription className="overlay-description">{description}</DrawerDescription>
            ) : (
              /* Radix names the panel by its title and warns when it has no
                 description; a hidden empty one is the documented way to say
                 "there is nothing more to add" without inventing copy. */
              <DrawerDescription className="visually-hidden" />
            )}
          </div>
          <Button variant="ghost" icon={X} aria-label="Close" onClick={onClose} />
        </header>
        <div className="overlay-body">{children}</div>
        {footer ? <footer className="overlay-foot">{footer}</footer> : null}
      </DrawerContent>
    </Drawer>
  );
}
