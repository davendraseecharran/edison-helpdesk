-- A leaver can be archived.
--
-- 20260914130000 added `requesters.archived_at` and said, honestly, that
-- nothing in that milestone wrote it: it was "the honest place for 'this person
-- has left' to live when the screens that offer it land". 20260914150200 then
-- read it — `app_today_devices_due` raises "Holder has left" for a machine whose
-- holder is a graduated student OR carries `archived_at` — so half of that row's
-- reason has been unreachable since the day it was written. A member of staff
-- leaves, keeps the laptop, and nothing anywhere can say so: `student_status`
-- is a student's column, and deleting the row is refused by the tickets and
-- machines that name them.
--
-- This is the other half. The column is read back by `app_person_json` and
-- written by `app_save_person`, which are the directory's only two doors, so
-- the screens can offer it and the Today row can fire.
--
-- The two halves of the contract are deliberately different shapes:
--
--   * reading gives `archivedAt` — the timestamp, or null. A date is what a
--     record of somebody leaving should carry, and it is what the screens show.
--   * writing takes `archived` — a boolean. Nobody types the moment somebody
--     left; they tick a box, and the database stamps `now()`. Archiving an
--     already-archived person leaves the original date alone, so a second save
--     of an unrelated field does not quietly restate when they left. Unticking
--     clears it, because somebody coming back is not a different person.
--
-- A save that does not mention `archived` at all leaves the column untouched,
-- so every existing caller — the assistant's tools included — keeps working
-- exactly as it did.
--
-- Additive. No column is added, no row is touched, no grant widens: the two
-- functions are dropped and recreated at the same signatures, in the same
-- security context, with their ACLs restated verbatim underneath.

-- ---------------------------------------------------------------------------
-- The projection. Internal helper: invoked by app_list_people and
-- app_get_person, reachable by no client, so it keeps its revoke-from-all ACL.
-- ---------------------------------------------------------------------------

drop function if exists public.app_person_json(public.requesters);

create function public.app_person_json(r public.requesters) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id',r.id,'kind',r.kind,'displayName',r.display_name,'externalId',coalesce(r.external_id,''),
    'firstName',coalesce(r.first_name,''),'lastName',coalesce(r.last_name,''),'email',coalesce(r.email,''),
    'schoolDbn',coalesce(r.school_dbn,''),'department',coalesce(r.department,''),'staffRole',coalesce(r.staff_role,''),
    'classOf',coalesce(r.class_of,''),'studentStatus',coalesce(r.student_status,'current'),'officialClass',coalesce(r.official_class,''),
    'guardianName',coalesce(r.guardian_name,''),'guardianPhone',coalesce(r.guardian_phone,''),
    'homePhone',coalesce(r.home_phone,''),'address',coalesce(r.address,''),'notes',coalesce(r.notes,''),
    'archivedAt',r.archived_at,
    'version',r.version,'updatedAt',r.updated_at,
    'deviceCount',(select count(*) from public.inventory_devices d where d.assigned_requester_id=r.id));
$$;

revoke all on function public.app_person_json(public.requesters) from public,anon,authenticated;

-- ---------------------------------------------------------------------------
-- The save. Same signature, same body, plus the one column.
-- ---------------------------------------------------------------------------

drop function if exists public.app_save_person(uuid,integer,jsonb);

create function public.app_save_person(p_id uuid,p_version integer,p_data jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare a public.app_accounts; r public.requesters; v_before jsonb; v_kind text; v_external text; v_email text; v_archived boolean;
begin
  a:=public.app_require_actor();
  perform public.app_validate_profile(p_data);
  v_kind:=p_data->>'kind'; v_email:=nullif(lower(btrim(p_data->>'email')),'');
  if v_kind is null or v_kind not in ('staff','student') then raise exception 'Choose staff or student.'; end if;
  if length(btrim(coalesce(p_data->>'displayName','')))=0 then raise exception 'A name is required.'; end if;
  if v_kind='staff' then
    if v_email is null then raise exception 'Staff email is required to calculate the Staff ID.'; end if;
    v_external:=split_part(v_email,'@',1);
  else
    v_external:=btrim(coalesce(p_data->>'externalId',''));
    if v_external !~ '^[0-9]+$' then raise exception 'OSIS must contain numbers only.' using errcode='check_violation'; end if;
  end if;
  -- Absent means "not mentioned", which means "leave it alone". Only a caller
  -- that sends the key is asking for a change, and only `true` and `false` are
  -- an answer: anything else is a client sending nonsense and is refused rather
  -- than read as "not archived".
  if p_data ? 'archived' then
    if pg_catalog.jsonb_typeof(p_data->'archived') <> 'boolean' then
      raise exception 'Archived must be true or false.' using errcode='check_violation';
    end if;
    v_archived := (p_data->>'archived')::boolean;
  end if;
  if p_id is not null then
    select * into r from public.requesters where id=p_id for update;
    if not found or r.kind<>v_kind then raise exception 'That record is not available for this directory.'; end if;
    if p_version is distinct from r.version then raise exception 'This record changed since you opened it. Reload it before saving.' using errcode='serialization_failure'; end if;
    v_before:=to_jsonb(r);
  else
    insert into public.requesters(display_name,kind,external_id,created_by)
      values(btrim(p_data->>'displayName'),v_kind,v_external,a.id) returning * into r;
  end if;
  update public.requesters set
    display_name=btrim(p_data->>'displayName'), external_id=v_external, email=v_email,
    first_name=nullif(btrim(p_data->>'firstName'),''),last_name=nullif(btrim(p_data->>'lastName'),''),
    school_dbn=case when v_kind='staff' then nullif(btrim(p_data->>'schoolDbn'),'') end,
    department=case when v_kind='staff' then nullif(btrim(p_data->>'department'),'') end,
    staff_role=case when v_kind='staff' then nullif(btrim(p_data->>'staffRole'),'') end,
    student_status=case when v_kind='student' then coalesce(p_data->>'studentStatus','current') end,
    class_of=case when v_kind='student' then nullif(btrim(p_data->>'classOf'),'') end,
    official_class=case when v_kind='student' then nullif(btrim(p_data->>'officialClass'),'') end,
    guardian_name=case when v_kind='student' then nullif(btrim(p_data->>'guardianName'),'') end,
    guardian_phone=case when v_kind='student' then nullif(btrim(p_data->>'guardianPhone'),'') end,
    home_phone=case when v_kind='student' then nullif(btrim(p_data->>'homePhone'),'') end,
    address=case when v_kind='student' then nullif(btrim(p_data->>'address'),'') end,
    notes=nullif(btrim(p_data->>'notes'),''),
    -- Ticked and already archived keeps the date it already has; ticked and not
    -- archived stamps now; unticked clears. Not mentioned changes nothing.
    archived_at=case
      when v_archived is null then archived_at
      when v_archived then coalesce(archived_at, pg_catalog.now())
      else null
    end
    where id=r.id returning * into r;
  insert into public.inventory_events(entity,entity_id,actor_id,before_record,after_record) values(v_kind,r.id,a.id,v_before,to_jsonb(r));
  return r.id;
exception when unique_violation then
  raise exception 'That OSIS or Staff ID is already in use. Open the existing record instead.' using errcode='unique_violation';
end;
$$;

revoke all on function public.app_save_person(uuid,integer,jsonb) from public,anon;
grant execute on function public.app_save_person(uuid,integer,jsonb) to authenticated;
