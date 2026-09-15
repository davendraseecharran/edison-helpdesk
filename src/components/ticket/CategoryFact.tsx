'use client';

/**
 * The ticket's category, as one row of the facts list.
 *
 * It is a select rather than a button that opens a form, because refiling a
 * ticket is a correction somebody makes in passing — "this is a network problem,
 * not a projector one" — and a two-step flow for a one-word change is a flow
 * nobody completes. The change is recorded in the history like any other.
 *
 * Renders the `dt`/`dd` pair itself so the facts list stays one `dl`: a wrapper
 * element between `dl` and `dt` would break the list's semantics for anyone
 * reading it with a screen reader.
 */

import { useState } from 'react';
import { Select } from '@/components/ui/Select';
import type { TicketDetail } from '@/lib/domain/selectors';
import { type TicketCategory, TICKET_CATEGORIES, TICKET_CATEGORY_LABELS } from '@/lib/domain/types';
import { canContribute } from '@/lib/domain/permissions';
import { setCategoryAction } from '@/lib/data/actions';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';

export function CategoryFact({ detail }: { detail: TicketDetail }) {
  const { pendingKey, run } = useRuntime();
  const actor = useActorAccount();
  const ticket = detail.ticket;
  const [error, setError] = useState<string | null>(null);

  const mayChange = canContribute(ticket, actor);
  const selectId = `category-${ticket.id}`;

  async function onChange(value: TicketCategory) {
    setError(null);
    const result = await run(`category:${ticket.id}`, () => setCategoryAction(ticket.id, value));
    if (!result.ok) setError(result.error ?? 'That change could not be saved.');
  }

  return (
    <>
      <dt>
        {mayChange ? <label htmlFor={selectId}>Category</label> : 'Category'}
      </dt>
      <dd>
        {mayChange ? (
          <>
            <Select
              id={selectId}
              value={ticket.category}
              disabled={pendingKey !== null}
              onChange={(value) => void onChange(value as TicketCategory)}
              options={TICKET_CATEGORIES.map((value) => ({
                value,
                label: TICKET_CATEGORY_LABELS[value],
              }))}
            />
            {error ? (
              <span className="field-error" role="alert">
                {error}
              </span>
            ) : null}
          </>
        ) : (
          TICKET_CATEGORY_LABELS[ticket.category]
        )}
      </dd>
    </>
  );
}
