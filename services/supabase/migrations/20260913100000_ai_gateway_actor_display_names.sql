-- Usage reports need actor display names for the billing leaderboard.
-- amux.actors carries RLS for `authenticated` only; the `ai_gateway` role is
-- neither the table owner nor covered by those policies, so a plain SELECT
-- returns zero rows (same trap as amux.ai_gateway_resolve_actor). Without this
-- helper every byActor row ships displayName=null and the UI labels them all
-- "Unattributed" / 「未归属」.

create or replace function amux.ai_gateway_actor_display_names(p_team_id uuid)
returns table (id uuid, display_name text)
language sql
stable
security definer
set search_path = amux, public
as $$
  select a.id, a.display_name
    from amux.actors a
   where a.team_id = p_team_id
$$;

comment on function amux.ai_gateway_actor_display_names(uuid) is
  'Lists actor id + display_name for one team, bypassing actors RLS so the AI gateway can label usage reports.';

revoke all on function amux.ai_gateway_actor_display_names(uuid) from public, anon, authenticated;
grant execute on function amux.ai_gateway_actor_display_names(uuid) to ai_gateway, service_role;
