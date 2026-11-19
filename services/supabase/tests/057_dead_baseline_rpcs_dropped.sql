-- 20261119000000_drop_dead_baseline_rpcs.sql: five baseline RPCs nothing
-- called are gone, and the two look-alikes that are still load-bearing stay.
-- (The share-mode pair is also covered by team_share_mode.test.sql.)
--
-- 20261119000100_drop_idea_external_refs.sql: the table is gone and
-- enforce_parent_integrity, which used to probe it, still guards team moves
-- (a leftover probe would surface as 42P01 instead of 23514).
begin;

select plan(10);

select hasnt_function('amux', 'enable_team_share',               'enable_team_share dropped');
select hasnt_function('amux', 'disable_team_share',              'disable_team_share dropped');
select hasnt_function('amux', 'add_gateway_session_participant', 'add_gateway_session_participant dropped');
select hasnt_function('amux', 'ensure_org_default_team',         'ensure_org_default_team dropped');
select hasnt_function('amux', 'bind_phone_to_account',           'bind_phone_to_account dropped');

-- team_member_set_roles was kept here, then dropped with the table it wrote
-- in 20261119130000_drop_shortcut_role_visibility.sql (see 015_rbac_shortcuts).
select hasnt_function('amux', 'team_member_set_roles', array['uuid', 'uuid', 'uuid[]'],
                      'team_member_set_roles dropped');
-- Kept: the SQL statement of the prompt + visibility rule.
select has_function('amux', 'can_prompt_agent', array['uuid'],
                    'can_prompt_agent kept');

select hasnt_table('amux', 'idea_external_refs', 'idea_external_refs dropped');

insert into auth.users (id) values ('57000000-0000-4000-8000-000000000001');
insert into amux.teams (id, slug, name) values
  ('57000000-0000-4000-8000-0000000000a1', 'dead-rpc-a', 'Dead RPC A'),
  ('57000000-0000-4000-8000-0000000000b1', 'dead-rpc-b', 'Dead RPC B');
insert into amux.actors (id, team_id, actor_type, display_name, user_id) values
  ('57000000-0000-4000-8000-000000000011', '57000000-0000-4000-8000-0000000000a1',
   'member', 'mover', '57000000-0000-4000-8000-000000000001');
insert into amux.members (id, status) values ('57000000-0000-4000-8000-000000000011', 'active');
insert into amux.ideas (id, team_id, created_by_actor_id, title, status) values
  ('57000000-0000-4000-8000-000000000021', '57000000-0000-4000-8000-0000000000a1',
   '57000000-0000-4000-8000-000000000011', 'parent', 'open');
insert into amux.ideas (id, team_id, created_by_actor_id, title, status, parent_idea_id) values
  ('57000000-0000-4000-8000-000000000022', '57000000-0000-4000-8000-0000000000a1',
   '57000000-0000-4000-8000-000000000011', 'child', 'open',
   '57000000-0000-4000-8000-000000000021');

select throws_ok(
  $q$ update amux.actors set team_id = '57000000-0000-4000-8000-0000000000b1'
       where id = '57000000-0000-4000-8000-000000000011' $q$,
  '23514', null,
  'actor with dependents still cannot change team'
);
select throws_ok(
  $q$ update amux.ideas set team_id = '57000000-0000-4000-8000-0000000000b1'
       where id = '57000000-0000-4000-8000-000000000021' $q$,
  '23514', null,
  'idea with a child idea still cannot change team'
);

select * from finish();
rollback;
