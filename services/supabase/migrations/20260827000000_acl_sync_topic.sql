-- Allow member and agent MQTT clients to SUBSCRIBE `amux/<team>/sync/+`.
--
-- Facts for operators:
-- - ACL is baked into the JWT by amux_access_token_hook. Existing MQTT
--   connections keep the old claim until the access token rotates (TTL 3600s).
--   The daemon rebuilds its MQTT connection ~5 minutes before expiry, so
--   within ≤1 hour after this migration every daemon can subscribe.
-- - Task 8's subscribe path is tolerant of ACL deny / missing topic: shipping
--   this migration and the daemon subscribe change in the same release is OK.
--   Migrate-first is advice, not a hard gate.
-- - Postgres / Better-Auth backends mint no `acl` claim; all-in-one NanoMQ has
--   no ACL. This migration only matters on the Supabase backend — do not
--   validate the rule against all-in-one.

create or replace function public.amux_acl_rules_for(
  p_team  uuid,
  p_actor uuid,
  p_type  text
) returns table (action text, topic text)
language sql
immutable
set search_path = public
as $$
  select action, topic
    from (values
      ('sub', format('amux/%s/user/%s/notify',              p_team, p_actor)),
      ('sub', format('amux/%s/session/+/live',              p_team)),
      ('sub', format('amux/%s/+/state',                     p_team)),
      ('sub', format('amux/%s/+/runtime/+/state',           p_team)),
      ('sub', format('amux/%s/+/runtime/+/events',          p_team)),
      ('sub', format('amux/%s/+/rpc/res',                   p_team)),
      ('sub', format('amux/%s/%s/rpc/req',                  p_team, p_actor)),
      ('sub', format('amux/%s/sync/+',                      p_team)),
      ('pub', format('amux/%s/+/rpc/req',                   p_team)),
      ('pub', format('amux/%s/+/runtime/+/commands',        p_team))
    ) as r(action, topic)
   where p_type = 'member'

  union all

  select action, topic
    from (values
      ('pub', format('amux/%s/%s/state',                    p_team, p_actor)),
      ('pub', format('amux/%s/%s/runtime/+/state',          p_team, p_actor)),
      ('pub', format('amux/%s/%s/runtime/+/events',         p_team, p_actor)),
      ('pub', format('amux/%s/%s/notify',                   p_team, p_actor)),
      ('pub', format('amux/%s/+/rpc/res',                   p_team)),
      ('pub', format('amux/%s/+/rpc/req',                   p_team)),
      ('pub', format('amux/%s/session/+/live',              p_team)),
      ('pub', format('amux/%s/user/+/notify',               p_team)),
      ('sub', format('amux/%s/%s/runtime/+/commands',       p_team, p_actor)),
      ('sub', format('amux/%s/%s/rpc/req',                  p_team, p_actor)),
      ('sub', format('amux/%s/%s/notify',                   p_team, p_actor)),
      ('sub', format('amux/%s/session/+/live',              p_team)),
      ('sub', format('amux/%s/user/%s/notify',               p_team, p_actor)),
      ('sub', format('amux/%s/sync/+',                      p_team))
    ) as r(action, topic)
   where p_type = 'agent';
$$;

revoke execute on function public.amux_acl_rules_for(uuid, uuid, text) from public, anon, authenticated;
grant  execute on function public.amux_acl_rules_for(uuid, uuid, text) to supabase_auth_admin;

create or replace function amux.amux_acl_rules_for(p_team uuid, p_actor uuid, p_type text)
returns table (action text, topic text)
language sql
immutable
set search_path = amux, public
as $$
  select action, topic from public.amux_acl_rules_for(p_team, p_actor, p_type)
$$;

revoke execute on function amux.amux_acl_rules_for(uuid, uuid, text) from public, anon, authenticated;
grant  execute on function amux.amux_acl_rules_for(uuid, uuid, text) to supabase_auth_admin;
