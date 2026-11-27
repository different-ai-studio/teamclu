-- P3.2: the Cloud API's direct writes to the platform model, made after the
-- legacy row P2.1's triggers project, settle rather than fail or undo it.
begin;

select plan(10);

-- ── fixtures (session role) ───────────────────────────────────────────────
-- Org A: teams A1, A2. Org B: team B1.
--   creator  — A1; app 1 (personal), app 2 (team-visible)
--   grantee  — A1; admin on app 1
--   outsider — A2 (same org, other team)
--   stranger — B1 (other org)
--   agent G  — grantee's agent in A1

insert into public.orgs (id, name) values
  ('00000000-0000-0000-0066-0000000000fa', 'P3.2 org A'),
  ('00000000-0000-0000-0066-0000000000fb', 'P3.2 org B');

insert into auth.users (id, email, aud, role, instance_id) values
  ('00000000-0000-0000-0066-000000000101', 'p32-creator@teamclu.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0066-000000000102', 'p32-grantee@teamclu.test',  'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0066-000000000103', 'p32-outsider@teamclu.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0066-000000000104', 'p32-stranger@teamclu.test', 'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000'),
  ('00000000-0000-0000-0066-000000000112', 'daemon.p32g@amuxd.run',     'authenticated', 'authenticated', '00000000-0000-0000-0000-000000000000');

insert into amux.teams (id, slug, name, oid) values
  ('00000000-0000-0000-0066-0000000000a1', 'p32-a1', 'P3.2 A1', '00000000-0000-0000-0066-0000000000fa'),
  ('00000000-0000-0000-0066-0000000000a2', 'p32-a2', 'P3.2 A2', '00000000-0000-0000-0066-0000000000fa'),
  ('00000000-0000-0000-0066-0000000000b1', 'p32-b1', 'P3.2 B1', '00000000-0000-0000-0066-0000000000fb');

insert into amux.actors (id, team_id, actor_type, user_id, display_name) values
  ('00000000-0000-0000-0066-000000000201', '00000000-0000-0000-0066-0000000000a1', 'member', '00000000-0000-0000-0066-000000000101', 'Creator'),
  ('00000000-0000-0000-0066-000000000202', '00000000-0000-0000-0066-0000000000a1', 'member', '00000000-0000-0000-0066-000000000102', 'Grantee'),
  ('00000000-0000-0000-0066-000000000203', '00000000-0000-0000-0066-0000000000a2', 'member', '00000000-0000-0000-0066-000000000103', 'Outsider'),
  ('00000000-0000-0000-0066-000000000204', '00000000-0000-0000-0066-0000000000b1', 'member', '00000000-0000-0000-0066-000000000104', 'Stranger'),
  ('00000000-0000-0000-0066-000000000212', '00000000-0000-0000-0066-0000000000a1', 'agent',  '00000000-0000-0000-0066-000000000112', 'Agent G');
insert into amux.members (id, status) values
  ('00000000-0000-0000-0066-000000000201', 'active'),
  ('00000000-0000-0000-0066-000000000202', 'active'),
  ('00000000-0000-0000-0066-000000000203', 'active'),
  ('00000000-0000-0000-0066-000000000204', 'active');
insert into amux.agents (id, owner_member_id, status) values
  ('00000000-0000-0000-0066-000000000212', '00000000-0000-0000-0066-000000000202', 'active');


-- ── P3.2: the Cloud API writes the platform model right after the legacy
-- row, which P2.1's triggers have just projected. Each write must settle,
-- never fail or undo the projection. Session role = the service role here.

insert into amux.workspaces (id, team_id, name) values
  ('00000000-0000-0000-0066-000000000401', '00000000-0000-0000-0066-0000000000a1', 'p32-ws');

-- An app whose explicit creating account is kept over the trigger's.
insert into amux.apps (id, team_id, created_by_actor_id, workspace_id, name, slug, type, org_id, visibility, created_by_user_id)
values ('00000000-0000-0000-0066-000000000301', '00000000-0000-0000-0066-0000000000a1', '00000000-0000-0000-0066-000000000201',
        '00000000-0000-0000-0066-000000000401', 'P3.2 app', 'p32-app', 'static_web',
        '00000000-0000-0000-0066-0000000000fa', 'team', '00000000-0000-0000-0066-000000000101');
select is((select created_by_user_id from amux.apps where id = '00000000-0000-0000-0066-000000000301'), '00000000-0000-0000-0066-000000000101'::uuid,
          'the platform''s explicit created_by_user_id is kept');

select lives_ok($$
  insert into amux.app_links (app_id, team_id, workspace_id, created_by_actor_id)
  values ('00000000-0000-0000-0066-000000000301', '00000000-0000-0000-0066-0000000000a1', '00000000-0000-0000-0066-000000000401', '00000000-0000-0000-0066-000000000201')
  on conflict (app_id) do update set team_id = excluded.team_id, workspace_id = excluded.workspace_id,
                                     created_by_actor_id = excluded.created_by_actor_id
$$, 'the link upsert lands on the projected link');
select is((select count(*)::int from amux.app_links where app_id = '00000000-0000-0000-0066-000000000301' and workspace_id = '00000000-0000-0000-0066-000000000401'), 1,
          'one link, with its workspace');

select throws_ok($$insert into amux.app_grants (app_id, principal_org_id, level)
                  values ('00000000-0000-0000-0066-000000000301', '00000000-0000-0000-0066-0000000000fa', 'read')$$,
                 '23505', null, 'the org grant insert meets the projected one (the Cloud API reads 23505 as done)');

-- A grant: the legacy row first, then the platform's update-then-insert.
insert into amux.app_member_access (app_id, member_id, permission_level, granted_by_member_id)
values ('00000000-0000-0000-0066-000000000301', '00000000-0000-0000-0066-000000000202', 'write', '00000000-0000-0000-0066-000000000201');
with u as (
  update amux.app_grants set level = 'write', granted_by_user_id = '00000000-0000-0000-0066-000000000101', updated_at = now()
   where app_id = '00000000-0000-0000-0066-000000000301' and principal_user_id = '00000000-0000-0000-0066-000000000102' returning 1)
select is((select count(*)::int from u), 1, 'the grant update finds the projected row');
select throws_ok($$insert into amux.app_grants (app_id, principal_user_id, level, granted_by_user_id)
                  values ('00000000-0000-0000-0066-000000000301', '00000000-0000-0000-0066-000000000102', 'write', '00000000-0000-0000-0066-000000000101')$$,
                 '23505', null, 'and an insert would only meet it');

-- Making it personal: the legacy column, then the platform's delete.
update amux.apps set visibility = 'personal' where id = '00000000-0000-0000-0066-000000000301';
select lives_ok($$delete from amux.app_grants where app_id = '00000000-0000-0000-0066-000000000301' and principal_org_id is not null$$,
                'removing the org grant after the projection did is a no-op');
select is((select count(*)::int from amux.app_grants where app_id = '00000000-0000-0000-0066-000000000301' and principal_org_id is not null), 0,
          'no org grant is left');

-- Revoking: the legacy row, then the platform's delete.
delete from amux.app_member_access where app_id = '00000000-0000-0000-0066-000000000301' and member_id = '00000000-0000-0000-0066-000000000202';
select lives_ok($$delete from amux.app_grants where app_id = '00000000-0000-0000-0066-000000000301' and principal_user_id = '00000000-0000-0000-0066-000000000102'$$,
                'removing the user grant after the projection did is a no-op');
select is((select count(*)::int from amux.app_grants where app_id = '00000000-0000-0000-0066-000000000301'), 0, 'no grant is left');

select * from finish();
rollback;
