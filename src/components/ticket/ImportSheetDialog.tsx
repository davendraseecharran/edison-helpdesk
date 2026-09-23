'use client';

/**
 * Import from a spreadsheet: the desk's old sheet, into the Resolved list.
 *
 * Three moments, one surface:
 *
 *   1. PASTE. Rows copied out of Google Sheets, headings first, or a CSV file
 *      dropped on the box. A paste is read the moment it lands; there is no
 *      button between copying the rows and seeing them.
 *   2. REVIEW. The sheet as it was, with one select above each column saying
 *      what that column is — guessed from its heading, changeable — and a
 *      check beside every row: ready, landing with a note (a requester the
 *      directory does not know, a category the helpdesk does not have), or
 *      not landing and why. Requesters are looked up in the directory in one
 *      round trip per two hundred names and shown matched or not.
 *   3. DONE. What was made, what was already here, what was refused.
 *
 * Every row goes through `app_import_resolved_tickets` — the rules the
 * assistant's import uses, in the database, where they are enforced whatever
 * this dialog thinks. Two hundred rows a call. Sending the same sheet twice
 * makes nothing the second time: the rows come back as skipped.
 */

import { useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { Check, CircleAlert, FileUp, Info } from 'lucide-react';
import { useActorAccount, useRuntime } from '@/components/AppRuntime';
import { Dialog } from '@/components/ui/Dialog';
import { Button } from '@/components/ui/Button';
import { Icon } from '@/components/ui/Icon';
import { Select } from '@/components/ui/Select';
import { resolvePeopleAction } from '@/lib/data/group-actions';
import { importResolvedSheetAction } from '@/lib/data/ticket-import-actions';
import { PASTE_LIMIT } from '@/lib/domain/groups';
import {
  autoMap,
  IMPORT_BATCH,
  IMPORT_FIELD_LABELS,
  IMPORT_FIELDS,
  IMPORT_MAX_ROWS,
  importSummary,
  mappingProblems,
  previewRows,
  readSheet,
  requesterKeys,
  type ImportField,
  type ImportOutcome,
  type PreviewRow,
  type RequesterAnswer,
  type Sheet,
} from '@/lib/domain/ticket-import';

const FIELD_OPTIONS = IMPORT_FIELDS.map((value) => ({ value, label: IMPORT_FIELD_LABELS[value] }));

/** A file bigger than this is not a desk's sheet. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

type Stage = 'paste' | 'review' | 'done';

export function ImportSheetDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { directory, notify } = useRuntime();
  const actor = useActorAccount();
  const isAdmin = actor?.role === 'admin';

  const [stage, setStage] = useState<Stage>('paste');
  const [text, setText] = useState('');
  const [readError, setReadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [mapping, setMapping] = useState<ImportField[]>([]);
  const [readAt, setReadAt] = useState(0);
  const [people, setPeople] = useState<ReadonlyMap<string, RequesterAnswer>>(new Map());
  const [lookup, setLookup] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [outcomes, setOutcomes] = useState<ImportOutcome[]>([]);
  const pasted = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const resolvers = useMemo(
    () =>
      directory
        .filter((account) => account.status === 'active')
        .map((account) => ({ id: account.id, displayName: account.displayName })),
    [directory],
  );

  const rows = useMemo<PreviewRow[]>(
    () =>
      sheet
        ? previewRows(sheet, mapping, {
            nowMs: readAt,
            actorId: actor?.id ?? '',
            isAdmin,
            people,
            resolvers,
          })
        : [],
    [sheet, mapping, readAt, actor?.id, isAdmin, people, resolvers],
  );

  const problems = mappingProblems(mapping);
  const sendable = rows.filter((row) => row.payload !== null);
  const withNotes = sendable.filter((row) => row.notes.length > 0).length;
  const blocked = rows.length - sendable.length;
  const importing = progress !== null;

  function reset() {
    setStage('paste');
    setText('');
    setReadError(null);
    setSheet(null);
    setMapping([]);
    setPeople(new Map());
    setLookup('idle');
    setProgress(null);
    setOutcomes([]);
  }

  function close() {
    if (importing) return;
    onClose();
    // The surface plays its exit with the last content it rendered, so the
    // state can go now; the next open starts from an empty box.
    reset();
  }

  async function lookUp(next: Sheet, nextMapping: ImportField[], known: ReadonlyMap<string, RequesterAnswer>) {
    const keys = requesterKeys(next, nextMapping).filter((key) => !known.has(key.toLowerCase()));
    if (keys.length === 0) return;
    setLookup('loading');
    try {
      const found = new Map(known);
      for (let start = 0; start < keys.length; start += PASTE_LIMIT) {
        const answers = await resolvePeopleAction(keys.slice(start, start + PASTE_LIMIT));
        for (const answer of answers) {
          found.set(answer.key.toLowerCase(), {
            found: answer.found,
            matches: answer.matches,
            id: answer.id,
            displayName: answer.displayName,
          });
        }
      }
      // A key the directory gave no row for matched nobody.
      for (const key of keys) {
        if (!found.has(key.toLowerCase())) {
          found.set(key.toLowerCase(), { found: 'none', matches: 0, id: null, displayName: null });
        }
      }
      setPeople(found);
      setLookup('idle');
    } catch {
      setLookup('failed');
    }
  }

  function read(source: string) {
    setReadError(null);
    const next = readSheet(source);
    if (next === null) {
      setReadError('There is nothing here to read. Copy the rows from the sheet, headings included.');
      return;
    }
    if (next.rows.length === 0) {
      setReadError('That is only the heading row. Copy the rows under it too.');
      return;
    }
    if (next.rows.length > IMPORT_MAX_ROWS) {
      setReadError(`That is ${next.rows.length} rows. Import at most ${IMPORT_MAX_ROWS} at a time.`);
      return;
    }
    // The first guess, from the headings' own words; every select can change it.
    const nextMapping = autoMap(next.headers);
    setSheet(next);
    setMapping(nextMapping);
    setReadAt(Date.now());
    setStage('review');
    void lookUp(next, nextMapping, people);
  }

  function choose(column: number, field: ImportField) {
    if (!sheet) return;
    // A field belongs to one column: choosing it here takes it from wherever
    // it was, which is what the person means and never leaves two columns
    // claiming the same thing.
    const next = mapping.map((current, index) => {
      if (index === column) return field;
      return field !== 'skip' && current === field ? 'skip' : current;
    });
    setMapping(next);
    if (field === 'requester') void lookUp(sheet, next, people);
  }

  async function readFile(file: File) {
    if (file.size > MAX_FILE_BYTES) {
      setReadError('That file is larger than a sheet of tickets. Export the rows as CSV and try again.');
      return;
    }
    try {
      const content = await file.text();
      setText(content);
      read(content);
    } catch {
      setReadError('That file could not be read. Save it as CSV and drop it again.');
    }
  }

  async function runImport() {
    const batch = rows.filter((row) => row.payload !== null);
    if (batch.length === 0 || problems.length > 0) return;

    const results: ImportOutcome[] = rows
      .filter((row) => row.payload === null)
      .map((row) => ({
        line: row.line,
        outcome: 'refused' as const,
        ticketId: null,
        ticketNumber: null,
        message: row.errors.join(' '),
      }));

    setProgress({ sent: 0, total: batch.length });
    for (let start = 0; start < batch.length; start += IMPORT_BATCH) {
      const chunk = batch.slice(start, start + IMPORT_BATCH);
      const answer = await importResolvedSheetAction(chunk.map((row) => row.payload!));
      if (!answer.ok) {
        // A refusal of the whole call: say it for every row it held, and stop,
        // because the next batch would be refused for the same reason.
        for (const row of batch.slice(start)) {
          results.push({
            line: row.line,
            outcome: 'refused',
            ticketId: null,
            ticketNumber: null,
            message: answer.error ?? 'That batch did not go through. Nothing in it was made.',
          });
        }
        break;
      }
      for (const row of answer.rows) {
        const source = chunk[row.index - 1];
        if (!source) continue;
        results.push({
          line: source.line,
          outcome: row.outcome,
          ticketId: row.ticketId,
          ticketNumber: row.ticketNumber,
          message: row.message,
        });
      }
      setProgress({ sent: Math.min(start + chunk.length, batch.length), total: batch.length });
    }

    results.sort((a, b) => a.line - b.line);
    setOutcomes(results);
    setProgress(null);
    setStage('done');
    if (results.some((row) => row.outcome !== 'refused')) notify('success', importSummary(results));
  }

  const footer =
    stage === 'paste' ? (
      <>
        <Button onClick={close}>Cancel</Button>
        <Button variant="primary" onClick={() => read(text)} disabled={text.trim() === ''}>
          Read the rows
        </Button>
      </>
    ) : stage === 'review' ? (
      <>
        <Button onClick={reset} disabled={importing}>
          Start over
        </Button>
        <Button
          variant="primary"
          onClick={runImport}
          loading={importing}
          disabled={importing || lookup === 'loading' || problems.length > 0 || sendable.length === 0}
        >
          {sendable.length === 1 ? 'Import 1 ticket' : `Import ${sendable.length} tickets`}
        </Button>
      </>
    ) : (
      <>
        <Button onClick={reset}>Import another</Button>
        <Button variant="primary" onClick={close}>
          Done
        </Button>
      </>
    );

  return (
    <Dialog
      open={open}
      onClose={close}
      title="Import from a spreadsheet"
      description={
        stage === 'paste'
          ? 'Finished work from the desk’s sheet. Each row becomes a resolved ticket.'
          : undefined
      }
      className="import-dialog"
      footer={footer}
    >
      {stage === 'paste' ? (
        <div
          className="import-drop"
          data-dragging={dragging || undefined}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes('Files')) return;
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            const file = event.dataTransfer.files[0];
            if (!file) return;
            event.preventDefault();
            setDragging(false);
            void readFile(file);
          }}
        >
          <label className="field-label" htmlFor="import-paste">
            Rows, headings first
          </label>
          <textarea
            id="import-paste"
            className="import-paste mono"
            rows={8}
            value={text}
            spellCheck={false}
            data-autofocus
            aria-describedby="import-paste-hint"
            aria-invalid={readError ? 'true' : undefined}
            placeholder={'Title\tRequester\tOpened\tResolved\tSolution\nProjector in 118\tNia Okonkwo\t9/12/2025 9:05\t9/12/2025 10:15\tReseated HDMI'}
            onPaste={() => {
              pasted.current = true;
            }}
            onChange={(event) => {
              setText(event.target.value);
              setReadError(null);
              if (pasted.current) {
                pasted.current = false;
                read(event.target.value);
              }
            }}
          />
          <div className="import-drop-foot">
            <span id="import-paste-hint" className="field-hint">
              Select the rows in Google Sheets with their headings and paste them here, or drop a CSV
              file on this box.
            </span>
            <Button size="sm" icon={FileUp} onClick={() => fileInput.current?.click()}>
              Choose a file
            </Button>
            <input
              ref={fileInput}
              type="file"
              accept=".csv,.tsv,.txt,text/csv,text/tab-separated-values,text/plain"
              className="visually-hidden"
              tabIndex={-1}
              aria-hidden="true"
              onChange={(event) => {
                const file = event.target.files?.[0];
                event.target.value = '';
                if (file) void readFile(file);
              }}
            />
          </div>
          {readError ? (
            <p className="field-error" role="alert">
              {readError}
            </p>
          ) : null}
        </div>
      ) : null}

      {stage === 'review' && sheet ? (
        <div className="import-review">
          <p className="import-counts" role="status">
            {countLine(rows.length, sendable.length - withNotes, withNotes, blocked)}
            {lookup === 'loading' ? ' Looking up requesters in the directory.' : null}
            {progress ? ` Importing ${progress.sent} of ${progress.total}.` : null}
          </p>
          {lookup === 'failed' ? (
            <p className="import-banner" role="alert">
              The directory could not be reached, so requesters will be left unknown. Start over to
              try the lookup again.
            </p>
          ) : null}
          {problems.length > 0 ? (
            <p className="import-banner import-banner-bad" role="alert">
              {problems.join(' ')}
            </p>
          ) : null}
          <div className="import-table-wrap" role="region" aria-label="Rows to import" tabIndex={0}>
            <table className="table import-table">
              <thead>
                <tr>
                  <th scope="col" className="import-line">
                    Row
                  </th>
                  <th scope="col" className="import-check">
                    Check
                  </th>
                  {sheet.headers.map((header, column) => (
                    <th scope="col" key={column} className="import-col" data-skip={mapping[column] === 'skip' || undefined}>
                      <span className="import-col-name" title={header}>
                        {header}
                      </span>
                      <Select
                        value={mapping[column] ?? 'skip'}
                        onChange={(value) => choose(column, value as ImportField)}
                        options={FIELD_OPTIONS}
                        aria-label={`What the column ${header} is`}
                        className="import-col-select"
                        disabled={importing}
                      />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.line} data-state={rowState(row)}>
                    <td className="import-line mono">{row.line}</td>
                    <td className="import-check">
                      <RowCheck row={row} />
                    </td>
                    {row.cells.map((cell, column) => (
                      <td
                        key={column}
                        className="import-cell"
                        data-skip={mapping[column] === 'skip' || undefined}
                      >
                        <span className="import-cell-text" title={cell}>
                          {cell}
                        </span>
                        {mapping[column] === 'requester' && cell !== '' ? (
                          <RequesterMark row={row} />
                        ) : null}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {stage === 'done' ? <ImportResult outcomes={outcomes} /> : null}
    </Dialog>
  );
}

function rowState(row: PreviewRow): 'ready' | 'noted' | 'blocked' {
  if (row.payload === null) return 'blocked';
  return row.notes.length > 0 ? 'noted' : 'ready';
}

function countLine(total: number, ready: number, noted: number, blocked: number): string {
  const parts = [`${ready} ready`];
  if (noted > 0) parts.push(`${noted} with notes`);
  if (blocked > 0) parts.push(`${blocked} will not import`);
  return `${total} ${total === 1 ? 'row' : 'rows'}: ${parts.join(', ')}.`;
}

/** One row's verdict, and every reason for it. */
function RowCheck({ row }: { row: PreviewRow }) {
  const state = rowState(row);
  const lines = state === 'blocked' ? row.errors : row.notes;
  return (
    <div className="import-verdict" data-state={state}>
      <span className="import-verdict-head">
        <Icon icon={state === 'blocked' ? CircleAlert : state === 'noted' ? Info : Check} size={14} />
        {state === 'blocked' ? 'Will not import' : state === 'noted' ? 'Ready, with a note' : 'Ready'}
      </span>
      {lines.map((line) => (
        <span key={line} className="import-verdict-line">
          {line}
        </span>
      ))}
    </div>
  );
}

/** What the directory made of the requester cell. */
function RequesterMark({ row }: { row: PreviewRow }) {
  const { state, label } = row.requester;
  if (state === 'pending') return <span className="import-match" data-state="pending">Looking up</span>;
  if (state === 'match') {
    return (
      <span className="import-match" data-state="match">
        <Icon icon={Check} size={12} />
        {label}
      </span>
    );
  }
  if (state === 'none') return null;
  return (
    <span className="import-match" data-state="miss">
      {label}
    </span>
  );
}

function ImportResult({ outcomes }: { outcomes: ImportOutcome[] }) {
  const made = outcomes.filter((row) => row.outcome === 'made');
  const refused = outcomes.filter((row) => row.outcome === 'refused');
  const first = made[0]?.ticketNumber ?? null;
  const last = made[made.length - 1]?.ticketNumber ?? null;
  return (
    <div className="import-result">
      <p className="import-result-line" role="status">
        {importSummary(outcomes)}
      </p>
      {first ? (
        <p className="import-result-range">
          {made.length === 1 ? first : `${first} to ${last}`}, on the{' '}
          <Link href="/resolved">Resolved list</Link> by the day each one opened.
        </p>
      ) : null}
      {refused.length > 0 ? (
        <ul className="import-refused">
          {refused.map((row) => (
            <li key={row.line}>
              <span className="mono import-refused-line">Row {row.line}</span>
              <span>{row.message}</span>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
