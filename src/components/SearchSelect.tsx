'use client';

import { useEffect, useId, useRef, useState } from 'react';

export interface SearchSelectProps<T> {
  id: string;
  value: T | null;
  query: string;
  options: T[];
  getOptionKey: (option: T) => string;
  getOptionLabel: (option: T) => string;
  onQueryChange: (query: string) => void;
  onSelect: (option: T) => void;
  placeholder?: string;
  disabled?: boolean;
  loading?: boolean;
  emptyText?: string;
}

/**
 * A small keyboard-friendly searchable listbox for intake lookups.
 *
 * The selected value and the search text are separate concepts: typing does
 * not silently select an option, and callers can require an explicit choice
 * before saving a form.
 */
export function SearchSelect<T>({
  id,
  value,
  query,
  options,
  getOptionKey,
  getOptionLabel,
  onQueryChange,
  onSelect,
  placeholder = 'Search…',
  disabled = false,
  loading = false,
  emptyText = 'No matches found.',
}: SearchSelectProps<T>) {
  const rootRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const listId = useId();

  useEffect(() => {
    function closeOnOutsidePointer(event: PointerEvent) {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    }

    document.addEventListener('pointerdown', closeOnOutsidePointer);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer);
  }, []);

  const normalizedQuery = query.trim().toLocaleLowerCase();
  const visibleOptions = options
    .filter((option) => getOptionLabel(option).toLocaleLowerCase().includes(normalizedQuery))
    .slice(0, 30);
  const selectedKey = value ? getOptionKey(value) : null;
  const activeOptionIndex = Math.min(activeIndex, Math.max(visibleOptions.length - 1, 0));
  const activeOption = visibleOptions[activeOptionIndex];

  function selectOption(option: T) {
    onSelect(option);
    setActiveIndex(0);
    setOpen(false);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'Escape') {
      setOpen(false);
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) =>
        visibleOptions.length ? Math.min(index + 1, visibleOptions.length - 1) : 0,
      );
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setActiveIndex((index) => Math.max(index - 1, 0));
      return;
    }
    if (event.key === 'Enter' && open && !loading && activeOption) {
      event.preventDefault();
      selectOption(activeOption);
    }
  }

  return (
    <div className="search-select" ref={rootRef}>
      <input
        id={id}
        type="text"
        role="combobox"
        value={query}
        placeholder={placeholder}
        autoComplete="off"
        disabled={disabled}
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={open}
        aria-activedescendant={
          open && !loading && activeOption ? `${listId}-option-${activeOptionIndex}` : undefined
        }
        aria-busy={loading || undefined}
        onFocus={() => setOpen(true)}
        onChange={(event) => {
          onQueryChange(event.target.value);
          setActiveIndex(0);
          setOpen(true);
        }}
        onKeyDown={handleKeyDown}
      />

      {open ? (
        <div className="search-select-menu" id={listId} role="listbox">
          {loading ? <div className="search-select-status">Searching…</div> : null}
          {!loading && visibleOptions.length === 0 ? (
            <div className="search-select-status">{emptyText}</div>
          ) : null}
          {!loading
            ? visibleOptions.map((option, index) => {
                const optionKey = getOptionKey(option);
                return (
                  <button
                    key={optionKey}
                    id={`${listId}-option-${index}`}
                    type="button"
                    className={
                      index === activeOptionIndex
                        ? 'search-select-option search-select-option-active'
                        : 'search-select-option'
                    }
                    role="option"
                    aria-selected={optionKey === selectedKey}
                    onMouseDown={(event) => event.preventDefault()}
                    onMouseEnter={() => setActiveIndex(index)}
                    onClick={() => selectOption(option)}
                  >
                    {getOptionLabel(option)}
                  </button>
                );
              })
            : null}
        </div>
      ) : null}
    </div>
  );
}
