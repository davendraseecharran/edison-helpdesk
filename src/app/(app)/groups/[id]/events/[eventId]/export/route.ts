/**
 * One register as a file: who was there, who was not, and when each was marked.
 *
 * Same two gates as the roster export — an active session, and the entry
 * written before the file is served — and the same answer for an event that is
 * not in this group as for one that does not exist, so a URL cannot be edited
 * into somebody else's register.
 *
 * Every member is a row, present or not. A file of only the people who came is
 * a file that cannot answer the question a register is kept for.
 */

import { loadActor } from '@/lib/auth/session';
import { csvFileName, toCsv } from '@/lib/csv';
import { ATTENDANCE_COLUMNS, attendanceRow, fileStem } from '@/lib/data/group-csv';
import { loadGroupEvent } from '@/lib/data/group-events';
import { logGroupExport } from '@/lib/data/groups';
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
  { params }: { params: Promise<{ id: string; eventId: string }> },
): Promise<Response> {
  const actor = await loadActor();
  if (actor.kind !== 'active') {
    return refuse(403, 'Your session is not able to export. Sign in again.');
  }

  const { id, eventId } = await params;
  const detail = await loadGroupEvent(id, eventId);
  if (!detail) return refuse(404, 'There is no event at this address.');

  const recorded = await logGroupExport(id, 'attendance', detail.roll.length);
  if (!recorded) {
    return refuse(403, 'That export could not be recorded, so it did not run.');
  }

  const csv = toCsv(ATTENDANCE_COLUMNS, detail.roll.map(attendanceRow));

  return new Response(csv, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${csvFileName(
        fileStem('attendance', `${detail.groupName} ${detail.event.name}`),
        detail.event.heldOn || schoolToday(),
      )}"`,
      'cache-control': 'no-store',
    },
  });
}
