'use client';

/*
 * shadcn/ui's Select, on Radix, wearing this product's class names.
 *
 * The behaviour is the reason it is here and none of it is ours: typeahead,
 * the roving focus, Home and End, the collision-aware placement, the
 * `transform-origin` handed back as a custom property, the scroll buttons on a
 * list taller than the viewport, and the pointer-versus-keyboard distinction
 * that decides whether moving the mouse selects. A native `<select>` has all
 * of that too — and an operating-system popup that belongs to a different
 * product on every machine it runs on.
 *
 * What is ours is every class on it. No Tailwind utility survives here: the
 * look comes from `components.css` against the tokens, so a select reads as
 * the same object as an input and its list as the same object as a menu.
 */

import * as React from 'react';
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import { Select as SelectPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';

function Select({ ...props }: React.ComponentProps<typeof SelectPrimitive.Root>) {
  return <SelectPrimitive.Root data-slot="select" {...props} />;
}

function SelectGroup({ ...props }: React.ComponentProps<typeof SelectPrimitive.Group>) {
  return <SelectPrimitive.Group data-slot="select-group" {...props} />;
}

function SelectValue({ ...props }: React.ComponentProps<typeof SelectPrimitive.Value>) {
  return <SelectPrimitive.Value data-slot="select-value" {...props} />;
}

function SelectTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Trigger>) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      className={cn('select-trigger', className)}
      {...props}
    >
      <span className="select-value">{children}</span>
      <SelectPrimitive.Icon asChild>
        <ChevronDownIcon className="select-chevron" aria-hidden="true" />
      </SelectPrimitive.Icon>
    </SelectPrimitive.Trigger>
  );
}

function SelectContent({
  className,
  children,
  position = 'popper',
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Content>) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Content
        data-slot="select-content"
        className={cn('menu select-content', className)}
        position={position}
        sideOffset={4}
        {...props}
      >
        <SelectScrollUpButton />
        <SelectPrimitive.Viewport className="select-viewport">{children}</SelectPrimitive.Viewport>
        <SelectScrollDownButton />
      </SelectPrimitive.Content>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({ className, ...props }: React.ComponentProps<typeof SelectPrimitive.Label>) {
  return (
    <SelectPrimitive.Label
      data-slot="select-label"
      className={cn('menu-label', className)}
      {...props}
    />
  );
}

function SelectItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Item>) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn('menu-item select-item', className)}
      {...props}
    >
      <span className="select-check" aria-hidden="true">
        <SelectPrimitive.ItemIndicator>
          <CheckIcon size={14} strokeWidth={2} />
        </SelectPrimitive.ItemIndicator>
      </span>
      <SelectPrimitive.ItemText>{children}</SelectPrimitive.ItemText>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.Separator>) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn('menu-separator', className)}
      {...props}
    />
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollUpButton>) {
  return (
    <SelectPrimitive.ScrollUpButton
      data-slot="select-scroll-up-button"
      className={cn('select-scroll', className)}
      {...props}
    >
      <ChevronUpIcon size={14} aria-hidden="true" />
    </SelectPrimitive.ScrollUpButton>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: React.ComponentProps<typeof SelectPrimitive.ScrollDownButton>) {
  return (
    <SelectPrimitive.ScrollDownButton
      data-slot="select-scroll-down-button"
      className={cn('select-scroll', className)}
      {...props}
    >
      <ChevronDownIcon size={14} aria-hidden="true" />
    </SelectPrimitive.ScrollDownButton>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectScrollDownButton,
  SelectScrollUpButton,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
