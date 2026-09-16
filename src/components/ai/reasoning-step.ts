/**
 * The keyboard's part of the reasoning slider, kept pure so it can be tested
 * without a document: which option the arrows, Home and End land on.
 */

export interface SliderOption {
  value: string;
  label: string;
}

/** The option a key moves to, or null when the key is not one of ours. */
export function stepOption(
  options: readonly SliderOption[],
  value: string,
  key: string,
): string | null {
  if (options.length === 0) return null;
  const at = Math.max(
    0,
    options.findIndex((option) => option.value === value),
  );
  let next: number;
  switch (key) {
    case 'ArrowRight':
    case 'ArrowDown':
      next = Math.min(options.length - 1, at + 1);
      break;
    case 'ArrowLeft':
    case 'ArrowUp':
      next = Math.max(0, at - 1);
      break;
    case 'Home':
      next = 0;
      break;
    case 'End':
      next = options.length - 1;
      break;
    default:
      return null;
  }
  return options[next].value;
}
