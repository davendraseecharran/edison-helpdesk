/**
 * The six things the audit log can be about.
 *
 * `record_events.entity_type` plus tickets, which come from `activity_events`.
 * A vocabulary rather than a rule: `app_audit_log` fails a filter it does not
 * recognise CLOSED, so a value outside this set shows an empty log that reads
 * exactly like a desk where nothing has happened. Both callers — the audit
 * screen's reader and the assistant's `list_audit` — drop an unknown value
 * rather than passing it through, and both need this list to do it.
 *
 * It lives here rather than in `audit.ts` because that module is `server-only`
 * and this is a list of six words.
 */
export const AUDIT_ENTITIES = ['ticket', 'account', 'person', 'device', 'invite', 'import'] as const;

export type AuditEntity = (typeof AUDIT_ENTITIES)[number];
