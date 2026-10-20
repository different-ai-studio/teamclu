-- Failure cleanup is a deployment-state invariant, not a client follow-up.
create function amux.clear_failed_app_deploy() returns trigger
language plpgsql security definer set search_path=amux,pg_temp as $$
begin
 if new.fc_status='deploy_error' then
  new.deploy_token := null;
  new.deploy_started_at := null;
 end if;
 return new;
end $$;
create trigger clear_failed_app_deploy before update of fc_status on amux.apps
 for each row execute function amux.clear_failed_app_deploy();

-- OLD retains the attempt token even when the BEFORE trigger cleared NEW.
-- Provider calls with unknown outcomes keep their durable fence.
create or replace function amux.release_failed_app_build() returns trigger
language plpgsql security definer set search_path=amux,pg_temp as $$
begin
 if new.fc_status='deploy_error' and old.deploy_token is not null then
  update amux.app_lifecycle_operations set status='succeeded',updated_at=now()
  where app_id=new.id and kind='deploy' and token=old.deploy_token
    and status<>'succeeded' and not in_flight;
 end if;
 return new;
end $$;

-- Serialize cancellation against begin_app_lifecycle using the same app row.
create function amux.cancel_app_deploy_preflight(p_app_id uuid,p_token text) returns boolean
language plpgsql security definer set search_path=amux,pg_temp as $$
declare a amux.apps;
begin
 select * into a from amux.apps where id=p_app_id for update;
 if not found then raise exception 'app_not_found' using errcode='P0002'; end if;
 if p_token is null or a.deploy_token is distinct from p_token then return false; end if;
 if coalesce(a.fc_status,'not_deployed') not in ('not_deployed','live','deploy_error','uninstalled') then return false; end if;
 if exists(select 1 from amux.app_lifecycle_operations where app_id=p_app_id and status<>'succeeded') then return false; end if;
 update amux.apps set deploy_token=null,updated_at=now() where id=p_app_id;
 return true;
end $$;
revoke all on function amux.clear_failed_app_deploy(),amux.cancel_app_deploy_preflight(uuid,text) from public,anon,authenticated;
grant execute on function amux.cancel_app_deploy_preflight(uuid,text) to service_role;
