import { loadForm } from '@/lib/data/forms';
import { FormBuilder } from '@/components/forms/FormBuilder';

export const metadata = { title: 'Form — Edison Helpdesk' };

export default async function FormQuestionsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const form = await loadForm(id);
  // The layout has already said so when there is no form.
  if (!form) return null;

  return (
    <FormBuilder
      formId={form.id}
      initialTitle={form.title}
      initialDescription={form.description}
      initialFields={form.fields}
      audience={form.audience}
      responseCount={form.responseCount}
    />
  );
}
