/**
 * Putting a short list on the clipboard, from a browser.
 *
 * Small on purpose and owned here: the one thing a roster wants to copy is a
 * column of names to paste into a message, and that is two lines of code plus
 * the fallback every clipboard helper needs — `navigator.clipboard` is absent
 * on an insecure origin and throws when the document is not focused, and a
 * silent failure is the worst possible outcome for "copy" because the person
 * finds out by pasting the wrong thing.
 */

/** One name per line: what somebody pastes into an email or a message. */
export function linesOf(values: readonly string[]): string {
  return values.join('\n');
}

/**
 * Copies text, answering whether it landed.
 *
 * The fallback is the old `execCommand` route through an off-screen textarea,
 * which works in the places the async API does not. Both are tried before
 * this reports false, and the caller says so out loud rather than pretending.
 */
export async function copyText(text: string): Promise<boolean> {
  if (text === '') return false;

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Not permitted, or the document is not focused. The fallback may still do it.
  }

  if (typeof document === 'undefined') return false;
  try {
    const field = document.createElement('textarea');
    field.value = text;
    // Off screen rather than hidden: a field with `display: none` cannot be
    // selected, and a selection is what the fallback copies.
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.top = '-1000px';
    field.style.opacity = '0';
    document.body.appendChild(field);
    field.select();
    const copied = document.execCommand('copy');
    document.body.removeChild(field);
    return copied;
  } catch {
    return false;
  }
}
