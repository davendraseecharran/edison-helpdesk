import type { ReactNode } from 'react';
import { loadForm } from '@/lib/data/forms';
import { EmptyState } from '@/components/Primitives';
import { ButtonLink } from '@/components/ui/Button';
import { FormHeader } from '@/components/forms/FormHeader';

/**
 * Every page of one form shares its header: the title, whether it takes
 * responses, Share, Kiosk, and the three tabs. A form that is not there — or
 * a private one that is somebody else's — is one answer for all three.
 */
export default async function FormLayout({
  children,
  params,
}: {
  children: ReactNode;
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const form = await loadForm(id);

  if (!form) {
    return (
      <div className="panel">
        <EmptyState
          title="Form not available"
          action={<ButtonLink href="/forms">Back to forms</ButtonLink>}
        >
          There is no form at this address. It may have been deleted, or it may be private to
          the person who made it.
        </EmptyState>
      </div>
    );
  }

  return (
    <div className="form-page">
      <FormHeader
        form={{
          id: form.id,
          title: form.title,
          state: form.state,
          isOpen: form.isOpen,
          audience: form.audience,
          shared: form.shared,
          responseCount: form.responseCount,
          ownerName: form.ownerName,
          mine: form.mine,
          groupName: form.groupName,
          eventName: form.eventName,
          description: form.description,
          fields: form.fields,
        }}
      />
      {children}
    </div>
  );
}
