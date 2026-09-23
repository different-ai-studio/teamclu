begin;

select plan(11);

-- The `attachments` bucket is public on purpose, and its paths must not be
-- listable.
--
-- 20260530000001_attachments_bucket_public.sql flipped the bucket to public
-- when iOS dropped the Supabase SDK: attachment URLs are persisted into message
-- content and idea.attachment_urls, and every client renders them as a plain
-- image fetch with no bearer. The confidentiality model is the unguessable path
-- (`<team>/<session>/<uuid>/<file>`), the same capability model as `avatars`.
--
-- On a public bucket storage-api answers every by-path read (public URL,
-- authenticated download, HEAD, info) without consulting RLS, so that model is
-- untouched by the policies here. What RLS governs is listing and upload —
-- the INSERT check plus the read-back storage-api does on an upsert — and
-- 20260920000000_attachments_bucket_team_scoped_policies.sql scopes those to
-- members of the team named by the first path segment. Before it, a
-- `to public` SELECT policy let anyone holding the anon key enumerate every
-- path in the bucket, which turned "unguessable" into "listed".
--
-- So:
--   1-2. a team member reads their team's objects, in both path layouts
--   3.   a non-uuid first segment hides the row instead of raising a cast error
--   4-5. another team's member, and a user in no team, read nothing
--   6.   a member can upload under their team and read the row back (upsert)
--   7-8. nobody uploads under another team's prefix, or outside a team prefix
--   9.   no read policy on the bucket reaches anon
--   10.  the policy set on storage.objects is pinned
--   11.  the private buckets are still private

insert into auth.users (id, email, aud, role, instance_id)
values
  ('91900000-0000-0000-0000-000000000001',
   'idea-rls-member@example.com',  'authenticated', 'authenticated',
   '00000000-0000-0000-0000-000000000000'),
  ('91900000-0000-0000-0000-000000000002',
   'idea-rls-other@example.com',   'authenticated', 'authenticated',
   '00000000-0000-0000-0000-000000000000'),
  ('91900000-0000-0000-0000-000000000003',
   'idea-rls-outsider@example.com','authenticated', 'authenticated',
   '00000000-0000-0000-0000-000000000000');

insert into amux.teams (id, slug, name)
values
  ('01900000-0000-0000-0000-000000000001', 'idea-rls-team-a', 'Idea RLS Team A'),
  ('01900000-0000-0000-0000-000000000002', 'idea-rls-team-b', 'Idea RLS Team B');

insert into amux.actors (id, team_id, actor_type, user_id, display_name)
values
  ('11900000-0000-0000-0000-000000000001',
   '01900000-0000-0000-0000-000000000001', 'member',
   '91900000-0000-0000-0000-000000000001', 'Team A Member'),
  ('11900000-0000-0000-0000-000000000002',
   '01900000-0000-0000-0000-000000000002', 'member',
   '91900000-0000-0000-0000-000000000002', 'Team B Member');

insert into amux.members (id, status)
values
  ('11900000-0000-0000-0000-000000000001', 'active'),
  ('11900000-0000-0000-0000-000000000002', 'active');

insert into amux.team_members (id, team_id, member_id, role)
values
  ('21900000-0000-0000-0000-000000000001',
   '01900000-0000-0000-0000-000000000001',
   '11900000-0000-0000-0000-000000000001', 'member'),
  ('21900000-0000-0000-0000-000000000002',
   '01900000-0000-0000-0000-000000000002',
   '11900000-0000-0000-0000-000000000002', 'member');

-- Insert the storage objects as the service role so we bypass the upload
-- policy and exercise only the SELECT policy under test: team A's idea and
-- session attachments, plus a row whose first segment is not a team id.
insert into storage.objects (bucket_id, name, owner, metadata)
values
  ('attachments',
   '01900000-0000-0000-0000-000000000001/ideas/aaaaaaaaaaaa1111/abcdef012345/photo.jpg',
   null, '{}'::jsonb),
  ('attachments',
   '01900000-0000-0000-0000-000000000001/5e550000-0000-0000-0000-000000000001/abcdef012345/photo.jpg',
   null, '{}'::jsonb),
  ('attachments', 'contract/roundtrip.txt', null, '{}'::jsonb);

-- 1-3. Team A member.
set local role authenticated;
set local request.jwt.claim.role = 'authenticated';
set local request.jwt.claim.sub = '91900000-0000-0000-0000-000000000001';
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '91900000-0000-0000-0000-000000000001',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (select count(*)::int
     from storage.objects
    where bucket_id = 'attachments'
      and name = '01900000-0000-0000-0000-000000000001/ideas/aaaaaaaaaaaa1111/abcdef012345/photo.jpg'),
  1,
  'team A member can select their team''s idea attachment'
);

select is(
  (select count(*)::int
     from storage.objects
    where bucket_id = 'attachments'
      and name = '01900000-0000-0000-0000-000000000001/5e550000-0000-0000-0000-000000000001/abcdef012345/photo.jpg'),
  1,
  'team A member can select their team''s session attachment'
);

-- Scans the whole bucket, so the policy is evaluated against the non-uuid row
-- too. A bare `::uuid` cast there would abort the listing for everyone.
select is(
  (select count(*)::int from storage.objects where bucket_id = 'attachments'),
  2,
  'a first segment that is not a team id hides the row rather than raising'
);

-- 6-8. Uploads, still as team A's member. RETURNING is the read-back
-- storage-api performs for `upsert: true`, which is what FC sends: it needs the
-- INSERT check and the SELECT policy to both pass on the new row.
select lives_ok(
  $$ insert into storage.objects (bucket_id, name, metadata)
     values ('attachments',
             '01900000-0000-0000-0000-000000000001/5e550000-0000-0000-0000-000000000001/upload.png',
             '{}'::jsonb)
     returning id $$,
  'team A member uploads under their team and reads the row back'
);

select throws_ok(
  $$ insert into storage.objects (bucket_id, name, metadata)
     values ('attachments',
             '01900000-0000-0000-0000-000000000002/5e550000-0000-0000-0000-000000000002/planted.png',
             '{}'::jsonb) $$,
  '42501',
  null,
  'team A member cannot upload under team B''s prefix'
);

select throws_ok(
  $$ insert into storage.objects (bucket_id, name, metadata)
     values ('attachments', 'undefined/session/planted.png', '{}'::jsonb) $$,
  '42501',
  null,
  'an upload whose first segment is not a team id is rejected'
);

-- 4. A member of another team reads none of team A's objects.
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '91900000-0000-0000-0000-000000000002';
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '91900000-0000-0000-0000-000000000002',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (select count(*)::int from storage.objects where bucket_id = 'attachments'),
  0,
  'another team''s member cannot list or read team A''s attachments'
);

-- 5. Neither does a signed-in user who belongs to no team.
reset role;
set local role authenticated;
set local request.jwt.claim.sub = '91900000-0000-0000-0000-000000000003';
select set_config(
  'request.jwt.claims',
  json_build_object(
    'sub',  '91900000-0000-0000-0000-000000000003',
    'role', 'authenticated'
  )::text,
  true
);

select is(
  (select count(*)::int from storage.objects where bucket_id = 'attachments'),
  0,
  'a signed-in user in no team cannot list or read attachments'
);

reset role;

-- 9. The anon key ships in every deployed app's browser bundle, so a read
-- policy that reaches `anon` (directly or via `public`) makes the bucket
-- enumerable by anyone. Asserted on the catalog because the CI storage stub
-- grants anon no table privilege, which would mask a bad policy.
select is_empty(
  $$ select policyname
       from pg_policies
      where schemaname = 'storage' and tablename = 'objects'
        and cmd in ('SELECT', 'ALL')
        and qual like '%attachments%'
        and roles && array['public', 'anon']::name[] $$,
  'no read policy on the attachments bucket reaches anon'
);

-- 10. Permissive policies OR together, so one broad policy added later would
-- silently undo the scoping above. Pin the set.
select policies_are('storage', 'objects', array[
  'attachments_team_member_read',
  'attachments_team_member_upload',
  'avatars_owner_delete',
  'avatars_owner_insert',
  'avatars_owner_update',
  'avatars_public_read',
  'no_delete'
]);

-- 11. The public flag is scoped to the two capability-URL buckets. If a future
-- migration flips team-skills or team-blobs public, sync payloads and skill
-- bundles would become world-readable, and this is the assertion that fails.
select results_eq(
  $$ select id, public from storage.buckets order by id $$,
  $$ values ('attachments'::text, true),
            ('avatars',           true),
            ('team-blobs',        false),
            ('team-skills',       false) $$,
  'only the capability-URL buckets are public'
);

select * from finish();

rollback;
