'use client';

/**
 * What the form already knows, offered back.
 *
 * The sentence somebody just typed answers two of the fields below it: "the
 * projector in 118 shows no signal" names the category, "regents testing today"
 * names the priority. Asking them to say it again in a select is asking twice,
 * and at a desk with a queue behind it that is the difference between recording
 * a walk-in in fifteen seconds and in forty.
 *
 * Offered, never filled in. A form that quietly changed a category under
 * somebody's hands would be worse than one that asked, because a wrong category
 * is invisible until a month of reporting is wrong. So the guess is a chip that
 * says what it read and which word it read it from, and accepting is a press.
 *
 * Tab accepts. A NetRider recording a walk-in is typing, not reaching for a
 * pointer, and the key that already means "done with this field, moving on" is
 * the one that should also mean "yes, that". Tab out of the issue box — the last
 * free-text field, and the one whose text the guess was read from — takes every
 * suggestion on offer. The default is never prevented: Tab still moves to the
 * next control, it just leaves the answers behind. The chips are real buttons
 * as well, and out of the tab order, because they are a shortcut past the
 * fields rather than a stop inside them.
 *
 * The rules are in `src/lib/intake/suggest.ts` and are keyword tables rather
 * than a model, because this has to answer on every keystroke with no network
 * and no account — which is precisely the state of the desk when the helpdesk
 * is busiest.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check } from 'lucide-react';
import { Icon } from '@/components/ui/Icon';
import {
  suggestCategory,
  suggestPriority,
  worthSuggesting,
} from '@/lib/intake/suggest';
import {
  PRIORITY_LABELS,
  TICKET_CATEGORY_LABELS,
  type Priority,
  type TicketCategory,
} from '@/lib/domain/types';
import '@/styles/lists.css';

export interface IntakeSuggestionsProps {
  title: string;
  issue: string;
  /** The field Tab accepts from: the issue box. */
  fieldId: string;
  category: TicketCategory;
  priority: Priority;
  onCategory: (value: TicketCategory) => void;
  onPriority: (value: Priority) => void;
}

export function IntakeSuggestions({
  title,
  issue,
  fieldId,
  category,
  priority,
  onCategory,
  onPriority,
}: IntakeSuggestionsProps) {
  /** Suggestions this person has already turned down. Offered once, not on every keystroke. */
  const [dismissed, setDismissed] = useState<ReadonlySet<string>>(() => new Set<string>());

  const enough = worthSuggesting(title, issue);
  const categoryGuess = useMemo(
    () => (enough ? suggestCategory(title, issue) : null),
    [enough, title, issue],
  );
  const priorityGuess = useMemo(
    () => (enough ? suggestPriority(title, issue) : null),
    [enough, title, issue],
  );

  // Only a guess that would actually change something is worth a chip.
  const showCategory =
    categoryGuess !== null &&
    categoryGuess.value !== category &&
    category === 'other' &&
    !dismissed.has(`category:${categoryGuess.value}`);
  const showPriority =
    priorityGuess !== null &&
    priorityGuess.value !== priority &&
    priority === 'normal' &&
    !dismissed.has(`priority:${priorityGuess.value}`);

  // Written in an effect rather than during render: a ref is not rendering
  // state, and no key can be pressed between a commit and its effects.
  const acceptAll = useRef(() => {});
  useEffect(() => {
    acceptAll.current = () => {
      if (showCategory && categoryGuess) onCategory(categoryGuess.value);
      if (showPriority && priorityGuess) onPriority(priorityGuess.value);
    };
  });

  useEffect(() => {
    const field = document.getElementById(fieldId);
    if (!field) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Tab' || event.shiftKey || event.metaKey || event.ctrlKey) return;
      acceptAll.current();
    }
    field.addEventListener('keydown', onKeyDown);
    return () => field.removeEventListener('keydown', onKeyDown);
  }, [fieldId]);

  if (!showCategory && !showPriority) return null;

  return (
    <div className="suggestions" role="group" aria-label="Suggested from what you typed">
      <span className="suggestions-label">Suggested</span>
      {showCategory && categoryGuess ? (
        <Chip
          label={TICKET_CATEGORY_LABELS[categoryGuess.value]}
          because={categoryGuess.because}
          onAccept={() => onCategory(categoryGuess.value)}
          onDismiss={() =>
            setDismissed((current) => new Set(current).add(`category:${categoryGuess.value}`))
          }
        />
      ) : null}
      {showPriority && priorityGuess ? (
        <Chip
          label={`${PRIORITY_LABELS[priorityGuess.value]} priority`}
          because={priorityGuess.because}
          onAccept={() => onPriority(priorityGuess.value)}
          onDismiss={() =>
            setDismissed((current) => new Set(current).add(`priority:${priorityGuess.value}`))
          }
        />
      ) : null}
      <kbd className="kbd">tab</kbd>
    </div>
  );
}

function Chip({
  label,
  because,
  onAccept,
  onDismiss,
}: {
  label: string;
  because: string;
  onAccept: () => void;
  onDismiss: () => void;
}) {
  return (
    <span className="suggestion-chip">
      <button type="button" className="suggestion-chip-accept" tabIndex={-1} onClick={onAccept}>
        <Icon icon={Check} size={12} />
        {label}
        <span className="suggestion-chip-why">from “{because}”</span>
      </button>
      <button
        type="button"
        className="suggestion-chip-no"
        tabIndex={-1}
        aria-label={`Do not suggest ${label}`}
        onClick={onDismiss}
      >
        No
      </button>
    </span>
  );
}
