'use client';

/**
 * A type-ahead over a server action: one input, a debounced search, and an
 * inline listbox the keyboard can walk.
 *
 * The list is laid out in the flow rather than floating over the page, as
 * the intake picker is: a floating list has to be positioned, dismissed and
 * kept from falling off the bottom of a phone; an inline one pushes the form
 * down, which somebody on a 390px screen can follow. The combobox contract
 * is the standard one: the input owns focus, Arrow keys move the active
 * option, Enter chooses it, Escape clears the list, and the active option is
 * announced through `aria-activedescendant`.
 *
 * Only the newest search may write to state: a slow early request must not
 * overwrite the results of the one the operator is actually waiting for.
 */

import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Field } from '@/components/Primitives';

/** Long enough that somebody has stopped typing, short enough to feel live. */
export const PICKER_DEBOUNCE_MS = 150;
/** Below this the search would return half the school. */
export const PICKER_MIN_CHARS = 2;

export interface PickerGroup<T> {
  key: string;
  label: string;
  items: T[];
}

export interface SearchPickerProps<T> {
  id: string;
  label: string;
  hint?: ReactNode;
  placeholder?: string;
  /** Usually a server action. Called with the trimmed term. */
  search: (term: string) => Promise<T[]>;
  keyOf: (item: T) => string;
  /** The option's content: a name line and a meta line, by convention. */
  renderOption: (item: T) => ReactNode;
  /** Split results under headings. Empty groups should be left out. */
  groups?: (items: T[]) => PickerGroup<T>[];
  onSelect: (item: T) => void;
  /** Keys that can be seen but not chosen, with the reason shown after them. */
  disabledKeys?: string[];
  disabledNote?: string;
  /** Take focus when the surface opens (the focus trap looks for it). */
  autoFocus?: boolean;
  disabled?: boolean;
  error?: string | null;
  /** Identifier searches (asset tags, serials) read better in mono. */
  mono?: boolean;
  emptyText?: (term: string) => string;
}

export function SearchPicker<T>({
  id,
  label,
  hint,
  placeholder,
  search,
  keyOf,
  renderOption,
  groups,
  onSelect,
  disabledKeys = [],
  disabledNote = 'already chosen',
  autoFocus,
  disabled,
  error,
  mono,
  emptyText = (term) => `Nothing matches "${term}".`,
}: SearchPickerProps<T>) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<T[]>([]);
  /** The term `results` belongs to. Anything else on screen is stale. */
  const [searched, setSearched] = useState('');
  const [active, setActive] = useState(0);
  const searchId = useRef(0);
  // The latest search function, so a parent passing a fresh closure on every
  // render does not restart the debounce on every keystroke.
  const searchRef = useRef(search);
  useEffect(() => {
    searchRef.current = search;
  }, [search]);
  const listId = useId();

  const term = query.trim();

  useEffect(() => {
    if (term.length < PICKER_MIN_CHARS) return;
    const current = searchId.current + 1;
    searchId.current = current;
    const timer = setTimeout(() => {
      searchRef.current(term).then(
        (found) => {
          if (searchId.current !== current) return;
          setResults(found);
          setSearched(term);
          setActive(0);
        },
        () => {
          if (searchId.current !== current) return;
          setResults([]);
          setSearched(term);
        },
      );
    }, PICKER_DEBOUNCE_MS);
    return () => clearTimeout(timer);
  }, [term]);

  // Derived rather than stored, so nothing has to be cleared: a term the
  // results do not belong to shows nothing, which is what "still typing" means.
  const shown = searched === term && term.length >= PICKER_MIN_CHARS ? results : [];
  const grouped: PickerGroup<T>[] = groups
    ? groups(shown)
    : [{ key: 'all', label: '', items: shown }];
  // Each group's first position in the flat, keyboard-walked list.
  const starts = grouped.reduce<number[]>((acc, _group, index) => {
    acc.push(index === 0 ? 0 : acc[index - 1] + grouped[index - 1].items.length);
    return acc;
  }, []);
  const flat = grouped.flatMap((group) => group.items);
  const disabledSet = new Set(disabledKeys);
  const activeItem = flat[active];
  const activeId = activeItem ? `${id}-option-${keyOf(activeItem)}` : undefined;

  function choose(item: T) {
    if (disabledSet.has(keyOf(item))) return;
    onSelect(item);
    setQuery('');
    setResults([]);
    setSearched('');
    setActive(0);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (flat.length === 0) return;
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setActive((at) => (at + 1) % flat.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setActive((at) => (at - 1 + flat.length) % flat.length);
        break;
      case 'Home':
        event.preventDefault();
        setActive(0);
        break;
      case 'End':
        event.preventDefault();
        setActive(flat.length - 1);
        break;
      case 'Enter':
        event.preventDefault();
        if (activeItem) choose(activeItem);
        break;
      case 'Escape':
        // With a list open, Escape closes the list and nothing else: the
        // dialog around it listens on the document and must not also close.
        event.preventDefault();
        event.nativeEvent.stopImmediatePropagation();
        setResults([]);
        setSearched('');
        break;
      default:
        break;
    }
  }

  const options = (items: T[], offset: number) =>
    items.map((item, index) => {
      const key = keyOf(item);
      const position = offset + index;
      const off = disabledSet.has(key);
      return (
        <li
          key={key}
          id={`${id}-option-${key}`}
          role="option"
          aria-selected={position === active}
          aria-disabled={off || undefined}
          className="picker-option"
          onMouseEnter={() => setActive(position)}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => choose(item)}
        >
          {renderOption(item)}
          {off ? <span className="picker-option-note">{disabledNote}</span> : null}
        </li>
      );
    });

  return (
    <div className="picker">
      <Field label={label} htmlFor={id} hint={hint} error={error}>
        <input
          id={id}
          type="search"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          aria-autocomplete="list"
          aria-expanded={flat.length > 0}
          aria-controls={flat.length > 0 ? listId : undefined}
          aria-activedescendant={activeId}
          aria-invalid={error ? 'true' : undefined}
          className={mono ? 'mono' : undefined}
          value={query}
          placeholder={placeholder}
          disabled={disabled}
          data-autofocus={autoFocus || undefined}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={onKeyDown}
        />
      </Field>
      {term.length >= PICKER_MIN_CHARS ? (
        <p className="picker-status" role="status">
          {searched !== term
            ? 'Searching…'
            : flat.length === 0
              ? emptyText(term)
              : `${flat.length} ${flat.length === 1 ? 'match' : 'matches'}. Use the arrow keys, then Enter.`}
        </p>
      ) : null}
      {flat.length > 0 ? (
        <ul id={listId} role="listbox" className="picker-results" aria-label={`${label} results`}>
          {grouped.map((group, index) => {
            const start = starts[index];
            if (!group.label) return options(group.items, start);
            return (
              <li key={group.key} role="presentation" className="picker-group">
                <span className="picker-group-label" aria-hidden="true">
                  {group.label}
                </span>
                <ul role="group" aria-label={group.label} className="picker-group-list">
                  {options(group.items, start)}
                </ul>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
