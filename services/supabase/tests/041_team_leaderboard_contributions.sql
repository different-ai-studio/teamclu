-- services/supabase/tests/041_team_leaderboard_contributions.sql
-- team_leaderboard_contributions: published skills and created apps per member,
-- the same for every viewer (SECURITY DEFINER past apps RLS), agents rolled up
-- to their owner, strangers get nothing.
begin;
select plan(8);

create or replace function pg_temp.as_user(p_user uuid)
returns void language plpgsql as $$
begin
  perform set_config('request.jwt.claims',
                     json_build_object('sub', p_user::text, 'role', 'authenticated')::text,
                     true);
  perform set_config('role', 'authenticated', true);
end;
$$;

create temp table ctx (
  team_id uuid, other_team_id uuid,
  alice_uid uuid, bob_uid uuid, eve_uid uuid,
  alice uuid, bob uuid, bob_agent uuid, eve_elsewhere uuid
);
insert into ctx values (
  gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(),
  gen_random_uuid(), gen_random_uuid(), gen_random_uuid(), gen_random_uuid()
);
grant select on ctx to authenticated;

insert into auth.users (id, email, aud, role, instance_id, is_anonymous)
select u.id, u.email, 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000', false
  from ctx, lateral (values
    (ctx.alice_uid, 'alice-lbc@amux.test'),
    (ctx.bob_uid,   'bob-lbc@amux.test'),
    (ctx.eve_uid,   'eve-lbc@amux.test')
  ) as u(id, email)
on conflict do nothing;

insert into amux.teams (id, slug, name)
select team_id, 'lbc-' || left(team_id::text, 8), 'Leaderboard Contributions' from ctx
union all
select other_team_id, 'lbc-other-' || left(other_team_id::text, 8), 'Somewhere Else' from ctx;

insert into amux.actors (id, team_id, actor_type, display_name, user_id)
select alice, team_id, 'member', 'Alice', alice_uid from ctx
union all select bob, team_id, 'member', 'Bob', bob_uid from ctx
union all select eve_elsewhere, other_team_id, 'member', 'Eve', eve_uid from ctx;

insert into amux.members (id, status)
select alice, 'active' from ctx
union all select bob, 'active' from ctx
union all select eve_elsewhere, 'active' from ctx;

insert into amux.team_members (team_id, member_id, role)
select team_id, alice, 'owner' from ctx
union all select team_id, bob, 'member' from ctx
union all select other_team_id, eve_elsewhere, 'owner' from ctx;

insert into amux.actors (id, team_id, actor_type, display_name)
select bob_agent, team_id, 'agent', 'Bob''s daemon' from ctx;
insert into amux.agents (id, status, owner_member_id)
select bob_agent, 'active', bob from ctx;

-- Skills: Alice published two (one since deprecated) and has a draft; Bob's
-- daemon published one; one row has lost its publisher.
insert into amux.team_skills
  (team_id, slug, summary, category, when_to_use, when_not_to_use, status, created_by)
select team_id, s.slug, 'summary', 'general', 'when', 'when not', s.status, s.created_by
  from ctx, lateral (values
    ('alice-one',   'published',  ctx.alice),
    ('alice-two',   'deprecated', ctx.alice),
    ('alice-draft', 'draft',      ctx.alice),
    ('agent-skill', 'published',  ctx.bob_agent),
    ('orphan',      'published',  null::uuid)
  ) as s(slug, status, created_by);

-- Apps: Alice one personal; Bob one personal + one team; Bob's daemon one
-- personal; Eve one in another team.
insert into amux.apps (team_id, created_by_actor_id, name, slug, type, visibility)
select a.team_id, a.creator, a.slug, a.slug, 'web', a.visibility
  from ctx, lateral (values
    (ctx.team_id,       ctx.alice,         'alice-app',      'personal'),
    (ctx.team_id,       ctx.bob,           'bob-private',    'personal'),
    (ctx.team_id,       ctx.bob,           'bob-shared',     'team'),
    (ctx.team_id,       ctx.bob_agent,     'bob-agent-app',  'personal'),
    (ctx.other_team_id, ctx.eve_elsewhere, 'eve-app',        'personal')
  ) as a(team_id, creator, slug, visibility);

-- 1
select has_function('amux', 'team_leaderboard_contributions', array['uuid'],
                    'team_leaderboard_contributions(team) exists');

select pg_temp.as_user((select alice_uid from ctx));

-- 2. Published and deprecated count, drafts do not; one personal app.
select results_eq(
  $$ select skills_published, apps_created
       from amux.team_leaderboard_contributions((select team_id from ctx))
      where actor_id = (select alice from ctx) $$,
  $$ values (2::bigint, 1::bigint) $$,
  'alice: published + deprecated skills, her app'
);

-- 3. Why SECURITY DEFINER: under RLS Alice sees only Bob's team app.
select results_eq(
  $$ select count(*)::int from amux.apps
      where team_id = (select team_id from ctx)
        and created_by_actor_id in ((select bob from ctx), (select bob_agent from ctx)) $$,
  $$ values (1) $$,
  'apps RLS hides the other member''s personal apps from alice'
);

-- 4. ...yet the count Alice gets for Bob includes them, and his daemon's
-- skill and app are credited to him.
select results_eq(
  $$ select skills_published, apps_created
       from amux.team_leaderboard_contributions((select team_id from ctx))
      where actor_id = (select bob from ctx) $$,
  $$ values (1::bigint, 3::bigint) $$,
  'bob: counts every app, agent work rolled up to him'
);

-- 5. The agent has no row of its own.
select is_empty(
  $$ select 1 from amux.team_leaderboard_contributions((select team_id from ctx))
      where actor_id = (select bob_agent from ctx) $$,
  'agent contributions are not listed under the agent'
);

-- 6. Other teams do not leak in, and neither do skills without a publisher.
select results_eq(
  $$ select count(*)::int from amux.team_leaderboard_contributions((select team_id from ctx)) $$,
  $$ values (2) $$,
  'only alice and bob have rows'
);

-- 7. Bob sees the same numbers for Alice that she sees for herself.
select pg_temp.as_user((select bob_uid from ctx));
select results_eq(
  $$ select skills_published, apps_created
       from amux.team_leaderboard_contributions((select team_id from ctx))
      where actor_id = (select alice from ctx) $$,
  $$ values (2::bigint, 1::bigint) $$,
  'bob sees alice''s counts, including her personal app'
);

-- 8. Eve is not in the team.
select pg_temp.as_user((select eve_uid from ctx));
select is_empty(
  $$ select 1 from amux.team_leaderboard_contributions((select team_id from ctx)) $$,
  'stranger gets no contributions'
);

select * from finish();
rollback;
