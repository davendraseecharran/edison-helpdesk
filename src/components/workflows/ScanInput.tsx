'use client';

/**
 * The field a USB scanner types into.
 *
 * A barcode scanner on a laptop is a keyboard: it types the code and presses
 * Enter. So the whole trick is that this field has the keyboard whenever
 * nothing else needs it — on arrival, after every click on a button or the
 * list, after the window comes back — and a code typed while focus had
 * wandered to a button still lands here instead of vanishing.
 *
 * Only where there is a fine pointer. On a phone a focused field is a keyboard
 * covering half the screen, and the phone's scanner is its camera; there the
 * field waits to be tapped like any other.
 */

import { forwardRef, useEffect, useImperativeHandle, useRef, useState, type FormEvent } from 'react';
import { ScanBarcode } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { isEditable, modalOpen } from '@/components/ui/shortcuts';

export interface ScanInputHandle {
  focus: () => void;
}

export interface ScanInputProps {
  id: string;
  label: string;
  placeholder: string;
  onCode: (code: string) => void;
  /** Whether the field should hold the keyboard. False once the run is finished. */
  active: boolean;
  /** A line under the field. */
  hint?: string;
  /**
   * A paste of several codes at once — a column out of a spreadsheet. A text
   * field would join the lines into one; this hands them over as a list.
   */
  onPasteCodes?: (text: string) => boolean;
  /** The button's word. */
  submitLabel?: string;
}

function finePointer(): boolean {
  return typeof window !== 'undefined' && window.matchMedia('(pointer: fine)').matches;
}

export const ScanInput = forwardRef<ScanInputHandle, ScanInputProps>(function ScanInput(
  { id, label, placeholder, onCode, active, hint, onPasteCodes, submitLabel = 'Add' },
  handle,
) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState('');

  useImperativeHandle(handle, () => ({ focus: () => input.current?.focus({ preventScroll: true }) }), []);

  useEffect(() => {
    if (!active || !finePointer()) return;
    const field = input.current;
    if (!field) return;

    const reclaim = () => {
      if (modalOpen()) return;
      const current = document.activeElement;
      if (current === field) return;
      if (isEditable(current)) return;
      if (current instanceof HTMLElement && current.closest('[data-keyboard-owner]')) return;
      field.focus({ preventScroll: true });
    };

    // After the click has done its job, so a button still receives its press.
    const onPointerUp = () => window.setTimeout(reclaim, 0);
    // A printable key while focus is on a button: move focus first, and the
    // browser delivers the character to the field it now belongs to.
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // Space presses a focused button; it is never the start of a code.
      if (event.key.length !== 1 || event.key === ' ') return;
      if (isEditable(event.target) || modalOpen()) return;
      if (event.target instanceof HTMLElement && event.target.closest('[data-keyboard-owner]')) return;
      field.focus({ preventScroll: true });
    };

    field.focus({ preventScroll: true });
    document.addEventListener('pointerup', onPointerUp);
    document.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('focus', reclaim);
    return () => {
      document.removeEventListener('pointerup', onPointerUp);
      document.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('focus', reclaim);
    };
  }, [active]);

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const code = value.trim();
    if (code === '') return;
    setValue('');
    onCode(code);
  }

  return (
    <form className="wf-scan-form" onSubmit={submit} autoComplete="off">
      <label className="visually-hidden" htmlFor={id}>
        {label}
      </label>
      <div className="wf-scan-field">
        <Icon icon={ScanBarcode} size={20} className="wf-scan-glyph" />
        <input
          ref={input}
          id={id}
          type="text"
          className="wf-scan-input mono"
          placeholder={placeholder}
          value={value}
          disabled={!active}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="characters"
          spellCheck={false}
          enterKeyHint="go"
          aria-describedby={hint ? `${id}-hint` : undefined}
          onChange={(event) => setValue(event.target.value)}
          onPaste={(event) => {
            if (!onPasteCodes) return;
            const text = event.clipboardData.getData('text');
            if (!/[\r\n,;\t]/.test(text.trim())) return;
            if (onPasteCodes(text)) event.preventDefault();
          }}
        />
        <Button type="submit" variant="secondary" size="sm" disabled={!active || value.trim() === ''}>
          {submitLabel}
        </Button>
      </div>
      {hint ? (
        <p id={`${id}-hint`} className="wf-scan-hint">
          {hint}
        </p>
      ) : null}
    </form>
  );
});
