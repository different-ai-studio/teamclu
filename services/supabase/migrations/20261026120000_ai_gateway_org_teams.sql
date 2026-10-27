-- Org -> teams lookup for the gateway's internal org-level credit endpoints.
--
-- Credits are ledgered per team, but the internal platform addresses customers
-- by org. amux.teams carries RLS and the gateway is not service_role, so a
-- plain select returns zero rows; same remedy as ai_gateway_resolve_actor:
-- security definer, pinned search_path, granted to exactly the roles needed.
create or replace function amux.ai_gateway_org_teams(p_org_id uuid)
returns table (team_id uuid, team_name text)
language sql
stable
security definer
set search_path = amux, public
as $$
  select t.id, t.name
    from amux.teams t
   where t.oid = p_org_id
   order by t.created_at
$$;

comment on function amux.ai_gateway_org_teams(uuid) is
  'Teams belonging to one org (teams.oid). Gateway-internal; the org id comes from a service-token caller, never an end user.';

revoke all on function amux.ai_gateway_org_teams(uuid) from public, anon, authenticated;
grant execute on function amux.ai_gateway_org_teams(uuid) to ai_gateway, service_role;
