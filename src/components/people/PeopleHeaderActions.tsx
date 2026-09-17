'use client';

/**
 * The people page's header actions: what to do with the list, then Add person.
 *
 * A client component so the icons can be handed to `ButtonLink` (a component
 * cannot cross from a server page into a client button as a prop) and so the
 * filter can be read off the URL. The kind follows the list somebody is looking
 * at, so Add person from the staff tab starts a member of staff.
 *
 * The mail and copy controls act on the WHOLE FILTER rather than on the fifty
 * rows on screen, which is why they take a loader rather than a list: the
 * database is what knows who "everybody matching this search" is, and it is
 * only asked when one of the menus is actually opened.
 */

import { useCallback } from 'react';
import { useSearchParams } from 'next/navigation';
import { Plus } from 'lucide-react';
import { useRuntime } from '@/components/AppRuntime';
import { peopleAddresseesAction } from '@/lib/data/people-actions';
import type { GmailMode } from '@/lib/domain/preferences';
import type { PersonKind } from '@/lib/domain/types';
import { ADDRESSEE_CAP } from '@/lib/people/clipboard';
import { ButtonLink } from '@/components/ui/Button';
import { PeopleActions } from './PeopleActions';

export function PeopleHeaderActions({
  kind = 'student',
  total = 0,
  gmailMode = 'cc',
  canExport = false,
}: {
  kind?: PersonKind;
  /** How many the filter matches, for the line shown while the list loads. */
  total?: number;
  gmailMode?: GmailMode;
  canExport?: boolean;
}) {
  const { notify } = useRuntime();
  const searchParams = useSearchParams();
  const query = searchParams.get('query') ?? '';

  const load = useCallback(async () => {
    const result = await peopleAddresseesAction({ kind, query });
    // A filter bigger than one read is said out loud rather than silently cut:
    // somebody writing to "every student" has to know they are writing to five
    // hundred of them, and that narrowing the search is how they reach the rest.
    if (result.capped) {
      notify(
        'error',
        `This search has ${result.total.toLocaleString('en-US')} people. ` +
          `The first ${ADDRESSEE_CAP} are ready.`,
      );
    }
    return result.people;
  }, [kind, query, notify]);

  const params = new URLSearchParams();
  if (kind === 'staff') params.set('kind', 'staff');
  if (query.trim() !== '') params.set('query', query);
  const search = params.toString();

  return (
    <>
      <PeopleActions
        people={[]}
        load={load}
        expected={total}
        kind={kind}
        label={kind === 'staff' ? 'Staff in this list' : 'Students in this list'}
        gmailMode={gmailMode}
        exportHref={canExport ? `/people/export${search ? `?${search}` : ''}` : null}
      />
      <ButtonLink href={`/people/new?kind=${kind}`} icon={Plus} collapseOnPhone>
        Add person
      </ButtonLink>
    </>
  );
}
