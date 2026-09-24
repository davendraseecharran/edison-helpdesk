-- NetRiders may delete an inventory record too, not only administrators.
--
-- The user's call (2026-09-24): every delete is already written in full to
-- inventory_events (the whole row) and to record_events (a readable line with
-- the identifiers and who did it), where an administrator can search who
-- deleted what. The refusals are unchanged — nothing assigned, linked to a
-- ticket, named in device notes, carrying attachments or referenced anywhere
-- else can be deleted, and each refusal still suggests Retired. Only the gate
-- moves from administrator to anybody who works tickets (administrator or
-- NetRider); a skills officer still cannot.

create or replace function public.app_delete_inventory_device(
  p_device uuid,
  p_reason text default null,
  p_version integer default null
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_before public.inventory_devices;
  v_label text;
  v_reason text := nullif(pg_catalog.btrim(coalesce(p_reason, '')), '');
  v_holder text;
  v_count integer;
  v_detail text;
begin
  v_actor := public.app_require_actor();
  if not public.app_can_work_tickets() then
    raise exception 'Only an administrator or a NetRider can delete an inventory record. Mark it Retired instead.'
      using errcode = 'insufficient_privilege';
  end if;

  if p_device is null then
    raise exception 'Choose the record to delete.' using errcode = 'check_violation';
  end if;
  if v_reason is not null and pg_catalog.length(v_reason) > 500 then
    raise exception 'Keep the reason under 500 characters.' using errcode = 'check_violation';
  end if;

  select * into v_before from public.inventory_devices d where d.id = p_device for update;
  if not found then
    raise exception 'That device is not in the inventory. It may have been deleted already.'
      using errcode = 'no_data_found';
  end if;
  perform public.app_require_inventory_version(v_before, p_version);

  v_label := public.app_device_label(v_before);

  if v_before.assigned_requester_id is not null then
    select r.display_name into v_holder from public.requesters r where r.id = v_before.assigned_requester_id;
    raise exception '% is with %. Return it first, or mark it Retired instead of deleting it.',
      v_label, coalesce(v_holder, 'somebody')
      using errcode = 'check_violation';
  end if;

  select pg_catalog.count(*)::integer into v_count
  from public.ticket_devices td where td.device_id = p_device;
  if v_count > 0 then
    raise exception '% is linked to % %. Keep the record and mark it Retired instead.',
      v_label, v_count, case when v_count = 1 then 'ticket' else 'tickets' end
      using errcode = 'check_violation';
  end if;

  if exists (
    select 1 from public.device_observations o where o.inventory_device_id = p_device
  ) then
    raise exception '% is named on a ticket. Keep the record and mark it Retired instead.', v_label
      using errcode = 'check_violation';
  end if;

  select pg_catalog.count(*)::integer into v_count
  from public.attachments a where a.device_id = p_device;
  if v_count > 0 then
    raise exception '% has % attached. Remove them on its page first, or mark it Retired instead.',
      v_label, case when v_count = 1 then 'a file' else v_count || ' files' end
      using errcode = 'check_violation';
  end if;

  -- The identifiers, because after this the audit log cannot look them up.
  v_detail := pg_catalog.concat_ws(
    '. ',
    case when v_reason is not null then 'Reason: ' || v_reason end,
    pg_catalog.concat_ws(
      ', ',
      case when nullif(pg_catalog.btrim(coalesce(v_before.asset_tag, '')), '') is not null
        then 'asset tag ' || v_before.asset_tag end,
      case when nullif(pg_catalog.btrim(coalesce(v_before.serial_number, '')), '') is not null
        then 'serial ' || v_before.serial_number end,
      'inventory id ' || v_before.external_id,
      nullif(pg_catalog.btrim(pg_catalog.concat_ws(' ', v_before.manufacturer, v_before.model)), ''),
      case when nullif(pg_catalog.btrim(coalesce(v_before.location, '')), '') is not null
        then 'recorded in ' || v_before.location end
    )
  ) || '.';

  insert into public.inventory_events (entity, entity_id, actor_id, before_record, after_record)
  values (
    'device', p_device, v_actor.id,
    pg_catalog.to_jsonb(v_before),
    pg_catalog.jsonb_build_object('deleted', true, 'reason', v_reason)
  );

  perform public.app_log_record_event(
    'inventory_device', p_device, 'deleted', v_actor.id,
    v_actor.display_name || ' deleted the record ' || v_label,
    v_detail
  );

  begin
    delete from public.inventory_devices d where d.id = p_device;
  exception
    when foreign_key_violation then
      raise exception '% is still named somewhere else in the helpdesk. Keep the record and mark it Retired instead.',
        v_label
        using errcode = 'check_violation';
  end;

  return pg_catalog.jsonb_build_object('id', p_device, 'label', v_label);
end;
$$;

comment on function public.app_delete_inventory_device(uuid, text, integer) is
  'Deletes one inventory record that should never have existed (a typo, a duplicate), for an administrator or a NetRider. Refused while the machine is assigned, linked to a ticket, named in ticket device notes, has attachments, or is referenced anywhere else; each refusal suggests the Retired status instead. Writes the whole row to inventory_events and a readable line, with the identifiers, to record_events.';

revoke all on function public.app_delete_inventory_device(uuid, text, integer) from public, anon, authenticated;
grant execute on function public.app_delete_inventory_device(uuid, text, integer) to authenticated;
