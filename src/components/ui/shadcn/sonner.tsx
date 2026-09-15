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

/**
 * One toast: its message, its dismiss button, and the hold the keyboard puts
 * on the clock.
 *
 * It carries no role of its own. Sonner already wraps every toast in an `<li
 * role="status" aria-live="polite" aria-atomic="true">`, and a live region
 * inside a live region is a message a reader may announce twice; `alert`
 * inside `status` is announced politely regardless, so the inner role was
 * buying nothing and risking that. An error here waits rather than interrupts
 * anyway — it has no clock at all, and it is still on screen to be read when
 * the reader arrives at it.
 */
function ToastBody({ id, kind, text }: { id: string | number; kind: ToastKind; text: string }) {
  return (
    <div
      className={kind === 'success' ? 'toast toast-success' : 'toast toast-error'}
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
      // Clear of the page's own bottom edge. At 16 the stack sat over whatever
      // the last row of a table held — on Administration, the Deactivate button
      // of the final account — and `.main` reserves the matching room below its
      // content so a page scrolled to the end never ends underneath a message.
      offset={24}
      // On a phone the stack starts below the top bar rather than on top of
      // it: a message that lasts five seconds should not take the brand and
      // every action in the bar with it.
      mobileOffset={{ top: 'calc(var(--topbar-h) + 12px)', left: 12, right: 12, bottom: 12 }}
      // Away from the edge it sits on, and on a phone also sideways, because
      // a thumb on a full-width toast flicks more easily across than up.
      swipeDirections={phone ? ['top', 'left', 'right'] : ['right', 'bottom']}
      style={{ '--width': 'min(360px, calc(100vw - 24px))' } as React.CSSProperties}
      // Every toast is `toast.custom`, so the only thing left to say about one
      // is that none of Sonner's own look applies. The announcement is the
      // `<li>` Sonner wraps it in; see the note in `ToastBody`.
      toastOptions={{ unstyled: true }}
      containerAriaLabel="Messages"
    />
  );
}
