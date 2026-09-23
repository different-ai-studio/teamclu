begin;

select plan(9);

select has_table('amux', 'wiki_maintainer_configs', 'wiki maintainer config table exists');
select has_table('amux', 'wiki_maintainer_state', 'wiki maintainer state table exists');
select has_table('amux', 'wiki_maintainer_checkpoints', 'wiki checkpoint table exists');

select ok(
  not has_table_privilege('authenticated', 'amux.wiki_maintainer_configs', 'SELECT')
    and has_function_privilege(
      'service_role',
      'amux.wiki_maintainer_complete_checkpoint(uuid,bigint,bigint,text,text,bigint,jsonb,uuid)',
      'EXECUTE'
    ),
  'checkpoint metadata is reachable only through the service-role API'
);

insert into amux.teams (id, slug, name)
values ('00000000-0000-0000-0043-000000000010', 'wiki-checkpoint', 'Wiki Checkpoint');

insert into amux.actors (id, team_id, actor_type, display_name)
values (
  '00000000-0000-0000-0043-000000000020',
  '00000000-0000-0000-0043-000000000010',
  'member',
  'Wiki Admin'
);

select is(
  amux.wiki_maintainer_put_config(
    '00000000-0000-0000-0043-000000000010',
    0,
    '{"sources":["documents/handbook/"]}',
    '00000000-0000-0000-0043-000000000020'
  ) ->> 'version',
  '1',
  'config starts at version one'
);

select is(
  amux.wiki_maintainer_complete_checkpoint(
    '00000000-0000-0000-0043-000000000010',
    0,
    1,
    'wiki-maintainer/teams/t/checkpoints/sha256/aa/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.zip',
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    10,
    '{"readyToPublish":true,"configVersion":1,"targetCommit":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","targetTreeHash":"cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc","baseTreeHash":null,"nodeId":"node-a"}',
    '00000000-0000-0000-0043-000000000020'
  ) ->> 'generation',
  '1',
  'first checkpoint atomically advances generation'
);

select throws_ok(
  $$select amux.wiki_maintainer_complete_checkpoint(
    '00000000-0000-0000-0043-000000000010', 0, 1, 'stale',
    'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    10, '{}'::jsonb, '00000000-0000-0000-0043-000000000020')$$,
  'P0001',
  null,
  'a stale checkpoint cannot overwrite the winning generation'
);

select is(
  amux.wiki_maintainer_begin_publish(
    '00000000-0000-0000-0043-000000000010',
    1,
    1,
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    null,
    'node-a',
    'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    '00000000-0000-0000-0043-000000000020'
  ) ->> 'stage',
  'publishing',
  'publish begin claims the generation'
);

select throws_ok(
  $$select amux.wiki_maintainer_begin_publish(
    '00000000-0000-0000-0043-000000000010', 1, 1,
    'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
    null, 'node-b',
    'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
    '00000000-0000-0000-0043-000000000020')$$,
  'P0001',
  null,
  'the same generation cannot be published twice'
);

select * from finish();
rollback;
