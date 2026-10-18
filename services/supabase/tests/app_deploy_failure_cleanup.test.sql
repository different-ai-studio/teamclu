begin;
select plan(5);
select has_function('amux','cancel_app_deploy_preflight',array['uuid','text'],'preflight cancellation is atomic');
select has_trigger('amux','apps','clear_failed_app_deploy','deploy_error clears attempt fields');
select has_trigger('amux','apps','release_failed_app_build','failed builds release their lifecycle');
select ok(not has_function_privilege('authenticated','amux.cancel_app_deploy_preflight(uuid,text)','execute'),'clients cannot bypass the Cloud API admin gate');
select ok(has_function_privilege('service_role','amux.cancel_app_deploy_preflight(uuid,text)','execute'),'Cloud API can cancel authorized preflights');
select * from finish();
rollback;
