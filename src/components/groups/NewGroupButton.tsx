'use client';

/**
 * "New group", wherever it is offered: the page header and the empty state.
 *
 * Anybody may start one. A group is a list somebody keeps — the officers, a
 * competition team, a cart — and asking an administrator for permission to
 * write a list down is how the list ends up in a spreadsheet instead.
 *
 * On success the new group opens, because the only useful next thing is to put
 * people in it.
 */

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Plus } from 'lucide-react';
import { createGroupAction } from '@/lib/data/group-actions';
import { useRuntime } from '@/components/AppRuntime';
import { Button, type ButtonVariant } from '@/components/ui/Button';
import { GroupDialog, type GroupValues } from './GroupDialog';

export function NewGroupButton({ variant = 'primary' }: { variant?: ButtonVariant }) {
  const { pendingKey, run } = useRuntime();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const pending = pendingKey === 'group:create';

  async function submit(values: GroupValues) {
    const result = await run(
      'group:create',
      () => createGroupAction(values.name, values.description),
      { inlineError: true },
    );
    if (result.ok && result.id) router.push(`/groups/${result.id}`);
    return result;
  }

  return (
    <>
      <Button icon={Plus} variant={variant} onClick={() => setOpen(true)} disabled={pending}>
        New group
      </Button>
      <GroupDialog
        open={open}
        onClose={() => setOpen(false)}
        title="New group"
        description="A name and a line about what it is for. People come next."
        submitLabel="Create group"
        pending={pending}
        onSubmit={submit}
      />
    </>
  );
}
