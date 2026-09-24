import { loadForms } from '@/lib/data/forms';
import { PageHeader } from '@/components/Primitives';
import { FormsList } from '@/components/forms/FormsList';
import { NewFormButton } from '@/components/forms/NewFormButton';

export const metadata = { title: 'Forms — Edison Helpdesk' };

export default async function FormsPage() {
  const forms = await loadForms();

  return (
    <>
      <PageHeader
        title="Forms"
        description="Sign-ups, permission slips and check-ins that fill themselves in from the directory."
        actions={<NewFormButton />}
      />
      <FormsList forms={forms} />
    </>
  );
}
