'use client';

/**
 * Import from Google Forms: a form somebody already built, brought here.
 *
 * Three moments, one surface:
 *
 *   1. PASTE. The form's link — the one people answer it at, or forms.gle —
 *      and the server reads the public page. A paste is read as it lands.
 *   2. SCRIPT, only when Google will not show the form to a stranger (a form
 *      that needs a school sign-in). A short Apps Script, run in the officer's
 *      own Google account, prints the form as JSON; the JSON pasted back here
 *      is read exactly like the page would have been.
 *   3. PREVIEW. Every question as it will arrive, with what changed on the way
 *      and what could not come at all, and each question whose title names a
 *      directory fact offered as one — ticked, and untickable. Nothing is
 *      made until "Create form".
 */

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Check, Copy, ExternalLink, FileDown } from 'lucide-react';
import { createImportedFormAction, readGoogleFormAction } from '@/lib/data/form-import-actions';
import {
  APPS_SCRIPT_NEW,
  APPS_SCRIPT_READER,
  fieldsFromDraft,
  suggestedDirectory,
  type FormDraft,
} from '@/lib/domain/google-forms';
import { DIRECTORY_LABELS, FORM_TITLE_MAX, QUESTION_TYPE_LABELS, type FormAudience } from '@/lib/domain/forms';
import { useRuntime } from '@/components/AppRuntime';
import { Field } from '@/components/Primitives';
import { Button, buttonClass } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { useCopied } from '@/components/ui/useCopied';
import { QUESTION_ICONS } from './questionIcons';
import '@/styles/forms.css';
import '@/styles/google-forms.css';

type Stage = 'paste' | 'script' | 'preview';

export function ImportGoogleFormDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { run, pendingKey, notify } = useRuntime();
  const router = useRouter();
  const [stage, setStage] = useState<Stage>('paste');
  const [pasted, setPasted] = useState('');
  const [scriptJson, setScriptJson] = useState('');
  const [reading, setReading] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [why, setWhy] = useState<string | null>(null);
  const [draft, setDraft] = useState<FormDraft | null>(null);
  const [title, setTitle] = useState('');
  const [audience, setAudience] = useState<FormAudience>('directory');
  const [directory, setDirectory] = useState<Set<number>>(new Set());
  const justPasted = useRef(false);
  const { copied, copy } = useCopied();
  const creating = pendingKey === 'form:import';

  function reset() {
    setStage('paste');
    setPasted('');
    setScriptJson('');
    setProblem(null);
    setWhy(null);
    setDraft(null);
    setTitle('');
    setDirectory(new Set());
  }

  function close() {
    if (creating) return;
    onClose();
    reset();
  }

  function adopt(next: FormDraft) {
    const suggested = suggestedDirectory(next);
    setDraft(next);
    setTitle(next.title);
    setDirectory(suggested);
    setAudience(suggested.size > 0 ? 'directory' : 'anyone');
    setProblem(null);
    setStage('preview');
  }

  async function read(text: string, from: Stage) {
    if (text.trim() === '' || reading) return;
    setReading(true);
    setProblem(null);
    try {
      const result = await readGoogleFormAction(text);
      if (result.ok) {
        adopt(result.draft);
        return;
      }
      if (from === 'paste' && (result.reason === 'signin' || result.reason === 'unreadable' || result.reason === 'unreachable')) {
        setWhy(result.message);
        setStage('script');
        return;
      }
      setProblem(result.message);
    } catch {
      setProblem('That did not go through. Check your connection and try again.');
    } finally {
      setReading(false);
    }
  }

  async function copyScript() {
    const done = await copy(APPS_SCRIPT_READER);
    if (!done) notify('error', 'That did not copy. Select the script and copy it by hand.');
  }

  async function create() {
    if (!draft) return;
    const fields = fieldsFromDraft(draft, directory);
    const result = await run(
      'form:import',
      () =>
        createImportedFormAction({
          title: title.trim() || draft.title,
          description: draft.description,
          audience,
          fields,
        }),
      { inlineError: true },
    );
    if (result.ok && result.id) {
      close();
      router.push(`/forms/${result.id}`);
    } else if (!result.ok) {
      setProblem(result.error ?? 'That did not go through. Nothing was created.');
    }
  }

  const footer =
    stage === 'paste' ? (
      <>
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" loading={reading} disabled={pasted.trim() === ''} onClick={() => void read(pasted, 'paste')}>
          Read the form
        </Button>
      </>
    ) : stage === 'script' ? (
      <>
        <Button onClick={reset} disabled={reading}>
          Start over
        </Button>
        <Button
          variant="primary"
          loading={reading}
          disabled={scriptJson.trim() === ''}
          onClick={() => void read(scriptJson, 'script')}
        >
          Read the JSON
        </Button>
      </>
    ) : (
      <>
        <Button onClick={reset} disabled={creating}>
          Start over
        </Button>
        <Button variant="primary" loading={creating} disabled={!draft} onClick={() => void create()}>
          Create form
        </Button>
      </>
    );

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Import from Google Forms"
      description={
        stage === 'paste'
          ? 'Paste the link people answer the form at. The questions come across; the answers stay in Google.'
          : stage === 'script'
            ? 'Google needs a sign-in to show this form, so read it from your own account instead.'
            : undefined
      }
      className="gf-dialog"
      footer={footer}
    >
      {stage === 'paste' ? (
        <div className="gf-paste">
          <Field label="Google Form link, or the script’s JSON" htmlFor="gf-link" error={problem}>
            <textarea
              id="gf-link"
              className="gf-input mono"
              rows={3}
              value={pasted}
              spellCheck={false}
              data-autofocus
              placeholder="https://forms.gle/…"
              onPaste={() => {
                justPasted.current = true;
              }}
              onChange={(event) => {
                setPasted(event.target.value);
                setProblem(null);
                if (justPasted.current) {
                  justPasted.current = false;
                  void read(event.target.value, 'paste');
                }
              }}
            />
          </Field>
          <p className="field-hint">
            A form that needs a school sign-in cannot be read from outside. Paste its link anyway and
            you will get a script to run instead.
          </p>
          <button type="button" className="gf-link-button" onClick={() => setStage('script')}>
            Use the script straight away
          </button>
        </div>
      ) : null}

      {stage === 'script' ? (
        <div className="gf-script">
          {why ? <p className="callout callout-warn">{why}</p> : null}
          <ol className="gf-steps">
            <li>
              <span className="gf-step-text">
                Copy the script, open Apps Script, and paste it over what is there.
              </span>
              <span className="btn-row">
                <Button
                  size="sm"
                  icon={copied ? Check : Copy}
                  iconKey={copied ? 'copied' : 'copy'}
                  onClick={() => void copyScript()}
                >
                  Copy script
                </Button>
                <a className={buttonClass({ size: 'sm' })} href={APPS_SCRIPT_NEW} target="_blank" rel="noopener noreferrer">
                  <Icon icon={ExternalLink} size={14} weight="medium" />
                  Open Apps Script
                </a>
              </span>
            </li>
            <li>
              <span className="gf-step-text">
                Put your form’s edit link where it says <code>PASTE_THE_EDIT_LINK_HERE</code>, then
                press Run and allow access. It only reads the form.
              </span>
            </li>
            <li>
              <span className="gf-step-text">Copy everything in the Execution log and paste it below.</span>
            </li>
          </ol>
          <pre className="gf-code mono" tabIndex={0} aria-label="The Apps Script that reads a form">
            {APPS_SCRIPT_READER}
          </pre>
          <Field label="What the script printed" htmlFor="gf-json" error={problem}>
            <textarea
              id="gf-json"
              className="gf-input mono"
              rows={4}
              value={scriptJson}
              spellCheck={false}
              placeholder='{"source":"edison-apps-script", …}'
              onChange={(event) => {
                setScriptJson(event.target.value);
                setProblem(null);
              }}
            />
          </Field>
        </div>
      ) : null}

      {stage === 'preview' && draft ? (
        <div className="gf-preview">
          <Field label="Title" htmlFor="gf-title">
            <input
              id="gf-title"
              type="text"
              value={title}
              maxLength={FORM_TITLE_MAX}
              onChange={(event) => setTitle(event.target.value)}
            />
          </Field>
          {draft.description ? <p className="gf-description">{draft.description}</p> : null}

          <div className="gf-audience">
            <span className="field-label">Who can answer</span>
            <SegmentedControl<FormAudience>
              label="Who can answer"
              size="sm"
              value={audience}
              onChange={setAudience}
              options={[
                { value: 'directory', label: 'People in the directory' },
                { value: 'anyone', label: 'Anyone with the link' },
              ]}
            />
          </div>

          <section aria-labelledby="gf-coming">
            <h3 className="gf-heading" id="gf-coming">
              {draft.questions.length} {draft.questions.length === 1 ? 'question' : 'questions'} come across
            </h3>
            <ol className="gf-questions">
              {draft.questions.map((entry, index) => {
                const asDirectory = entry.directory !== null && directory.has(index);
                return (
                  <li key={index} className="gf-question" data-directory={asDirectory || undefined}>
                    <Icon icon={QUESTION_ICONS[asDirectory ? 'directory' : entry.type]} size={16} className="gf-q-icon" />
                    <div className="gf-q-text">
                      <span className="gf-q-label">
                        {entry.label || 'Untitled question'}
                        {entry.required ? <span className="gf-required"> Required</span> : null}
                      </span>
                      <span className="gf-q-meta">
                        {asDirectory && entry.directory
                          ? `From the directory: ${DIRECTORY_LABELS[entry.directory]}`
                          : [
                              entry.options
                                ? `${QUESTION_TYPE_LABELS[entry.type]} of ${entry.options.length}`
                                : QUESTION_TYPE_LABELS[entry.type],
                              entry.note === null && entry.from !== QUESTION_TYPE_LABELS[entry.type]
                                ? `was ${entry.from}`
                                : null,
                            ]
                              .filter(Boolean)
                              .join(', ')}
                      </span>
                      {entry.note ? <span className="gf-q-note">{entry.note}</span> : null}
                      {entry.directory ? (
                        <label className="check gf-q-toggle">
                          <input
                            type="checkbox"
                            checked={directory.has(index)}
                            onChange={(event) => {
                              const next = new Set(directory);
                              if (event.target.checked) next.add(index);
                              else next.delete(index);
                              setDirectory(next);
                            }}
                          />
                          Fill it in from the directory
                        </label>
                      ) : null}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>

          {draft.skipped.length > 0 ? (
            <section aria-labelledby="gf-left">
              <h3 className="gf-heading" id="gf-left">
                {draft.skipped.length} {draft.skipped.length === 1 ? 'item stays' : 'items stay'} behind
              </h3>
              <ul className="gf-skipped">
                {draft.skipped.map((entry, index) => (
                  <li key={index}>
                    <span className="gf-skipped-label">{entry.label}</span>
                    <span className="gf-skipped-why">{entry.reason}</span>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}

          {problem ? (
            <p className="field-error" role="alert">
              {problem}
            </p>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}

/** The button beside "New form". */
export function ImportGoogleFormButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button icon={FileDown} onClick={() => setOpen(true)}>
        Import from Google Forms
      </Button>
      <ImportGoogleFormDialog open={open} onClose={() => setOpen(false)} />
    </>
  );
}
