'use client';

/**
 * The top of every page of one form: its name, whether it is taking
 * responses, and the three things done to a form from anywhere in it —
 * sharing it, opening the kiosk, and opening or closing it.
 *
 * Share is a sheet rather than a page because it is a moment: copy the link,
 * or hold the QR code up to a projector, and go back to what you were doing.
 */

import { useState } from 'react';
import Link from 'next/link';
import { Check, Copy, Download, Link2, Lock, MonitorSmartphone, MoreHorizontal, Share2 } from 'lucide-react';
import { formShareAction, setFormOpenAction } from '@/lib/data/form-actions';
import type { FormShareResult } from '@/lib/domain/forms';
import { AUDIENCE_LABELS, type FormAudience, type FormField, type FormState } from '@/lib/domain/forms';
import { formJson } from '@/lib/domain/google-forms';
import { copyText } from '@/lib/groups/clipboard';
import { useRuntime } from '@/components/AppRuntime';
import { Button, ButtonLink } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { QrCode } from '@/components/ui/QrCode';
import { Sheet } from '@/components/ui/Sheet';
import { Skeleton } from '@/components/ui/Skeleton';
import { Tabs } from '@/components/ui/Tabs';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/shadcn/dropdown-menu';
import { ExportGoogleFormSheet } from './ExportGoogleFormSheet';
import { usePhone } from '@/components/ui/media';
import { FormStateBadge } from './FormStateBadge';
import '@/styles/scan.css';
import '@/styles/forms.css';

export interface FormHeaderData {
  id: string;
  title: string;
  state: FormState;
  isOpen: boolean;
  audience: FormAudience;
  shared: boolean;
  responseCount: number;
  ownerName: string | null;
  mine: boolean;
  groupName: string | null;
  eventName: string | null;
  description: string;
  fields: FormField[];
}

/** The form as this helpdesk's own JSON, handed to the browser as a file. */
function downloadJson(form: FormHeaderData) {
  const body = JSON.stringify(
    formJson({ title: form.title, description: form.description, audience: form.audience, fields: form.fields }),
    null,
    2,
  );
  const url = URL.createObjectURL(new Blob([body], { type: 'application/json' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `${form.title.replace(/[\\/:*?"<>|]+/g, ' ').trim() || 'Form'}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function FormHeader({ form }: { form: FormHeaderData }) {
  const { pendingKey, run } = useRuntime();
  const [sharing, setSharing] = useState(false);
  const [share, setShare] = useState<FormShareResult | null>(null);
  const [exporting, setExporting] = useState(false);
  const toggling = pendingKey === 'form:open';

  // Asked for the first time the sheet opens: the link never changes, and the
  // code is drawn on the server so the generator stays out of the bundle.
  function openShare() {
    setSharing(true);
    if (share === null || !share.ok) {
      void formShareAction(form.id)
        .then(setShare)
        .catch(() => setShare({ ok: false, error: 'The link did not load. Close this and try again.' }));
    }
  }

  return (
    <>
      <header className="ticket-head record-head form-head">
        <div className="record-head-main">
          <div className="ticket-head-text">
            <nav className="form-crumb" aria-label="Breadcrumb">
              <Link href="/forms">Forms</Link>
            </nav>
            <div className="record-title-row">
              <h1 className="record-title">{form.title}</h1>
            </div>
            <div className="ticket-meta record-idents">
              <span className="ticket-meta-item">
                <FormStateBadge state={form.state} />
              </span>
              <span className="ticket-meta-item">{AUDIENCE_LABELS[form.audience]}</span>
              {form.groupName ? (
                <span className="ticket-meta-item">
                  Fills {form.groupName}
                  {form.eventName ? `, marks ${form.eventName}` : ''}
                </span>
              ) : null}
              {!form.shared ? (
                <span className="ticket-meta-item forms-private">
                  <Icon icon={Lock} size={12} />
                  Private
                </span>
              ) : null}
              <span className="ticket-meta-item">
                {form.mine ? 'Made by you' : form.ownerName ? `Made by ${form.ownerName}` : null}
              </span>
            </div>
          </div>
        </div>
        <div className="btn-row record-actions">
          <Button icon={Share2} variant="primary" onClick={openShare}>
            Share
          </Button>
          <ButtonLink href={`/kiosk/forms/${form.id}`} icon={MonitorSmartphone} prefetch={false}>
            Kiosk
          </ButtonLink>
          <Button
            loading={toggling}
            disabled={pendingKey !== null && !toggling}
            onClick={() => void run('form:open', () => setFormOpenAction(form.id, !form.isOpen))}
          >
            {form.isOpen ? 'Close form' : 'Open form'}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button icon={MoreHorizontal} aria-label="More for this form" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => setExporting(true)}>Export to Google Forms</DropdownMenuItem>
              <DropdownMenuItem onSelect={() => downloadJson(form)}>Download as JSON</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>
      <Tabs
        label="Form sections"
        items={[
          { href: `/forms/${form.id}`, label: 'Questions' },
          { href: `/forms/${form.id}/responses`, label: 'Responses', count: form.responseCount },
          { href: `/forms/${form.id}/settings`, label: 'Settings' },
        ]}
      />
      <ExportGoogleFormSheet
        open={exporting}
        onClose={() => setExporting(false)}
        title={form.title}
        description={form.description}
        fields={form.fields}
      />
      <ShareSheet
        open={sharing}
        onClose={() => setSharing(false)}
        share={share}
        formId={form.id}
        title={form.title}
        state={form.state}
        audience={form.audience}
      />
    </>
  );
}

function ShareSheet({
  open,
  onClose,
  share,
  formId,
  title,
  state,
  audience,
}: {
  open: boolean;
  onClose: () => void;
  share: FormShareResult | null;
  formId: string;
  title: string;
  state: FormState;
  audience: FormAudience;
}) {
  const { notify } = useRuntime();
  const phone = usePhone();
  const [copied, setCopied] = useState(false);

  async function copy() {
    if (!share || !share.ok) return;
    const done = await copyText(share.url);
    setCopied(done);
    notify(done ? 'success' : 'error', done ? 'Link copied.' : 'That did not copy. Select the link and copy it by hand.');
    if (done) window.setTimeout(() => setCopied(false), 1600);
  }

  const download =
    share && share.ok ? `data:image/svg+xml;charset=utf-8,${encodeURIComponent(share.qrSvg)}` : null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      side={phone ? 'bottom' : 'right'}
      title="Share this form"
      description={
        audience === 'directory'
          ? 'People confirm their school email and OSIS, then see their details filled in.'
          : 'Anybody with the link can answer. Nobody is asked who they are.'
      }
      className="form-share"
    >
      <div className="form-share-body">
        {state !== 'open' ? (
          <p className="callout callout-warn">
            This form is {state === 'full' ? 'full' : 'closed'}, so the link shows a closed page until
            you open it again.
          </p>
        ) : null}

        <section className="form-share-section" aria-labelledby="share-link-heading">
          <h3 className="form-share-heading" id="share-link-heading">
            <Icon icon={Link2} size={16} />
            Link
          </h3>
          <div className="form-share-link">
            {share && share.ok ? (
              <span className="form-share-url mono">{share.url}</span>
            ) : share && !share.ok ? (
              <span className="field-error">{share.error}</span>
            ) : (
              <Skeleton className="form-share-url-skeleton" />
            )}
            <Button
              icon={copied ? Check : Copy}
              onClick={copy}
              disabled={!share || !share.ok}
              aria-label="Copy the link"
            >
              {copied ? 'Copied' : 'Copy'}
            </Button>
          </div>
        </section>

        <section className="form-share-section" aria-labelledby="share-qr-heading">
          <h3 className="form-share-heading" id="share-qr-heading">
            QR code for a poster
          </h3>
          {share && share.ok ? (
            <QrCode svg={share.qrSvg} label={`QR code for ${title}`} size={208} />
          ) : (
            <Skeleton className="scan-qr-skeleton" />
          )}
          {download ? (
            <a className="btn btn-ghost btn-sm form-share-download" href={download} download={`${title} QR.svg`}>
              <Icon icon={Download} size={16} weight="medium" />
              Download the code
            </a>
          ) : null}
        </section>

        <section className="form-share-section" aria-labelledby="share-kiosk-heading">
          <h3 className="form-share-heading" id="share-kiosk-heading">
            <Icon icon={MonitorSmartphone} size={16} />
            At the door
          </h3>
          <p className="form-share-note">
            Put a signed-in laptop or tablet by the entrance. People scan their ID or type their
            OSIS, and the form opens with their details filled in.
          </p>
          <ButtonLink href={`/kiosk/forms/${formId}`} prefetch={false}>
            Open the kiosk on this device
          </ButtonLink>
        </section>
      </div>
    </Sheet>
  );
}
