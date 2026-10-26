import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
const app = '00000000-0000-0000-0000-000000000001';
async function db() {
 const pg = new PGlite();
 await pg.exec(`create schema amux; create role service_role; create role authenticated; create role anon;
 create table amux.apps (id uuid primary key, fc_status text, fc_endpoint text, deploy_token text, deploy_started_at timestamptz, updated_at timestamptz, slug text, fc_function_name text, auth_mode text, oauth_client_id text);
 insert into amux.apps(id,fc_status,deploy_token,slug) values ('${app}','live','preflight','sample');`);
 const sql = await readFile(new URL('../../../services/supabase/migrations/20261005000000_app_undeploy_lifecycle.sql', import.meta.url),'utf8');
 await pg.exec(sql);
 await pg.exec(await readFile(new URL('../../../services/supabase/migrations/20261018000000_app_deploy_failure_cleanup.sql', import.meta.url),'utf8'));
 return pg;
}
test('undeploy atomically blocks deployment and revokes preflight, duplicates return same operation', async()=>{
 const pg=await db(); try {
 const first=await pg.query<any>(`select amux.begin_app_lifecycle($1,'undeploy',null) as op`,[app]);
 const second=await pg.query<any>(`select amux.begin_app_lifecycle($1,'undeploy',null) as op`,[app]);
 assert.equal(first.rows[0].op.id,second.rows[0].op.id);
 const row=(await pg.query<any>('select * from amux.apps')).rows[0];
 assert.equal(row.fc_status,'uninstalling'); assert.equal(row.deploy_token,null);
 await assert.rejects(pg.query(`select amux.begin_app_lifecycle($1,'deploy','other')`,[app]),/lifecycle_conflict/);
 await assert.rejects(pg.query(`update amux.apps set fc_status='live' where id=$1`,[app]),/lifecycle_conflict/);
 } finally {await pg.close();}
});
test('deployment owns lock before external calls; delete and uninstall cannot race it',async()=>{
 const pg=await db();try{
 await pg.query(`select amux.begin_app_lifecycle($1,'deploy','preflight')`,[app]);
 await assert.rejects(pg.query(`select amux.begin_app_lifecycle($1,'undeploy',null)`,[app]),/lifecycle_conflict/);
 await assert.rejects(pg.query(`select amux.begin_app_lifecycle($1,'delete',null)`,[app]),/lifecycle_conflict/);
 await assert.rejects(pg.query(`select amux.begin_app_lifecycle($1,'deploy','preflight')`,[app]),/lifecycle_conflict/);
 }finally{await pg.close();}
});
test('uncompleted provider call prevents lease reclamation and live writes',async()=>{
 const pg=await db();try{
 const op=(await pg.query<any>(`select amux.begin_app_lifecycle($1,'undeploy',null) as op`,[app])).rows[0].op;
 const claim=(await pg.query<any>(`select amux.claim_app_undeploy($1) as op`,[op.id])).rows[0].op;
 assert.ok(claim.lease_owner);
 await pg.query(`update amux.app_lifecycle_operations set lease_until=now()-interval '1 hour', in_flight=true where id=$1`,[op.id]);
 assert.equal((await pg.query<any>(`select amux.claim_app_undeploy($1) as op`,[op.id])).rows[0].op,null);
 }finally{await pg.close();}
});

test('finished cleanup retains history and permits fresh deployment, failed cleanup remains locked',async()=>{
 const pg=await db();try{
 const op=(await pg.query<any>(`select amux.begin_app_lifecycle($1,'undeploy',null) as op`,[app])).rows[0].op;
 let claimed=(await pg.query<any>(`select amux.claim_app_undeploy($1) as op`,[op.id])).rows[0].op;
 const steps:any=Object.fromEntries(['httpTrigger','originDomain','function','artifact','oauthClient'].map(k=>[k,{status:'succeeded'}]));
 steps.function={status:'failed',error:'AccessDenied'};
 await pg.query(`select amux.finish_app_undeploy($1,$2,$3)`,[op.id,claimed.lease_owner,steps]);
 assert.equal((await pg.query<any>('select fc_status from amux.apps')).rows[0].fc_status,'uninstall_failed');
 await assert.rejects(pg.query(`select amux.begin_app_lifecycle($1,'deploy','preflight')`,[app]),/lifecycle_conflict/);
 await pg.query(`select amux.begin_app_lifecycle($1,'undeploy',null)`,[app]);
 claimed=(await pg.query<any>(`select amux.claim_app_undeploy($1) as op`,[op.id])).rows[0].op;
 steps.function={status:'succeeded'};
 await pg.query(`select amux.finish_app_undeploy($1,$2,$3)`,[op.id,claimed.lease_owner,steps]);
 const row=(await pg.query<any>('select * from amux.apps')).rows[0];assert.equal(row.fc_status,'uninstalled');assert.equal(row.undeploy_operation.status,'succeeded');
 await pg.query(`update amux.apps set deploy_token='fresh' where id=$1`,[app]);
 assert.ok((await pg.query<any>(`select amux.begin_app_lifecycle($1,'deploy','fresh') as op`,[app])).rows[0].op.id);
 }finally{await pg.close();}
});

test('origin route is captured atomically with the cleanup operation', async () => {
 const pg=await db(); try {
 const op=(await pg.query<any>(`select amux.begin_app_lifecycle($1,'undeploy',null,'sample.origin.test') as op`,[app])).rows[0].op;
 assert.equal(op.snapshot.originDomain,'sample.origin.test');
 await assert.rejects(pg.query(`update amux.apps set fc_status=null where id=$1`,[app]),/lifecycle_conflict/);
 } finally {await pg.close();}
});

test('expired provider call is reported as unknown without releasing the fence', async () => {
 const pg=await db(); try {
 const op=(await pg.query<any>(`select amux.begin_app_lifecycle($1,'undeploy',null) as op`,[app])).rows[0].op;
 await pg.query(`select amux.claim_app_undeploy($1)`,[op.id]);
 await pg.query(`update amux.app_lifecycle_operations set in_flight=true,lease_until=now()-interval '1 hour' where id=$1`,[op.id]);
 await pg.query(`select amux.report_expired_app_undeploy_calls()`);
 const row=(await pg.query<any>('select * from amux.apps')).rows[0];
 assert.equal(row.fc_status,'uninstall_failed'); assert.match(row.undeploy_operation.error,/unknown/);
 await assert.rejects(pg.query(`select amux.begin_app_lifecycle($1,'undeploy',null)`,[app]),/provider_outcome_unknown/);
 } finally {await pg.close();}
});

test('known delete failure permits serialized retry but active delete call remains fenced', async () => {
 const pg=await db(); try {
 const op=(await pg.query<any>(`select amux.begin_app_lifecycle($1,'delete',null) as op`,[app])).rows[0].op;
 await pg.query(`update amux.app_lifecycle_operations set status='failed' where id=$1`,[op.id]);
 const retry=(await pg.query<any>(`select amux.begin_app_lifecycle($1,'delete',null) as op`,[app])).rows[0].op;
 assert.equal(retry.id,op.id);
 await pg.query(`update amux.app_lifecycle_operations set in_flight=true where id=$1`,[op.id]);
 await assert.rejects(pg.query(`select amux.begin_app_lifecycle($1,'delete',null)`,[app]),/provider_outcome_unknown/);
 } finally {await pg.close();}
});

test('deploy_error clears attempt fields and finishes only its non-flight lifecycle atomically', async () => {
 for (const inFlight of [false, true]) {
  const pg=await db(); try {
   const op=(await pg.query<any>(`select amux.begin_app_lifecycle($1,'deploy','preflight') as op`,[app])).rows[0].op;
   await pg.query(`update amux.apps set fc_status='awaiting_build',deploy_started_at=now()`);
   await pg.query(`update amux.app_lifecycle_operations set in_flight=$1 where id=$2`,[inFlight,op.id]);
   await pg.query(`update amux.apps set fc_status='deploy_error'`);
   const row=(await pg.query<any>('select * from amux.apps')).rows[0];
   assert.equal(row.deploy_token,null); assert.equal(row.deploy_started_at,null);
   assert.equal((await pg.query<any>('select status from amux.app_lifecycle_operations')).rows[0].status,inFlight?'pending':'succeeded');
  } finally {await pg.close();}
 }
});

test('a retry failing from deploy_error also clears its new token', async () => {
 const pg=await db(); try {
  await pg.query(`update amux.apps set fc_status='deploy_error'`);
  await pg.query(`update amux.apps set deploy_token='retry'`);
  await pg.query(`select amux.begin_app_lifecycle($1,'deploy','retry')`,[app]);
  await pg.query(`update amux.apps set fc_status='deploy_error'`);
  assert.equal((await pg.query<any>('select deploy_token from amux.apps')).rows[0].deploy_token,null);
  assert.equal((await pg.query<any>('select status from amux.app_lifecycle_operations')).rows[0].status,'succeeded');
 } finally {await pg.close();}
});

test('preflight cancellation refuses an active lifecycle and preserves deployment status', async () => {
 const pg=await db(); try {
  assert.equal((await pg.query<any>(`select amux.cancel_app_deploy_preflight($1,'stale') as cancelled`,[app])).rows[0].cancelled,false);
  assert.equal((await pg.query<any>(`select amux.cancel_app_deploy_preflight($1,'preflight') as cancelled`,[app])).rows[0].cancelled,true);
  assert.equal((await pg.query<any>('select fc_status from amux.apps')).rows[0].fc_status,'live');
  await pg.query(`update amux.apps set deploy_token='next'`);
  await pg.query(`select amux.begin_app_lifecycle($1,'deploy','next')`,[app]);
  assert.equal((await pg.query<any>(`select amux.cancel_app_deploy_preflight($1,'next') as cancelled`,[app])).rows[0].cancelled,false);
  assert.equal((await pg.query<any>('select deploy_token from amux.apps')).rows[0].deploy_token,'next');
 } finally {await pg.close();}
});

test('deploy_error never finishes a lifecycle with a different attempt token', async () => {
 const pg=await db(); try {
  await pg.query(`insert into amux.app_lifecycle_operations(app_id,kind,token) values ($1,'deploy','other-attempt')`,[app]);
  await pg.query(`update amux.apps set fc_status='deploy_error'`);
  assert.equal((await pg.query<any>('select status from amux.app_lifecycle_operations')).rows[0].status,'pending');
 } finally {await pg.close();}
});

test('a rejected failure write rolls back token and lifecycle cleanup together', async () => {
 const pg=await db(); try {
  await pg.query(`select amux.begin_app_lifecycle($1,'deploy','preflight')`,[app]);
  await pg.exec(`create function amux.reject_test_failure() returns trigger language plpgsql as $$ begin raise exception 'rollback probe'; end $$;
    create trigger zz_reject_test_failure after update of fc_status on amux.apps for each row execute function amux.reject_test_failure();`);
  await assert.rejects(pg.query(`update amux.apps set fc_status='deploy_error'`),/rollback probe/);
  assert.equal((await pg.query<any>('select deploy_token from amux.apps')).rows[0].deploy_token,'preflight');
  assert.equal((await pg.query<any>('select status from amux.app_lifecycle_operations')).rows[0].status,'pending');
 } finally {await pg.close();}
});

test('completed uninstall keeps immutable naming mode and exact code cleanup snapshot', async () => {
 const pg=await db();try {
  await pg.exec(await readFile(new URL('../../../services/supabase/migrations/20261026060936_apps_function_naming_mode.sql',import.meta.url),'utf8'));
  await pg.query(`delete from amux.apps where id=$1`,[app]);
  await pg.query(`insert into amux.apps(id,slug,fc_status,fc_function_name,function_naming_mode) values ($1,'renamed','live','a-p35cg2kk6bh3','app_code')`,[app]);
  const op=(await pg.query<any>(`select amux.begin_app_lifecycle($1,'undeploy',null,'a-p35cg2kk6bh3.origins.test') as op`,[app])).rows[0].op;
  assert.equal(op.snapshot.functionName,'a-p35cg2kk6bh3');assert.equal(op.snapshot.originDomain,'a-p35cg2kk6bh3.origins.test');
  const claim=(await pg.query<any>(`select amux.claim_app_undeploy($1) as op`,[op.id])).rows[0].op;
  const steps=Object.fromEntries(['httpTrigger','originDomain','function','artifact','oauthClient'].map(k=>[k,{status:'succeeded'}]));
  await pg.query(`select amux.finish_app_undeploy($1,$2,$3)`,[op.id,claim.lease_owner,steps]);
  const row=(await pg.query<any>('select * from amux.apps')).rows[0];
  assert.equal(row.fc_status,'uninstalled');assert.equal(row.function_naming_mode,'app_code');assert.equal(row.fc_function_name,'a-p35cg2kk6bh3');
 }finally{await pg.close();}
});
