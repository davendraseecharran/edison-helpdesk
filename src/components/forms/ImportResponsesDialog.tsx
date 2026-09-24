'use client';

/**
 * Import responses: the Google Sheet behind an old Google Form, into this one.
 *
 * The same three moments as the Resolved list's import, on the same table:
 *
 *   1. PASTE the rows out of Sheets, headings first, or drop the CSV.
 *   2. REVIEW. One select above each column saying which question it answers
 *      — guessed from the heading, which on a Google Form's sheet is the
 *      question's own words — or that it is the time sent, or who answered.
 *      Every row says whether it will land, and who in the directory it names.
 *   3. DONE. How many came in, replaced an older answer, were already here,
 *      or were refused and why.
 *
 * Two hundred rows a call through `app_import_form_responses`, which checks
 * every answer again, finds the person again and decides what is already
 * there. A second import of the same sheet brings in nothing.
 */

import { useMemo, useRef, useState } from 'react';
import { Check, CircleAlert, FileUp, Info } from 'lucide-react';
import { importResponsesAction, matchRespondentsAction } from '@/lib/data/form-import-actions';
import { readSheet, type Sheet } from '@/lib/domain/ticket-import';
import {
  RESPONSE_IMPORT_BATCH,
  RESPONSE_IMPORT_MAX_ROWS,
  guessTargets,
  identityOf,
  previewResponses,
  responseImportSummary,
  targetOptions,
  targetProblems,
  type ColumnTarget,
  type ResponseImportOutcome,
  type ResponsePreviewRow,
  type RowMatch,
} from '@/lib/domain/form-response-import';
import type { FormField } from '@/lib/domain/forms';
import { useRuntime } from '@/components/AppRuntime';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { Select } from '@/components/ui/Select';
import '@/styles/google-forms.css';

const MAX_FILE_BYTES = 5 * 1024 * 1024;

type Stage = 'paste' | 'review' | 'done';

/** The moment the rows were read, which "in the future" is measured from. Only ever read in a handler. */
function readClock(): number {
  return Date.now();
}

function identityTargets(target: ColumnTarget, fields: readonly FormField[]): boolean {
  if (target === 'email' || target === 'external_id' || target === 'name' || target === 'first_name' || target === 'last_name') {
    return true;
  }
  if (!target.startsWith('q:')) return false;
  const field = fields.find((entry) => entry.id === target.slice(2));
  return field?.type === 'directory' && ['email', 'external_id', 'full_name'].includes(field.directory ?? '');
}

export function ImportResponsesDialog({
  open,
  onClose,
  formId,
  fields,
}: {
  open: boolean;
  onClose: () => void;
  formId: string;
  fields: FormField[];
}) {
  const { notify } = useRuntime();
  const [stage, setStage] = useState<Stage>('paste');
  const [text, setText] = useState('');
  const [readError, setReadError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const [targets, setTargets] = useState<ColumnTarget[]>([]);
  const [readAt, setReadAt] = useState(0);
  const [matches, setMatches] = useState<Array<RowMatch | undefined>>([]);
  const [lookup, setLookup] = useState<'idle' | 'loading' | 'failed'>('idle');
  const [progress, setProgress] = useState<{ sent: number; total: number } | null>(null);
  const [outcomes, setOutcomes] = useState<ResponseImportOutcome[]>([]);
  const pasted = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const lookupTicket = useRef(0);

  const options = useMemo(() => targetOptions(fields), [fields]);
  const rows = useMemo<ResponsePreviewRow[]>(
    () => (sheet ? previewResponses(sheet, targets, fields, matches, readAt) : []),
    [sheet, targets, fields, matches, readAt],
  );
  const problems = targetProblems(targets);
  const sendable = rows.filter((row) => row.payload !== null);
  const matched = sendable.filter((row) => row.match?.state === 'match').length;
  const importing = progress !== null;

  function reset() {
    setStage('paste');
    setText('');
    setReadError(null);
    setSheet(null);
    setTargets([]);
    setMatches([]);
    setLookup('idle');
    setProgress(null);
    setOutcomes([]);
  }

  function close() {
    if (importing) return;
    onClose();
    reset();
  }

  async function lookUp(next: Sheet, nextTargets: ColumnTarget[]) {
    const ticket = lookupTicket.current + 1;
    lookupTicket.current = ticket;
    const identities = next.rows.map((cells) => identityOf(cells, nextTargets, fields));
    if (!identities.some((row) => row.email || row.external_id || row.name)) {
      setMatches([]);
      setLookup('idle');
      return;
    }
    setLookup('loading');
    try {
      const found: Array<RowMatch | undefined> = [];
      for (let start = 0; start < identities.length; start += 1000) {
        const answer = await matchRespondentsAction(formId, identities.slice(start, start + 1000));
        if (answer === null) throw new Error('refused');
        found.push(...answer);
      }
      if (lookupTicket.current !== ticket) return;
      setMatches(found);
      setLookup('idle');
    } catch {
      if (lookupTicket.current === ticket) setLookup('failed');
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
    if (next.rows.length > RESPONSE_IMPORT_MAX_ROWS) {
      setReadError(`That is ${next.rows.length} rows. Import at most ${RESPONSE_IMPORT_MAX_ROWS} at a time.`);
      return;
    }
    const nextTargets = guessTargets(next.headers, fields);
    setSheet(next);
    setTargets(nextTargets);
    setMatches([]);
    setReadAt(readClock());
    setStage('review');
    void lookUp(next, nextTargets);
  }

  function choose(column: number, target: ColumnTarget) {
    if (!sheet) return;
    const before = targets[column];
    // A target belongs to one column: choosing it here takes it from wherever
    // it was.
    const next = targets.map((current, index) => {
      if (index === column) return target;
      return target !== 'skip' && current === target ? 'skip' : current;
    });
    setTargets(next);
    if (identityTargets(target, fields) || identityTargets(before, fields)) void lookUp(sheet, next);
  }

  async function readFile(file: File) {
    if (file.size > MAX_FILE_BYTES) {
      setReadError('That file is larger than a sheet of responses. Export the rows as CSV and try again.');
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
    const results: ResponseImportOutcome[] = rows
      .filter((row) => row.payload === null)
      .map((row) => ({ line: row.line, outcome: 'refused' as const, message: row.errors.join(' ') }));

    setProgress({ sent: 0, total: batch.length });
    for (let start = 0; start < batch.length; start += RESPONSE_IMPORT_BATCH) {
      const chunk = batch.slice(start, start + RESPONSE_IMPORT_BATCH);
      let answer;
      try {
        answer = await importResponsesAction(formId, chunk.map((row) => row.payload!));
      } catch {
        answer = { ok: false, error: 'That batch did not reach the server. Nothing in it was imported.', rows: [] };
      }
      if (!answer.ok) {
        for (const row of batch.slice(start)) {
          results.push({
            line: row.line,
            outcome: 'refused',
            message: answer.error ?? 'That batch did not go through. Nothing in it was imported.',
          });
        }
        break;
      }
      for (const row of answer.rows) {
        const source = chunk[row.index - 1];
        if (source) results.push({ line: source.line, outcome: row.outcome, message: row.message });
      }
      setProgress({ sent: Math.min(start + chunk.length, batch.length), total: batch.length });
    }

    results.sort((a, b) => a.line - b.line);
    setOutcomes(results);
    setProgress(null);
    setStage('done');
    if (results.some((row) => row.outcome === 'made' || row.outcome === 'updated')) {
      notify('success', responseImportSummary(results));
    }
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
          onClick={() => void runImport()}
          loading={importing}
          disabled={importing || lookup === 'loading' || problems.length > 0 || sendable.length === 0}
        >
          {sendable.length === 1 ? 'Import 1 response' : `Import ${sendable.length} responses`}
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
      title="Import responses"
      description={
        stage === 'paste'
          ? 'Rows from the Google Sheet of a Google Form’s responses. Each row becomes a response here.'
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
          <label className="field-label" htmlFor="ri-paste">
            Rows, headings first
          </label>
          <textarea
            id="ri-paste"
            className="import-paste mono"
            rows={8}
            value={text}
            spellCheck={false}
            data-autofocus
            aria-describedby="ri-paste-hint"
            aria-invalid={readError ? 'true' : undefined}
            placeholder={'Timestamp\tEmail Address\tShirt size\n9/23/2026 14:05:31\tnia.okonkwo@edison.example\tM'}
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
            <span id="ri-paste-hint" className="field-hint">
              In the sheet, select the rows with their headings and paste them here, or drop a CSV file
              on this box.
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
            {countLine(rows.length, sendable.length, matched)}
            {lookup === 'loading' ? ' Looking people up in the directory.' : null}
            {progress ? ` Importing ${progress.sent} of ${progress.total}.` : null}
          </p>
          {lookup === 'failed' ? (
            <p className="import-banner" role="alert">
              The directory could not be reached for the preview. The import still matches people as
              it goes.
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
                    <th scope="col" key={column} className="import-col" data-skip={targets[column] === 'skip' || undefined}>
                      <span className="import-col-name" title={header}>
                        {header}
                      </span>
                      <Select
                        value={targets[column] ?? 'skip'}
                        onChange={(value) => choose(column, value as ColumnTarget)}
                        options={options}
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
                      <td key={column} className="import-cell" data-skip={targets[column] === 'skip' || undefined}>
                        <span className="import-cell-text" title={cell}>
                          {cell}
                        </span>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : null}

      {stage === 'done' ? (
        <div className="import-result">
          <p className="import-result-line" role="status">
            {responseImportSummary(outcomes)}
          </p>
          {outcomes.some((row) => row.outcome === 'refused') ? (
            <ul className="import-refused">
              {outcomes
                .filter((row) => row.outcome === 'refused')
                .map((row) => (
                  <li key={row.line}>
                    <span className="mono import-refused-line">Row {row.line}</span>
                    <span>{row.message}</span>
                  </li>
                ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </Dialog>
  );
}

function rowState(row: ResponsePreviewRow): 'ready' | 'noted' | 'blocked' {
  if (row.payload === null) return 'blocked';
  return row.notes.length > 0 ? 'noted' : 'ready';
}

function countLine(total: number, ready: number, matched: number): string {
  const parts = [`${ready} ready`, `${matched} matched to the directory`];
  if (total - ready > 0) parts.push(`${total - ready} will not import`);
  return `${total} ${total === 1 ? 'row' : 'rows'}: ${parts.join(', ')}.`;
}

function RowCheck({ row }: { row: ResponsePreviewRow }) {
  const state = rowState(row);
  const lines = state === 'blocked' ? row.errors : row.notes;
  const who = row.match?.state === 'match' ? row.match.displayName : null;
  return (
    <div className="import-verdict" data-state={state}>
      <span className="import-verdict-head">
        <Icon icon={state === 'blocked' ? CircleAlert : state === 'noted' ? Info : Check} size={14} />
        {state === 'blocked' ? 'Will not import' : who ? who : state === 'noted' ? 'Ready, with a note' : 'Ready'}
      </span>
      {lines.map((line) => (
        <span key={line} className="import-verdict-line">
          {line}
        </span>
      ))}
    </div>
  );
}
