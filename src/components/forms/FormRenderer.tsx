'use client';

/**
 * A form, as the person answering it sees it.
 *
 * One renderer for three places: the public page, the builder's live preview
 * and the kiosk. It is controlled — the caller holds the answers — so each of
 * those can decide what happens on submit without this knowing about it.
 *
 * DIRECTORY QUESTIONS. A question the directory answered arrives holding
 * `{keep: true}`: "use what the school has". It shows the directory's value
 * in an ordinary field; typing replaces it with the respondent's own words,
 * and "Use the directory's" puts it back. A guardian's phone is never shown
 * whole — the page only ever received its last four digits — so it is a
 * masked line with "Change", and changing it is typing a new number.
 *
 * THE ONE MOMENT. When `reveal` is set, the directory's answers write
 * themselves into their fields one after another: a wipe uncovers each value
 * from the left, ninety milliseconds apart, so the respondent watches the form
 * fill itself in with what the school already knew. That is the only motion
 * on the page, and under reduced motion the values are simply there.
 */

import { Fragment, type CSSProperties } from 'react';
import { BookUser, RotateCcw } from 'lucide-react';
import {
  fieldLabel,
  isKeep,
  type AnswerValue,
  type Answers,
  type FormField,
} from '@/lib/domain/forms';
import { Icon } from '@/components/ui/Icon';
import { Select } from '@/components/ui/Select';
import { SignaturePad } from './SignaturePad';

export interface FormRendererProps {
  fields: readonly FormField[];
  answers: Answers;
  onChange: (id: string, value: AnswerValue) => void;
  prefill: Record<string, string>;
  masked: Record<string, string>;
  errors?: Record<string, string>;
  disabled?: boolean;
  /** Play the prefill cascade on this render's directory answers. */
  reveal?: boolean;
  /** Keeps ids unique when two renderers share a page (the builder and its preview). */
  idPrefix: string;
  /** The kiosk's larger type and targets. */
  size?: 'regular' | 'large';
}

export function FormRenderer({
  fields,
  answers,
  onChange,
  prefill,
  masked,
  errors = {},
  disabled,
  reveal,
  idPrefix,
  size = 'regular',
}: FormRendererProps) {
  let revealIndex = 0;

  return (
    <div className={size === 'large' ? 'form-questions form-questions-large' : 'form-questions'}>
      {fields.map((field) => {
        const id = `${idPrefix}-${field.id}`;
        const hintId = `${id}-hint`;
        const errorId = `${id}-error`;
        const error = errors[field.id];
        const describedBy = [field.help ? hintId : null, error ? errorId : null]
          .filter(Boolean)
          .join(' ') || undefined;
        const fromDirectory =
          field.type === 'directory' && (prefill[field.id] !== undefined || masked[field.id] !== undefined);
        const order = fromDirectory ? revealIndex++ : 0;
        const label = fieldLabel(field);
        const groupLabelled = field.type === 'single_choice' || field.type === 'multi_choice' || field.type === 'yes_no';

        return (
          <div
            key={field.id}
            className={[
              'form-q',
              fromDirectory ? 'form-q-directory' : '',
              fromDirectory && reveal ? 'form-q-reveal' : '',
              error ? 'form-q-invalid' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            style={{ '--reveal-i': order } as CSSProperties}
            data-q={`${idPrefix}-${field.id}`}
            role={groupLabelled ? 'group' : undefined}
            aria-labelledby={groupLabelled ? `${id}-label` : undefined}
          >
            <div className="form-q-head">
              {groupLabelled ? (
                <span className="form-q-label" id={`${id}-label`}>
                  {label}
                  {!field.required ? <span className="field-optional">optional</span> : null}
                </span>
              ) : (
                <label className="form-q-label" htmlFor={id} id={`${id}-label`}>
                  {label}
                  {!field.required ? <span className="field-optional">optional</span> : null}
                </label>
              )}
              {fromDirectory ? (
                <span className="form-q-source">
                  <Icon icon={BookUser} size={14} />
                  From the directory
                </span>
              ) : null}
            </div>
            {field.help ? (
              <p className="form-q-help" id={hintId}>
                {field.help}
              </p>
            ) : null}
            <Control
              field={field}
              id={id}
              value={answers[field.id] ?? null}
              onChange={(value) => onChange(field.id, value)}
              prefill={prefill[field.id]}
              masked={masked[field.id]}
              disabled={disabled}
              invalid={Boolean(error)}
              describedBy={describedBy}
              label={label}
            />
            {error ? (
              <p className="field-error form-q-error" id={errorId} role="alert">
                {error}
              </p>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

interface ControlProps {
  field: FormField;
  id: string;
  value: AnswerValue;
  onChange: (value: AnswerValue) => void;
  prefill: string | undefined;
  masked: string | undefined;
  disabled?: boolean;
  invalid: boolean;
  describedBy?: string;
  label: string;
}

function textOf(value: AnswerValue): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number') return String(value);
  return '';
}

function Control(props: ControlProps) {
  const { field, id, value, onChange, disabled, invalid, describedBy, label } = props;
  const common = {
    id,
    disabled,
    'aria-invalid': invalid || undefined,
    'aria-describedby': describedBy,
  };

  switch (field.type) {
    case 'directory':
      return <DirectoryControl {...props} />;

    case 'short_text':
      return (
        <input
          {...common}
          type="text"
          value={textOf(value)}
          maxLength={500}
          onChange={(event) => onChange(event.target.value)}
        />
      );

    case 'long_text':
      return (
        <textarea
          {...common}
          value={textOf(value)}
          maxLength={5000}
          rows={4}
          onChange={(event) => onChange(event.target.value)}
        />
      );

    case 'number':
      return (
        <input
          {...common}
          type="text"
          inputMode="decimal"
          className="form-input-number"
          value={textOf(value)}
          maxLength={20}
          onChange={(event) => onChange(event.target.value)}
        />
      );

    case 'date':
      return (
        <input
          {...common}
          type="date"
          className="form-input-date"
          value={textOf(value)}
          onChange={(event) => onChange(event.target.value)}
        />
      );

    case 'yes_no':
      return (
        <div className="form-choices form-choices-row" role="radiogroup" aria-labelledby={`${id}-label`} aria-describedby={describedBy}>
          {[
            { label: 'Yes', value: true },
            { label: 'No', value: false },
          ].map((option) => (
            <label key={option.label} className="form-choice">
              <input
                type="radio"
                name={id}
                checked={value === option.value}
                disabled={disabled}
                onChange={() => onChange(option.value)}
              />
              <span>{option.label}</span>
            </label>
          ))}
        </div>
      );

    case 'single_choice':
      return (
        <div className="form-choices" role="radiogroup" aria-labelledby={`${id}-label`} aria-describedby={describedBy}>
          {(field.options ?? []).map((option) => (
            <label key={option} className="form-choice">
              <input
                type="radio"
                name={id}
                checked={value === option}
                disabled={disabled}
                onChange={() => onChange(option)}
              />
              <span>{option}</span>
            </label>
          ))}
          {!field.required && typeof value === 'string' && value !== '' ? (
            <button type="button" className="form-choice-clear" onClick={() => onChange(null)} disabled={disabled}>
              Clear the choice
            </button>
          ) : null}
        </div>
      );

    case 'multi_choice': {
      const picked = Array.isArray(value) ? value : [];
      return (
        <div className="form-choices" aria-describedby={describedBy}>
          {(field.options ?? []).map((option) => (
            <label key={option} className="form-choice">
              <input
                type="checkbox"
                checked={picked.includes(option)}
                disabled={disabled}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...picked, option]
                      : picked.filter((entry) => entry !== option),
                  )
                }
              />
              <span>{option}</span>
            </label>
          ))}
        </div>
      );
    }

    case 'dropdown':
      return (
        <Select
          id={id}
          value={typeof value === 'string' ? value : ''}
          onChange={(next) => onChange(next === '' ? null : next)}
          options={[
            { value: '', label: 'Choose' },
            ...(field.options ?? []).map((option) => ({ value: option, label: option })),
          ]}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          className="form-select"
        />
      );

    case 'signature':
      return (
        <SignaturePad
          id={id}
          value={typeof value === 'string' ? value : ''}
          onChange={(path) => onChange(path === '' ? null : path)}
          disabled={disabled}
          invalid={invalid}
          describedBy={describedBy}
          label={label}
        />
      );

    default:
      return null;
  }
}

/** The input a directory fact is typed into, for the kind of fact it is. */
function inputKind(field: FormField): { type: string; inputMode?: 'numeric' | 'email' | 'tel'; autoComplete?: string } {
  switch (field.directory) {
    case 'email':
      return { type: 'email', inputMode: 'email', autoComplete: 'email' };
    case 'external_id':
      return { type: 'text', inputMode: 'numeric', autoComplete: 'off' };
    case 'guardian_phone':
      return { type: 'tel', inputMode: 'tel', autoComplete: 'off' };
    case 'full_name':
      return { type: 'text', autoComplete: 'name' };
    default:
      return { type: 'text', autoComplete: 'off' };
  }
}

function DirectoryControl({
  field,
  id,
  value,
  onChange,
  prefill,
  masked,
  disabled,
  invalid,
  describedBy,
}: ControlProps) {
  const kind = inputKind(field);
  const keeping = isKeep(value);

  // The masked phone: the page never had the number, so there is nothing to
  // show in a field. It is a line, and "Change" swaps it for an empty one.
  if (masked !== undefined && keeping) {
    return (
      <div className="form-masked">
        <span className="form-masked-value" id={id} aria-describedby={describedBy}>
          {masked}
        </span>
        <button type="button" className="form-masked-change" onClick={() => onChange('')} disabled={disabled}>
          Change
        </button>
      </div>
    );
  }

  const shown = keeping ? (prefill ?? '') : textOf(value);
  const differs =
    prefill !== undefined && !keeping && shown.trim().toLowerCase() !== prefill.trim().toLowerCase();

  return (
    <Fragment>
      <span className="form-prefill">
        <input
          id={id}
          type={kind.type}
          inputMode={kind.inputMode}
          autoComplete={kind.autoComplete}
          value={shown}
          maxLength={300}
          disabled={disabled}
          aria-invalid={invalid || undefined}
          aria-describedby={describedBy}
          onChange={(event) => onChange(event.target.value)}
        />
      </span>
      {masked !== undefined || differs ? (
        <button
          type="button"
          className="form-restore"
          onClick={() => onChange({ keep: true })}
          disabled={disabled}
        >
          <Icon icon={RotateCcw} size={14} />
          {masked !== undefined ? `Keep the number on file (${masked})` : `Use the directory's: ${prefill}`}
        </button>
      ) : null}
    </Fragment>
  );
}

/**
 * Takes a respondent to a question that needs another look: its field when it
 * has one, otherwise the question itself (a set of choices has no single
 * field to focus).
 */
export function focusQuestion(idPrefix: string, fieldId: string): void {
  const target = `${idPrefix}-${fieldId}`;
  const field = document.getElementById(target);
  const question = document.querySelector<HTMLElement>(`[data-q="${target}"]`);
  question?.scrollIntoView({ block: 'center' });
  const focusable =
    field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement || field instanceof HTMLButtonElement
      ? field
      : question?.querySelector<HTMLElement>('input, textarea, button');
  focusable?.focus({ preventScroll: true });
}
