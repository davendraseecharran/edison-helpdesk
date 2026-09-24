'use client';

/*
 * shadcn/ui's Dropdown Menu, on Radix, wearing this product's class names.
 *
 * Ours was a correct menu and this one is a better one, and the difference is
 * all in the parts that are tedious to get right rather than in anything the
 * product has an opinion about: typeahead, a menu that flips or shifts when it
 * would run off the window instead of being clipped, a `transform-origin`
 * handed back as a custom property so the surface grows out of the corner
 * nearest its trigger wherever that corner turned out to be, pointer intent on
 * submenus, and the modal handling that stops the page behind scrolling under
 * an open menu.
 *
 * No Tailwind utility survives here. The look is `components.css` against the
 * tokens, and the entrance and exit are the ones in `docs/MOTION.md`.
 */

import * as React from 'react';
import { CheckIcon, ChevronRightIcon, CircleIcon } from 'lucide-react';
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui';

import { cn } from '@/lib/utils';
import { GlideLayer } from '@/components/ui/HoverGlide';

function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  return <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />;
}

function DropdownMenuPortal({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Portal>) {
  return <DropdownMenuPrimitive.Portal data-slot="dropdown-menu-portal" {...props} />;
}

function DropdownMenuTrigger({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>) {
  return <DropdownMenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
  className,
  sideOffset = 6,
  portal = true,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content> & {
  /**
   * A menu goes to the end of the document, where nothing can clip it.
   *
   * `portal={false}` leaves it where it is written, which is what a menu
   * inside a surface that runs its own focus trap needs: the assistant's panel
   * keeps Tab among its own descendants, and a menu that is not one of them is
   * a menu the keyboard cannot reach. Radix positions it against the trigger
   * either way.
   */
  portal?: boolean;
}) {
  const content = (
    <DropdownMenuPrimitive.Content
      data-slot="dropdown-menu-content"
      /* An open menu owns the keyboard: it navigates with the arrows and it
         types ahead, and Radix does not stop a character key travelling on
         to the document. Without this the shell's `n` would both jump the
         typeahead to "Notes" and navigate away to the new-ticket form. */
      data-keyboard-owner=""
      sideOffset={sideOffset}
      className={cn('menu glide-host', className)}
      {...props}
    >
      {/* The highlight glides between items (`HoverGlide`), following
          Radix's `data-highlighted`, so the pointer and the arrow keys move
          the same light. A child of its own, so this wrapper stays free of
          hooks. */}
      <GlideLayer kind="menu" selector=".menu-item" follow="highlight" />
      {children}
    </DropdownMenuPrimitive.Content>
  );
  if (!portal) return content;
  return <DropdownMenuPrimitive.Portal>{content}</DropdownMenuPrimitive.Portal>;
}

function DropdownMenuGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Group>) {
  return <DropdownMenuPrimitive.Group data-slot="dropdown-menu-group" {...props} />;
}

function DropdownMenuItem({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  variant?: 'default' | 'destructive';
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn('menu-item', variant === 'destructive' && 'menu-item-danger', className)}
      {...props}
    />
  );
}

function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  mark = true,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.CheckboxItem> & {
  /**
   * The tick in the gutter. `mark={false}` is for a row that shows its own
   * state — a switch pill at the end of the line — where a tick as well would
   * be the same answer given twice.
   */
  mark?: boolean;
}) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      data-slot="dropdown-menu-checkbox-item"
      className={cn('menu-item', mark && 'menu-item-marked', className)}
      checked={checked}
      {...props}
    >
      {mark ? (
        <span className="menu-mark" aria-hidden="true">
          <DropdownMenuPrimitive.ItemIndicator>
            <CheckIcon size={14} strokeWidth={2} />
          </DropdownMenuPrimitive.ItemIndicator>
        </span>
      ) : null}
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

function DropdownMenuRadioGroup({
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />;
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn('menu-item menu-item-marked', className)}
      {...props}
    >
      <span className="menu-mark" aria-hidden="true">
        <DropdownMenuPrimitive.ItemIndicator>
          <CircleIcon size={8} className="menu-mark-dot" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  );
}

function DropdownMenuLabel({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label>) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      className={cn('menu-label', className)}
      {...props}
    />
  );
}

function DropdownMenuSeparator({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn('menu-separator', className)}
      {...props}
    />
  );
}

function DropdownMenuShortcut({ className, ...props }: React.ComponentProps<'span'>) {
  return (
    <span data-slot="dropdown-menu-shortcut" className={cn('menu-shortcut', className)} {...props} />
  );
}

function DropdownMenuSub({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Sub>) {
  return <DropdownMenuPrimitive.Sub data-slot="dropdown-menu-sub" {...props} />;
}

function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubTrigger>) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      className={cn('menu-item', className)}
      {...props}
    >
      {children}
      <ChevronRightIcon size={14} className="menu-item-more" aria-hidden="true" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.SubContent
      data-slot="dropdown-menu-sub-content"
      className={cn('menu', className)}
      {...props}
    />
  );
}

export {
  DropdownMenu,
  DropdownMenuPortal,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuLabel,
  DropdownMenuItem,
  DropdownMenuCheckboxItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuSub,
  DropdownMenuSubTrigger,
  DropdownMenuSubContent,
};
