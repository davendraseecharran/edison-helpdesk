'use client';

/**
 * "Opened: Now", and the one press that makes it an earlier moment.
 *
 * The common ticket is a walk-in logged while the person is standing there, so
 * the control is a quiet line that says Now and asks nothing. It becomes a
 * question only when somebody presses it: a date and a time, school-local,
 * with the bounds the database holds (not in the future, not before 2020, and
 * for a resolution, not before the ticket opened) checked while they choose.
 *
 * `value` is null for now. The popover edits a draft and writes it back on
 * "Set", so a half-typed date never leaves the form holding a moment nobody
 * chose; "Now" puts it back to null.
 *
 * The date and time are the browser's own fields, for the reason MOTION.md
 * keeps the date field native: they type, arrow, and know what a month is.
 */

import { useId, useState } from 'react';
import { ChevronDown, Clock } from 'lucide-react';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/shadcn/popover';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import {
  HISTORY_FLOOR_KEY,
  momentFromParts,
  momentLabel,
  momentParts,
  momentProblem,
  NOW_TOLERANCE_MS,
} from '@/lib/domain/ticket-moments';
import { useNow } from '@/lib/useNow';

export function MomentPicker({
  label,
  what,
  value,
  onChange,
  notBefore,
  error,
  disabled,
}: {
  /** The word beside the control: "Opened", "Resolved". */
  label: string;
  /** How an error names it: "The opened time". */
  what: string;
  value: string | null;
  onChange: (value: string | null) => void;
  /** The other end of the ticket, when this moment may not come before it. */
  notBefore?: { iso: string; what: string } | null;
  error?: string | null;
  disabled?: boolean;
}) {
  const id = useId();
  const clock = useNow();
  const [open, setOpen] = useState(false);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  // The moment the popover opened: what "the future" is measured from while
  // it is open, and what a chosen moment is labelled against before the
  // shared clock has ticked on the client.
  const [anchor, setAnchor] = useState(0);

  function openWith(next: boolean) {
    if (next) {
      const opened = Date.now();
      setAnchor(opened);
      const seed = momentParts(value ?? opened);
      setDate(seed.date);
      setTime(seed.time);
    }
    setOpen(next);
  }

  const now = Math.max(anchor, clock ?? 0);
  const draft = date && time ? momentFromParts(date, time) : null;
  const problem =
    date === '' || time === ''
      ? 'Choose a date and a time.'
      : draft === null
        ? `${what} is not a date and time.`
        : momentProblem(draft, now, what, notBefore);

  function apply() {
    if (problem || draft === null) return;
    // Within a minute of now is now: a clock, not a history.
    onChange(Math.abs(Date.now() - Date.parse(draft)) <= NOW_TOLERANCE_MS ? null : draft);
    setOpen(false);
  }

  function reset() {
    onChange(null);
    setOpen(false);
  }

  // Before hydration there is no clock to compare with, so a chosen moment is
  // spelled out in full and "Now" is still "Now".
  const shown = momentLabel(value, now);

  return (
    <div className="moment" data-set={value !== null || undefined}>
      <span className="moment-label" id={`${id}-label`}>
        {label}
      </span>
      <Popover open={open} onOpenChange={openWith}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="moment-trigger"
            aria-labelledby={`${id}-label ${id}-value`}
            data-invalid={error ? '' : undefined}
            aria-describedby={error ? `${id}-error` : undefined}
            disabled={disabled}
          >
            <Icon icon={Clock} size={14} className="moment-icon" />
            <span id={`${id}-value`} className="moment-value">
              {shown}
            </span>
            <Icon icon={ChevronDown} size={14} className="moment-chevron" />
          </button>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          collisionPadding={16}
          className="moment-panel"
          aria-label={`${label} time`}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              apply();
            }
          }}
        >
          <div className="moment-fields">
            <label className="field" htmlFor={`${id}-date`}>
              <span className="field-label">Date</span>
              <input
                id={`${id}-date`}
                type="date"
                value={date}
                min={HISTORY_FLOOR_KEY}
                max={momentParts(now).date}
                aria-invalid={problem ? 'true' : undefined}
                onChange={(event) => setDate(event.target.value)}
                data-autofocus
              />
            </label>
            <label className="field" htmlFor={`${id}-time`}>
              <span className="field-label">Time</span>
              <input
                id={`${id}-time`}
                type="time"
                value={time}
                aria-invalid={problem ? 'true' : undefined}
                onChange={(event) => setTime(event.target.value)}
              />
            </label>
          </div>
          <p className={problem ? 'moment-note field-error' : 'moment-note'} role="status">
            {problem ?? 'School time. Not in the future, not before 2020.'}
          </p>
          <div className="moment-actions">
            <Button variant="ghost" size="sm" onClick={reset}>
              Now
            </Button>
            <Button variant="primary" size="sm" onClick={apply} disabled={problem !== null}>
              Set {label.toLowerCase()} time
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      {error ? (
        <span id={`${id}-error`} className="field-error moment-error" role="alert">
          {error}
        </span>
      ) : null}
    </div>
  );
}
