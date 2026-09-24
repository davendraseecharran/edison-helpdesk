import { loadForm, loadFormResponses } from '@/lib/data/forms';
import { FormResponses } from '@/components/forms/FormResponses';

export const metadata = { title: 'Form responses — Edison Helpdesk' };

export default async function FormResponsesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [form, rows] = await Promise.all([loadForm(id), loadFormResponses(id)]);
  if (!form) return null;

  return <FormResponses formId={form.id} title={form.title} fields={form.fields} rows={rows} />;
}
