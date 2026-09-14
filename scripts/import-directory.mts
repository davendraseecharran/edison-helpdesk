#!/usr/bin/env node
/**
 * Rehearsing the import from a folder of CSV exports, on a LOCAL stack.
 *
 * The school's three AppSheet tabs come out as `students.csv`, `staff.csv` and
 * `inventory.csv`. Before any of that reaches the real database somebody should
 * be able to run the whole thing against a local copy, read the counts, and see
 * the rows that will not land — which is what this is. It is the same code path
 * the import screen uses: `src/lib/import` parses and normalises, and
 * `app_admin_import` decides what is written.
 *
 *   npm run import:csv -- --dir ~/.edison-private/2026-09 --email you@edison.example
 *   npm run import:csv -- --dir ~/.edison-private/2026-09 --email you@edison.example --commit
 *
 * Without `--commit` every file is a dry run and nothing is written. With it,
 * the dry runs still run first and the commits follow in the order that makes
 * the holders match: students, then staff, then devices.
 *
 * Four refusals, in the order they are checked:
 *   * a Supabase URL that is not loopback — this tool is for rehearsal, and a
 *     hosted project is not a rehearsal;
 *   * no `--dir`, or a folder with none of the three files in it;
 *   * a password on the command line: the password is read from stdin, never
 *     from argv, because argv is in the shell history and in `ps`;
 *   * on exit, any parse error or any unmatched holder (unless
 *     `--allow-unmatched`), so a rehearsal that half-worked fails visibly.
 *
 * Run by Node directly, with no loader and no bundler — which is why the
 * imports below carry their `.ts` extension and why nothing from `@/` appears
 * here. No whole row is ever printed: these files hold children's addresses and
 * parents' phone numbers, and a terminal is not a private place. Problems are
 * reported by row number, which is what you need to go and fix the sheet —
 * though a message about one value may quote that value back, as the OSIS
 * refusal does, because a number you cannot see is a number you cannot correct.
 */

import { createClient } from '@supabase/supabase-js';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PRESETS, detectPreset, parseCsv } from '../src/lib/import/index.ts';
import type { ColumnPreset, ImportKind, RowError } from '../src/lib/import/index.ts';
// The screen's own rules, not a second copy of them: which rows are malformed,
// which file row each sent row came from, and what the RPC's positions mean.
// The module is plain TypeScript with relative imports for exactly this reason.
import {
  MAX_IMPORT_ROWS,
  buildImportPlan,
  remapRunRows,
  type ImportRunResult,
} from '../src/lib/data/import-plan.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOOPBACK = ['127.0.0.1', 'localhost', '::1', '[::1]'];
/** How many problems are worth reading in a terminal before you open the file. */
const SHOWN_PROBLEMS = 20;

interface Args {
  dir?: string;
  email?: string;
  commit: boolean;
  allowUnmatched: boolean;
}

interface FileSpec {
  file: string;
  presetId: string;
  label: string;
}

/** The three tabs, in the order that lets a device find its holder. */
const FILES: FileSpec[] = [
  { file: 'students.csv', presetId: 'appsheet_students', label: 'Students' },
  { file: 'staff.csv', presetId: 'appsheet_staff', label: 'Staff' },
  { file: 'inventory.csv', presetId: 'appsheet_inventory', label: 'Devices' },
];

function parseArgs(argv: string[]): Args {
  const args: Args = { commit: false, allowUnmatched: false };
  for (let at = 0; at < argv.length; at += 1) {
    const arg = argv[at];
    if (arg === '--dir') args.dir = argv[(at += 1)];
    else if (arg === '--email') args.email = argv[(at += 1)];
    else if (arg === '--commit') args.commit = true;
    else if (arg === '--allow-unmatched') args.allowUnmatched = true;
    else if (arg === '--password' || arg === '--pass' || arg.startsWith('--password=')) {
      throw new Error(
        'The password is never taken from the command line. Leave it out and type it when asked, or pipe it in on stdin.',
      );
    } else throw new Error(`Unknown option "${arg}".`);
  }
  return args;
}

/**
 * Reads `.env.local` into a plain object.
 *
 * Only the two public values are ever used from it — the API URL and the anon
 * key — and neither is printed. The service-role key in the same file is not
 * read at all: this tool signs in as a named administrator and is subject to
 * exactly the checks the import screen is subject to.
 */
async function readEnvFile(): Promise<Record<string, string>> {
  const file = path.join(ROOT, '.env.local');
  if (!existsSync(file)) return {};
  const values: Record<string, string> = {};
  for (const line of (await readFile(file, 'utf8')).split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const at = trimmed.indexOf('=');
    if (at <= 0) continue;
    const key = trimmed.slice(0, at).trim();
    let value = trimmed.slice(at + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

/** The local stack, or a refusal. The environment wins over the file. */
async function localStack(): Promise<{ url: string; key: string }> {
  const file = await readEnvFile();
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? file.NEXT_PUBLIC_SUPABASE_URL ?? '';
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? file.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '';
  if (url === '' || key === '') {
    throw new Error('Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY in .env.local.');
  }
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('NEXT_PUBLIC_SUPABASE_URL is not a URL.');
  }
  if (!LOOPBACK.includes(host)) {
    throw new Error(
      `Refusing to run against "${host}". This is a rehearsal tool and only runs against a local stack.`,
    );
  }
  return { url, key };
}

/**
 * The password, from stdin and nowhere else.
 *
 * On a terminal the echo is turned off and nothing is written back; piped in,
 * the whole of stdin is the password. Either way it is held in memory for the
 * one sign-in and never printed, stored or passed as an argument.
 */
async function readPassword(email: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8').trim();
  }

  process.stderr.write(`Password for ${email}: `);
  return await new Promise<string>((resolve, reject) => {
    const stdin = process.stdin;
    let value = '';
    const finish = (error: Error | null) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stderr.write('\n');
      if (error) reject(error);
      else resolve(value);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        // End of line, end of transmission, interrupt, backspace: written as
        // escapes so the source stays readable in every editor and diff.
        if (char === '\n' || char === '\r' || char === '\u0004') return finish(null);
        if (char === '\u0003') return finish(new Error('Cancelled.'));
        if (char === '\u007f' || char === '\b') value = value.slice(0, -1);
        else value += char;
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');
    stdin.on('data', onData);
  });
}

function count(value: number): string {
  return value.toLocaleString('en-US');
}

/** "1 row" rather than "1 rows": these lines are read by a person. */
function rows(value: number): string {
  return `${count(value)} ${value === 1 ? 'row' : 'rows'}`;
}

function summarise(label: string, mode: string, result: ImportRunResult) {
  console.log(
    `  ${label} (${mode}): ${count(result.inserts)} new, ${count(result.updates)} changed, ` +
      `${count(result.unchanged)} unchanged, ${count(result.errors.length)} with problems` +
      (result.assignments_created > 0
        ? `, ${count(result.assignments_created)} recorded as held`
        : ''),
  );
}

/** Row numbers and sentences only. Never a row's contents. */
function showProblems(problems: Array<{ row: number; message: string; detail?: string }>) {
  for (const problem of problems.slice(0, SHOWN_PROBLEMS)) {
    console.log(`    row ${problem.row}: ${problem.message}${problem.detail ? ` [${problem.detail}]` : ''}`);
  }
  if (problems.length > SHOWN_PROBLEMS) {
    console.log(`    ... and ${count(problems.length - SHOWN_PROBLEMS)} more.`);
  }
}

interface Prepared {
  spec: FileSpec;
  kind: ImportKind;
  rows: Record<string, unknown>[];
  /** The file row each sent row came from, for turning the RPC's answer back. */
  sourceRows: number[];
  parseErrors: RowError[];
  rowErrors: RowError[];
  rowCount: number;
}

/** Reads one file and turns it into the rows `app_admin_import` accepts. */
async function prepare(dir: string, spec: FileSpec): Promise<Prepared | null> {
  const file = path.join(dir, spec.file);
  if (!existsSync(file)) return null;

  const preset = PRESETS.find((entry: ColumnPreset) => entry.id === spec.presetId) as ColumnPreset;
  const text = await readFile(file, 'utf8');
  const plan = buildImportPlan(text, {
    kind: preset.kind,
    presetId: preset.id,
    personKind: preset.fixed?.kind === 'staff' ? 'staff' : 'student',
  });

  if (plan.rowCount > MAX_IMPORT_ROWS) {
    throw new Error(
      `${spec.file} has ${count(plan.rowCount)} rows. An import is at most ${count(MAX_IMPORT_ROWS)} rows at a time. Split the file.`,
    );
  }

  // The file name says what the file is; detection is reported when it
  // disagrees, because a renamed column is worth knowing about before a commit.
  const looksLike = detectPreset(parseCsv(text).headers);
  if (looksLike !== null && looksLike.id !== preset.id) {
    console.log(`  ${spec.file}: headers look more like the ${looksLike.label} export.`);
  }

  return {
    spec,
    kind: preset.kind,
    rows: plan.rows,
    sourceRows: plan.sourceRows,
    parseErrors: plan.parseErrors,
    rowErrors: plan.normalisedErrors,
    rowCount: plan.rowCount,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.dir || !args.email) {
    console.error(
      'Usage: npm run import:csv -- --dir <folder> --email <admin address> [--commit] [--allow-unmatched]',
    );
    process.exit(2);
  }

  const dir = path.resolve(args.dir);
  if (!existsSync(dir)) throw new Error(`No such folder: ${dir}`);

  const stack = await localStack();

  const prepared: Prepared[] = [];
  for (const spec of FILES) {
    const one = await prepare(dir, spec);
    if (one) prepared.push(one);
  }
  if (prepared.length === 0) {
    throw new Error(
      `${dir} holds none of students.csv, staff.csv or inventory.csv. Export the tabs into it and run again.`,
    );
  }

  const password = await readPassword(args.email.trim());
  if (password === '') throw new Error('No password was supplied on stdin.');

  const supabase = createClient(stack.url, stack.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error: signInError } = await supabase.auth.signInWithPassword({
    email: args.email.trim().toLowerCase(),
    password,
  });
  if (signInError) {
    throw new Error('Could not sign in with that address and password.');
  }

  async function importRows(one: Prepared, mode: 'dry_run' | 'commit'): Promise<ImportRunResult> {
    const { data, error } = await supabase.rpc('app_admin_import', {
      p_kind: one.kind,
      p_rows: one.rows,
      p_mode: mode,
    });
    if (error) throw new Error(`${one.spec.file}: ${error.message}`);
    // The RPC counts positions in the array it was handed; every number this
    // script prints is a row of the spreadsheet.
    return remapRunRows(data as ImportRunResult, one.sourceRows);
  }

  let failed = false;
  let unmatchedTotal = 0;

  console.log(`\nDry run over ${dir}`);
  for (const one of prepared) {
    console.log(`\n${one.spec.label} — ${one.spec.file}, ${rows(one.rowCount)}`);
    if (one.parseErrors.length > 0) {
      failed = true;
      console.log(`  ${rows(one.parseErrors.length)} could not be read as CSV:`);
      showProblems(one.parseErrors);
    }
    if (one.rowErrors.length > 0) {
      console.log(`  ${rows(one.rowErrors.length)} cannot be saved:`);
      showProblems(one.rowErrors);
    }

    const result = await importRows(one, 'dry_run');
    summarise(one.spec.label, 'dry run', result);
    if (result.errors.length > 0) showProblems(result.errors);
    if (result.unmatched_holders.length > 0) {
      unmatchedTotal += result.unmatched_holders.length;
      console.log(
        `  ${count(result.unmatched_holders.length)} ${result.unmatched_holders.length === 1 ? 'device names a holder who is' : 'devices name a holder who is'} not in the directory (${result.unmatched_holders.length === 1 ? 'row' : 'rows'} ${result.unmatched_holders
          .slice(0, SHOWN_PROBLEMS)
          .map((entry) => entry.row)
          .join(', ')}${result.unmatched_holders.length > SHOWN_PROBLEMS ? ', ...' : ''}).`,
      );
    }
  }

  let committed = 0;
  if (!args.commit) {
    console.log('\nNothing was written. Add --commit to import.');
  } else if (failed) {
    console.log('\nNot committing: fix the rows that could not be read as CSV first.');
  } else {
    console.log('\nCommitting');
    for (const one of prepared) {
      const result = await importRows(one, 'commit');
      committed += 1;
      summarise(one.spec.label, 'commit', result);
      console.log(`    run ${result.run_id}`);
    }
  }

  if (failed) {
    console.error('\nFinished with parse errors. Nothing was written.');
    process.exitCode = 1;
  } else if (unmatchedTotal > 0 && !args.allowUnmatched) {
    // A non-zero exit after a commit must not read as "it did not happen": the
    // rows are in, and what is outstanding is the loans they could not record.
    console.error(
      `\nFinished with ${count(unmatchedTotal)} unmatched ${unmatchedTotal === 1 ? 'holder' : 'holders'}. ` +
        (committed > 0
          ? `The ${count(committed)} ${committed === 1 ? 'file was' : 'files were'} committed and those rows are in the helpdesk; what is missing is who holds those machines. Import the people files first, then import the inventory again, or pass --allow-unmatched to accept it.`
          : 'Nothing was written. Import the people files first, or pass --allow-unmatched.'),
    );
    process.exitCode = 1;
  }

  await supabase.auth.signOut();
}

main().catch((error: unknown) => {
  console.error(`\n${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
