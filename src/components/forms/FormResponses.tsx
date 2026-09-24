'use client';

/**
 * Everybody who answered, one column per question, and the three ways out of
 * the building: a CSV file, a paste for Google Sheets, and a new sheet opened
 * with the paste already on the clipboard.
 *
 * Above the table, one line per choice question with how the answers fell —
 * the counts an officer is asked for ("how many vegetarians?") without
 * opening a spreadsheet at all.
 *
 * A dot beside an answer means the respondent changed what the directory
 * holds. That is the column somebody reads to put the directory right.
 */

import { useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { ClipboardCopy, Download, FileUp, Sheet as SheetIcon, Trash2 } from 'lucide-react';
import { deleteFormResponseAction, logFormCopyAction } from '@/lib/data/form-actions';
import {
  answerText,
  choiceCounts,
  fieldLabel,
  isChoiceType,
  respondentName,
  responseTable,
  toTsv,
  VIA_LABELS,
  type FormField,
  type FormResponseRow,
} from '@/lib/domain/forms';
import { copyText } from '@/lib/groups/clipboard';
import { formatDateTime } from '@/lib/format';
import { useRuntime } from '@/components/AppRuntime';
import { EmptyState, TimeAgo } from '@/components/Primitives';
import { Button, ButtonLink } from '@/components/ui/Button';
import { DataTable, type Column } from '@/components/ui/DataTable';
import { Dialog } from '@/components/ui/Dialog';
import { FilterBar } from '@/components/ui/FilterBar';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { useApplePlatform } from '@/components/ui/media';
import { useRowKeys } from '@/components/ui/useRowKeys';
import { SignatureThumb } from './SignaturePad';
import { ImportResponsesDialog } from './ImportResponsesDialog';
import '@/styles/forms.css';

type Show = 'all' | 'matched' | 'unmatched' | 'changed';

/**
 * Text onto the clipboard once the log has said yes.
 *
 * A `ClipboardItem` built from a promise is written inside the click that asked
 * for it, which is what Safari insists on, while the text itself waits for the
 * export to be recorded. Where that is not supported the older path waits
 * first and writes after.
 */
async function copyWhenRecorded(text: Promise<string>): Promise<boolean> {
  try {
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      const blob = text.then((value) => new Blob([value], { type: 'text/plain' }));
      await navigator.clipboard.write([new ClipboardItem({ 'text/plain': blob })]);
      return true;
    }
  } catch {
    // Fall through to the plain path, which has its own fallback.
  }
  try {
    return await copyText(await text);
  } catch {
    return false;
  }
}

export function FormResponses({
  formId,
  title,
  fields,
  rows,
}: {
  formId: string;
  title: string;
  fields: FormField[];
  rows: FormResponseRow[];
}) {
  const { notify, pendingKey, run } = useRuntime();
  const router = useRouter();
  const apple = useApplePlatform();
  const [show, setShow] = useState<Show>('all');
  const [query, setQuery] = useState('');
  const [deleting, setDeleting] = useState<FormResponseRow | null>(null);
  const [copying, setCopying] = useState(false);
  const [importing, setImporting] = useState(false);
  const importDialog = (
    <ImportResponsesDialog open={importing} onClose={() => setImporting(false)} formId={formId} fields={fields} />
  );

  const visible = useMemo(() => {
    const folded = query.trim().toLowerCase();
    return rows.filter((row) => {
      if (show === 'matched' && !row.requesterId) return false;
      if (show === 'unmatched' && row.requesterId) return false;
      if (show === 'changed' && row.changed.length === 0) return false;
      if (folded === '') return true;
      const haystack = [
        respondentName(row, fields),
        row.externalId ?? '',
        ...fields.map((field) => answerText(field, row.answers[field.id])),
      ]
        .join(' ')
        .toLowerCase();
      return haystack.includes(folded);
    });
  }, [rows, fields, show, query]);

  const keys = useRowKeys<FormResponseRow>({
    rows: visible,
    keyOf: (row) => row.id,
    onAction: (action, row) => {
      if (action === 'open' && row.requesterId) router.push(`/people/${row.requesterId}`);
    },
    can: (action, row) => action === 'open' && row.requesterId !== null,
  });

  const matched = rows.filter((row) => row.requesterId).length;
  const changed = rows.filter((row) => row.changed.length > 0).length;
  const summaries = fields.filter((field) => isChoiceType(field.type) || field.type === 'yes_no');

  async function copyForSheets(openSheet: boolean) {
    if (copying || visible.length === 0) return;
    setCopying(true);
    const table = responseTable(fields, visible, formatDateTime);
    const text = logFormCopyAction(formId, visible.length).then((recorded) => {
      if (!recorded) throw new Error('not recorded');
      return toTsv(table);
    });
    const copied = await copyWhenRecorded(text);
    setCopying(false);
    if (!copied) {
      notify('error', 'That did not copy. Use Export CSV instead.');
      return;
    }
    const count = `${visible.length} ${visible.length === 1 ? 'response' : 'responses'}`;
    const paste = apple ? 'Command V' : 'Ctrl V';
    if (!openSheet) {
      notify('success', `Copied ${count}. Paste into a sheet with ${paste}.`);
      return;
    }
    const tab = window.open('https://sheets.new', '_blank');
    if (tab) {
      tab.opener = null;
      notify('success', `Copied ${count}. In the new sheet, click A1 and press ${paste}.`);
    } else {
      notify('success', `Copied ${count}. Your browser kept the new tab closed: open sheets.new and paste.`);
    }
  }

  const columns: Column<FormResponseRow>[] = [
    {
      key: 'who',
      header: 'Respondent',
      hideOnPhone: true,
      width: 220,
      cell: (row) => (
        <div className="dir-cell-title">
          <span className="dir-name-row">
            {row.requesterId ? (
              <Link href={`/people/${row.requesterId}`} className="dir-name row-link">
                {respondentName(row, fields)}
              </Link>
            ) : (
              <span className="dir-name">{respondentName(row, fields)}</span>
            )}
          </span>
          <span className="dir-sub">
            {[row.externalId, row.via === 'link' ? null : VIA_LABELS[row.via]].filter(Boolean).join(', ') || 'Link'}
          </span>
        </div>
      ),
    },
    {
      key: 'when',
      header: 'Sent',
      width: 130,
      cell: (row) => (
        <span className="dir-age">
          <TimeAgo iso={row.submittedAt} />
        </span>
      ),
    },
    ...fields.map<Column<FormResponseRow>>((field) => ({
      key: `q-${field.id}`,
      header: <span className="fr-head" title={fieldLabel(field)}>{fieldLabel(field)}</span>,
      width: field.type === 'long_text' ? 260 : field.type === 'signature' ? 120 : 170,
      cell: (row) => <AnswerCell field={field} row={row} fields={fields} />,
    })),
    {
      key: 'actions',
      header: <span className="visually-hidden">Actions</span>,
      width: 56,
      hideOnPhone: true,
      align: 'right',
      cell: (row) => (
        <Button
          size="sm"
          variant="ghost"
          icon={Trash2}
          aria-label={`Delete the response from ${respondentName(row, fields)}`}
          onClick={() => setDeleting(row)}
        />
      ),
    },
  ];

  if (rows.length === 0) {
    return (
      <section className="panel">
        <EmptyState
          title="No responses yet"
          action={
            <Button icon={FileUp} onClick={() => setImporting(true)}>
              Import responses
            </Button>
          }
        >
          Share the link or open the kiosk, and answers land here as they come in. Moving from
          Google Forms? Import the rows from its sheet.
        </EmptyState>
        {importDialog}
      </section>
    );
  }

  return (
    <div className="stack fr">
      {summaries.length > 0 ? (
        <section className="panel" aria-labelledby="fr-summary-heading">
          <div className="panel-head">
            <h2 className="panel-title" id="fr-summary-heading">
              Summary
            </h2>
            <span className="panel-aside">
              {rows.length} {rows.length === 1 ? 'response' : 'responses'}, {matched} matched to the directory
              {changed > 0 ? `, ${changed} changed a directory answer` : ''}
            </span>
          </div>
          <div className="fr-summaries">
            {summaries.map((field) => {
              const counts = choiceCounts(field, rows);
              const top = Math.max(1, ...counts.map((entry) => entry.count));
              return (
                <figure key={field.id} className="fr-summary">
                  <figcaption className="fr-summary-title">{fieldLabel(field)}</figcaption>
                  <ul className="fr-bars">
                    {counts.map((entry) => (
                      <li key={entry.option} className="fr-bar">
                        <span className="fr-bar-label">{entry.option}</span>
                        <span className="fr-bar-track" aria-hidden="true">
                          <span className="fr-bar-fill" style={{ transform: `scaleX(${entry.count / top})` }} />
                        </span>
                        <span className="fr-bar-count num">{entry.count}</span>
                      </li>
                    ))}
                  </ul>
                </figure>
              );
            })}
          </div>
        </section>
      ) : null}

      <section className="panel directory" aria-labelledby="fr-table-heading">
        <div className="panel-head">
          <h2 className="panel-title" id="fr-table-heading">
            Responses
          </h2>
          <div className="panel-head-end btn-row fr-exports">
            <ButtonLink href={`/forms/${formId}/export`} icon={Download} size="sm" prefetch={false}>
              Export CSV
            </ButtonLink>
            <Button size="sm" icon={ClipboardCopy} onClick={() => void copyForSheets(false)} disabled={copying}>
              Copy for Google Sheets
            </Button>
            <Button size="sm" icon={SheetIcon} onClick={() => void copyForSheets(true)} disabled={copying}>
              Open in Google Sheets
            </Button>
            <Button size="sm" icon={FileUp} onClick={() => setImporting(true)}>
              Import responses
            </Button>
          </div>
        </div>
        <FilterBar
          active={show !== 'all' || query !== ''}
          onClear={() => {
            setShow('all');
            setQuery('');
          }}
          summary={
            visible.length === rows.length
              ? `${rows.length} ${rows.length === 1 ? 'response' : 'responses'}`
              : `${visible.length} of ${rows.length}`
          }
        >
          <input
            type="search"
            className="forms-search"
            placeholder="Find a name or an answer"
            aria-label="Find a response"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
          <SegmentedControl<Show>
            label="Which responses"
            size="sm"
            value={show}
            onChange={setShow}
            options={[
              { value: 'all', label: 'All' },
              { value: 'matched', label: 'Matched' },
              { value: 'unmatched', label: 'Unmatched' },
              { value: 'changed', label: 'Changed' },
            ]}
          />
        </FilterBar>
        <div className="fr-table">
          <DataTable
            columns={columns}
            rows={visible}
            rowKey={(row) => row.id}
            caption={`Responses to ${title}`}
            rowProps={keys.rowProps}
            listProps={keys.listProps}
            empty={<p className="panel-empty forms-empty-filter">No response matches that.</p>}
            cardTitle={(row) => (
              <span className="fr-card-title">
                {row.requesterId ? (
                  <Link href={`/people/${row.requesterId}`} className="row-link">
                    {respondentName(row, fields)}
                  </Link>
                ) : (
                  <span>{respondentName(row, fields)}</span>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  icon={Trash2}
                  aria-label={`Delete the response from ${respondentName(row, fields)}`}
                  onClick={() => setDeleting(row)}
                />
              </span>
            )}
            cardMeta={(row) =>
              [row.externalId, VIA_LABELS[row.via], formatDateTime(row.submittedAt)]
                .filter(Boolean)
                .join(', ')
            }
          />
        </div>
      </section>

      {importDialog}
      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title="Delete this response?"
        description="The answers go. If the form added this person to a group, they stay in it."
        footer={
          <>
            <Button onClick={() => setDeleting(null)} disabled={pendingKey !== null}>
              Cancel
            </Button>
            <Button
              variant="danger"
              loading={pendingKey === 'form:response:delete'}
              onClick={() => {
                if (!deleting) return;
                void run('form:response:delete', () => deleteFormResponseAction(deleting.id)).then((result) => {
                  if (result.ok) setDeleting(null);
                });
              }}
            >
              Delete response
            </Button>
          </>
        }
      >
        <p className="muted">
          {deleting ? `From ${respondentName(deleting, fields)}, sent ${formatDateTime(deleting.submittedAt)}.` : null}
        </p>
      </Dialog>
    </div>
  );
}

function AnswerCell({
  field,
  row,
  fields,
}: {
  field: FormField;
  row: FormResponseRow;
  fields: readonly FormField[];
}) {
  const value = row.answers[field.id];
  if (value === undefined || value === null || value === '') return <span className="dir-quiet">None</span>;
  if (field.type === 'signature' && typeof value === 'string') {
    return <SignatureThumb path={value} label={`Signed by ${respondentName(row, fields)}`} />;
  }
  const wasChanged = row.changed.includes(field.id);
  return (
    <span className={field.type === 'long_text' ? 'fr-answer fr-answer-long' : 'fr-answer'}>
      {wasChanged ? (
        <span className="fr-changed" title="Changed from what the directory holds">
          <span className="visually-hidden">Changed from the directory: </span>
        </span>
      ) : null}
      {answerText(field, value)}
    </span>
  );
}
