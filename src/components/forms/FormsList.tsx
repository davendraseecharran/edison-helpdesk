'use client';

/**
 * Every form this account can see: the desk's shared ones and its own.
 *
 * Tens, not thousands, so the whole list is the screen. The two things
 * somebody scans for sit beside the title — whether it is taking responses,
 * and how many it has — and "Mine" narrows to the forms this account made,
 * which is the question an officer with a dozen trips on the go asks first.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Lock } from 'lucide-react';
import type { FormSummary } from '@/lib/data/forms';
import { AUDIENCE_LABELS } from '@/lib/domain/forms';
import { EmptyState, TimeAgo } from '@/components/Primitives';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { FilterBar } from '@/components/ui/FilterBar';
import { Icon } from '@/components/ui/Icon';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { useRowKeys } from '@/components/ui/useRowKeys';
import { FormStateBadge } from './FormStateBadge';
import { NewFormButton } from './NewFormButton';
import '@/styles/forms.css';
import '@/styles/paper-stack.css';

/**
 * The empty forms page's picture: three blank forms in a loose stack, drawn
 * in CSS 3D, the top one already showing a name filled in from the
 * directory — which is the one thing a form here does that a paper one
 * cannot. It leans towards a precise pointer (`data-tilt`) and the sheets
 * fan apart a little under it. Decoration: the words beside it say it all.
 */
function PaperStack() {
  return (
    <div className="paper-stack" data-tilt="" aria-hidden="true">
      <span className="paper paper-3" />
      <span className="paper paper-2" />
      <span className="paper paper-1">
        <span className="paper-title" />
        <span className="paper-field paper-field-filled">
          <span />
        </span>
        <span className="paper-field" />
        <span className="paper-field paper-field-short" />
        <span className="paper-check" />
      </span>
    </div>
  );
}

type Scope = 'all' | 'mine';

export function FormsList({ forms }: { forms: FormSummary[] }) {
  const router = useRouter();
  const [scope, setScope] = useState<Scope>('all');
  const [query, setQuery] = useState('');

  const rows = useMemo(() => {
    const folded = query.trim().toLowerCase();
    return forms.filter(
      (form) =>
        (scope === 'all' || form.mine) &&
        (folded === '' || form.title.toLowerCase().includes(folded)),
    );
  }, [forms, scope, query]);

  const keys = useRowKeys<FormSummary>({
    rows,
    keyOf: (form) => form.id,
    onAction: (action, form) => {
      if (action === 'open') router.push(`/forms/${form.id}`);
    },
    can: (action) => action === 'open',
  });

  const columns: Column<FormSummary>[] = [
    {
      key: 'title',
      header: 'Form',
      hideOnPhone: true,
      cell: (form) => (
        <div className="dir-cell-title">
          <span className="dir-name-row">
            <Link href={`/forms/${form.id}`} className="dir-name row-link">
              {form.title}
            </Link>
            {!form.shared ? (
              <span className="forms-private" title="Only you and administrators can see this form">
                <Icon icon={Lock} size={12} />
                Private
              </span>
            ) : null}
          </span>
          <span className="dir-sub">
            {[AUDIENCE_LABELS[form.audience], form.groupName ? `Fills ${form.groupName}` : null]
              .filter(Boolean)
              .join('. ')}
          </span>
        </div>
      ),
    },
    {
      key: 'state',
      header: 'Status',
      width: 110,
      cell: (form) => <FormStateBadge state={form.state} />,
    },
    {
      key: 'responses',
      header: 'Responses',
      align: 'right',
      width: 110,
      cell: (form) =>
        form.responseCount > 0 ? (
          <Link href={`/forms/${form.id}/responses`} className="row-link">
            {form.responseCount}
          </Link>
        ) : (
          <span className="dir-quiet">0</span>
        ),
    },
    {
      key: 'owner',
      header: 'Made by',
      width: 160,
      hideOnPhone: true,
      cell: (form) => (form.mine ? 'You' : form.ownerName ?? <span className="dir-quiet">Unknown</span>),
    },
    {
      key: 'updated',
      header: 'Last response',
      width: 150,
      cell: (form) =>
        form.lastResponseAt ? (
          <span className="dir-age">
            <TimeAgo iso={form.lastResponseAt} />
          </span>
        ) : (
          <span className="dir-quiet">None yet</span>
        ),
    },
  ];

  if (forms.length === 0) {
    return (
      <section className="panel directory">
        <EmptyState title="No forms yet" action={<NewFormButton />} mark={<PaperStack />}>
          A form is a sign-up sheet that already knows who is filling it in. Start a trip sign-up
          and people see their name, class and guardian filled in from the directory.
        </EmptyState>
      </section>
    );
  }

  return (
    <section className="panel directory">
      <FilterBar
        active={scope !== 'all' || query !== ''}
        onClear={() => {
          setScope('all');
          setQuery('');
        }}
        summary={`${rows.length} ${rows.length === 1 ? 'form' : 'forms'}`}
      >
        <input
          type="search"
          className="forms-search"
          placeholder="Find a form"
          aria-label="Find a form by title"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        <SegmentedControl<Scope>
          label="Which forms"
          size="sm"
          value={scope}
          onChange={setScope}
          options={[
            { value: 'all', label: 'All' },
            { value: 'mine', label: 'Mine' },
          ]}
        />
      </FilterBar>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(form) => form.id}
        caption="Forms"
        settle
        rowProps={keys.rowProps}
        listProps={keys.listProps}
        empty={<p className="panel-empty forms-empty-filter">No form matches that.</p>}
        cardTitle={(form) => (
          <Link href={`/forms/${form.id}`} className="row-link">
            {form.title}
          </Link>
        )}
        cardMeta={(form) => (form.mine ? 'Made by you' : form.ownerName ? `Made by ${form.ownerName}` : null)}
      />
    </section>
  );
}
