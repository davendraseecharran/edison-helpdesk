-- ---------------------------------------------------------------------------
-- A group has as many checklist columns as it needs.
--
-- Six was a guess about phones; the chapter asked for however many a roster
-- calls for. The only ceiling left is forty, a guard against a runaway
-- script rather than a design. Restates app_save_group_field from
-- 20260916130300_m5_group_events.sql with that one block changed.
-- ---------------------------------------------------------------------------
create or replace function public.app_save_group_field(
  p_field uuid,
  p_group uuid,
  p_name text,
  p_position integer
)
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_actor public.app_accounts;
  v_name text;
  v_position integer;
  v_group uuid;
  v_count integer;
  v_id uuid;
begin
  v_actor := public.app_require_actor();

  v_name := pg_catalog.btrim(coalesce(p_name, ''));
  if v_name = '' then
    raise exception 'Give the column a name.' using errcode = 'check_violation';
  end if;
  if pg_catalog.length(v_name) > 40 then
    raise exception 'A column name is 40 characters at most.' using errcode = 'check_violation';
  end if;
  v_position := greatest(0, least(coalesce(p_position, 0), 99));

  if p_field is null then
    select g.id into v_group from public.people_groups g where g.id = p_group for update;
    if v_group is null then
      raise exception 'There is no group with that id.' using errcode = 'check_violation';
    end if;

    select pg_catalog.count(*)::integer into v_count
    from public.group_fields f
    where f.group_id = v_group;

    -- No practical limit: a roster has as many columns as the chapter needs
    -- to tick. Forty is a guard against a runaway script, not a design.
    if v_count >= 40 then
      raise exception 'A group has forty columns at most. Delete one before adding another.'
        using errcode = 'check_violation';
    end if;

    begin
      insert into public.group_fields (group_id, name, position)
      values (v_group, v_name, v_position)
      returning id into v_id;
    exception
      when unique_violation then
        raise exception 'There is already a column called % on this group.', v_name
          using errcode = 'check_violation';
    end;

    return v_id;
  end if;

  -- An edit. The group is the field's own; a caller that names a different one
  -- is not moving a column between rosters, it is wrong, and the stored group
  -- is what the uniqueness rule is checked against anyway.
  select f.group_id into v_group from public.group_fields f where f.id = p_field for update;
  if v_group is null then
    raise exception 'There is no column with that id.' using errcode = 'check_violation';
  end if;

  begin
    update public.group_fields f
    set name = v_name,
        position = v_position
    where f.id = p_field;
  exception
    when unique_violation then
      raise exception 'There is already a column called % on this group.', v_name
        using errcode = 'check_violation';
  end;

  return p_field;
end;
$$;

