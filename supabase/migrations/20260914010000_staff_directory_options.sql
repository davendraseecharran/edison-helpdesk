-- Staff profile suggestions are read through an authenticated RPC so the
-- browser does not need direct access to the directory table.
create function public.app_staff_directory_options()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  perform public.app_require_actor();
  return jsonb_build_object(
    'departments', coalesce(
      (
        select jsonb_agg(value order by lower(value), value)
        from (
          select distinct btrim(r.department) as value
          from public.requesters r
          where r.kind = 'staff'
            and nullif(btrim(r.department), '') is not null
        ) options
      ),
      '[]'::jsonb
    ),
    'roles', coalesce(
      (
        select jsonb_agg(value order by lower(value), value)
        from (
          select distinct btrim(r.staff_role) as value
          from public.requesters r
          where r.kind = 'staff'
            and nullif(btrim(r.staff_role), '') is not null
        ) options
      ),
      '[]'::jsonb
    )
  );
end;
$$;

revoke all on function public.app_staff_directory_options() from public, anon;
grant execute on function public.app_staff_directory_options() to authenticated;
