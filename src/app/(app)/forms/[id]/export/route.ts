/**
 * A form's responses as a spreadsheet file.
 *
 * The same two gates as the roster export: an active session, and the export
 * recorded before it is served. The columns are the form's questions in order,
 * after when it came in and who it came from; a signature is the word
 * "Signed", never its drawing.
 */

import { loadActor } from '@/lib/auth/session';
import { csvFileName, toCsv } from '@/lib/csv';
import { loadForm, loadFormResponses, logFormExport } from '@/lib/data/forms';
import { responseTable } from '@/lib/domain/forms';
import { formatDateTime, schoolToday } from '@/lib/format';

export const dynamic = 'force-dynamic';

function refuse(status: number, line: string): Response {
  return new Response(`${line}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

function stem(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48);
  return `form-${slug || 'responses'}`;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<Response> {
  const actor = await loadActor();
  if (actor.kind !== 'active') {
    return refuse(403, 'Your session is not able to export. Sign in again.');
  }

  const { id } = await params;
  const form = await loadForm(id);
  if (!form) return refuse(404, 'There is no form at this address.');

  const rows = await loadFormResponses(id);
  const recorded = await logFormExport(id, 'csv', rows.length);
  if (!recorded) return refuse(403, 'That export could not be recorded, so it did not run.');

  const [header, ...body] = responseTable(form.fields, rows, formatDateTime);
  return new Response(toCsv(header, body), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${csvFileName(stem(form.title), schoolToday())}"`,
      'cache-control': 'no-store',
    },
  });
}
