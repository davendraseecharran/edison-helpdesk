import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/**
 * Join class names, letting a later Tailwind utility win over an earlier one.
 *
 * The helper every shadcn component expects. `clsx` flattens the conditional
 * forms; `tailwind-merge` resolves the conflicts that come from a caller
 * passing `className` to override a component's own utility — without it,
 * `p-2` and `p-4` both survive and the cascade decides by source order, which
 * is not what the caller meant.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
