import { loadForm } from '@/lib/data/forms';
import { loadGroups } from '@/lib/data/groups';
import { loadGroupEvents } from '@/lib/data/group-events';
import { FormSettings } from '@/components/forms/FormSettings';

export const metadata = { title: 'Form settings — Edison Helpdesk' };

export default async function FormSettingsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const [form, groups] = await Promise.all([loadForm(id), loadGroups()]);
  if (!form) return null;
  const events = form.groupId ? await loadGroupEvents(form.groupId) : [];

  return (
    <FormSettings
      // Keyed on the saved values, so a save that lands re-seeds the fields
      // from what the database kept rather than what was typed.
      key={form.updatedAt}
      form={{
        id: form.id,
        title: form.title,
        isOpen: form.isOpen,
        closesAt: form.closesAt,
        responseCap: form.responseCap,
        audience: form.audience,
        groupId: form.groupId,
        eventId: form.eventId,
        shared: form.shared,
        canOwn: form.canOwn,
        responseCount: form.responseCount,
      }}
      groups={groups.map((group) => ({ id: group.id, name: group.name }))}
      initialEvents={events.map((event) => ({ id: event.id, name: event.name, heldOn: event.heldOn }))}
    />
  );
}
