'use client';

/**
 * Importing the school's spreadsheets.
 *
 * This is how the directory and the inventory get here: three AppSheet tabs,
 * about 2,800 people and 7,500 machines, exported as CSV and read in. It is
 * also how the roster is refreshed every September, so it is built to be used
 * by somebody who has not used it since last September.
 *
 * Four steps, top to bottom, each one a panel that can be read on its own:
 *
 *   1. Choose file      what the file holds, and the file itself
 *   2. Map columns      folded away when the headers were recognised
 *   3. Check            the dry run: counts, problems, unmatched holders
 *   4. Import           the button, behind a confirmation
 *
 * The dry run is the whole point of the screen. `app_admin_import` performs the
 * real writes inside a savepoint and rolls them back, so the counts in step 3
 * are the counts step 4 produces rather than a second implementation's guess.
 * Nothing is written until the button in step 4 is pressed.
 *
 * The file is read in the browser only to say how many rows it has and which
 * export it looks like. What gets imported is decided on the server, from the
 * same text, parsed again: nothing this component normalised is ever trusted.
 */

import { useMemo, useRef, useState, type DragEvent } from 'react';
import { FileSpreadsheet, Upload } from 'lucide-react';
import { useRuntime } from '@/components/AppRuntime';
import { Button } from '@/components/ui/Button';
import { Dialog } from '@/components/ui/Dialog';
import { Icon } from '@/components/ui/Icon';
import { SegmentedControl } from '@/components/ui/SegmentedControl';
import { commitImportAction, previewImportAction, type ImportPreview } from '@/lib/data/import-actions';
import {
  MAX_CSV_BYTES,
  MAX_IMPORT_ROWS,
  countDataRows,
  describeDetection,
  fieldLabel,
  fieldsFor,
  mergeProblems,
  prefillMapping,
  presetLabel,
  problemRowsCsv,
  summariseImport,
  type ImportRunResult,
} from '@/lib/data/import-plan';
import { PRESETS, parseCsv } from '@/lib/import';
import type { ColumnPreset, ImportKind } from '@/lib/import';
import { ImportChips, ImportProblems, ImportUnmatched } from './ImportResult';

type PersonKind = 'student' | 'staff';

interface ChosenFile {
  name: string;
  text: string;
  headers: string[];
  rowCount: number;
  /** Bumped on every new file so a re-upload of the same name invalidates. */
  token: number;
}

/** The preset a kind and a people choice start from. One of the three tabs. */
function basePreset(kind: ImportKind, personKind: PersonKind): ColumnPreset {
  const id =
    kind === 'devices'
      ? 'appsheet_inventory'
      : personKind === 'staff'
        ? 'appsheet_staff'
        : 'appsheet_students';
  return PRESETS.find((preset) => preset.id === id) as ColumnPreset;
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

/**
 * Hands text to the browser as a file. The object URL is revoked on the next
 * frame: revoking it in the same tick cancels the save in some browsers.
 */
function saveCsv(filename: string, csv: string) {
  // The byte order mark is for Excel, which otherwise reads a UTF-8 file as the
  // local code page and turns every accented name into mojibake.
  const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.rel = 'noopener';
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function ImportScreen() {
  const { pendingKey, run, notify } = useRuntime();

  const [kind, setKind] = useState<ImportKind>('people');
  const [personKind, setPersonKind] = useState<PersonKind>('student');
  const [file, setFile] = useState<ChosenFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);

  const [map, setMap] = useState<Record<string, string>>({});
  /** True once a column has been re-pointed by hand. Then the map is sent. */
  const [mapAdjusted, setMapAdjusted] = useState(false);
  const [mapOpen, setMapOpen] = useState(false);
  const [detectedId, setDetectedId] = useState<string | null>(null);
  const [detectedSentence, setDetectedSentence] = useState<string | null>(null);

  const [preview, setPreview] = useState<ImportPreview | null>(null);
  /**
   * What the commit did, with the denominators the check used beside it: the
   * rows that failed before the database saw them are not in the RPC's counts,
   * and the result panel has to add up to the same file the check did.
   */
  const [committed, setCommitted] = useState<{
    result: ImportRunResult;
    rowCount: number;
    skipped: number;
  } | null>(null);
  const [confirming, setConfirming] = useState(false);

  const nextToken = useRef(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const busy = pendingKey !== null;
  const fields = fieldsFor(kind);

  /**
   * What the dry run was run against. When this changes, the dry run on screen
   * is no longer about the file and mapping in front of the operator, so it and
   * anything that followed it go.
   */
  const signature = useMemo(
    () =>
      JSON.stringify({
        token: file?.token ?? null,
        kind,
        personKind,
        map: mapAdjusted ? map : null,
      }),
    [file?.token, kind, personKind, map, mapAdjusted],
  );
  const [checkedSignature, setCheckedSignature] = useState<string | null>(null);
  const [committedSignature, setCommittedSignature] = useState<string | null>(null);

  const current = preview !== null && checkedSignature === signature ? preview : null;
  const done = committed !== null && committedSignature === signature ? committed : null;

  const problems = useMemo(() => {
    if (!current) return [];
    return mergeProblems(
      current.parseErrors,
      current.normalisedErrors,
      current.dryRun?.errors ?? [],
    );
  }, [current]);

  const summary = useMemo(
    () => (current?.dryRun ? summariseImport(current.dryRun, current.rowCount, problems.length) : null),
    [current, problems.length],
  );

  const doneSummary = useMemo(
    () =>
      done
        ? summariseImport(done.result, done.rowCount, done.skipped + done.result.errors.length)
        : null,
    [done],
  );

  /** Re-point every column at the file's own headers for a fresh preset. */
  function refill(headers: string[], nextKind: ImportKind, nextPersonKind: PersonKind) {
    setMap(prefillMapping(headers, basePreset(nextKind, nextPersonKind)));
    setMapAdjusted(false);
  }

  function forgetCheck() {
    setCheckedSignature(null);
    setPreview(null);
  }

  async function onFile(chosen: File | undefined) {
    if (!chosen) return;
    setFileError(null);
    forgetCheck();
    setCommitted(null);

    if (!/\.csv$/i.test(chosen.name)) {
      setFileError('Choose a CSV file. Export the sheet as CSV and upload that.');
      return;
    }
    if (chosen.size > MAX_CSV_BYTES) {
      setFileError('This file is larger than 5 MB. Split it into parts and import them one at a time.');
      return;
    }

    const text = await chosen.text();
    const csv = parseCsv(text);
    if (csv.headers.length === 0) {
      setFileError('This file is empty. Export the sheet again and upload it.');
      return;
    }

    const rowCount = countDataRows(csv);
    if (rowCount > MAX_IMPORT_ROWS) {
      setFileError(
        `This file has ${count(rowCount)} rows. An import is at most ${count(MAX_IMPORT_ROWS)} rows at a time. Split the file and import it in parts.`,
      );
      return;
    }

    const detection = describeDetection(csv.headers);
    const detected = detection ? PRESETS.find((preset) => preset.id === detection.id) : undefined;
    const nextKind = detected?.kind ?? kind;
    const nextPersonKind = (detected?.fixed?.kind as PersonKind | undefined) ?? personKind;

    nextToken.current += 1;
    setFile({ name: chosen.name, text, headers: csv.headers, rowCount, token: nextToken.current });
    setKind(nextKind);
    setPersonKind(nextPersonKind);
    setDetectedId(detection?.id ?? null);
    setDetectedSentence(detection?.sentence ?? null);
    refill(csv.headers, nextKind, nextPersonKind);
    // A file nothing recognised needs the mapping decided before anything else,
    // so the step that decides it opens itself rather than waiting to be found.
    setMapOpen(detection === null);
  }

  function onDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    void onFile(event.dataTransfer.files?.[0]);
  }

  function clearFile() {
    setFile(null);
    setFileError(null);
    setMap({});
    setMapAdjusted(false);
    setMapOpen(false);
    setDetectedId(null);
    setDetectedSentence(null);
    forgetCheck();
    setCommitted(null);
    if (inputRef.current) inputRef.current.value = '';
  }

  function changeKind(next: ImportKind) {
    setKind(next);
    forgetCheck();
    setCommitted(null);
    if (file) refill(file.headers, next, personKind);
  }

  function changePersonKind(next: PersonKind) {
    setPersonKind(next);
    forgetCheck();
    setCommitted(null);
    if (file) refill(file.headers, kind, next);
  }

  function changeColumn(field: string, header: string) {
    setMap((previous) => {
      const next = { ...previous };
      if (header === '') delete next[field];
      else next[field] = header;
      return next;
    });
    setMapAdjusted(true);
    forgetCheck();
    setCommitted(null);
  }

  function inputFor() {
    if (!file) return null;
    return {
      kind,
      presetId: basePreset(kind, personKind).id,
      personKind,
      customMap: mapAdjusted ? map : undefined,
      csvText: file.text,
    };
  }

  async function onCheck() {
    const input = inputFor();
    if (!input) return;
    const at = signature;
    const outcome = await run('import-dry-run', async () => {
      const result = await previewImportAction(input);
      setPreview(result);
      setCheckedSignature(at);
      return { ok: result.ok, error: result.error };
    });
    if (outcome.ok) notify('success', 'Dry run finished. Nothing was saved.');
  }

  async function onCommit() {
    const input = inputFor();
    if (!input) return;
    const at = signature;
    const outcome = await run('import-commit', async () => {
      const result = await commitImportAction(input);
      if (result.ok && result.result) {
        setCommitted({
          result: result.result,
          rowCount: current?.rowCount ?? result.result.total,
          skipped:
            (current?.parseErrors.length ?? 0) + (current?.normalisedErrors.length ?? 0),
        });
        setCommittedSignature(at);
      }
      return { ok: result.ok, error: result.error, message: result.message };
    });
    if (outcome.ok) setConfirming(false);
  }

  function downloadProblems() {
    if (!file || problems.length === 0) return;
    const csv = problemRowsCsv(parseCsv(file.text), problems);
    const stem = file.name.replace(/\.csv$/i, '');
    saveCsv(`${stem}-problem-rows.csv`, csv);
  }

  const ready =
    current !== null &&
    current.ok &&
    current.dryRun !== null &&
    current.parseErrors.length === 0 &&
    summary !== null &&
    summary.changing > 0;

  const blocked = (() => {
    if (!file) return 'Choose a file first.';
    if (!current || !summary) return 'Run the check first, so you can see what this file would do.';
    if (!current.ok) return 'The check did not finish. Fix the problem above and run it again.';
    if (current.parseErrors.length > 0) {
      return 'This file has rows the reader could not line up with its columns. Fix the quotation marks in the spreadsheet and upload it again.';
    }
    if (summary.changing === 0) {
      return 'Everything in this file already matches the helpdesk, so there is nothing to import.';
    }
    return null;
  })();

  return (
    <div className="import-flow">
      {/* -- 1. Choose file ------------------------------------------------ */}
      <section className="panel import-step" aria-labelledby="import-step-file">
        <div className="panel-head">
          <h2 className="panel-title" id="import-step-file">
            <span className="import-step-number" aria-hidden="true">
              1
            </span>
            Choose file
          </h2>
          <span className="panel-aside">{file ? `${count(file.rowCount)} rows` : 'No file yet'}</span>
        </div>

        <div className="panel-body stack-sm">
          <div className="field">
            <span className="field-label">What this file holds</span>
            <SegmentedControl
              label="What this file holds"
              value={kind}
              options={[
                { value: 'people', label: 'People' },
                { value: 'devices', label: 'Devices' },
              ]}
              onChange={(next) => changeKind(next)}
            />
          </div>

          {file ? (
            <div className="import-file">
              <Icon icon={FileSpreadsheet} size={20} className="import-file-icon" />
              <div className="import-file-text">
                <span className="import-file-name mono">{file.name}</span>
                <span className="import-file-note">
                  {count(file.rowCount)} {file.rowCount === 1 ? 'row' : 'rows'}
                </span>
                <span className="import-file-note">
                  {detectedSentence ?? 'No export was recognised. Map the columns in step 2.'}
                </span>
              </div>
              <Button variant="ghost" size="sm" onClick={clearFile} disabled={busy}>
                Remove file
              </Button>
            </div>
          ) : (
            <div
              className={dragging ? 'import-drop import-drop-active' : 'import-drop'}
              onDragOver={(event) => {
                event.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={onDrop}
            >
              <input
                ref={inputRef}
                id="import-file"
                type="file"
                accept=".csv,text/csv"
                className="visually-hidden"
                onChange={(event) => void onFile(event.target.files?.[0])}
              />
              <label className="import-drop-label" htmlFor="import-file">
                <Icon icon={Upload} size={22} />
                <span className="import-drop-title">Drop a CSV here, or choose a file</span>
                <span className="import-drop-note">
                  The student directory, the staff directory or the master inventory, exported from
                  AppSheet as CSV. Up to {count(MAX_IMPORT_ROWS)} rows at a time.
                </span>
              </label>
            </div>
          )}

          {fileError ? (
            <p className="flash flash-error" role="alert">
              {fileError}
            </p>
          ) : null}
        </div>
      </section>

      {/* -- 2. Map columns ------------------------------------------------ */}
      <section className="panel import-step" aria-labelledby="import-step-map">
        <div className="panel-head">
          <h2 className="panel-title" id="import-step-map">
            <span className="import-step-number" aria-hidden="true">
              2
            </span>
            Map columns
          </h2>
          {file && detectedId && !mapOpen ? (
            <Button size="sm" variant="ghost" onClick={() => setMapOpen(true)} disabled={busy}>
              Adjust mapping
            </Button>
          ) : null}
        </div>

        <div className="panel-body stack-sm">
          {!file ? (
            <p className="panel-empty">Choose a file first.</p>
          ) : (
            <>
              {kind === 'people' ? (
                <div className="field">
                  <span className="field-label">These rows are</span>
                  <SegmentedControl
                    label="These rows are"
                    value={personKind}
                    options={[
                      { value: 'student', label: 'Students' },
                      { value: 'staff', label: 'Staff' },
                    ]}
                    onChange={(next) => changePersonKind(next)}
                  />
                  <span className="field-hint">
                    One file holds one or the other. The AppSheet tabs are already split that way.
                  </span>
                </div>
              ) : null}

              {detectedId && !mapOpen ? (
                <p className="panel-note">
                  Using the {presetLabel(detectedId)} mapping. Adjust it if a column in this file
                  has been renamed.
                </p>
              ) : (
                <>
                  <p className="panel-note">
                    Each field below takes its value from one column of the file. Anything left as
                    not imported is left alone on records the helpdesk already holds.
                  </p>
                  <div className="import-map">
                    <table>
                      <thead>
                        <tr>
                          <th scope="col">Field</th>
                          <th scope="col">Column in the file</th>
                        </tr>
                      </thead>
                      <tbody>
                        {fields.map((field) => (
                          <tr key={field}>
                            <th scope="row">
                              <label htmlFor={`import-map-${field}`}>{fieldLabel(field)}</label>
                            </th>
                            <td>
                              <select
                                id={`import-map-${field}`}
                                value={map[field] ?? ''}
                                disabled={busy}
                                onChange={(event) => changeColumn(field, event.target.value)}
                              >
                                <option value="">Not imported</option>
                                {file.headers.map((header, at) => (
                                  <option key={`${header}-${at}`} value={header}>
                                    {header === '' ? `Column ${at + 1}` : header}
                                  </option>
                                ))}
                              </select>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}
            </>
          )}
        </div>
      </section>

      {/* -- 3. Check ------------------------------------------------------ */}
      <section className="panel import-step" aria-labelledby="import-step-check">
        <div className="panel-head">
          <h2 className="panel-title" id="import-step-check">
            <span className="import-step-number" aria-hidden="true">
              3
            </span>
            Check
          </h2>
          {file ? (
            <Button
              size="sm"
              onClick={() => void onCheck()}
              disabled={busy}
              loading={pendingKey === 'import-dry-run'}
            >
              {current ? 'Check again' : 'Check this file'}
            </Button>
          ) : null}
        </div>

        <div className="panel-body stack-sm">
          {!file ? (
            <p className="panel-empty">Choose a file first.</p>
          ) : !current ? (
            <p className="panel-note">
              The check runs the whole import inside the database and undoes it, so these counts are
              exactly what importing would do. Nothing is saved until step 4.
            </p>
          ) : (
            <>
              {current.error ? (
                <p className="flash flash-error" role="alert">
                  {current.error}
                </p>
              ) : null}

              {summary ? (
                <>
                  <ImportChips summary={summary} />
                  {done ? (
                    <p className="panel-note">
                      This is the check that was run before the import below.
                    </p>
                  ) : (
                    <p className="panel-note">
                      Nothing has been saved. {count(summary.changing)}{' '}
                      {summary.changing === 1 ? 'row' : 'rows'} would be written
                      {kind === 'devices' && summary.assignments > 0
                        ? `, and ${count(summary.assignments)} ${summary.assignments === 1 ? 'machine' : 'machines'} would be recorded as held`
                        : ''}
                      .
                    </p>
                  )}
                </>
              ) : null}

              {problems.length > 0 ? (
                <ImportProblems problems={problems} onDownload={downloadProblems} />
              ) : null}

              {summary && summary.unmatched > 0 && current.dryRun ? (
                <ImportUnmatched holders={current.dryRun.unmatched_holders} />
              ) : null}
            </>
          )}
        </div>
      </section>

      {/* -- 4. Import ----------------------------------------------------- */}
      <section className="panel import-step" aria-labelledby="import-step-import">
        <div className="panel-head">
          <h2 className="panel-title" id="import-step-import">
            <span className="import-step-number" aria-hidden="true">
              4
            </span>
            Import
          </h2>
        </div>

        <div className="panel-body stack-sm">
          {done && doneSummary ? (
            <>
              <p className="flash flash-success" role="status">
                Imported {count(doneSummary.changing)} {doneSummary.changing === 1 ? 'row' : 'rows'}.
              </p>
              <ImportChips summary={doneSummary} />
              <p className="panel-note">
                Run recorded as <span className="mono">{done.result.run_id ?? 'unknown'}</span>. It
                is in the list below, and on the history of every record it changed.
              </p>
            </>
          ) : (
            <>
              {blocked ? <p className="panel-note">{blocked}</p> : null}
              <div className="btn-row">
                <Button
                  variant="primary"
                  disabled={!ready || busy}
                  loading={pendingKey === 'import-commit'}
                  onClick={() => setConfirming(true)}
                >
                  {ready && summary
                    ? `Import ${count(summary.changing)} ${summary.changing === 1 ? 'row' : 'rows'}`
                    : 'Import'}
                </Button>
              </div>
            </>
          )}
        </div>
      </section>

      <Dialog
        open={confirming}
        onClose={() => setConfirming(false)}
        title={
          summary
            ? `Import ${count(summary.changing)} ${summary.changing === 1 ? 'row' : 'rows'}?`
            : 'Import this file?'
        }
        description="This writes to the directory and the inventory. It cannot be undone from this screen."
        footer={
          <>
            <Button onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="primary"
              data-autofocus
              loading={pendingKey === 'import-commit'}
              onClick={() => void onCommit()}
            >
              {summary
                ? `Import ${count(summary.changing)} ${summary.changing === 1 ? 'row' : 'rows'}`
                : 'Import'}
            </Button>
          </>
        }
      >
        {summary ? (
          <ul className="import-confirm">
            <li>
              {count(summary.inserts)} {kind === 'people' ? 'people' : 'devices'} will be added.
            </li>
            <li>
              {count(summary.updates)} will be updated with what this file says.
            </li>
            <li>{count(summary.unchanged)} already match and will be left alone.</li>
            {summary.problems > 0 ? (
              <li>
                {count(summary.problems)} {summary.problems === 1 ? 'row has' : 'rows have'} problems
                and will be skipped.
              </li>
            ) : null}
            {kind === 'devices' && summary.assignments > 0 ? (
              <li>
                {count(summary.assignments)}{' '}
                {summary.assignments === 1 ? 'machine' : 'machines'} will be recorded as held by the
                person named in the file.
              </li>
            ) : null}
          </ul>
        ) : null}
      </Dialog>
    </div>
  );
}
