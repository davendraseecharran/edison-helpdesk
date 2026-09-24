'use client';

/**
 * Self check-in, from the officer's side: turn it on, put the code on the
 * door, and watch the register fill.
 *
 * Off, it is one sentence and one button. On, it is the code itself (big
 * enough to hold a phone up to straight off the screen), the link with a copy
 * control, the two ways out to paper — the poster and the bare PNG — and the
 * two settings that matter: what people type to prove who they are, and
 * whether somebody not on the roster may walk in. The switch closes it at
 * once; the event's day closes it by itself.
 *
 * The same body is the event page's panel and, from the group's list of
 * events, a sheet. The caller owns the settings, so the event page's polling
 * and this panel's own saves land in one place.
 */

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { Check, Copy, Download, Printer, QrCode as QrIcon } from 'lucide-react';
import { checkinCodeAction, setEventCheckinAction } from '@/lib/data/checkin-actions';
import {
  CHECKIN_IDENTITIES,
  CHECKIN_IDENTITY_HINTS,
  CHECKIN_IDENTITY_LABELS,
  CHECKIN_STATE_LABELS,
  longDate,
  shortLink,
  type CheckinCodeResult,
  type CheckinIdentity,
  type CheckinPatch,
  type CheckinSettings,
} from '@/lib/domain/checkin';
import { useRuntime } from '@/components/AppRuntime';
import { Button, buttonClass } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { CountSwap } from '@/components/ui/Motion';
import { QrCode } from '@/components/ui/QrCode';
import { Skeleton } from '@/components/ui/Skeleton';
import { Switch } from '@/components/ui/shadcn/switch';
import { useCopied } from '@/components/ui/useCopied';
import '@/styles/scan.css';
import '@/styles/forms.css';
import '@/styles/settings.css';
import '@/styles/checkin.css';

export function CheckinStateBadge({ settings }: { settings: CheckinSettings }) {
  return (
    <span className={`badge badge-status checkin-state-${settings.state}`}>
      <span className="badge-dot" aria-hidden="true" />
      <span className="badge-label">{CHECKIN_STATE_LABELS[settings.state]}</span>
    </span>
  );
}

function stateLine(settings: CheckinSettings): string {
  switch (settings.state) {
    case 'open':
      return 'Taking check-ins today.';
    case 'early':
      return `Opens on ${longDate(settings.heldOn)}.`;
    case 'ended':
      return 'The event day has passed. The link says so.';
    default:
      return 'Closed. The link says to ask an officer.';
  }
}

export function SelfCheckinBody({
  eventId,
  eventName,
  groupName,
  settings,
  onSettings,
  initialCode = null,
}: {
  eventId: string;
  eventName: string;
  groupName: string;
  settings: CheckinSettings | null;
  onSettings: (next: CheckinSettings) => void;
  /** The code, when the page drew it on the server already. */
  initialCode?: CheckinCodeResult | null;
}) {
  const { run, pendingKey, notify } = useRuntime();
  const { copied, copy } = useCopied();
  const key = `checkin:${eventId}`;
  const saving = pendingKey === key;
  const slug = settings?.slug ?? null;

  // The code for the address, drawn on the server: handed over with the page
  // when there is one, fetched once when self check-in is turned on here. The
  // address never changes, so neither does the code.
  const [drawn, setDrawn] = useState<{ slug: string; result: CheckinCodeResult } | null>(
    settings && initialCode ? { slug: settings.slug, result: initialCode } : null,
  );
  const code = drawn !== null && drawn.slug === slug ? drawn.result : null;
  useEffect(() => {
    if (slug === null || (drawn !== null && drawn.slug === slug)) return;
    let alive = true;
    void checkinCodeAction(eventId)
      .then((result) => {
        if (alive) setDrawn({ slug, result });
      })
      .catch(() => {
        if (alive) setDrawn({ slug, result: { ok: false, error: 'The code did not load. Reload the page to try again.' } });
      });
    return () => {
      alive = false;
    };
  }, [eventId, slug, drawn]);

  async function save(patch: CheckinPatch) {
    const result = await run(key, () => setEventCheckinAction(eventId, patch));
    if (result.ok && 'settings' in result && result.settings) onSettings(result.settings as CheckinSettings);
  }

  async function copyLink() {
    if (!code?.ok) return;
    const done = await copy(code.url);
    if (!done) notify('error', 'That did not copy. Select the link and copy it by hand.');
  }

  if (!settings) {
    return (
      <div className="sci-off">
        <p className="sci-off-text">
          Put a code on the door and people check themselves in on their own phones. It opens on the
          day of the event and closes after it.
        </p>
        <Button icon={QrIcon} loading={saving} disabled={pendingKey !== null && !saving} onClick={() => void save({ open: true })}>
          Turn on self check-in
        </Button>
      </div>
    );
  }

  const fileName = `${eventName} check-in QR.png`;

  return (
    <div className="sci-body">
      <div className="sci-qr">
        {code?.ok ? (
          <QrCode svg={code.svg} label={`QR code that opens check-in for ${eventName}`} size={132} />
        ) : code && !code.ok ? (
          <span className="field-error">{code.error}</span>
        ) : (
          <Skeleton className="sci-qr-skeleton" />
        )}
        <span className="sci-qr-caption">Scan it with your phone to try it.</span>
      </div>

      <div className="sci-main">
        <div className="sci-status" role="status">
          <CheckinStateBadge settings={settings} />
          <span className="sci-count">
            <CountSwap value={settings.selfCount} /> checked themselves in
          </span>
          <span className="sci-count">{stateLine(settings)}</span>
        </div>

        <div className="sci-link">
          {code?.ok ? (
            <span className="sci-url mono">
              {shortLink(code.url)
                .split('/')
                .map((part, index) => (
                  <span key={index}>
                    {index > 0 ? '/' : null}
                    {index > 0 ? <wbr /> : null}
                    {part}
                  </span>
                ))}
            </span>
          ) : (
            <Skeleton className="sci-url" />
          )}
          <Button
            icon={copied ? Check : Copy}
            iconKey={copied ? 'copied' : 'copy'}
            onClick={() => void copyLink()}
            disabled={!code?.ok}
            aria-label="Copy the check-in link"
          >
            Copy
          </Button>
        </div>

        <div className="btn-row">
          <Link href={`/print/checkin/${eventId}`} className={buttonClass({ variant: 'primary' })} prefetch={false}>
            <Icon icon={Printer} size={16} weight="medium" />
            Print poster
          </Link>
          {code?.ok ? (
            <a className={buttonClass({})} href={code.png} download={fileName}>
              <Icon icon={Download} size={16} weight="medium" />
              Download QR
            </a>
          ) : (
            <Button icon={Download} disabled>
              Download QR
            </Button>
          )}
        </div>

        <div className="sci-settings">
          <div className="setting-row">
            <div className="setting-row-text">
              <label className="setting-row-label" htmlFor={`sci-open-${eventId}`}>
                Taking check-ins
              </label>
              <span className="setting-row-hint">Turn it off to close the link now. The poster keeps working when you turn it back on.</span>
            </div>
            <Switch
              id={`sci-open-${eventId}`}
              checked={settings.isOpen}
              disabled={pendingKey !== null}
              onCheckedChange={(open) => void save({ open })}
            />
          </div>
          <div className="setting-row">
            <fieldset className="sci-identity">
              <legend className="setting-row-label">People check in with</legend>
              {CHECKIN_IDENTITIES.map((identity) => (
                <label key={identity} className="form-template">
                  <input
                    type="radio"
                    name={`sci-identity-${eventId}`}
                    value={identity}
                    checked={settings.identity === identity}
                    disabled={pendingKey !== null}
                    onChange={() => void save({ identity: identity as CheckinIdentity })}
                  />
                  <span className="form-template-text">
                    <span className="form-template-name">{CHECKIN_IDENTITY_LABELS[identity]}</span>
                    <span className="form-template-summary">{CHECKIN_IDENTITY_HINTS[identity]}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          </div>
          <div className="setting-row">
            <div className="setting-row-text">
              <label className="setting-row-label" htmlFor={`sci-walk-${eventId}`}>
                Let walk-ins check in
              </label>
              <span className="setting-row-hint">
                Somebody in the directory who is not in {groupName} is added to it, noted as a walk-in, and
                marked present.
              </span>
            </div>
            <Switch
              id={`sci-walk-${eventId}`}
              checked={settings.walkIns}
              disabled={pendingKey !== null}
              onCheckedChange={(walkIns) => void save({ walkIns })}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
