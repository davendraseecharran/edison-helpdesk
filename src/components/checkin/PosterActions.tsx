'use client';

/**
 * The buttons above the poster. Outside the application's shell, so there is
 * no runtime here to toast through: each answers in place.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Download, Printer, QrCode as QrIcon } from 'lucide-react';
import { setEventCheckinAction } from '@/lib/data/checkin-actions';
import { Button, buttonClass } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';

export function PosterActions({ png, fileName }: { png: string; fileName: string }) {
  return (
    <div className="btn-row">
      <a className={buttonClass({})} href={png} download={fileName}>
        <Icon icon={Download} size={16} weight="medium" />
        Download QR
      </a>
      <Button variant="primary" icon={Printer} onClick={() => window.print()}>
        Print poster
      </Button>
    </div>
  );
}

/** What the poster page shows for an event whose self check-in was never turned on. */
export function PosterTurnOn({ eventId }: { eventId: string }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function turnOn() {
    setPending(true);
    setError(null);
    try {
      const result = await setEventCheckinAction(eventId, { open: true });
      if (result.ok) router.refresh();
      else setError(result.error);
    } catch {
      setError('That did not go through. Nothing changed. Try again.');
    } finally {
      setPending(false);
    }
  }

  return (
    <section className="poster-note sci-off" aria-labelledby="poster-off-heading">
      <div>
        <h1 className="sci-off-title" id="poster-off-heading">
          Self check-in is off
        </h1>
        <p className="sci-off-text">
          Turn it on and this page becomes a poster with a code people scan to check themselves
          in. They type their name, or their OSIS if two people share it.
        </p>
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
      </div>
      <Button variant="primary" icon={QrIcon} loading={pending} onClick={() => void turnOn()}>
        Turn on self check-in
      </Button>
    </section>
  );
}
