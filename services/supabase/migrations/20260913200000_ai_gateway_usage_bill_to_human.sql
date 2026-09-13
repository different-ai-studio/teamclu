-- Roll agent usage up to the owning human on the billing leaderboard.
-- Replaces the id→display_name helper from 20260913100000: Settings should
-- attribute spend to humans (agents.owner_member_id), not to each device agent.
-- Same RLS reason as ai_gateway_resolve_actor — the ai_gateway role cannot
-- read amux.actors / amux.agents directly.

create or replace function amux.ai_gateway_usage_bill_to(p_team_id uuid)
returns table (usage_actor_id uuid, bill_to_actor_id uuid, display_name text)
language sql
stable
security definer
set search_path = amux, public
as $$
  select a.id as usage_actor_id,
         coalesce(ag.owner_member_id, a.id) as bill_to_actor_id,
         coalesce(owner.display_name, a.display_name) as display_name
    from amux.actors a
    left join amux.agents ag on ag.id = a.id
    left join amux.actors owner on owner.id = ag.owner_member_id
   where a.team_id = p_team_id
$$;

comment on function amux.ai_gateway_usage_bill_to(uuid) is
  'Maps each team actor to the human the usage leaderboard should credit: agents roll up to owner_member_id; members stay themselves. Bypasses actors/agents RLS for the AI gateway.';

revoke all on function amux.ai_gateway_usage_bill_to(uuid) from public, anon, authenticated;
grant execute on function amux.ai_gateway_usage_bill_to(uuid) to ai_gateway, service_role;

-- Keep the old helper working for anything that might still call it, but point
-- it at the same attribution rule (bill_to id + human display name).
create or replace function amux.ai_gateway_actor_display_names(p_team_id uuid)
returns table (id uuid, display_name text)
language sql
stable
security definer
set search_path = amux, public
as $$
  select distinct on (b.bill_to_actor_id)
         b.bill_to_actor_id as id,
         b.display_name
    from amux.ai_gateway_usage_bill_to(p_team_id) b
   order by b.bill_to_actor_id, b.usage_actor_id
$$;
