/**
 * Access rules for the helpdesk.
 *
 * IMPORTANT: in M1 these functions run in the browser against the in-memory demo
 * store, so they are an interface filter only — they are NOT security. M2 moves
 * the same predicates into server code and Postgres row-level security, which is
 * where they become enforceable. Keeping every view and search path routed
 * through this module is what makes that swap mechanical.
 */

import type { Account, AccountId, HelpdeskData, Ticket } from './types';

export function findAccount(data: HelpdeskData, id: AccountId | null): Account | null {
  if (!id) return null;
  return data.accounts.find((account) => account.id === id) ?? null;
}

export function isAdmin(account: Account | null): boolean {
  return account?.role === 'admin';
}

/**
 * Only an active account may read or change anything. Deactivation and
 * incomplete setup take effect immediately rather than at next sign-in.
 */
export function isUsableAccount(account: Account | null): account is Account {
  return account != null && account.status === 'active';
}

export function isOwner(ticket: Ticket, accountId: AccountId): boolean {
  return ticket.ownerId === accountId;
}

export function isCollaborator(ticket: Ticket, accountId: AccountId): boolean {
  return ticket.collaboratorIds.includes(accountId);
}

export function isParticipant(ticket: Ticket, accountId: AccountId): boolean {
  return isOwner(ticket, accountId) || isCollaborator(ticket, accountId);
}

export function participantIds(ticket: Ticket): AccountId[] {
  return ticket.ownerId ? [ticket.ownerId, ...ticket.collaboratorIds] : [...ticket.collaboratorIds];
}

/** An unowned, still-open ticket is claimable work every technician may see. */
export function isClaimable(ticket: Ticket): boolean {
  return ticket.status === 'open' && ticket.ownerId === null;
}

/**
 * Technicians see claimable work plus the tickets they own or collaborate on.
 * Admins see everything. Past contributions stay attributed in history even
 * after a collaborator is removed, but removal revokes further access.
 */
export function canViewTicket(ticket: Ticket, actor: Account | null): boolean {
  if (!isUsableAccount(actor)) return false;
  if (isAdmin(actor)) return true;
  return isClaimable(ticket) || isParticipant(ticket, actor.id);
}

export function canClaimTicket(ticket: Ticket, actor: Account | null): boolean {
  if (!isUsableAccount(actor)) return false;
  return isClaimable(ticket);
}

/** Notes, device observations, waiting state and priority edits. */
export function canContribute(ticket: Ticket, actor: Account | null): boolean {
  if (!isUsableAccount(actor)) return false;
  if (ticket.status === 'resolved' || ticket.status === 'cancelled') return false;
  return isAdmin(actor) || isParticipant(ticket, actor.id);
}

/**
 * Time entries are the one contribution still allowed after resolution: the plan
 * lets contributors record or correct their own minutes while they retain access.
 */
export function canLogWork(ticket: Ticket, actor: Account | null): boolean {
  if (!isUsableAccount(actor)) return false;
  if (ticket.status === 'cancelled') return false;
  return isAdmin(actor) || isParticipant(ticket, actor.id);
}

export function canResolveTicket(ticket: Ticket, actor: Account | null): boolean {
  if (!isUsableAccount(actor)) return false;
  if (ticket.status === 'resolved' || ticket.status === 'cancelled') return false;
  return isAdmin(actor) || isParticipant(ticket, actor.id);
}

/** Owner or admin manages the collaborator list (prototype default to review). */
export function canManageCollaborators(ticket: Ticket, actor: Account | null): boolean {
  if (!isUsableAccount(actor)) return false;
  if (ticket.status === 'resolved' || ticket.status === 'cancelled') return false;
  return isAdmin(actor) || isOwner(ticket, actor.id);
}

/**
 * Participants may change priority and every change is logged. Whether later
 * changes should be admin-only is an open decision in TICKETING-PLAN.md.
 */
export function canSetPriority(ticket: Ticket, actor: Account | null): boolean {
  return canContribute(ticket, actor);
}

/** The primary owner can release unfinished work; collaborators cannot release another owner's ticket. */
export function canReturnToQueue(ticket: Ticket, actor: Account | null): boolean {
  return isUsableAccount(actor) && ticket.ownerId !== null &&
    ticket.status !== 'resolved' && ticket.status !== 'cancelled' &&
    (isAdmin(actor) || isOwner(ticket, actor.id));
}

/** Reassignment to another owner, reopening and cancelling are admin-only. */
export function canAdministerTicket(actor: Account | null): boolean {
  return isUsableAccount(actor) && isAdmin(actor);
}

export function canCreateTicket(actor: Account | null): boolean {
  return isUsableAccount(actor);
}

/** Admins create any channel and may route to the Open Queue or a technician. */
export function canChooseChannelAndOwner(actor: Account | null): boolean {
  return isUsableAccount(actor) && isAdmin(actor);
}

export function canAdministerAccounts(actor: Account | null): boolean {
  return isUsableAccount(actor) && isAdmin(actor);
}

/** Every list, count and search result must start from this filter. */
export function visibleTickets(data: HelpdeskData, actor: Account | null): Ticket[] {
  if (!isUsableAccount(actor)) return [];
  return data.tickets.filter((ticket) => canViewTicket(ticket, actor));
}

/** Accounts that may be offered as owners or collaborators. */
export function assignableAccounts(data: HelpdeskData): Account[] {
  return data.accounts.filter((account) => account.status === 'active');
}
