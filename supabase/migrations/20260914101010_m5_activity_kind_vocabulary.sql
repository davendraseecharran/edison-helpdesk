-- The activity vocabulary, stated once as the union of every lane that added to
-- it.
--
-- This migration exists because `activity_events_kind_valid` is a literal list
-- inside a CHECK constraint, and two M5 migrations written in parallel both
-- extend it by dropping and re-adding it:
--
--   20260914100350_m5_ticket_category_devices.sql adds
--     'category_changed', 'device_linked', 'device_unlinked'
--   20260914100800_m5_attachments.sql adds
--     'attachment_added', 'attachment_removed'
--
-- 100800 sorts later, so its re-add — written before 100350 existed — restates a
-- list that does not contain 100350's three kinds, and deletes them. Nothing
-- fails at migration time, because a CHECK constraint is only tested when a row
-- is written; the first thing to notice would be a technician changing a ticket
-- category in production and being told the value violates a constraint.
--
-- The two lanes' migrations are already applied elsewhere, and this project does
-- not edit an applied migration to change what it does, so the fix is an
-- additive one: drop the constraint once more and state the whole vocabulary,
-- with every kind either file contributed.
--
-- FOR WHOEVER ADDS THE NEXT KIND: restate this entire list, not only your own
-- addition. If your migration sorts before somebody else's re-add, your kinds
-- disappear when theirs runs, and the only symptom is a write refused months
-- later.

alter table public.activity_events drop constraint activity_events_kind_valid;

alter table public.activity_events add constraint activity_events_kind_valid check (
  kind in (
    -- M2 ticket lifecycle (20260910200000_core_schema.sql).
    'created', 'claimed', 'assigned', 'returned_to_queue',
    'collaborator_added', 'collaborator_removed', 'note_added',
    'device_recorded', 'priority_changed', 'status_changed',
    'time_logged', 'resolved', 'reopened', 'cancelled',
    -- Categories and inventory links (20260914100350).
    'category_changed', 'device_linked', 'device_unlinked',
    -- Attachments (20260914100800).
    'attachment_added', 'attachment_removed'
  )
);

comment on constraint activity_events_kind_valid on public.activity_events is
  'The whole activity vocabulary. Adding a kind means restating this entire list in a migration that sorts after every other file that re-adds this constraint.';
