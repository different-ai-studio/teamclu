-- Inbox MQTT ACL: members/agents must SUB `inbox/<auth.user_id>` so FC push
-- fan-out (push-dispatch.ts) can drive unread dots and debounced session-list
-- reloads. Previously only amux/* rules existed; session-list discovery silently
-- relied on the team wildcard `amux/{team}/session/+/live` instead.

create or replace function amux.amux_access_token_hook(event jsonb) returns jsonb
    language plpgsql stable security definer
    set search_path to 'amux', 'public', 'auth', 'extensions'
    as $$
declare
  v_user_id     uuid;
  v_claims      jsonb;
  v_memberships jsonb;
  v_acl         jsonb;
  v_org         uuid;
  v_inbox_rule  jsonb;
begin
  v_user_id := nullif(event->>'user_id','')::uuid;
  if v_user_id is null then
    return event;
  end if;
  v_claims := coalesce(event->'claims', '{}'::jsonb);

  select coalesce(
    jsonb_agg(jsonb_build_object(
      'team_id', a.team_id::text, 'actor_id', a.id::text, 'actor_type', a.actor_type
    ) order by a.team_id, a.id),
    '[]'::jsonb)
    into v_memberships
    from amux.actors a where a.user_id = v_user_id;

  v_inbox_rule := jsonb_build_object(
    'permission', 'allow',
    'action',     'sub',
    'topic',      format('inbox/%s', v_user_id)
  );

  with expanded as (
    select jsonb_build_object('permission','allow','action',r.action,'topic',r.topic) as rule
      from amux.actors a,
           lateral amux.amux_acl_rules_for(a.team_id, a.id, a.actor_type) r
     where a.user_id = v_user_id
  )
  select coalesce(jsonb_agg(rule), '[]'::jsonb)
         || jsonb_build_array(v_inbox_rule)
         || jsonb_build_array(jsonb_build_object('permission','deny','action','all','topic','#'))
    into v_acl from expanded;

  -- org_id: existing claim > public.users > agent actor's team oid (daemon users)
  v_org := coalesce(
    nullif(v_claims->'app_metadata'->>'org_id','')::uuid,
    (select u.org_id from public.users u where u.id = v_user_id limit 1),
    (select t.oid
       from amux.actors a
       join amux.teams t on t.id = a.team_id
      where a.user_id = v_user_id
        and a.actor_type = 'agent'
        and t.oid is not null
      limit 1)
  );

  v_claims := v_claims
    || jsonb_build_object('acl', v_acl)
    || jsonb_build_object('app_metadata',
         coalesce(v_claims->'app_metadata', '{}'::jsonb)
         || jsonb_build_object('memberships', v_memberships)
         || case when v_org is not null then jsonb_build_object('org_id', v_org::text) else '{}'::jsonb end
       );

  return jsonb_build_object('claims', v_claims);
exception when others then
  return event;
end;
$$;
