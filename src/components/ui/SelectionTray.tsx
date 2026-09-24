'use client';

/**
 * The bar for a selection that outlives the view it was made in.
 *
 * The count is a button: it opens the whole selection, including the rows a
 * later search has scrolled out of view, each with a way to take it back out.
 * When some of the selection is off screen the bar says how many, so nobody
 * writes to eleven people believing they are writing to the four they can see.
 *
 * The actions (Gmail, Copy, Export for people; Assign, Move, Return for
 * devices) are the caller's, as children, so one tray serves every list.
 */

import { type ReactNode } from 'react';
import Link from 'next/link';
import { ChevronUp, X } from 'lucide-react';
import { AnimatePresence, EASE_OUT_FAST, motion } from '@/components/ui/Motion';
import { useReducedMotion } from '@/components/ui/media';
import { GlideLayer } from '@/components/ui/HoverGlide';
import { RollingNumber } from '@/components/ui/RollingNumber';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shadcn/popover';
import { Button } from '@/components/ui/Button';

export interface TrayItem {
  id: string;
  title: string;
  meta?: string;
  /** An identifier, set in mono: an OSIS, an asset tag. */
  code?: string;
  href?: string;
}

export function SelectionTray({
  label,
  count,
  offPage,
  noun,
  items,
  onRemove,
  onClear,
  children,
}: {
  label: string;
  count: number;
  /** How many selected rows the current view does not show. */
  offPage: number;
  noun: [singular: string, plural: string];
  items: TrayItem[];
  onRemove: (id: string) => void;
  onClear: () => void;
  children: ReactNode;
}) {
  const reduced = useReducedMotion();
  if (count === 0) return null;

  return (
    <div className="bulk-bar" role="region" aria-label={label}>
      <Popover>
        <PopoverTrigger asChild>
          <button type="button" className="bulk-bar-count tray-trigger" aria-live="polite">
            <span className="tray-count" aria-hidden="true">
              <RollingNumber value={count} />
            </span>
            <span className="visually-hidden">{count}</span> selected
            {offPage > 0 ? <span className="tray-off">{offPage} not shown</span> : null}
            <ChevronUp aria-hidden="true" className="tray-chevron" size={14} />
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="tray-list glide-host" aria-label={`Selected ${noun[1]}`}>
          <div className="tray-head">
            <span>
              {count} {count === 1 ? noun[0] : noun[1]}
            </span>
            <Button variant="ghost" size="sm" onClick={onClear}>
              Clear all
            </Button>
          </div>
          <GlideLayer selector=".tray-item" />
          <ul className="tray-items">
            <AnimatePresence initial={false}>
              {items.map((item) => (
                <motion.li
                  key={item.id}
                  layout={!reduced}
                  initial={reduced ? false : { opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={reduced ? { opacity: 0 } : { opacity: 0, height: 0 }}
                  transition={EASE_OUT_FAST}
                >
                  <div className="tray-item">
                    <span className="tray-item-text">
                      {item.href ? (
                        <Link href={item.href} className="tray-item-title">
                          {item.title}
                        </Link>
                      ) : (
                        <span className="tray-item-title">{item.title}</span>
                      )}
                      <span className="tray-item-meta">
                        {item.meta}
                        {item.code ? <span className="tray-item-code">{item.code}</span> : null}
                      </span>
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      icon={X}
                      className="tray-remove"
                      aria-label={`Remove ${item.title}`}
                      onClick={() => onRemove(item.id)}
                    />
                  </div>
                </motion.li>
              ))}
            </AnimatePresence>
          </ul>
        </PopoverContent>
      </Popover>
      <div className="bulk-bar-actions">{children}</div>
      <Button variant="ghost" size="sm" className="bulk-bar-clear" onClick={onClear}>
        Clear
      </Button>
    </div>
  );
}
