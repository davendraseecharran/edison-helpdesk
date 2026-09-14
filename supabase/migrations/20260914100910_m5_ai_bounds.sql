-- M5: bounds on the AI conversation tables.
--
-- 20260914100900 made `ai_conversations` and `ai_messages` the one place in this
-- schema a signed-in session writes a table DIRECTLY. The policies there decide
-- WHOSE rows a caller may write. They say nothing about HOW MANY or HOW BIG, and
-- for every other table in this schema that question is answered by the RPC that
-- owns the write. Here there is no RPC, so the limits have to be constraints and
-- triggers or they do not exist at all.
--
-- Three bounds, none of which a legitimate client will ever meet:
--
--   1. A conversation title is 1..200 characters after trimming. The sidebar
--      renders it, and an untitled or book-length thread is not a thing the
--      product has a place for.
--   2. A message is at most 256 KiB. The Responses API items this column holds
--      are kilobytes; a megabyte is a bug or an attempt to fill the disk.
--      `pg_column_size` measures the datum as it arrives, before TOAST
--      compression, so a highly compressible payload cannot slip past by
--      shrinking on the way to storage.
--   3. An account keeps at most 200 conversations.
--
-- The cap needs two triggers rather than one, and the reason is worth stating.
-- A BEFORE INSERT ... FOR EACH ROW trigger counts the rows that were already
-- committed. Rows inserted EARLIER IN THE SAME STATEMENT are not visible to it,
-- because they carry the command id the trigger is running under. So the row
-- trigger alone stops the ordinary path — one conversation at a time, which is
-- the only thing the application does — and does nothing at all about a single
-- PostgREST insert carrying an array of five hundred. The AFTER ... FOR EACH
-- STATEMENT trigger, which sees the finished statement through a transition
-- table, closes that. The row trigger stays because it is the one that produces
-- the message an operator reads.

-- ---------------------------------------------------------------------------
-- Shape
-- ---------------------------------------------------------------------------

alter table public.ai_conversations
  add constraint ai_conversations_title_length
  check (length(btrim(title)) between 1 and 200);

comment on constraint ai_conversations_title_length on public.ai_conversations is
  'A conversation is named, and the name fits on a line: 1 to 200 characters once trimmed.';

alter table public.ai_messages
  add constraint ai_messages_content_size
  check (pg_column_size(content) <= 262144);

comment on constraint ai_messages_content_size on public.ai_messages is
  'One turn is at most 256 KiB, measured as the value arrives rather than as it is stored, so compression cannot be used to get around it.';

-- ---------------------------------------------------------------------------
-- The per-account cap
-- ---------------------------------------------------------------------------

create function public.app_ai_conversation_cap()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  -- SECURITY DEFINER so the count is of the account's real total rather than of
  -- the rows the caller happens to be able to see. They are the same thing under
  -- the policies as written; relying on that would make this cap depend on a
  -- policy in another file staying the way it is.
  if (
    select pg_catalog.count(*)
    from public.ai_conversations c
    where c.account_id = new.account_id
  ) >= 200 then
    raise exception 'You have 200 conversations, which is the limit. Delete one you have finished with to start another.'
      using errcode = 'check_violation';
  end if;
  return new;
end;
$$;

comment on function public.app_ai_conversation_cap() is
  'Trusted trigger function: refuses a 201st conversation for one account, with the message an operator reads. Counts committed rows, so the statement-level companion below is what covers a multi-row insert.';

create trigger ai_conversations_cap
before insert on public.ai_conversations
for each row execute function public.app_ai_conversation_cap();

create function public.app_ai_conversation_cap_statement()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_account uuid;
begin
  -- One check per account the statement touched, not per row, and only for
  -- accounts it actually touched.
  for v_account in select distinct i.account_id from inserted i loop
    if (
      select pg_catalog.count(*)
      from public.ai_conversations c
      where c.account_id = v_account
    ) > 200 then
      raise exception 'You have 200 conversations, which is the limit. Delete one you have finished with to start another.'
        using errcode = 'check_violation';
    end if;
  end loop;
  return null;
end;
$$;

comment on function public.app_ai_conversation_cap_statement() is
  'Trusted trigger function: re-checks the 200-conversation cap once the statement has finished, which is the only way to catch a single insert carrying many rows.';

create trigger ai_conversations_cap_batch
after insert on public.ai_conversations
referencing new table as inserted
for each statement execute function public.app_ai_conversation_cap_statement();

-- ---------------------------------------------------------------------------
-- Grants
--
-- Trigger functions inherit EXECUTE for PUBLIC, which leaves them listed as
-- callable RPCs. PostgreSQL checks EXECUTE on a trigger function when the
-- trigger is CREATED rather than when it fires, so revoking here removes a
-- pointless entry point without affecting the triggers above. service_role is
-- named explicitly: Supabase's default privileges grant it EXECUTE directly, so
-- it does not lose it when the grant to PUBLIC is revoked.
-- ---------------------------------------------------------------------------

revoke execute on function
  public.app_ai_conversation_cap(),
  public.app_ai_conversation_cap_statement()
from public, anon, authenticated, service_role;
