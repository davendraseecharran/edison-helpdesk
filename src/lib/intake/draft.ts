/**
 * A pasted email, read as a ticket.
 *
 * Half the walk-ins at this desk arrive as forwarded mail: a subject line, a
 * sender, three paragraphs, a signature block. Retyping that into four fields
 * is the most mechanical thing anybody does here, and it is the thing most
 * often done badly — the title becomes "email from Marcus" and the issue
 * becomes the whole thread including the disclaimer.
 *
 * This reads the message instead. The subject becomes the title, the body
 * becomes the issue with the quoted thread and the signature cut off, the
 * sender becomes something to search the directory for, and the words decide
 * the category and the priority through the same tables intake already uses.
 *
 * Pure, and offline. The assistant can do better when it is connected — it can
 * read a sentence that names a room in the middle of a paragraph — but this is
 * the version that works at the desk with no account, and it is the same
 * function the `draft_ticket_from_text` tool calls, so a draft is a draft
 * whichever way it was asked for.
 *
 * Nothing here is applied on its own. The caller shows what was read and the
 * person presses to accept it.
 */

import type { Priority, TicketCategory } from '@/lib/domain/types';
import { suggestCategory, suggestPriority } from './suggest';

export interface TicketDraft {
  title: string;
  issue: string;
  /** What to search the directory for: an address, or a name off a From line. */
  requesterQuery: string | null;
  category: TicketCategory | null;
  priority: Priority | null;
}

/** The longest an issue is worth carrying. Past this it is a thread, not a report. */
export const DRAFT_ISSUE_MAX = 2000;

/** The most a title can be before it stops being a title. */
export const DRAFT_TITLE_MAX = 120;

const SUBJECT = /^\s*(?:subject|betreff|asunto)\s*:\s*(.+)$/im;
const FROM = /^\s*(?:from|sender|de)\s*:\s*(.+)$/im;
const EMAIL = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/i;

/** Header lines a mail client adds, which are never the issue. */
const HEADER = /^\s*(?:from|to|cc|bcc|sent|date|subject|reply-to)\s*:/i;

/**
 * Where the message stops being the message.
 *
 * A quoted thread (`>`, "On … wrote:", "-----Original Message-----") and a
 * signature (`--`, "Sent from my", a phone number on its own line) are both
 * things the reporter did not write about this problem. Cutting at the first
 * one is deliberately blunt: everything above it is theirs, and a rule that
 * tried to weave the good parts back out of a thread would sooner or later
 * quote a different incident into a ticket.
 */
const CUT = [
  /^\s*-{2,}\s*$/,
  /^\s*-{3,}\s*original message\s*-{3,}/i,
  /^\s*on .+ wrote:\s*$/i,
  /^\s*_{5,}\s*$/,
  /^\s*sent from my /i,
  /^\s*>/,
];

function trimToSentence(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const stop = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('\n'));
  return stop > max / 2 ? cut.slice(0, stop + 1).trim() : `${cut.trim()}…`;
}

/** The address a From line names, or the first address anywhere in the text. */
function senderOf(text: string): string | null {
  const from = FROM.exec(text)?.[1]?.trim();
  if (from) {
    const address = EMAIL.exec(from)?.[0];
    if (address) return address.toLowerCase();
    // "Marcus Ellery" with no address on the line is still a name to search for.
    const name = from.replace(/[<>"]/g, '').trim();
    if (name !== '') return name;
  }
  return EMAIL.exec(text)?.[0]?.toLowerCase() ?? null;
}

/**
 * What a pasted message says, as a ticket draft.
 *
 * Every field may be null or empty: a paste with no subject line has no title
 * to offer, and the caller shows the fields it got rather than inventing the
 * ones it did not.
 */
export function draftFromText(raw: string): TicketDraft {
  const text = raw.replace(/\r\n/g, '\n');

  const lines = text.split('\n');
  const bodyLines: string[] = [];
  for (const line of lines) {
    if (CUT.some((pattern) => pattern.test(line))) break;
    if (HEADER.test(line)) continue;
    bodyLines.push(line);
  }

  const body = bodyLines.join('\n').replace(/\n{3,}/g, '\n\n').trim();

  const subject = SUBJECT.exec(text)?.[1]?.trim() ?? '';
  // No subject line: the first sentence of the body is what the message is
  // about, which is what a subject line would have said.
  const firstSentence = body.split(/(?<=[.!?])\s|\n/)[0]?.trim() ?? '';
  const title = trimToSentence(
    (subject || firstSentence).replace(/^(?:re|fwd|fw)\s*:\s*/i, '').trim(),
    DRAFT_TITLE_MAX,
  );

  const issue = trimToSentence(body, DRAFT_ISSUE_MAX);
  const category = suggestCategory(title, issue)?.value ?? null;
  const priority = suggestPriority(title, issue)?.value ?? null;

  return { title, issue, requesterQuery: senderOf(text), category, priority };
}
