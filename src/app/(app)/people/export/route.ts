/**
 * The directory as a file.
 *
 * A route rather than a server action, and deliberately: the browser's own save
 * is the shortest path from a menu item to something on somebody's disk, and a
 * GET that answers with `content-disposition: attachment` needs no Blob, no
 * object URL and no second copy of the file in the page's memory. The devices
 * export went the other way in M5 and is fine; this one is 3,448 rows with
 * guardian phone numbers in it, and keeping it out of the client entirely is
 * worth the different shape.
 *
 * Three gates, in this order:
 *
 *   1. An active session. Anything else is sent away before a query runs.
 *   2. An administrator or a skills officer. A NetRider reads the roster to
 *      work a ticket; carrying it out of the building is the roster's own
 *      people's job. The refusal says so, in plain text, rather than answering
 *      with an empty file.
 *   3. THE EXPORT IS RECORDED BEFORE IT IS SERVED. `app_log_people_export`
 *      checks the role again and writes one history entry with the count. If
 *      that write fails the file is not sent: an export nobody can see
 *      afterwards is exactly what the entry exists to prevent.
 *
 * The URL is the list's own — the same `kind` and `query` the screen had — or
 * `?ids=` for a ticked selection, so the file is what was on screen rather than
 * an approximation of it.
 */

import type { NextRequest } from 'next/server';
import { loadActor } from '@/lib/auth/session';
import { canExportDirectory } from '@/lib/auth/roles';
import { cappedExportMessage, csvFileName, toCsv } from '@/lib/csv';
import { loadPeopleForExport, logPeopleExport } from '@/lib/data/people-addressees';
import { peopleCsvColumns, peopleCsvStem, personCsvRow } from '@/lib/data/people-csv';
import { schoolToday } from '@/lib/format';
import { isPersonKind, type PersonKind } from '@/lib/domain/types';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** At most one page of ticked rows, and every one of them really an id. */
function idsParam(value: string | null): string[] {
  if (!value) return [];
  return value
    .split(',')
    .map((id) => id.trim())
    .filter((id) => UUID.test(id))
    .slice(0, 500);
}

function refuse(status: number, line: string): Response {
  return new Response(`${line}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

export async function GET(request: NextRequest): Promise<Response> {
  const actor = await loadActor();
  if (actor.kind !== 'active') {
    return refuse(403, 'Your session is not able to export. Sign in again.');
  }
  if (!canExportDirectory(actor.account.roles)) {
    return refuse(403, 'Only an administrator or a skills officer can export the directory.');
  }

  const params = request.nextUrl.searchParams;
  const raw = params.get('kind');
  const kind: PersonKind = isPersonKind(raw) ? raw : 'student';
  const ids = idsParam(params.get('ids'));

  const { people, total, capped } = await loadPeopleForExport({
    kind,
    query: params.get('query') ?? '',
    ids: ids.length > 0 ? ids : null,
  });

  const recorded = await logPeopleExport(kind, people.length);
  if (!recorded.ok) {
    return refuse(403, 'That export could not be recorded, so it did not run.');
  }

  const csv = toCsv(
    peopleCsvColumns(kind),
    people.map((person) => personCsvRow(kind, person)),
  );
  const filename = csvFileName(peopleCsvStem(kind), schoolToday(), capped);

  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${filename}"`,
      // The file carries its own limitation in its name; this says it once more
      // in a header, for whatever asked without a person watching.
      ...(capped ? { 'x-export-note': cappedExportMessage('This filter', total) } : {}),
      'cache-control': 'no-store',
    },
  });
}
