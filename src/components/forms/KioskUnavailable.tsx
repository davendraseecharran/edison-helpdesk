import { ButtonLink } from '@/components/ui/Button';

/** A kiosk link to something that is not there, or not this account's to open. */
export function KioskUnavailable({ what, backHref }: { what: 'event' | 'form'; backHref: string }) {
  return (
    <main className="kiosk kiosk-gone">
      <div className="kiosk-stage">
        <p className="kiosk-prompt">This {what} is not available</p>
        <p className="kiosk-hint">
          It may have been deleted, or it may belong to somebody else. Open the kiosk again from
          the {what}&rsquo;s page.
        </p>
        <ButtonLink href={backHref}>Go back</ButtonLink>
      </div>
    </main>
  );
}
