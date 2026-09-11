-- Trigger functions inherit EXECUTE for PUBLIC by default, which leaves them
-- listed as callable RPCs. PostgreSQL checks EXECUTE on a trigger function when
-- the trigger is CREATED, not when it fires, so revoking here does not affect
-- the triggers themselves — it only removes a pointless public entry point.

revoke execute on function
  public.app_tickets_guard(),
  public.app_collaborator_guard(),
  public.app_work_log_guard(),
  public.app_append_only()
from public, anon, authenticated;
