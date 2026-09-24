'use client';

/**
 * One printed page: a sheet of labels, or one label off a roll.
 *
 * Drawn at its physical size in millimetres with every label placed at the
 * coordinates the stock's own template gives (`placeLabels`). The print is
 * this element unscaled; the preview is this element inside a scaler, with
 * the die cuts drawn in and the used labels of a partly used sheet filled.
 */

import { memo } from 'react';
import {
  slotPosition,
  type LabelContent,
  type LabelDevice,
  type LabelLayout,
  type LabelSlot,
  type LabelTemplate,
} from '@/lib/labels/layout';
import { LabelFace } from './LabelFace';

export interface PlacedLabel {
  slot: LabelSlot;
  device: LabelDevice;
  /** Unique within the print: a device printed twice has two. */
  key: string;
}

export interface LabelSheetProps {
  template: LabelTemplate;
  labels: readonly PlacedLabel[];
  content: LabelContent;
  layout: LabelLayout;
  /** Preview only: draw every die cut, fill the used ones, and let a label be picked. */
  preview?: {
    /** Slots on this page already peeled off. */
    used: number;
    /** A press on an empty slot: start the print there. */
    onPick?: (slot: number) => void;
  };
}

function box(template: LabelTemplate, x: number, y: number) {
  return {
    left: `${x}mm`,
    top: `${y}mm`,
    width: `${template.label.width}mm`,
    height: `${template.label.height}mm`,
    padding: `${template.padding}mm`,
    borderRadius: `${template.radius}mm`,
  };
}

export const LabelSheet = memo(function LabelSheet({ template, labels, content, layout, preview }: LabelSheetProps) {
  const style = { width: `${template.page.width}mm`, height: `${template.page.height}mm` };
  const filled = new Set(labels.map((label) => label.slot.slot));
  const slots = template.columns * template.rows;

  return (
    <div className="label-page" data-kind={template.kind} style={style}>
      {preview
        ? Array.from({ length: slots }, (_, slot) => {
            // Every slot is a target, filled or not: the first free label on
            // the sheet in somebody's hand may be under one of these.
            const position = slotPosition(template, slot);
            const used = slot < preview.used;
            const common = {
              className: 'label-slot',
              'data-used': used || undefined,
              style: box(template, position.x, position.y),
            };
            return preview.onPick ? (
              <button
                key={`slot-${slot}`}
                type="button"
                {...common}
                aria-label={`Start at label ${slot + 1}`}
                aria-pressed={preview.used > 0 && slot === preview.used}
                data-filled={filled.has(slot) || undefined}
                onClick={() => preview.onPick?.(slot)}
              />
            ) : (
              <span key={`slot-${slot}`} {...common} aria-hidden="true" />
            );
          })
        : null}
      {labels.map((label) => (
        <div
          key={label.key}
          className="label"
          data-preview={preview ? '' : undefined}
          style={box(template, label.slot.x, label.slot.y)}
        >
          <LabelFace device={label.device} content={content} layout={layout} />
        </div>
      ))}
    </div>
  );
});
