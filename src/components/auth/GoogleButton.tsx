'use client';

/**
 * The primary way in.
 *
 * A plain form posting to a server action, so it works before hydration and
 * without JavaScript: the action builds the provider URL and redirects. The
 * mark is drawn in the current colour rather than the four brand colours, so it
 * sits inside an accented button in both themes and needs no image request.
 */

import { useFormStatus } from 'react-dom';
import { signInWithGoogleAction } from '@/lib/auth/google-actions';
import { Button } from '@/components/ui/Button';

function GoogleMark() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M21.35 11.1h-9.17v2.96h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.75h3.57c2.09-1.93 3.29-4.77 3.29-8.14 0-.35-.02-.68-.05-1a8.7 8.7 0 0 0-1.35.12ZM12.18 22c2.7 0 4.96-.9 6.61-2.43l-3.57-2.75c-.99.66-2.26 1.06-3.04 1.06-2.86 0-5.29-1.93-6.16-4.53H2.33v2.84A9.98 9.98 0 0 0 12.18 22ZM6.02 13.35a5.99 5.99 0 0 1 0-3.83V6.68H2.33a10 10 0 0 0 0 8.97l3.69-2.3ZM12.18 5.58c1.47 0 2.79.51 3.83 1.5l2.87-2.87C17.13 2.55 14.88 1.6 12.18 1.6c-3.9 0-7.27 2.24-8.9 5.5l3.69 2.84c.87-2.6 3.3-4.36 6.16-4.36Z" />
    </svg>
  );
}

function Submit() {
  const { pending } = useFormStatus();
  return (
    <Button type="submit" variant="primary" block loading={pending}>
      {pending ? null : <GoogleMark />}
      Continue with Google
    </Button>
  );
}

/**
 * `next` rides in a hidden field rather than a query string on the provider
 * URL: the action reads it from the form, checks it, and keeps it on this
 * origin in a short-lived cookie. See `signInWithGoogleAction`.
 */
export function GoogleButton({ next }: { next?: string }) {
  return (
    <form action={signInWithGoogleAction}>
      {next ? <input type="hidden" name="next" value={next} /> : null}
      <Submit />
    </form>
  );
}
