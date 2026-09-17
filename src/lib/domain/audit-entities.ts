/**
 * The seven things the audit log can be about.
 *
 * `record_events.entity_type` plus tickets, which come from `activity_events`.
 * A vocabulary rather than a rule: `app_audit_log` fails a filter it does not
 * recognise CLOSED, so a value outside this set shows an empty log that reads
 * exactly like a desk where nothing has happened. Both callers — the audit
 * screen's reader and the assistant's `list_audit` — drop an unknown value
 * rather than passing it through, and both need this list to do it.
 *
 * It lives here rather than in `audit.ts` because that module is `server-only`
 * and this is a list of seven words.
 */
export const AUDIT_ENTITIES = [
  'ticket',
  'account',
  'person',
  'device',
  // A roster, its events and its checklist all file their history against the
  // group, which is the record with a page and a name.
  'group',
  'invite',
  'import',
] as const;

export type AuditEntity = (typeof AUDIT_ENTITIES)[number];
