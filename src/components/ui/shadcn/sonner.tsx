'use client';

/*
 * Sonner, wearing this product's markup.
 *
 * Sonner owns the parts of a toast stack that are the same everywhere and
 * tedious to get right: the stack that lifts and expands under the pointer,
 * the clock that stops while the tab is in the background, the swipe with a
 * velocity threshold, the limit, and the enter and exit that survive a toast
 * being replaced mid-flight. It is `unstyled` here and every toast goes
 * through `toast.custom`, so the thing on screen is our `.toast` — the same
 * left stripe, the same dismiss button, the same tokens — and Sonner's only
 * contribution to the look is where it sits and how it arrives.
 */

import { X } from 'lucide-react';
import { Toaster as SonnerToaster, toast as sonner } from 'sonner';

import { Button } from '@/components/ui/Button';
import { usePhone } from '@/components/ui/media';
import {
  TOAST_LIMIT,
  toastDuration,
  toastKey,
  toastPosition,
  type ToastKind,
} from '@/components/ui/toast';

/** One toast: its message, its dismiss button, and the hold the keyboard puts on the clock. */
function ToastBody({ id, kind, text }: { id: string | number; kind: ToastKind; text: string }) {
  return (
    <div
      className={kind === 'success' ? 'toast toast-success' : 'toast toast-error'}
      role={kind === 'error' ? 'alert' : 'status'}
      /*
       * The pointer's pause is Sonner's. This is the keyboard's: arriving at
       * the dismiss button with Tab stops the clock the same way resting the
       * mouse on the message does, and leaving starts it again. Re-issuing
       * under the same id updates the toast in place rather than replacing it,
       * so nothing moves and focus is not lost.
       */
      onFocus={() => emit(kind, text, toastDuration(kind, true))}
      onBlur={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return;
        emit(kind, text, toastDuration(kind));
      }}
    >
      <span className="toast-text">{text}</span>
      <Button
        variant="ghost"
        size="sm"
        icon={X}
        aria-label="Dismiss message"
        onClick={() => sonner.dismiss(id)}
      />
    </div>
  );
}

function emit(kind: ToastKind, text: string, duration: number): void {
  sonner.custom((id) => <ToastBody id={id} kind={kind} text={text} />, {
    id: toastKey(kind, text),
    duration,
  });
}

/** Show a message. The one way anything in the product raises a toast. */
export function showToast(kind: ToastKind, text: string): void {
  emit(kind, text, toastDuration(kind));
}

/** Remove every toast on screen. For a route change that invalidates them. */
export function clearToasts(): void {
  sonner.dismiss();
}

/**
 * The stack.
 *
 * Mounted once, inside the shell. A message nobody is looking at has not been
 * read, and Sonner holds to that without being asked: every clock stops while
 * `document.hidden`, and resumes with the time that was left. Switch tabs
 * while "Ticket resolved" is on screen, come back a minute later, and it is
 * still there.
 */
export function Toaster() {
  const phone = usePhone();
  return (
    <SonnerToaster
      position={toastPosition(phone)}
      visibleToasts={TOAST_LIMIT}
      gap={8}
      offset={16}
      mobileOffset={12}
      // Away from the edge it sits on, and on a phone also sideways, because
      // a thumb on a full-width toast flicks more easily across than up.
      swipeDirections={phone ? ['top', 'left', 'right'] : ['right', 'bottom']}
      style={{ '--width': 'min(360px, calc(100vw - 24px))' } as React.CSSProperties}
      toastOptions={{ unstyled: true }}
    />
  );
}
