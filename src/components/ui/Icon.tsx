import type { LucideIcon, LucideProps } from 'lucide-react';

export type { LucideIcon };

/**
 * How heavy the type beside this icon is, in stroke widths.
 *
 * An icon carries the optical weight of the text it sits next to: a hairline
 * glyph beside a semibold label reads as broken, and a heavy one beside body
 * text shouts. `regular` is body copy at 400, `medium` a control or a nav
 * item at 500–600, `bold` an emphasised standalone mark.
 */
export type IconWeight = 'regular' | 'medium' | 'bold';

const STROKE: Record<IconWeight, number> = { regular: 1.5, medium: 2, bold: 2.5 };

export interface IconProps extends Omit<LucideProps, 'ref' | 'size' | 'aria-label'> {
  /** The lucide icon component, imported by name so bundles only carry icons in use. */
  icon: LucideIcon;
  /** Rendered box in px. 18 in navigation and buttons, 14 in inline labels. */
  size?: number;
  /** Stroke weight, matched to the weight of the adjacent text. */
  weight?: IconWeight;
  /**
   * Text for assistive technology when the icon carries meaning on its own.
   * Omit it for icons that sit beside visible text: those are decoration.
   */
  label?: string;
}

/**
 * Thin wrapper over lucide that settles the three things every icon must get
 * right: a stroke matched to its neighbouring text, one asset recoloured by
 * state rather than a second file, and the accessibility contract. An icon
 * without a label is hidden from screen readers; one with a label is
 * announced as an image with that name.
 *
 * `absoluteStrokeWidth` keeps the number literal: a `medium` icon renders a
 * 2px stroke at 16px and at 24px, instead of thinning as it shrinks.
 */
export function Icon({
  icon: Glyph,
  size = 18,
  weight = 'regular',
  label,
  className,
  ...rest
}: IconProps) {
  return (
    <Glyph
      size={size}
      strokeWidth={STROKE[weight]}
      absoluteStrokeWidth
      className={className ? `icon ${className}` : 'icon'}
      aria-hidden={label ? undefined : true}
      role={label ? 'img' : undefined}
      aria-label={label}
      focusable="false"
      {...rest}
    />
  );
}
