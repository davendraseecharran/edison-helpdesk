'use client';

/**
 * One question in the builder.
 *
 * At rest it is a line: the mark for its kind, its label, and whether it is
 * required or answered from the directory. Selected, it opens where it is into
 * everything a question is made of. Only one is open at a time, which is what
 * keeps a thirty-question form a list somebody can read rather than a wall of
 * inputs.
 *
 * Moving is two ways, because dragging is not solid on every phone: the handle
 * drags (the list is motion's `Reorder`), and the up and down buttons in the
 * open question do the same thing with a tap or the keyboard.
 */

import type { PointerEvent as ReactPointerEvent } from 'react';
import { Reorder, useDragControls } from 'motion/react';
import { ArrowDown, ArrowUp, Copy, GripVertical, Plus, Trash2, X } from 'lucide-react';
import {
  DIRECTORY_LABELS,
  FORM_HELP_MAX,
  FORM_LABEL_MAX,
  FORM_OPTION_LIMIT,
  FORM_OPTION_MAX,
  QUESTION_TYPES,
  QUESTION_TYPE_LABELS,
  fieldLabel,
  isChoiceType,
  type FormField,
  type QuestionType,
} from '@/lib/domain/forms';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Select } from '@/components/ui/Select';
import { Switch } from '@/components/ui/shadcn/switch';
import { QUESTION_ICONS } from './questionIcons';

export interface QuestionEditorProps {
  field: FormField;
  index: number;
  count: number;
  open: boolean;
  onOpen: () => void;
  onChange: (next: FormField) => void;
  onMove: (to: number) => void;
  onDuplicate: () => void;
  onDelete: () => void;
}

export function QuestionEditor({
  field,
  index,
  count,
  open,
  onOpen,
  onChange,
  onMove,
  onDuplicate,
  onDelete,
}: QuestionEditorProps) {
  const controls = useDragControls();
  const id = `q-${field.id}`;
  const directory = field.type === 'directory';
  const options = field.options ?? [];
  const emptyChoices = isChoiceType(field.type) && options.filter((option) => option.trim() !== '').length === 0;

  function startDrag(event: ReactPointerEvent) {
    // The handle is the only thing that drags, so scrolling a long form on a
    // phone never picks a question up by accident.
    event.preventDefault();
    controls.start(event);
  }

  function setType(type: QuestionType) {
    const next: FormField = { ...field, type };
    if (isChoiceType(type)) {
      next.options = field.options && field.options.length > 0 ? field.options : ['Option 1', 'Option 2'];
    } else {
      delete next.options;
    }
    onChange(next);
  }

  function setOption(at: number, value: string) {
    const next = [...options];
    next[at] = value;
    onChange({ ...field, options: next });
  }

  function addOption() {
    if (options.length >= FORM_OPTION_LIMIT) return;
    onChange({ ...field, options: [...options, `Option ${options.length + 1}`] });
    // Focus lands on the new choice once it is rendered.
    requestAnimationFrame(() => {
      const inputs = document.querySelectorAll<HTMLInputElement>(`#${id}-options input`);
      const last = inputs[inputs.length - 1];
      last?.focus();
      last?.select();
    });
  }

  function removeOption(at: number) {
    onChange({ ...field, options: options.filter((_, position) => position !== at) });
  }

  return (
    <Reorder.Item
      as="li"
      value={field}
      dragListener={false}
      dragControls={controls}
      className={open ? 'fq fq-open' : 'fq'}
      data-directory={directory ? '' : undefined}
    >
      <div className="fq-row">
        <button
          type="button"
          className="fq-handle"
          aria-label={`Drag to move ${fieldLabel(field)}`}
          onPointerDown={startDrag}
          tabIndex={-1}
        >
          <Icon icon={GripVertical} size={16} />
        </button>
        <button
          type="button"
          className="fq-summary"
          aria-expanded={open}
          aria-controls={`${id}-body`}
          onClick={onOpen}
        >
          <span className="fq-kind" aria-hidden="true">
            <Icon icon={QUESTION_ICONS[field.type]} size={16} />
          </span>
          <span className={field.label.trim() === '' && !directory ? 'fq-title fq-title-empty' : 'fq-title'}>
            {fieldLabel(field)}
          </span>
          <span className="fq-tags">
            {directory ? <span className="fq-tag">Directory</span> : null}
            {field.required ? <span className="fq-tag">Required</span> : null}
            {emptyChoices ? <span className="fq-tag fq-tag-warn">No choices</span> : null}
          </span>
        </button>
      </div>

      {open ? (
        <div className="fq-body" id={`${id}-body`}>
          <div className="fq-main">
            <div className="field fq-label-field">
              <label className="visually-hidden" htmlFor={`${id}-label`}>
                Question
              </label>
              <input
                type="text"
                id={`${id}-label`}
                className="fq-label-input"
                value={field.label}
                maxLength={FORM_LABEL_MAX}
                placeholder={directory && field.directory ? DIRECTORY_LABELS[field.directory] : 'Question'}
                autoComplete="off"
                onChange={(event) => onChange({ ...field, label: event.target.value })}
              />
            </div>
            {!directory ? (
              <div className="fq-type">
                <label className="visually-hidden" htmlFor={`${id}-type`}>
                  Kind of question
                </label>
                <Select
                  id={`${id}-type`}
                  value={field.type}
                  onChange={(value) => setType(value as QuestionType)}
                  options={QUESTION_TYPES.map((type) => ({ value: type, label: QUESTION_TYPE_LABELS[type] }))}
                />
              </div>
            ) : null}
          </div>

          <div className="field">
            <label className="visually-hidden" htmlFor={`${id}-help`}>
              Help text
            </label>
            <input
              type="text"
              id={`${id}-help`}
              className="fq-help-input"
              value={field.help}
              maxLength={FORM_HELP_MAX}
              placeholder="Help text, if the question needs it"
              autoComplete="off"
              onChange={(event) => onChange({ ...field, help: event.target.value })}
            />
          </div>

          {directory && field.directory ? (
            <p className="fq-directory-note">
              Filled in from the directory: {DIRECTORY_LABELS[field.directory].toLowerCase()}.
              {field.directory === 'guardian_phone'
                ? ' People see only its last four digits and can type a new number.'
                : ' People see it filled in and can change it.'}
            </p>
          ) : null}

          {isChoiceType(field.type) ? (
            <div className="fq-options" id={`${id}-options`}>
              <ul className="fq-option-list">
                {options.map((option, at) => (
                  <li key={at} className="fq-option">
                    <span className={`fq-option-mark fq-option-mark-${field.type}`} aria-hidden="true" />
                    <label className="visually-hidden" htmlFor={`${id}-option-${at}`}>
                      Choice {at + 1}
                    </label>
                    <input
                      type="text"
                      id={`${id}-option-${at}`}
                      value={option}
                      maxLength={FORM_OPTION_MAX}
                      autoComplete="off"
                      onChange={(event) => setOption(at, event.target.value)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          addOption();
                        }
                      }}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      icon={X}
                      aria-label={`Remove choice ${at + 1}`}
                      onClick={() => removeOption(at)}
                      disabled={options.length <= 1}
                    />
                  </li>
                ))}
              </ul>
              {emptyChoices ? <p className="field-error">Add at least one choice.</p> : null}
              <Button
                size="sm"
                variant="ghost"
                icon={Plus}
                onClick={addOption}
                disabled={options.length >= FORM_OPTION_LIMIT}
              >
                Add a choice
              </Button>
            </div>
          ) : null}

          <div className="fq-foot">
            <label className="fq-required">
              <Switch
                checked={field.required}
                onCheckedChange={(checked) => onChange({ ...field, required: checked })}
                aria-label="Required"
              />
              <span>Required</span>
            </label>
            <div className="fq-foot-actions">
              <Button
                size="sm"
                variant="ghost"
                icon={ArrowUp}
                aria-label="Move up"
                onClick={() => onMove(index - 1)}
                disabled={index === 0}
              />
              <Button
                size="sm"
                variant="ghost"
                icon={ArrowDown}
                aria-label="Move down"
                onClick={() => onMove(index + 1)}
                disabled={index === count - 1}
              />
              {!directory ? (
                <Button size="sm" variant="ghost" icon={Copy} aria-label="Duplicate" onClick={onDuplicate} />
              ) : null}
              <Button size="sm" variant="ghost" icon={Trash2} aria-label="Delete question" onClick={onDelete} />
            </div>
          </div>
        </div>
      ) : null}
    </Reorder.Item>
  );
}
