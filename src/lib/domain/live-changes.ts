/**
 * Which areas of the desk a screen shows, so a colleague's change refreshes
 * only the screens it could alter. Tickets are not listed: every screen
 * carries the rail's ticket counts, so a ticket change refreshes them all.
 */

export type ChangeArea = 'tickets' | 'inventory' | 'directory' | 'groups' | 'forms' | 'workflows';

const RULES: Array<[RegExp, ChangeArea[]]> = [
  [/^\/today/, ['inventory']],
  [/^\/people/, ['directory', 'inventory', 'groups']],
  [/^\/devices/, ['inventory', 'directory']],
  [/^\/(groups|events)/, ['groups', 'directory', 'forms']],
  [/^\/forms/, ['forms', 'groups']],
  [/^\/workflows/, ['workflows', 'inventory']],
  [/^\/tickets/, ['inventory', 'directory']],
];

export function areasForPath(pathname: string): ChangeArea[] {
  return RULES.find(([pattern]) => pattern.test(pathname))?.[1] ?? [];
}
