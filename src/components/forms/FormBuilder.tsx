'use client';

/**
 * The builder: the questions on the left, the form as a respondent will see
 * it on the right.
 *
 * It saves itself. Every change is sent seven tenths of a second after the
 * typing stops, one save at a time, and the line at the top says which of
 * three things is true — saved, saving, or not saved and why. There is no
 * Save button to forget, and leaving with a change still in flight asks first.
 *
 * The preview is the real renderer, fed an invented person, so what an officer
 * sees beside the builder is what a student will see on their phone: the same
 * fields, the directory answers written in, the guardian's number masked. On a
 * phone the two halves are one control apart rather than side by side.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MotionConfig, Reorder } from 'motion/react';
import { Check, CircleAlert, LoaderCircle, Plus } from 'lucide-react';
import { saveFormAction } from '@/lib/data/form-actions';
import {
  DIRECTORY_KEYS,
  DIRECTORY_LABELS,
  FORM_DESCRIPTION_MAX,
  FORM_FIELD_LIMIT,
  FORM_TITLE_MAX,
  QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
  blankField,
  initialAnswers,
  moveField,
  newFieldId,
  samplePrefill,
  usedDirectoryKeys,
  type AnswerValue,
  type Answers,
  type DirectoryKey,
  type FieldType,
  type FormAudience,
  type FormField,
} from '@/lib/domain/forms';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/shadcn/dropdown-menu';
import { FormRenderer } from './FormRenderer';
import { QuestionEditor } from './QuestionEditor';
import { QUESTION_ICONS } from './questionIcons';
import '@/styles/forms.css';

interface Draft {
  title: string;
  description: string;
  fields: FormField[];
}

const SAVE_DELAY_MS = 700;

export function FormBuilder({
  formId,
  initialTitle,
  initialDescription,
  initialFields,
  audience,
  responseCount,
}: {
  formId: string;
  initialTitle: string;
  initialDescription: string;
  initialFields: FormField[];
  audience: FormAudience;
  responseCount: number;
}) {
  const router = useRouter();
  const [draft, setDraft] = useState<Draft>({
    title: initialTitle,
    description: initialDescription,
    fields: initialFields,
  });
  const [savedSnapshot, setSavedSnapshot] = useState(() =>
    JSON.stringify({ title: initialTitle, description: initialDescription, fields: initialFields }),
  );
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(initialFields[0]?.id ?? null);
  const [pane, setPane] = useState<'edit' | 'preview'>('edit');

  const snapshot = useMemo(() => JSON.stringify(draft), [draft]);
  const dirty = snapshot !== savedSnapshot;
  const titleMissing = draft.title.trim() === '';

  // The latest draft, for a save that starts after the render that scheduled it.
  const latest = useRef(draft);
  const savedTitle = useRef(initialTitle);
  const inFlight = useRef(false);
  const again = useRef(false);
  useEffect(() => {
    latest.current = draft;
  });

  // The save itself lives in a ref, rewritten after every render so it reads
  // the latest props; it calls itself again when a change arrived mid-save.
  const flushRef = useRef<() => Promise<void>>(async () => undefined);

  async function flush() {
    if (inFlight.current) {
      again.current = true;
      return;
    }
    const current = latest.current;
    if (current.title.trim() === '') return;
    inFlight.current = true;
    setSaving(true);
    const sent = JSON.stringify(current);
    try {
      const result = await saveFormAction(formId, current.title, current.description, current.fields);
      if (result.ok) {
        setSavedSnapshot(sent);
        setSaveError(null);
        // The header above is the server's; it learns a new title by refreshing.
        if (current.title.trim() !== savedTitle.current) {
          savedTitle.current = current.title.trim();
          router.refresh();
        }
      } else {
        setSaveError(result.error ?? 'That did not save. Your changes are still here.');
      }
    } catch {
      setSaveError('That did not save. Check your connection; your changes are still here.');
    } finally {
      inFlight.current = false;
      setSaving(false);
      if (again.current) {
        again.current = false;
        void flushRef.current();
      }
    }
  }

  useEffect(() => {
    flushRef.current = flush;
  });

  useEffect(() => {
    if (!dirty || titleMissing) return;
    const timer = window.setTimeout(() => void flushRef.current(), SAVE_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [snapshot, dirty, titleMissing]);

  // Leaving with a change that has not landed asks first.
  useEffect(() => {
    if (!dirty && !saving) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty, saving]);

  function setFields(next: FormField[]) {
    setDraft((current) => ({ ...current, fields: next }));
  }

  function updateField(next: FormField) {
    setDraft((current) => ({
      ...current,
      fields: current.fields.map((field) => (field.id === next.id ? next : field)),
    }));
  }

  function insert(field: FormField) {
    setDraft((current) => {
      const at = openId ? current.fields.findIndex((entry) => entry.id === openId) : -1;
      const fields = [...current.fields];
      fields.splice(at === -1 ? fields.length : at + 1, 0, field);
      return { ...current, fields };
    });
    setOpenId(field.id);
    requestAnimationFrame(() => document.getElementById(`q-${field.id}-label`)?.focus());
  }

  function add(type: FieldType, directory?: DirectoryKey) {
    if (draft.fields.length >= FORM_FIELD_LIMIT) return;
    insert(blankField(type, draft.fields.map((field) => field.id), directory));
  }

  function duplicate(field: FormField) {
    if (draft.fields.length >= FORM_FIELD_LIMIT) return;
    const copy: FormField = {
      ...field,
      id: newFieldId(draft.fields.map((entry) => entry.id)),
      label: field.label ? `${field.label} (copy)`.slice(0, 200) : '',
      options: field.options ? [...field.options] : undefined,
    };
    if (!copy.options) delete copy.options;
    insert(copy);
  }

  function remove(field: FormField) {
    setDraft((current) => ({ ...current, fields: current.fields.filter((entry) => entry.id !== field.id) }));
    setOpenId((current) => (current === field.id ? null : current));
  }

  function move(from: number, to: number) {
    setFields(moveField(draft.fields, from, to));
    requestAnimationFrame(() => {
      const moved = draft.fields[from];
      if (moved) document.querySelector<HTMLButtonElement>(`#q-${moved.id}-body`)?.scrollIntoView({ block: 'nearest' });
    });
  }

  const used = usedDirectoryKeys(draft.fields);
  const atLimit = draft.fields.length >= FORM_FIELD_LIMIT;

  const status = titleMissing
    ? { tone: 'warn', icon: CircleAlert, text: 'Give the form a title to save it.' }
    : saveError
      ? { tone: 'warn', icon: CircleAlert, text: saveError }
      : saving
        ? { tone: 'quiet', icon: LoaderCircle, text: 'Saving' }
        : dirty
          ? { tone: 'quiet', icon: LoaderCircle, text: 'Saving' }
          : { tone: 'quiet', icon: Check, text: 'Saved' };

  return (
    <div className="fb" data-pane={pane}>
      <div className="fb-bar">
        <p className={`fb-status fb-status-${status.tone}`} role="status" aria-live="polite">
          <Icon
            icon={status.icon}
            size={14}
            className={status.icon === LoaderCircle ? 'icon-spin' : undefined}
          />
          <span>{status.text}</span>
          {saveError && !titleMissing ? (
            <button type="button" className="fb-retry" onClick={() => void flushRef.current()}>
              Try again
            </button>
          ) : null}
        </p>
        <div className="fb-pane-switch">
          <SegmentedControl<'edit' | 'preview'>
            label="Builder or preview"
            size="sm"
            value={pane}
            onChange={setPane}
            options={[
              { value: 'edit', label: 'Edit' },
              { value: 'preview', label: 'Preview' },
            ]}
          />
        </div>
      </div>

      {responseCount > 0 ? (
        <p className="callout fb-live-note">
          This form has {responseCount} {responseCount === 1 ? 'response' : 'responses'}. Changes apply
          to new answers; a question you delete disappears from the responses table.
        </p>
      ) : null}

      <div className="fb-columns">
        <div className="fb-edit">
          <section className="fb-card fb-intro" aria-label="Title and description">
            <label className="visually-hidden" htmlFor="fb-title">
              Title
            </label>
            <textarea
              id="fb-title"
              className="fb-title-input"
              value={draft.title}
              maxLength={FORM_TITLE_MAX}
              rows={1}
              placeholder="Form title"
              autoComplete="off"
              aria-invalid={titleMissing || undefined}
              // A title is one line that may wrap; Enter moves on rather than
              // breaking it.
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  document.getElementById('fb-description')?.focus();
                }
              }}
              onChange={(event) =>
                setDraft((current) => ({ ...current, title: event.target.value.replace(/\s*\n\s*/g, ' ') }))
              }
            />
            <label className="visually-hidden" htmlFor="fb-description">
              Description
            </label>
            <textarea
              id="fb-description"
              className="fb-description-input"
              value={draft.description}
              maxLength={FORM_DESCRIPTION_MAX}
              rows={2}
              placeholder="What is this form for? Dates, what to bring, who to ask."
              onChange={(event) => setDraft((current) => ({ ...current, description: event.target.value }))}
            />
          </section>

          {draft.fields.length === 0 ? (
            <div className="fb-empty">
              <p className="empty-title">No questions yet</p>
              <p className="empty-body">
                Start with the directory: a name, an OSIS and a guardian are filled in for everybody
                who answers.
              </p>
            </div>
          ) : (
            // Reduced motion: the cards swap places rather than sliding.
            <MotionConfig reducedMotion="user">
              <Reorder.Group as="ol" axis="y" values={draft.fields} onReorder={setFields} className="fq-list">
                {draft.fields.map((field, index) => (
                  <QuestionEditor
                    key={field.id}
                    field={field}
                    index={index}
                    count={draft.fields.length}
                    open={openId === field.id}
                    onOpen={() => setOpenId((current) => (current === field.id ? null : field.id))}
                    onChange={updateField}
                    onMove={(to) => move(index, to)}
                    onDuplicate={() => duplicate(field)}
                    onDelete={() => remove(field)}
                  />
                ))}
              </Reorder.Group>
            </MotionConfig>
          )}

          <div className="fb-add">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button icon={Plus} disabled={atLimit}>
                  Add a question
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="fb-add-menu" aria-label="Kinds of question">
                <DropdownMenuLabel>From the directory</DropdownMenuLabel>
                {DIRECTORY_KEYS.map((key) => (
                  <DropdownMenuItem key={key} disabled={used.has(key)} onSelect={() => add('directory', key)}>
                    <Icon icon={QUESTION_ICONS.directory} size={16} />
                    <span>{DIRECTORY_LABELS[key]}</span>
                  </DropdownMenuItem>
                ))}
                <DropdownMenuSeparator />
                <DropdownMenuLabel>Questions</DropdownMenuLabel>
                {QUESTION_TYPES.map((type) => (
                  <DropdownMenuItem key={type} onSelect={() => add(type)}>
                    <Icon icon={QUESTION_ICONS[type]} size={16} />
                    <span>{QUESTION_TYPE_LABELS[type]}</span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
            {atLimit ? <span className="fb-add-note">A form has {FORM_FIELD_LIMIT} questions at most.</span> : null}
          </div>
        </div>

        <aside className="fb-preview" aria-label="Preview">
          <Preview title={draft.title} description={draft.description} fields={draft.fields} audience={audience} />
        </aside>
      </div>
    </div>
  );
}

/**
 * The form as a respondent sees it, answered by an invented student. Typing
 * into it does what it would do for them and saves nothing.
 */
function Preview({
  title,
  description,
  fields,
  audience,
}: {
  title: string;
  description: string;
  fields: FormField[];
  audience: FormAudience;
}) {
  const sample = useMemo(() => samplePrefill(fields), [fields]);
  const [answers, setAnswers] = useState<Answers>({});
  const shown = useMemo(
    () => ({ ...initialAnswers(fields, sample.prefill, sample.masked), ...answers }),
    [answers, fields, sample],
  );

  function change(id: string, value: AnswerValue) {
    setAnswers((current) => ({ ...current, [id]: value }));
  }

  return (
    <div className="fb-device">
      <p className="fb-device-caption">
        {audience === 'directory' ? 'As Jordan Rivera, a sample student, sees it' : 'As anybody with the link sees it'}
      </p>
      <div className="fb-device-screen pf pf-embedded">
        <div className="pf-column">
          <header className="pf-head">
            <h2 className="pf-title">{title.trim() || 'Form title'}</h2>
            {description ? <p className="pf-description">{description}</p> : null}
          </header>
          {audience === 'directory' ? (
            <div className="pf-greeting">
              <p className="pf-greeting-line">Hi, Jordan.</p>
              <p className="pf-greeting-note">
                We filled in what the school has on file. Change anything that is out of date.
              </p>
            </div>
          ) : null}
          <div className="pf-card">
            {fields.length === 0 ? (
              <p className="pf-card-note">Questions appear here as you add them.</p>
            ) : (
              <FormRenderer
                fields={fields}
                answers={shown}
                onChange={change}
                prefill={sample.prefill}
                masked={sample.masked}
                idPrefix="preview"
              />
            )}
          </div>
          <div className="pf-actions">
            <Button variant="primary" size="lg" className="pf-primary" disabled>
              Send answers
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
