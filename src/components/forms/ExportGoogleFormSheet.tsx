'use client';

/**
 * Export to Google Forms: the same form, built in the officer's own Google
 * account by an Apps Script this sheet writes.
 *
 * The helpdesk never holds a Google credential, so it cannot make the form
 * itself; what it can do is write the few lines of FormApp that make it, and
 * say in three steps where to paste them. What will not be the same in Google
 * Forms — a signature it cannot take, directory questions it has no directory
 * to fill — is said above the script, before anybody runs it.
 */

import { useMemo } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { APPS_SCRIPT_NEW, googleFormScript } from '@/lib/domain/google-forms';
import type { FormField } from '@/lib/domain/forms';
import { useRuntime } from '@/components/AppRuntime';
import { Button, buttonClass } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Sheet } from '@/components/ui/Sheet';
import { usePhone } from '@/components/ui/media';
import { useCopied } from '@/components/ui/useCopied';
import '@/styles/google-forms.css';

export function ExportGoogleFormSheet({
  open,
  onClose,
  title,
  description,
  fields,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description: string;
  fields: readonly FormField[];
}) {
  const { notify } = useRuntime();
  const phone = usePhone();
  const { copied, copy } = useCopied();
  const exported = useMemo(() => googleFormScript({ title, description, fields }), [title, description, fields]);

  async function copyScript() {
    const done = await copy(exported.script);
    if (!done) notify('error', 'That did not copy. Select the script and copy it by hand.');
  }

  return (
    <Sheet
      open={open}
      onClose={onClose}
      side={phone ? 'bottom' : 'right'}
      title="Export to Google Forms"
      description="A script that makes this form in your Google account. Responses stay separate."
      className="gf-export-sheet"
    >
      <div className="gf-export">
        <ol className="gf-steps">
          <li>
            <span className="gf-step-text">Copy the script.</span>
            <Button
              size="sm"
              variant="primary"
              icon={copied ? Check : Copy}
              iconKey={copied ? 'copied' : 'copy'}
              onClick={() => void copyScript()}
            >
              Copy script
            </Button>
          </li>
          <li>
            <span className="gf-step-text">Open Apps Script and paste it over what is there.</span>
            <a className={buttonClass({ size: 'sm' })} href={APPS_SCRIPT_NEW} target="_blank" rel="noopener noreferrer">
              <Icon icon={ExternalLink} size={14} weight="medium" />
              Open Apps Script
            </a>
          </li>
          <li>
            <span className="gf-step-text">
              Press Run and allow access. The Execution log shows the new form’s links.
            </span>
          </li>
        </ol>

        {exported.notes.length > 0 ? (
          <ul className="gf-notes">
            {exported.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
        ) : null}

        <pre className="gf-code mono" tabIndex={0} aria-label="The Apps Script that makes this form">
          {exported.script}
        </pre>
      </div>
    </Sheet>
  );
}
