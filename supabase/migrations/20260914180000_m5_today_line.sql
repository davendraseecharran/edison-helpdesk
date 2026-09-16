-- ---------------------------------------------------------------------------
-- Today: where the assistant's line under the greeting is kept.
--
-- `briefingSentence` composes the library line from the counts, instantly and
-- for free. When a person has connected their own ChatGPT, the same counts and
-- the titles already on their screen are handed to it and it writes the
-- sentence instead — "Two projector tickets in room 118 look like one fault;
-- the queue is otherwise clear" rather than "Three things need you."
--
-- That costs a model call, so the answer is kept. One jsonb column on the row
-- this account already has, rather than a table of its own: the value is a
-- sentence, a hash and a timestamp, it belongs to exactly one account, it is
-- read on the same round trip as the rest of that account's settings, and a
-- table would have brought a primary key, two policies, four grants and a
-- second read to hold three fields.
--
-- The hash is what makes it safe to reuse. It is a fingerprint of the facts the
-- sentence was written from, so claiming a ticket changes it and the next
-- render asks for a new sentence; the ten-minute ceiling in the application is
-- only for a queue nobody is touching. Nothing here trusts the stored value: a
-- row from an older build, or one edited by hand, fails the shape check in
-- `today-line.ts` and the screen falls back to the library line.
--
-- This is a cache, not a setting, which is why `app_set_today_line` is the one
-- door to the column and why writing it deliberately does NOT move
-- `updated_at`. The settings row must not look changed because a greeting was
-- rewritten in the background.
-- ---------------------------------------------------------------------------

alter table public.account_preferences
  add column if not exists today_line jsonb not null default '{}'::jsonb;

-- An object, and a small one. A preferences row is read on every authenticated
-- page render, so an unbounded blob here would be paid for on every page this
-- account ever opens.
alter table public.account_preferences
  drop constraint if exists account_preferences_today_line_shape;

alter table public.account_preferences
  add constraint account_preferences_today_line_shape
  check (
    pg_catalog.jsonb_typeof(today_line) = 'object'
    and pg_catalog.length(today_line::text) <= 600
  );

comment on column public.account_preferences.today_line is
  'The assistant''s line under the Today greeting, cached: {"line","hash","generated_at"}. A read-only summary of this account''s own briefing. Written only by app_set_today_line.';

-- ---------------------------------------------------------------------------
-- app_set_today_line: the one door to that column.
--
-- The whole object is replaced rather than patched, because the three fields
-- are only ever true together: a line without the hash it was written from is a
-- line nobody can tell is stale.
--
-- Both arguments are clamped rather than refused. The line is bounded at the
-- ninety characters the screen gives it and the hash at the thirty-two the
-- application produces, so a caller that sends more stores less instead of
-- raising — there is nothing an operator could do about a refusal here, and the
-- only cost of a bad value is a sentence that is regenerated next time.
--
-- `generated_at` is stamped here rather than taken from the caller. Freshness
-- is the whole point of the row, and a clock the browser could set is not one
-- to measure ten minutes with.
-- ---------------------------------------------------------------------------
create or replace function public.app_set_today_line(p_line text, p_hash text)
returns public.account_preferences
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_row public.account_preferences;
  v_line text;
  v_hash text;
begin
  v_actor := public.app_require_actor();

  v_line := pg_catalog.left(pg_catalog.btrim(coalesce(p_line, '')), 90);
  v_hash := pg_catalog.left(pg_catalog.btrim(coalesce(p_hash, '')), 64);

  if v_line = '' or v_hash = '' then
    raise exception 'Send the line and the hash of the briefing it was written from.'
      using errcode = 'check_violation';
  end if;

  -- An account may cache a line before it has ever opened settings, so the row
  -- is ensured here rather than assumed.
  insert into public.account_preferences (account_id)
  values (v_actor.id)
  on conflict (account_id) do nothing;

  -- `updated_at` is untouched on purpose. See the note at the top of this file.
  update public.account_preferences p
  set today_line = pg_catalog.jsonb_build_object(
        'line', v_line,
        'hash', v_hash,
        'generated_at', pg_catalog.to_char(
          pg_catalog.now() at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'
        )
      )
  where p.account_id = v_actor.id
  returning * into v_row;

  return v_row;
end;
$$;

comment on function public.app_set_today_line(text, text) is
  'Stores the caller''s cached Today line with the fingerprint of the briefing it was written from and the moment it was written. Never moves updated_at: this is a cache, not a setting.';

revoke execute on function public.app_set_today_line(text, text) from public, anon;
grant execute on function public.app_set_today_line(text, text) to authenticated;
