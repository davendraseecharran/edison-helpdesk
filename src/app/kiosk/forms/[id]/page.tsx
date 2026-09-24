import { loadForm } from '@/lib/data/forms';
import { FormKiosk } from '@/components/forms/FormKiosk';
import { KioskUnavailable } from '@/components/forms/KioskUnavailable';

export default async function FormKioskPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const form = await loadForm(id);
  if (!form) return <KioskUnavailable what="form" backHref="/forms" />;

  return (
    <FormKiosk
      formId={form.id}
      title={form.title}
      description={form.description}
      audience={form.audience}
      fields={form.fields}
      open={form.state !== 'closed'}
    />
  );
}
