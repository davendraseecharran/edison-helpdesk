'use client';

/*
 * shadcn/ui's Switch, on Radix, wearing this product's class names.
 *
 * Ours was a `<button role="switch">`, which is the correct element and was
 * missing the parts a control like this collects once it is in a form: the
 * hidden input that carries its value on submit, `disabled` that is real
 * rather than an `aria-disabled` the pointer still reaches, and a `form`
 * association. Radix brings those; the shape and the two colours are
 * `settings.css` against the tokens. The thumb travels as a drop of the same
 * liquid as the segmented control's pill: its two edges move on different
 * clocks, so it stretches across the track and snaps round at the far end.
 */

import * as React from 'react';
import { Switch as SwitchPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
  return (
    <SwitchPrimitive.Root data-slot="switch" className={cn('switch', className)} {...props}>
      <SwitchPrimitive.Thumb data-slot="switch-thumb" className="switch-thumb" />
    </SwitchPrimitive.Root>
  );
}

export { Switch };
