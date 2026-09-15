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
 * Each chip is rendered where its answer goes. The guesses used to sit in one
 * row under the issue box — the field they were read FROM rather than the
 * fields they are ABOUT — so accepting "Hardware" meant reading a chip at the
 * bottom of the section and trusting that it had changed a select four rows
 * above it, out of sight. A suggestion belongs against the control it changes,
 * so the provider holds the state and `SuggestedCategory` and
 * `SuggestedPriority` render under their own selects.
 *
 * Tab accepts. A NetRider recording a walk-in is typing, not reaching for a
 * pointer, and the key that already means "done with this field, moving on" is
 * the one that should also mean "yes, that". Tab out of the issue box — the
 * last free-text field, and the one whose text the guess was read from — takes
 * every suggestion on offer. The default is never prevented: Tab still moves to
 * the next control, it just leaves the answers behind. `SuggestionTabHint` says
 * so under that box, because a gesture nobody is told about is a gesture nobody
 * uses. The chips are real buttons as well, and they are in the tab order,
 * which is the only way "No" is reachable without a pointer. A control that can
 * only be refused with a mouse is not a control everybody has.
 *
 * The rules are in `src/lib/intake/suggest.ts` and are keyword tables rather
 * than a model, because this has to answer on every keystroke with no network
 * and no account — which is precisely the state of the desk when the helpdesk
 * is busiest.
 */

import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
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

/** One offer: what it would set, and the word it was read from. */
interface Offer {
  label: string;
  because: string;
  accept: () => void;
  dismiss: () => void;
}

interface SuggestionsValue {
  category: Offer | null;
  priority: Offer | null;
}

const SuggestionsContext = createContext<SuggestionsValue>({ category: null, priority: null });

export interface IntakeSuggestionsProps {
  title: string;
  issue: string;
  /** The field Tab accepts from: the issue box. */
  fieldId: string;
  category: TicketCategory;
  priority: Priority;
  onCategory: (value: TicketCategory) => void;
  onPriority: (value: Priority) => void;
  children: ReactNode;
}

export function IntakeSuggestions({
  title,
  issue,
  fieldId,
  category,
  priority,
  onCategory,
  onPriority,
  children,
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

  const value = useMemo<SuggestionsValue>(
    () => ({
      category:
        showCategory && categoryGuess
          ? {
              label: TICKET_CATEGORY_LABELS[categoryGuess.value],
              because: categoryGuess.because,
              accept: () => onCategory(categoryGuess.value),
              dismiss: () =>
                setDismissed((current) =>
                  new Set(current).add(`category:${categoryGuess.value}`),
                ),
            }
          : null,
      priority:
        showPriority && priorityGuess
          ? {
              label: PRIORITY_LABELS[priorityGuess.value],
              because: priorityGuess.because,
              accept: () => onPriority(priorityGuess.value),
              dismiss: () =>
                setDismissed((current) =>
                  new Set(current).add(`priority:${priorityGuess.value}`),
                ),
            }
          : null,
    }),
    [showCategory, showPriority, categoryGuess, priorityGuess, onCategory, onPriority],
  );

  // Written in an effect rather than during render: a ref is not rendering
  // state, and no key can be pressed between a commit and its effects.
  const acceptAll = useRef(() => {});
  useEffect(() => {
    acceptAll.current = () => {
      value.category?.accept();
      value.priority?.accept();
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

  return <SuggestionsContext.Provider value={value}>{children}</SuggestionsContext.Provider>;
}

/** The guess for the category, under the select it would change. */
export function SuggestedCategory() {
  const { category } = useContext(SuggestionsContext);
  return <Offered offer={category} />;
}

/** The guess for the priority, under the select it would change. */
export function SuggestedPriority() {
  const { priority } = useContext(SuggestionsContext);
  return <Offered offer={priority} />;
}

/**
 * The line under the issue box that names the key.
 *
 * Shown only while something is on offer, because a hint about a gesture with
 * nothing to accept is noise on every ticket that needed no guess at all.
 */
export function SuggestionTabHint() {
  const { category, priority } = useContext(SuggestionsContext);
  if (!category && !priority) return null;
  return (
    <span className="field-hint suggestions-hint">
      <kbd className="kbd">tab</kbd> accepts the suggestion
      {category && priority ? 's' : ''}.
    </span>
  );
}

function Offered({ offer }: { offer: Offer | null }) {
  if (!offer) return null;
  return (
    <div className="suggestions" role="group" aria-label="Suggested from what you typed">
      <span className="suggestions-label">Suggested</span>
      <span className="suggestion-chip">
        <button type="button" className="suggestion-chip-accept" onClick={offer.accept}>
          <Icon icon={Check} size={12} />
          {offer.label}
          <span className="suggestion-chip-why">from “{offer.because}”</span>
        </button>
        <button
          type="button"
          className="suggestion-chip-no"
          aria-label={`Do not suggest ${offer.label}`}
          onClick={offer.dismiss}
        >
          No
        </button>
      </span>
    </div>
  );
}
