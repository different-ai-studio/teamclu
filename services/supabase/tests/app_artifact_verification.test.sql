begin;
select plan(4);
select has_column('amux', 'apps', 'artifact_verification', 'apps records the last published build check');
select col_type_is('amux', 'apps', 'artifact_verification', 'jsonb', 'build check is structured evidence');
select has_column('amux', 'apps', 'deploy_attempt_id', 'apps retains a safe deploy correlation id');
select col_type_is('amux', 'apps', 'deploy_attempt_id', 'uuid', 'deploy correlation id is a UUID');
select * from finish();
rollback;
