-- Durable lifecycle mutex. Never reclaim a potentially active provider call by TTL.
create table amux.app_lifecycle_operations (
 id uuid primary key default gen_random_uuid(),
 app_id uuid not null references amux.apps(id) on delete cascade,
 kind text not null check(kind in ('deploy','undeploy','delete')),
 status text not null default 'pending' check(status in ('pending','running','failed','succeeded')),
 token text,
 snapshot jsonb not null default '{}'::jsonb,
 steps jsonb not null default '{}'::jsonb,
 error text,
 lease_owner uuid,
 lease_until timestamptz,
 in_flight boolean not null default false,
 started_at timestamptz not null default now(),
 updated_at timestamptz not null default now()
);
create unique index app_lifecycle_exclusive on amux.app_lifecycle_operations(app_id) where status <> 'succeeded';
alter table amux.app_lifecycle_operations enable row level security;
revoke all on amux.app_lifecycle_operations from public,anon,authenticated;
grant all on amux.app_lifecycle_operations to service_role;

create function amux.begin_app_lifecycle(p_app_id uuid,p_kind text,p_token text default null,p_origin_domain text default null)
returns jsonb language plpgsql security definer set search_path=amux,pg_temp as $$
declare a amux.apps; o amux.app_lifecycle_operations;
begin
 select * into a from amux.apps where id=p_app_id for update;
 if not found then raise exception 'app_not_found' using errcode='P0002'; end if;
 select * into o from amux.app_lifecycle_operations where app_id=p_app_id and status<>'succeeded' for update;
 if found then
  if p_kind='delete' and o.kind='delete' and o.in_flight then raise exception 'provider_outcome_unknown' using errcode='55000'; end if;
  if p_kind='delete' and o.kind='delete' and o.status='failed' and not o.in_flight then
   update amux.app_lifecycle_operations set status='pending',error=null,updated_at=now() where id=o.id returning * into o;
   return to_jsonb(o);
  end if;
  if p_kind='undeploy' and o.kind='undeploy' then
   if o.status='failed' and o.in_flight then raise exception 'provider_outcome_unknown' using errcode='55000'; end if;
   if o.status='failed' and not o.in_flight then
    update amux.app_lifecycle_operations set status='pending',error=null,updated_at=now() where id=o.id returning * into o;
    update amux.apps set fc_status='uninstalling',updated_at=now() where id=p_app_id;
   end if;
   return to_jsonb(o);
  end if;
  raise exception 'lifecycle_conflict' using errcode='55000';
 end if;
 if p_kind='undeploy' and a.fc_status is null and a.fc_function_name is null and a.fc_endpoint is null then
  raise exception 'not_deployed' using errcode='55000';
 end if;
 if p_kind='undeploy' and a.fc_status='uninstalled' then
  select * into o from amux.app_lifecycle_operations where app_id=p_app_id and kind='undeploy' order by started_at desc limit 1;
  return to_jsonb(o);
 end if;
 if p_kind in ('undeploy','delete') and a.fc_status in ('awaiting_build','building','deploying') then
  raise exception 'lifecycle_conflict' using errcode='55000';
 end if;
 if p_kind='deploy' and (p_token is null or a.deploy_token is distinct from p_token) then
  raise exception 'deploy_token_mismatch' using errcode='55000';
 end if;
 insert into amux.app_lifecycle_operations(app_id,kind,token,snapshot)
 values(p_app_id,p_kind,p_token,jsonb_build_object('appId',a.id,'slug',a.slug,'functionName',a.fc_function_name,'oauthClientId',a.oauth_client_id,'originDomain',p_origin_domain)) returning * into o;
 if p_kind='undeploy' then
  update amux.apps set fc_status='uninstalling',deploy_token=null,deploy_started_at=null,updated_at=now() where id=p_app_id;
 end if;
 return to_jsonb(o);
end $$;

create function amux.claim_app_undeploy(p_operation_id uuid) returns jsonb
language plpgsql security definer set search_path=amux,pg_temp as $$
declare o amux.app_lifecycle_operations;
begin
 update amux.app_lifecycle_operations set status='running',lease_owner=gen_random_uuid(),lease_until=now()+interval '2 minutes',updated_at=now()
 where id=p_operation_id and kind='undeploy' and status in ('pending','running') and not in_flight
 and (lease_until is null or lease_until<now()) returning * into o;
 if not found then return null; end if;
 return to_jsonb(o);
end $$;

create function amux.finish_app_lifecycle(p_operation_id uuid,p_token text) returns void
language plpgsql security definer set search_path=amux,pg_temp as $$
begin
 update amux.app_lifecycle_operations set status='succeeded',in_flight=false,updated_at=now()
 where id=p_operation_id and kind in ('deploy','delete') and token is not distinct from p_token;
 if not found then raise exception 'lifecycle_conflict' using errcode='55000'; end if;
end $$;

create function amux.guard_app_undeploy() returns trigger language plpgsql security definer set search_path=amux,pg_temp as $$
begin
 if exists(select 1 from amux.app_lifecycle_operations where app_id=old.id and kind='undeploy' and status<>'succeeded')
 and (new.fc_status is null or new.fc_status not in ('uninstalling','uninstall_failed','uninstalled')) then
  raise exception 'lifecycle_conflict' using errcode='55000';
 end if;
 return new;
end $$;
create trigger guard_app_undeploy before update of fc_status on amux.apps for each row execute function amux.guard_app_undeploy();

revoke all on function amux.begin_app_lifecycle(uuid,text,text,text),amux.claim_app_undeploy(uuid),amux.finish_app_lifecycle(uuid,text) from public,anon,authenticated;
grant execute on function amux.begin_app_lifecycle(uuid,text,text,text),amux.claim_app_undeploy(uuid),amux.finish_app_lifecycle(uuid,text) to service_role;

create function amux.finish_app_undeploy(p_operation_id uuid,p_owner uuid,p_steps jsonb) returns void
language plpgsql security definer set search_path=amux,pg_temp as $$
declare o amux.app_lifecycle_operations; failed boolean;
begin
 select * into o from amux.app_lifecycle_operations where id=p_operation_id and kind='undeploy' and lease_owner=p_owner and status='running' and not in_flight for update;
 if not found then raise exception 'lifecycle_conflict' using errcode='55000'; end if;
 failed := exists(select 1 from jsonb_each(p_steps) s where s.value->>'status'='failed');
 if (select count(*) from jsonb_each(p_steps)) <> 5 then raise exception 'incomplete cleanup'; end if;
 update amux.app_lifecycle_operations set status=case when failed then 'failed' else 'succeeded' end,steps=p_steps,error=case when failed then 'Some deployment resources could not be cleaned; retry cleanup.' else null end,lease_until=null,updated_at=now() where id=o.id;
 update amux.apps set fc_status=case when failed then 'uninstall_failed' else 'uninstalled' end,fc_endpoint=null,oauth_client_id=case when p_steps->'oauthClient'->>'status'='succeeded' then null else oauth_client_id end,updated_at=now() where id=o.app_id;
end $$;
revoke all on function amux.finish_app_undeploy(uuid,uuid,jsonb) from public,anon,authenticated;
grant execute on function amux.finish_app_undeploy(uuid,uuid,jsonb) to service_role;

alter table amux.apps add column undeploy_operation jsonb;
create function amux.sync_app_undeploy_view() returns trigger language plpgsql security definer set search_path=amux,pg_temp as $$
begin
 if new.kind='undeploy' then
  update amux.apps set undeploy_operation=jsonb_build_object('id',new.id,'appId',new.app_id,'status',new.status,'startedAt',new.started_at,'updatedAt',new.updated_at,'steps',new.steps,'error',new.error) where id=new.app_id;
 end if;
 return new;
end $$;
create trigger sync_app_undeploy_view after insert or update on amux.app_lifecycle_operations for each row execute function amux.sync_app_undeploy_view();
-- A user cannot revive an app by patching build status during cleanup.
create function amux.guard_app_deploy_token() returns trigger language plpgsql security definer set search_path=amux,pg_temp as $$
begin
 if new.deploy_token is distinct from old.deploy_token and new.deploy_token is not null and exists(select 1 from amux.app_lifecycle_operations where app_id=old.id and status<>'succeeded') then
  raise exception 'lifecycle_conflict' using errcode='55000';
 end if;
 return new;
end $$;
create trigger guard_app_deploy_token before update of deploy_token on amux.apps for each row execute function amux.guard_app_deploy_token();

create function amux.fail_app_undeploy_unknown(p_operation_id uuid,p_owner uuid) returns void
language plpgsql security definer set search_path=amux,pg_temp as $$
declare aid uuid;
begin
 update amux.app_lifecycle_operations set status='failed',error='Provider outcome unknown; operator reconciliation required before retry or deploy.',updated_at=now()
 where id=p_operation_id and lease_owner=p_owner and in_flight returning app_id into aid;
 if not found then raise exception 'lifecycle_conflict' using errcode='55000'; end if;
 update amux.apps set fc_status='uninstall_failed',updated_at=now() where id=aid;
end $$;
revoke all on function amux.fail_app_undeploy_unknown(uuid,uuid) from public,anon,authenticated;
grant execute on function amux.fail_app_undeploy_unknown(uuid,uuid) to service_role;

-- A daemon build failure releases an issued upload handle, but never an active FC finalize.
create function amux.release_failed_app_build() returns trigger language plpgsql security definer set search_path=amux,pg_temp as $$
begin
 if new.fc_status='deploy_error' then
  update amux.app_lifecycle_operations set status='succeeded',updated_at=now()
  where app_id=new.id and kind='deploy' and status<>'succeeded' and not in_flight;
 end if;
 return new;
end $$;
create trigger release_failed_app_build after update of fc_status on amux.apps for each row execute function amux.release_failed_app_build();

create function amux.guard_app_lifecycle_delete() returns trigger language plpgsql security definer set search_path=amux,pg_temp as $$
begin
 if exists(select 1 from amux.app_lifecycle_operations where app_id=old.id and status<>'succeeded' and kind<>'delete') then
  raise exception 'lifecycle_conflict' using errcode='55000';
 end if;
 return old;
end $$;
create trigger guard_app_lifecycle_delete before delete on amux.apps for each row execute function amux.guard_app_lifecycle_delete();

-- A crashed worker must surface uncertainty, without allowing a second deletion.
create function amux.report_expired_app_undeploy_calls() returns void
language plpgsql security definer set search_path=amux,pg_temp as $$
begin
 update amux.app_lifecycle_operations set status='failed',error='Provider outcome unknown; operator reconciliation required before retry or deploy.',updated_at=now()
 where kind='undeploy' and status='running' and in_flight and lease_until<now();
 update amux.apps a set fc_status='uninstall_failed',updated_at=now()
 where fc_status='uninstalling' and exists(select 1 from amux.app_lifecycle_operations o where o.app_id=a.id and o.kind='undeploy' and o.status='failed' and o.in_flight);
end $$;
revoke all on function amux.report_expired_app_undeploy_calls() from public,anon,authenticated;
grant execute on function amux.report_expired_app_undeploy_calls() to service_role;
