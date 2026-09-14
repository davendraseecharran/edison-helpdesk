-- ---------------------------------------------------------------------------
-- Three integers for the sign-in screen, and nothing else.
--
-- The sign-in panel was six hundred pixels of empty navy. It becomes the hero:
-- the school's own numbers, live. That needs a count readable by somebody who
-- has not signed in yet, which is the only thing in this schema that `anon`
-- may call.
--
-- What makes it safe is what it cannot return. The function is
-- SECURITY DEFINER because `anon` has no grant on the three tables it reads,
-- and it hands back exactly three bigints: how many machines the inventory
-- holds, how many people the directory holds, how many tickets have been
-- resolved. No row, no name, no identifier, no filter argument -- there is no
-- parameter to vary, so there is no way to turn it into an oracle that answers
-- "is there a person called X" one question at a time. A signed-out caller
-- learns three magnitudes about a public high school's IT programme, which is
-- the sort of thing the programme puts on a poster.
--
-- `search_path = ''` and schema-qualified names, so the definer's rights
-- cannot be redirected at a shadowing object. `stable`, so a page that calls
-- it twice pays once.
--
-- The counts come from the owner's model (`requesters`, `inventory_devices`)
-- rather than M5's, because that is the directory the application is being
-- rebuilt on. Where a table is still empty the screen simply has nothing to
-- say and says the tagline instead; it never prints a zero as if it were news.
-- ---------------------------------------------------------------------------

create or replace function public.app_public_totals()
returns table (devices bigint, people bigint, tickets_resolved bigint)
language sql
stable
security definer
set search_path = ''
as $$
  select
    (select count(*) from public.inventory_devices),
    (select count(*) from public.requesters),
    (select count(*) from public.tickets where status = 'resolved');
$$;

revoke execute on function public.app_public_totals() from public;
grant execute on function public.app_public_totals() to anon, authenticated;

comment on function public.app_public_totals() is
  'Three magnitudes for the signed-out hero: machines, people, tickets resolved. '
  'Takes no argument and returns no row, so it cannot be used to probe for one.';
