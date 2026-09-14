-- Inventory is shared by active technicians and administrators. Writes use
-- authenticated RPCs, revision checks, and append-only audit records.
alter table public.requesters
  add column source_external_id text,
  add column first_name text,
  add column last_name text,
  add column email text,
  add column school_dbn text,
  add column department text,
  add column staff_role text,
  add column class_of text,
  add column student_status text default 'current' check(student_status in ('current','graduated','other')),
  add column official_class text,
  add column guardian_name text,
  add column guardian_phone text,
  add column home_phone text,
  add column address text,
  add column notes text,
  add column version integer not null default 1,
  add column updated_at timestamptz not null default now();
update public.requesters set source_external_id = external_id;
create unique index requesters_source_key on public.requesters(kind,source_external_id) where source_external_id is not null;
alter table public.inventory_devices
  add column notes text,
  add column version integer not null default 1,
  add column updated_at timestamptz not null default now();
create index inventory_serial_lookup on public.inventory_devices(lower(serial_number));

create table public.inventory_events (
  id uuid primary key default gen_random_uuid(),
  entity text not null check(entity in ('student','staff','device')),
  entity_id uuid not null,
  actor_id uuid not null references public.app_accounts(id),
  at timestamptz not null default now(),
  before_record jsonb,
  after_record jsonb not null
);
alter table public.inventory_events enable row level security;
revoke all on public.inventory_events from public, anon, authenticated;
grant select,insert on public.inventory_events to service_role;
create index inventory_events_entity on public.inventory_events(entity,entity_id,at);
create function public.app_inventory_revision() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  new.version := old.version + 1;
  new.updated_at := clock_timestamp();
  return new;
end;
$$;
revoke all on function public.app_inventory_revision() from public,anon,authenticated;
create trigger requesters_revision before update on public.requesters for each row execute function public.app_inventory_revision();
create trigger inventory_devices_revision before update on public.inventory_devices for each row execute function public.app_inventory_revision();
create function public.app_inventory_audit_immutable() returns trigger
language plpgsql set search_path = '' as $$
begin raise exception 'Inventory history cannot be changed.' using errcode='insufficient_privilege'; end;
$$;
revoke all on function public.app_inventory_audit_immutable() from public,anon,authenticated;
create trigger inventory_events_immutable before update or delete on public.inventory_events for each row execute function public.app_inventory_audit_immutable();

-- Whitelisted JSON projections shared by list/detail RPCs; internal helpers
-- cannot be invoked by clients and expose no account credentials.
create function public.app_person_json(r public.requesters) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object(
    'id',r.id,'kind',r.kind,'displayName',r.display_name,'externalId',coalesce(r.external_id,''),
    'firstName',coalesce(r.first_name,''),'lastName',coalesce(r.last_name,''),'email',coalesce(r.email,''),
    'schoolDbn',coalesce(r.school_dbn,''),'department',coalesce(r.department,''),'staffRole',coalesce(r.staff_role,''),
    'classOf',coalesce(r.class_of,''),'studentStatus',coalesce(r.student_status,'current'),'officialClass',coalesce(r.official_class,''),
    'guardianName',coalesce(r.guardian_name,''),'guardianPhone',coalesce(r.guardian_phone,''),
    'homePhone',coalesce(r.home_phone,''),'address',coalesce(r.address,''),'notes',coalesce(r.notes,''),
    'version',r.version,'updatedAt',r.updated_at,
    'deviceCount',(select count(*) from public.inventory_devices d where d.assigned_requester_id=r.id));
$$;
create function public.app_inventory_device_json(d public.inventory_devices) returns jsonb
language sql stable security definer set search_path = '' as $$
  select jsonb_build_object('id',d.id,'externalId',d.external_id,'deviceType',d.device_type,
    'manufacturer',d.manufacturer,'model',coalesce(d.model,''),'osVersion',coalesce(d.os_version,''),
    'serialNumber',coalesce(d.serial_number,''),'assetTag',coalesce(d.asset_tag,''),
    'status',coalesce(d.status,''),'location',coalesce(d.location,''),'notes',coalesce(d.notes,''),
    'assignedRequesterId',d.assigned_requester_id,
    'assignedName',(select r.display_name from public.requesters r where r.id=d.assigned_requester_id),
    'assignedKind',(select r.kind from public.requesters r where r.id=d.assigned_requester_id),
    'version',d.version,'updatedAt',d.updated_at);
$$;
revoke all on function public.app_person_json(public.requesters), public.app_inventory_device_json(public.inventory_devices) from public,anon,authenticated;

create function public.app_list_people(p_kind text,p_query text default '',p_page integer default 1)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_query text := lower(btrim(coalesce(p_query,''))); v_result jsonb;
begin
  perform public.app_require_actor();
  if p_kind is null or p_kind not in ('student','staff') then raise exception 'Choose students or staff.'; end if;
  if p_page is null or p_page < 1 or p_page > 100000 or length(v_query)>120 then raise exception 'Invalid search or page.'; end if;
  with matches as materialized (
    select r.* from public.requesters r where r.kind=p_kind and (v_query='' or strpos(lower(concat_ws(' ',
      r.display_name,r.external_id,r.email,r.first_name,r.last_name,r.school_dbn,r.department,r.staff_role,
      r.class_of,r.student_status,r.official_class,r.guardian_name,r.guardian_phone,r.home_phone,r.address,r.notes)),v_query)>0)
  ), page as (select * from matches order by display_name,id limit 50 offset ((p_page-1)*50))
  select jsonb_build_object('rows',coalesce((select jsonb_agg(public.app_person_json(p::public.requesters) order by p.display_name,p.id) from page p),'[]'::jsonb),
    'total',(select count(*) from matches),'page',p_page,'pageSize',50) into v_result;
  return v_result;
end;
$$;
create function public.app_get_person(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare r public.requesters;
begin
  perform public.app_require_actor();
  select * into r from public.requesters where id=p_id and kind in ('student','staff');
  if not found then raise exception 'That person no longer exists.'; end if;
  return public.app_person_json(r);
end;
$$;
create function public.app_list_inventory(p_query text default '',p_page integer default 1,p_requester uuid default null)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare v_query text:=lower(btrim(coalesce(p_query,''))); v_result jsonb;
begin
  perform public.app_require_actor();
  if p_page is null or p_page<1 or p_page>100000 or length(v_query)>120 then raise exception 'Invalid search or page.'; end if;
  with matches as materialized (
    select d.* from public.inventory_devices d left join public.requesters r on r.id=d.assigned_requester_id
    where (p_requester is null or d.assigned_requester_id=p_requester)
      and (v_query='' or strpos(lower(concat_ws(' ',d.external_id,d.device_type,d.manufacturer,d.model,d.os_version,
        d.serial_number,d.asset_tag,d.status,d.location,d.notes,r.display_name,r.external_id,r.email)),v_query)>0)
  ), page as (select * from matches order by device_type,manufacturer,model,id limit 50 offset ((p_page-1)*50))
  select jsonb_build_object('rows',coalesce((select jsonb_agg(public.app_inventory_device_json(p::public.inventory_devices) order by p.device_type,p.manufacturer,p.model,p.id) from page p),'[]'::jsonb),
    'total',(select count(*) from matches),'page',p_page,'pageSize',50) into v_result;
  return v_result;
end;
$$;
create function public.app_get_inventory_device(p_id uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare d public.inventory_devices;
begin
  perform public.app_require_actor();
  select * into d from public.inventory_devices where id=p_id;
  if not found then raise exception 'That device no longer exists.'; end if;
  return public.app_inventory_device_json(d);
end;
$$;
create function public.app_inventory_statuses() returns jsonb
language plpgsql security definer set search_path = '' as $$
begin
  perform public.app_require_actor();
  return (select coalesce(jsonb_agg(s order by s),'[]'::jsonb) from
    (select distinct status as s from public.inventory_devices where nullif(btrim(status),'') is not null
     union select unnest(array['Available','Assigned','In repair','Retired','Lost'])) q);
end;
$$;

-- Restrict fields by meaning in the RPC as well as in browser controls.
create function public.app_validate_profile(p_data jsonb) returns void
language plpgsql set search_path = '' as $$
declare v_key text; v_value text; v_limit integer;
begin
  if p_data is null or jsonb_typeof(p_data)<>'object' then raise exception 'Provide a record.'; end if;
  for v_key,v_value in select key,value from jsonb_each_text(p_data) loop
    v_limit:=case v_key when 'notes' then 6000 when 'address' then 500 when 'email' then 254 else 120 end;
    if length(coalesce(v_value,''))>v_limit then raise exception 'The % field is too long (maximum % characters).',v_key,v_limit; end if;
  end loop;
  if nullif(btrim(p_data->>'email'),'') is not null and btrim(p_data->>'email') !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' then
    raise exception 'Enter a valid email address.' using errcode='check_violation';
  end if;
  if p_data ? 'studentStatus' and (p_data->>'studentStatus' is null or p_data->>'studentStatus' not in ('current','graduated','other')) then raise exception 'Choose a valid enrollment status.'; end if;
  if nullif(btrim(p_data->>'classOf'),'') is not null and btrim(p_data->>'classOf') !~ '^[0-9]{4}$' then
    raise exception 'Class of must be a four-digit year.' using errcode='check_violation';
  end if;
  foreach v_key in array array['guardianPhone','homePhone'] loop
    v_value:=nullif(btrim(p_data->>v_key),'');
    if v_value is not null and (v_value !~ '^[+0-9() .xX-]{7,30}$' or v_value !~ '[0-9]') then
      raise exception 'Enter a valid phone number for %.',v_key using errcode='check_violation';
    end if;
  end loop;
end;
$$;
revoke all on function public.app_validate_profile(jsonb) from public,anon,authenticated;

create function public.app_save_person(p_id uuid,p_version integer,p_data jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare a public.app_accounts; r public.requesters; v_before jsonb; v_kind text; v_external text; v_email text;
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
    notes=nullif(btrim(p_data->>'notes'),'') where id=r.id returning * into r;
  insert into public.inventory_events(entity,entity_id,actor_id,before_record,after_record) values(v_kind,r.id,a.id,v_before,to_jsonb(r));
  return r.id;
exception when unique_violation then
  raise exception 'That OSIS or Staff ID is already in use. Open the existing record instead.' using errcode='unique_violation';
end;
$$;

create function public.app_save_inventory_device(p_id uuid,p_version integer,p_data jsonb) returns uuid
language plpgsql security definer set search_path = '' as $$
declare a public.app_accounts; d public.inventory_devices; v_before jsonb; v_key text; v_value text; v_serial text; v_assignee uuid;
begin
  a:=public.app_require_actor();
  perform public.app_validate_profile(p_data);
  foreach v_key in array array['deviceType','manufacturer','model','serialNumber'] loop
    if length(btrim(coalesce(p_data->>v_key,'')))=0 then raise exception 'Device type, manufacturer, model and serial number are required.'; end if;
  end loop;
  v_serial:=btrim(p_data->>'serialNumber');
  v_assignee:=nullif(p_data->>'assignedRequesterId','')::uuid;
  if v_assignee is not null and not exists(select 1 from public.requesters r where r.id=v_assignee and r.kind in ('staff','student')) then
    raise exception 'Select an existing student or staff member for the assignment.';
  end if;
  if p_id is not null then
    select * into d from public.inventory_devices where id=p_id for update;
    if not found then raise exception 'That device no longer exists.'; end if;
    if p_version is distinct from d.version then raise exception 'This device changed since you opened it. Reload it before saving.' using errcode='serialization_failure'; end if;
    v_before:=to_jsonb(d);
  end if;
  -- Serialize competing new serials; legacy duplicates remain editable unless
  -- their serial is changed. No old rows are deleted or silently merged.
  perform pg_advisory_xact_lock(hashtextextended(lower(v_serial),1162103124));
  if (p_id is null or lower(v_serial) is distinct from lower(d.serial_number)) and exists(
    select 1 from public.inventory_devices i where lower(i.serial_number)=lower(v_serial) and i.id is distinct from p_id
  ) then raise exception 'That serial number is already recorded in inventory.' using errcode='unique_violation'; end if;
  if p_id is null then
    insert into public.inventory_devices(external_id,device_type,manufacturer,model,serial_number)
      values('DEV-'||upper(substr(replace(gen_random_uuid()::text,'-',''),1,12)),btrim(p_data->>'deviceType'),btrim(p_data->>'manufacturer'),btrim(p_data->>'model'),v_serial)
      returning * into d;
  end if;
  update public.inventory_devices set device_type=btrim(p_data->>'deviceType'),manufacturer=btrim(p_data->>'manufacturer'),model=btrim(p_data->>'model'),
    serial_number=v_serial,os_version=nullif(btrim(p_data->>'osVersion'),''),asset_tag=nullif(btrim(p_data->>'assetTag'),''),
    status=nullif(btrim(p_data->>'status'),''),location=nullif(btrim(p_data->>'location'),''),notes=nullif(btrim(p_data->>'notes'),''),assigned_requester_id=v_assignee
    where id=d.id returning * into d;
  insert into public.device_catalog(device_type,manufacturer,model) values(d.device_type,d.manufacturer,d.model) on conflict do nothing;
  insert into public.inventory_events(entity,entity_id,actor_id,before_record,after_record) values('device',d.id,a.id,v_before,to_jsonb(d));
  return d.id;
end;
$$;

revoke all on function public.app_list_people(text,text,integer),public.app_get_person(uuid),public.app_list_inventory(text,integer,uuid),public.app_get_inventory_device(uuid),public.app_inventory_statuses(),public.app_save_person(uuid,integer,jsonb),public.app_save_inventory_device(uuid,integer,jsonb) from public,anon;
grant execute on function public.app_list_people(text,text,integer),public.app_get_person(uuid),public.app_list_inventory(text,integer,uuid),public.app_get_inventory_device(uuid),public.app_inventory_statuses(),public.app_save_person(uuid,integer,jsonb),public.app_save_inventory_device(uuid,integer,jsonb) to authenticated;
