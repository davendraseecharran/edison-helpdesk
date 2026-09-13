'use client';

/**
 * The form on its own page: save goes to the new record, cancel goes back.
 */

import { useRouter } from 'next/navigation';
import { useRuntime } from '@/components/AppRuntime';
import { Button } from '@/components/ui/Button';
import { PersonForm, PersonFormSubmit } from './PersonForm';

export function NewPersonForm({ departments }: { departments: string[] }) {
  const router = useRouter();
  const { pendingKey } = useRuntime();
  return (
    <PersonForm
      departments={departments}
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
