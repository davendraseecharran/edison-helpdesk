'use client';

/**
 * "New form": a title and what to start from.
 *
 * Three starting points, because a skills officer makes the same two forms all
 * year — a trip sign-up and a check-in — and the third is a blank page for
 * everything else. The template is only a first draft: every question it adds
 * can be changed or removed in the builder, which is where this lands.
 */

import { useState, type FormEvent } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { createFormAction } from '@/lib/data/form-actions';
import { FORM_TEMPLATES, FORM_TITLE_MAX, type FormTemplateKey } from '@/lib/domain/forms';
import { useRuntime } from '@/components/AppRuntime';
import { Field } from '@/components/Primitives';
import { Button, type ButtonVariant } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { ImportGoogleFormDialog } from './ImportGoogleFormDialog';

export function NewFormButton({ variant = 'primary' }: { variant?: ButtonVariant }) {
  const { pendingKey, run } = useRuntime();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [template, setTemplate] = useState<FormTemplateKey>('trip');
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const pending = pendingKey === 'form:create';

  function close() {
    setOpen(false);
    setTitle('');
    setTemplate('trip');
    setError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = await run('form:create', () => createFormAction(template, title), {
      inlineError: true,
    });
    if (result.ok && result.id) {
      close();
      router.push(`/forms/${result.id}`);
    } else if (!result.ok) {
      setError(result.error ?? 'That did not go through. Nothing was created.');
    }
  }

  const chosen = FORM_TEMPLATES.find((entry) => entry.key === template) ?? FORM_TEMPLATES[0];

  return (
    <>
      <Button icon={Plus} variant={variant} onClick={() => setOpen(true)} disabled={pending}>
        New form
      </Button>
      <Dialog
        open={open}
        onClose={close}
        title="New form"
        description="Pick a starting point. Every question can be changed after."
        footer={
          <>
            <Button onClick={close} disabled={pending}>
              Cancel
            </Button>
            <Button type="submit" form="new-form" variant="primary" loading={pending}>
              Create form
            </Button>
          </>
        }
      >
        <form id="new-form" className="form" onSubmit={submit} noValidate>
          <fieldset className="form-templates">
            <legend className="field-label">Start from</legend>
            {FORM_TEMPLATES.map((entry) => (
              <label key={entry.key} className="form-template">
                <input
                  type="radio"
                  name="template"
                  value={entry.key}
                  checked={template === entry.key}
                  onChange={() => setTemplate(entry.key)}
                />
                <span className="form-template-text">
                  <span className="form-template-name">{entry.name}</span>
                  <span className="form-template-summary">{entry.summary}</span>
                </span>
              </label>
            ))}
          </fieldset>
          <Field label="Title" htmlFor="new-form-title" optional hint={`Leave it empty to call it "${chosen.title}".`} error={error}>
            <input
              type="text"
              id="new-form-title"
              value={title}
              maxLength={FORM_TITLE_MAX}
              autoComplete="off"
              data-autofocus
              placeholder="Museum of the Moving Image, October 14"
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          <p className="field-hint">
            Built it in Google Forms already?{' '}
            <button
              type="button"
              className="gf-link-button"
              onClick={() => {
                close();
                setImporting(true);
              }}
            >
              Import it from Google Forms
            </button>
          </p>
        </form>
      </Dialog>
      <ImportGoogleFormDialog open={importing} onClose={() => setImporting(false)} />
    </>
  );
}
