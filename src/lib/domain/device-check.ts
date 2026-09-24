/**
 * "Who has this device": one scan, one answer.
 *
 * The check is read-only. It is the question a NetRider is asked twenty times
 * a day in a corridor — whose is this, is it meant to be here, is there a
 * ticket on it — and the answer is a card, not a page. What the card holds is
 * named here so the check page, the corner card after a palette scan and the
 * tests agree.
 */

import type { PersonKind, RecordEvent, RecordTicketRef, TicketStatus } from '@/lib/domain/types';

export interface CheckedHolder {
  id: string;
  name: string;
  kind: PersonKind;
  /** OSIS for a student, staff id for staff. Empty when the directory has none. */
  externalId: string;
}

export interface CheckedDevice {
  id: string;
  label: string;
  assetTag: string;
  serialNumber: string;
  externalId: string;
  deviceType: string;
  manufacturer: string;
  model: string;
  status: string;
  location: string;
  version: number;
  updatedAt: string;
  holder: CheckedHolder | null;
  /** When the current holder was given it: the latest assignment in its history. */
  assignedAt: string | null;
  /** Open tickets naming it that this account may see, newest first. */
  openTickets: RecordTicketRef[];
  /** The last three things that happened to the record, newest first. */
  recent: RecordEvent[];
}

export interface CheckedPerson {
  id: string;
  displayName: string;
  kind: PersonKind;
  externalId: string;
  holding: number;
}

export type CheckResult =
  | { kind: 'device'; code: string; device: CheckedDevice }
  /** Two machines answer to the code; the person picks. */
  | { kind: 'ambiguous'; code: string; options: Array<{ id: string; label: string }> }
  /** Not a machine: somebody's ID card. */
  | { kind: 'person'; code: string; person: CheckedPerson }
  | { kind: 'unknown'; code: string }
  | { kind: 'error'; code: string; message: string };

const CLOSED: readonly TicketStatus[] = ['resolved', 'cancelled'];

export function isOpenTicket(ticket: Pick<RecordTicketRef, 'status'>): boolean {
  return !CLOSED.includes(ticket.status);
}

/** The latest assignment in a newest-first history, when it is the current holder's. */
export function assignedAtFrom(events: readonly Pick<RecordEvent, 'kind' | 'at'>[]): string | null {
  for (const event of events) {
    if (event.kind === 'assigned') return event.at;
    // A return after the assignment means whoever holds it now was given it
    // some other way (the editor, an import); there is no date to say.
    if (event.kind === 'returned') return null;
  }
  return null;
}

/** "Chromebook, Lenovo 300e": the second line of the card. */
export function checkedSubtitle(device: Pick<CheckedDevice, 'deviceType' | 'manufacturer' | 'model'>): string {
  const model = [device.manufacturer, device.model].filter((part) => part.trim() !== '').join(' ');
  return [device.deviceType.trim(), model].filter(Boolean).join(', ');
}

/** The one line a recent-checks row says about a machine. */
export function checkedGlance(device: Pick<CheckedDevice, 'holder' | 'status' | 'location'>): string {
  if (device.holder) return `With ${device.holder.name}`;
  const status = device.status.trim() || 'No status';
  return device.location.trim() ? `${status}, ${device.location.trim()}` : status;
}

/** The hub's tile and the palette's row. Not a `WorkflowKind`: it changes nothing. */
export const CHECK_WORKFLOW = {
  title: 'Check a device',
  description: 'Scan a machine and see who has it, where it belongs and any open tickets.',
  href: '/workflows/check',
} as const;

/** How many checks the page keeps under the card. */
export const RECENT_CHECKS = 8;

/** The event a scan elsewhere sends so a page that wants codes can take them first. */
export const SCANNED_CODE_EVENT = 'edison:scanned-code';

/** `/workflows/check`, with a code to look up on arrival when there is one. */
export function checkHref(code?: string): string {
  const trimmed = code?.trim() ?? '';
  return trimmed === '' ? '/workflows/check' : `/workflows/check?code=${encodeURIComponent(trimmed)}`;
}
