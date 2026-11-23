-- A Chinese skill id is stored as itself. Path-unsafe ids are not.
-- Existing ASCII ids, including a Windows device name the old check allowed,
-- still insert. This test does not rewrite any row.

begin;

select plan(7);

reset role;

do $$
declare
  v_org uuid := gen_random_uuid();
  v_team uuid := gen_random_uuid();
begin
  insert into public.orgs (id, name) values (v_org, 'Unicode Skill Fixture');
  insert into amux.teams (id, slug, name, oid)
  values (v_team, 'unicode-skill-' || left(v_team::text, 8), 'Unicode Skill', v_org);
  perform set_config('test.team_id', v_team::text, true);
end;
$$;

select lives_ok(
  format(
    $$ insert into amux.team_skills (team_id, slug, summary, category, when_to_use, when_not_to_use)
       values (%L, '整车成本智能表格', '整车运单', 'general', '查运费', '别的表') $$,
    current_setting('test.team_id')
  ),
  'a Chinese title is a legal skill id'
);

select lives_ok(
  format(
    $$ insert into amux.team_skills (team_id, slug, summary, category, when_to_use, when_not_to_use)
       values (%L, 'deploy-check', 'preflight', 'devops', 'before ship', 'not local') $$,
    current_setting('test.team_id')
  ),
  'an existing ASCII id still inserts'
);

select lives_ok(
  format(
    $$ insert into amux.team_skills (team_id, slug, summary, category, when_to_use, when_not_to_use)
       values (%L, 'con', 'legacy device name', 'general', 'old row', 'do not create new ones') $$,
    current_setting('test.team_id')
  ),
  'a legacy ASCII device name is not rewritten or rejected by the migration'
);

select throws_ok(
  format(
    $$ insert into amux.team_skills (team_id, slug, summary, category, when_to_use, when_not_to_use)
       values (%L, '整车/成本', 'bad', 'general', 'x', 'y') $$,
    current_setting('test.team_id')
  ),
  '23514',
  null,
  'a slash is not a skill id'
);

select throws_ok(
  format(
    $$ insert into amux.team_skills (team_id, slug, summary, category, when_to_use, when_not_to_use)
       values (%L, '整车\成本', 'bad', 'general', 'x', 'y') $$,
    current_setting('test.team_id')
  ),
  '23514',
  null,
  'a backslash is not a skill id'
);

select throws_ok(
  format(
    $$ insert into amux.team_skills (team_id, slug, summary, category, when_to_use, when_not_to_use)
       values (%L, 'cafe' || chr(769), 'bad', 'general', 'x', 'y') $$,
    current_setting('test.team_id')
  ),
  '23514',
  null,
  'a non-NFC id is rejected so macOS and Windows share one folder'
);

select is(
  (select slug from amux.team_skills where slug = '整车成本智能表格'),
  '整车成本智能表格',
  'the stored id is the Chinese title, not a transcription'
);

select * from finish();
rollback;
