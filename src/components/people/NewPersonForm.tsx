'use client';

/**
 * The form on its own page: save goes to the new record, cancel goes back.
 */

import { useRouter } from 'next/navigation';
import { useRuntime } from '@/components/AppRuntime';
import type { PersonKind } from '@/lib/domain/types';
import { Button } from '@/components/ui/Button';
import { PersonForm, PersonFormSubmit } from './PersonForm';

export function NewPersonForm({
  kind,
  departments,
  roles,
}: {
  kind: PersonKind;
  departments: string[];
  roles: string[];
}) {
  const router = useRouter();
  const { pendingKey } = useRuntime();
  return (
    <PersonForm
      kind={kind}
      departments={departments}
      roles={roles}
      onSaved={(id) => router.push(`/people/${id}`)}
      actions={
        <>
          <PersonFormSubmit />
          <Button onClick={() => router.back()} disabled={pendingKey !== null}>
            Cancel
          </Button>
        </>
      }
    />
  );
}
