'use client';

/**
 * Copies an identifier to the clipboard: an OSIS to paste into the roster, a
 * serial into a warranty form. The icon flips to a check for a moment and a
 * live region says "Copied" for anyone not looking at it. A browser that
 * refuses the clipboard gets told what to do instead.
 */

import { useEffect, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { useRuntime } from '@/components/AppRuntime';
import { Button } from '@/components/ui/Button';

const SHOW_COPIED_MS = 1500;

export function CopyButton({ value, label }: { value: string; label: string }) {
  const { notify } = useRuntime();
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  async function copy() {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => setCopied(false), SHOW_COPIED_MS);
    } catch {
      notify('error', `Could not copy the ${label}. Select the text and copy it instead.`);
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        icon={copied ? Check : Copy}
        aria-label={`Copy ${label}`}
        title={`Copy ${label}`}
        className="copy-btn"
        data-copied={copied || undefined}
        onClick={() => void copy()}
      />
      <span className="visually-hidden" role="status">
        {copied ? `${label} copied` : ''}
      </span>
    </>
  );
}

/** A labelled identifier in mono with its copy button: "OSIS 240000123 [copy]". */
export function Identifier({ label, value }: { label: string; value: string }) {
  return (
    <span className="ident">
      <span className="ident-label">{label}</span>
      <span className="ident-value mono">{value}</span>
      <CopyButton value={value} label={label} />
    </span>
  );
}
