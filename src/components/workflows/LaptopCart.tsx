'use client';

/**
 * The cart, filling.
 *
 * The one moment on the Load a cart screen: a charging cart drawn in CSS 3D —
 * a front, a side and a top, turned a few degrees so it reads as an object
 * rather than a diagram — with a slot for every laptop. Machines the inventory
 * already had in this cart stand in their slots at rest; each one scanned in
 * slides down into the next free slot, and the count on the cart's plate
 * turns over. Undo lifts it out again.
 *
 * Only `transform` and `opacity` move, on the one slot that changed, so a
 * Chromebook keeps up at a scanner's pace. Under reduced motion the slot is
 * simply filled and the number simply changes. Monochrome: the cart is the
 * surface ladder, a laptop is ink.
 */

import { useMemo } from 'react';
import { SettleNumber } from './SettleNumber';

const PER_SHELF = 10;
const MIN_SLOTS = 30;

export interface LaptopCartProps {
  /** Where they are going: the name on the plate. */
  name: string;
  /** Recorded here before the run started. */
  resident: number;
  /** Put here by this run, still here. */
  added: number;
}

export function LaptopCart({ name, resident, added }: LaptopCartProps) {
  const total = resident + added;
  const slots = Math.max(MIN_SLOTS, Math.ceil((total + 1) / PER_SHELF) * PER_SHELF);
  const shelves = useMemo(() => {
    const rows: number[][] = [];
    for (let start = 0; start < slots; start += PER_SHELF) {
      rows.push(Array.from({ length: PER_SHELF }, (_, index) => start + index));
    }
    return rows;
  }, [slots]);

  return (
    <figure className="wf-cart-figure" aria-label={`${name}: ${total} ${total === 1 ? 'laptop' : 'laptops'}`}>
      <div className="wf-cart-scene" aria-hidden="true">
        <div className="wf-cart" style={{ ['--shelves' as string]: shelves.length }}>
          <div className="wf-cart-face wf-cart-top" />
          <div className="wf-cart-face wf-cart-side" />
          <div className="wf-cart-face wf-cart-front">
            <div className="wf-cart-plate">
              <SettleNumber value={total} className="wf-cart-count" />
              <span className="wf-cart-name">{name}</span>
            </div>
            <div className="wf-cart-bays">
              {shelves.map((shelf, row) => (
                <div key={row} className="wf-cart-shelf">
                  {shelf.map((slot) => (
                    <span
                      key={slot}
                      className="wf-cart-slot"
                      data-fill={slot < resident ? 'resident' : slot < total ? 'added' : undefined}
                    >
                      <span className="wf-cart-laptop" />
                    </span>
                  ))}
                </div>
              ))}
            </div>
          </div>
          <span className="wf-cart-wheel wf-cart-wheel-left" />
          <span className="wf-cart-wheel wf-cart-wheel-right" />
        </div>
      </div>
      <figcaption className="wf-cart-caption">
        {added > 0 ? (
          <>
            <span className="num">{added}</span> added this run
            {resident > 0 ? (
              <>
                , <span className="num">{resident}</span> already here
              </>
            ) : null}
          </>
        ) : resident > 0 ? (
          <>
            <span className="num">{resident}</span> already here
          </>
        ) : (
          'Empty. Scan the first laptop.'
        )}
      </figcaption>
    </figure>
  );
}
