/**
 * The roster as a file.
 *
 * A route rather than a server action, for the reason the directory export is
 * one: a GET answering with `content-disposition: attachment` is the shortest
 * path from a button to something on somebody's disk, with no Blob and no
 * second copy of the file in the page's memory.
 *
 * Two gates, in this order:
 *
 *   1. An active session — and nothing more. A roster is the chapter's own
 *      list and every active account may already read it on screen; a rule
 *      about who may save it to a laptop would be a rule nobody could explain.
 *   2. THE EXPORT IS RECORDED BEFORE IT IS SERVED. `app_log_group_export`
 *      writes one history entry with the count. If that write fails, the file
 *      is not sent.
 */

import { loadActor } from '@/lib/auth/session';
import { csvFileName, toCsv } from '@/lib/csv';
import { fileStem, rosterColumns, rosterRow } from '@/lib/data/group-csv';
import { loadGroup, logGroupExport } from '@/lib/data/groups';
import { schoolToday } from '@/lib/format';

export const dynamic = 'force-dynamic';

function refuse(status: number, line: string): Response {
  return new Response(`${line}\n`, {
    status,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
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
  const detail = await loadGroup(id);
  if (!detail) return refuse(404, 'There is no group at this address.');

  const recorded = await logGroupExport(id, 'roster', detail.members.length);
  if (!recorded) {
    return refuse(403, 'That export could not be recorded, so it did not run.');
  }

  const csv = toCsv(
    rosterColumns(detail.fields),
    detail.members.map((member) => rosterRow(member, detail.fields, detail.marks)),
  );

  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${csvFileName(
        fileStem('group', detail.group.name),
        schoolToday(),
      )}"`,
      'cache-control': 'no-store',
    },
  });
}
