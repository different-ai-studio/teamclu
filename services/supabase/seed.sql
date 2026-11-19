-- Local dev / demo fixture: two people, one team, one pi agent, an idea and a
-- collab session with a few messages.
--
-- OPT-IN ONLY. deploy/self-host/init/apply-migrations.sh applies it after the
-- migrations when APPLY_SEED=true (default false) and records it as
-- `__seed__` in _selfhost.schema_migrations, so it runs at most once. Never
-- enable it on self-host or belayo: these are fake users with fixed ids.
--
-- Written against the current schema (business tables in `amux`). The users
-- have no password and no identity rows, so nobody can sign in as them; they
-- exist to give list/detail screens something to render when you point a
-- client at a local stack.

insert into auth.users (
  id,
  instance_id,
  aud,
  role,
  email,
  email_confirmed_at,
  raw_app_meta_data,
  raw_user_meta_data,
  created_at,
  updated_at
)
values
  (
    '90000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'alice@example.com',
    now(),
    '{}'::jsonb,
    '{"display_name":"Alice"}'::jsonb,
    now(),
    now()
  ),
  (
    '90000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000000',
    'authenticated',
    'authenticated',
    'carol@example.com',
    now(),
    '{}'::jsonb,
    '{"display_name":"Carol"}'::jsonb,
    now(),
    now()
  );

insert into amux.teams (id, slug, name)
values ('00000000-0000-0000-0000-000000000001', 'core', 'Core Team');

insert into amux.actors (id, team_id, actor_type, user_id, display_name, last_active_at)
values
  ('10000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'member', '90000000-0000-0000-0000-000000000001', 'Alice', now()),
  ('10000000-0000-0000-0000-000000000002', '00000000-0000-0000-0000-000000000001', 'member', '90000000-0000-0000-0000-000000000002', 'Carol', now()),
  ('20000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', 'agent', null, 'Builder', now());

insert into amux.members (id, status)
values
  ('10000000-0000-0000-0000-000000000001', 'active'),
  ('10000000-0000-0000-0000-000000000002', 'active');

insert into amux.team_members (team_id, member_id, role)
values
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'owner'),
  ('00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'member');

-- The agent row comes before the workspace that names it, and gets its
-- default workspace afterwards (agents.default_workspace_id -> workspaces,
-- workspaces.agent_id -> agents).
insert into amux.agents (id, owner_member_id, visibility, agent_types, default_agent_type, status)
values
  (
    '20000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'team',
    '["pi"]'::jsonb,
    'pi',
    'active'
  );

insert into amux.workspaces (id, team_id, created_by_member_id, agent_id, name, path)
values
  ('30000000-0000-0000-0000-000000000001', '00000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'amux', '/workspaces/amux');

update amux.agents
   set default_workspace_id = '30000000-0000-0000-0000-000000000001'
 where id = '20000000-0000-0000-0000-000000000001';

insert into amux.agent_member_access (agent_id, member_id, permission_level, granted_by_member_id)
values
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'admin', '10000000-0000-0000-0000-000000000001'),
  ('20000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'view', '10000000-0000-0000-0000-000000000001');

insert into amux.ideas (id, team_id, workspace_id, created_by_actor_id, title, description, status)
values
  (
    '40000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    '30000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    'Model auth flow',
    'Design collaboration and authorization model',
    'open'
  );

insert into amux.sessions (id, team_id, idea_id, created_by_actor_id, primary_agent_id, mode, title, summary, last_message_preview, last_message_at)
values
  (
    '50000000-0000-0000-0000-000000000001',
    '00000000-0000-0000-0000-000000000001',
    '40000000-0000-0000-0000-000000000001',
    '10000000-0000-0000-0000-000000000001',
    '20000000-0000-0000-0000-000000000001',
    'collab',
    'Agent access review',
    'Alice chatting with Builder',
    'Carol joined with view-only access to Builder',
    now()
  );

insert into amux.session_participants (session_id, actor_id, role)
values
  ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'owner'),
  ('50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'participant'),
  ('50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'agent');

insert into amux.messages (team_id, session_id, sender_actor_id, kind, content)
values
  ('00000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000001', 'text', 'Please help review the permission model.'),
  ('00000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '20000000-0000-0000-0000-000000000001', 'text', 'I can respond to Alice.'),
  ('00000000-0000-0000-0000-000000000001', '50000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-000000000002', 'text', 'I can follow the review, but only Alice should be able to drive Builder.');
