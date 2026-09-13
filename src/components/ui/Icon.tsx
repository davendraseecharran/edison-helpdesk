import type { LucideIcon, LucideProps } from 'lucide-react';

export type { LucideIcon };

export interface IconProps extends Omit<LucideProps, 'ref' | 'size' | 'aria-label'> {
  /** The lucide icon component, imported by name so bundles only carry icons in use. */
  icon: LucideIcon;
  /** Rendered box in px. 18 in navigation and buttons, 14 in inline labels. */
  size?: number;
  /**
   * Text for assistive technology when the icon carries meaning on its own.
   * Omit it for icons that sit beside visible text: those are decoration.
   */
  label?: string;
}

/**
 * Thin wrapper over lucide that settles the two things every icon must get
 * right: a consistent stroke and the accessibility contract. An icon without
 * a label is hidden from screen readers; one with a label is announced as an
 * image with that name.
 */
export function Icon({ icon: Glyph, size = 18, label, className, ...rest }: IconProps) {
  return (
    <Glyph
      size={size}
      strokeWidth={1.75}
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
