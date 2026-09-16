/**
 * What an account may do, as a set.
 *
 * Three roles exist and an account holds at least one of them:
 *
 *   * `admin`          — administration, every ticket, everything below.
 *   * `netrider`       — works tickets. What this school calls the students who
 *                        run the helpdesk; it replaces the old "technician".
 *   * `skills_officer` — works the student and staff directory, reads the
 *                        device inventory, and never touches a ticket.
 *
 * These helpers are pure so they can be used in a server component, a client
 * component and a test without a database. They are NOT the authorization
 * boundary: the database decides, and every one of these rules is enforced
 * again there (see `20260914140000_m5_roles_set.sql`). What they are for is
 * showing a person only the work they can actually do.
 *
 * The database still carries a single-value `role` column, derived from the
 * set, so that the forty-odd `role = 'admin'` gates written before roles were a
 * set keep working. `DerivedRole` is that column's type. Its `technician`
 * literal is internal and is never shown to anyone.
 */

export type AccountRole = 'admin' | 'netrider' | 'skills_officer';

/** The derived single-value column on `app_accounts`. Internal vocabulary. */
export type DerivedRole = 'admin' | 'technician';

/** Every role, in the order role chips are shown. */
export const ACCOUNT_ROLES: readonly AccountRole[] = ['admin', 'netrider', 'skills_officer'];

export const ROLE_LABELS: Record<AccountRole, string> = {
  admin: 'Administrator',
  netrider: 'NetRider',
  skills_officer: 'Skills officer',
};

/** What each role lets someone do, for the chips on the access screen. */
export const ROLE_DESCRIPTIONS: Record<AccountRole, string> = {
  admin: 'Administration, every ticket, and everything the other roles can do.',
  netrider: 'Works tickets: the queue, devices and the directory.',
  skills_officer: 'Works the student and staff directory. No tickets.',
};

export function roleLabel(role: AccountRole): string {
  return ROLE_LABELS[role];
}

/** The sentence a list of roles reads as: "Administrator and NetRider". */
export function rolesLabel(roles: readonly AccountRole[]): string {
  const labels = sortRoles(roles).map(roleLabel);
  if (labels.length === 0) return 'No role';
  if (labels.length === 1) return labels[0];
  return `${labels.slice(0, -1).join(', ')} and ${labels[labels.length - 1]}`;
}

function isAccountRole(value: unknown): value is AccountRole {
  return value === 'admin' || value === 'netrider' || value === 'skills_officer';
}

function sortRoles(roles: readonly AccountRole[]): AccountRole[] {
  return ACCOUNT_ROLES.filter((role) => roles.includes(role));
}

/**
 * The role set from whatever the database handed back.
 *
 * `technician` is read as `netrider`: it is the old spelling and may still
 * arrive from a row written before the rename. An unreadable or empty value
 * becomes `['netrider']` rather than `[]`, so a display never has to invent a
 * meaning for "no role" — the database's own CHECK makes an empty set
 * impossible, and a UI that quietly showed nothing would hide a real fault.
 */
export function normalizeRoles(input: unknown): AccountRole[] {
  const source = Array.isArray(input) ? input : [input];
  const mapped = source
    .map((value) => (value === 'technician' ? 'netrider' : value))
    .filter(isAccountRole);
  const unique = ACCOUNT_ROLES.filter((role) => mapped.includes(role));
  return unique.length > 0 ? unique : ['netrider'];
}

/**
 * The set as an account row carries it, with one allowance: a row from a
 * database that predates the set has no `roles` column at all, only the
 * single `role`. Reading nothing as "NetRider" turned every administrator
 * into a technician for exactly as long as the migrations were pending, which
 * is the moment an administrator most needs to be one.
 */
export function rolesOfRow(roles: unknown, role: unknown): AccountRole[] {
  if (roles === null || roles === undefined) return role === 'admin' ? ['admin'] : ['netrider'];
  return normalizeRoles(roles);
}

/** Canonical form for a set a person just chose: deduplicated and in chip order. */
export function canonicalRoles(roles: readonly AccountRole[]): AccountRole[] {
  return sortRoles(roles);
}

export function sameRoles(a: readonly AccountRole[], b: readonly AccountRole[]): boolean {
  const left = canonicalRoles(a);
  const right = canonicalRoles(b);
  return left.length === right.length && left.every((role, at) => role === right[at]);
}

export function hasRole(roles: readonly AccountRole[], role: AccountRole): boolean {
  return roles.includes(role);
}

export function isAdmin(roles: readonly AccountRole[]): boolean {
  return hasRole(roles, 'admin');
}

/**
 * Tickets, notes, work logs, attachments, the queue and the scanner.
 * An administrator works tickets too; a skills officer who is neither does not.
 */
export function canWorkTickets(roles: readonly AccountRole[]): boolean {
  return hasRole(roles, 'admin') || hasRole(roles, 'netrider');
}

/**
 * The student and staff directory and the device inventory.
 *
 * Every role can today, which is why this reads as always true. It is a named
 * rule rather than an inlined `true` so that a role which cannot reach the
 * directory is one line here instead of a search through the screens.
 */
export function canWorkDirectory(roles: readonly AccountRole[]): boolean {
  return roles.length > 0;
}

/** Changing the inventory, as opposed to reading it. */
export function canEditInventory(roles: readonly AccountRole[]): boolean {
  return canWorkTickets(roles);
}

/**
 * Where signing in lands, and where a screen someone may not see sends them.
 *
 * Today rather than the queue: the queue is a list of everything, and the
 * first question somebody has when they sit down is not "what exists" but
 * "what needs me". A skills officer has no queue and no Today, so the
 * directory is their home rather than a consolation prize.
 */
export function landingPath(roles: readonly AccountRole[]): string {
  return canWorkTickets(roles) ? '/today' : '/people';
}
