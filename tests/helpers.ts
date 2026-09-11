/** Shared test helpers for the domain rules. */

import type {
  HelpdeskData,
  OperationContext,
  OperationResult,
  Ticket,
} from '../src/lib/domain/types';
import { createDemoData, DEMO_ACCOUNT_IDS } from '../src/lib/demo/fixtures';
import { toDateKey } from '../src/lib/format';

/** A fixed clock so generated records are predictable. */
export const NOW = new Date(2026, 8, 10, 10, 30, 0);

export const IDS = DEMO_ACCOUNT_IDS;

export function freshData(): HelpdeskData {
  return createDemoData(NOW);
}

export function contextFor(actorId: string, now: Date = NOW): OperationContext {
  return {
    actorId,
    now: now.toISOString(),
    today: toDateKey(now),
  };
}

/** Unwraps a successful result, failing loudly with the error otherwise. */
export function expectOk(result: OperationResult): HelpdeskData {
  if (!result.ok) {
    throw new Error(`Expected success but got: ${result.error}`);
  }
  return result.data;
}

/** Returns the ticket a successful create/claim result points at. */
export function createdTicket(result: OperationResult): Ticket {
  if (!result.ok) {
    throw new Error(`Expected success but got: ${result.error}`);
  }
  const ticket = result.data.tickets.find((entry) => entry.id === result.ticketId);
  if (!ticket) {
    throw new Error('The result did not reference a ticket.');
  }
  return ticket;
}

/** Returns the error message of a failed result. */
export function expectFail(result: OperationResult): string {
  if (result.ok) {
    throw new Error('Expected the operation to fail, but it succeeded.');
  }
  return result.error;
}

export function ticketByNumber(data: HelpdeskData, number: string) {
  const ticket = data.tickets.find((entry) => entry.number === number);
  if (!ticket) throw new Error(`No fixture ticket ${number}`);
  return ticket;
}

export function accountOf(data: HelpdeskData, id: string) {
  const account = data.accounts.find((entry) => entry.id === id);
  if (!account) throw new Error(`No fixture account ${id}`);
  return account;
}
