-- Team skills: hard-delete and status/superseded_by changes are owner/admin only.
-- Spec: docs/specs/2026-09-16-team-skill-retire-and-delete-design.md
-- Do not restore the owner_actor_id bypass; that column is display, not ACL.

drop policy if exists team_skills_delete_if_member on amux.team_skills;
drop policy if exists team_skills_delete_if_owner_or_admin on amux.team_skills;
create policy team_skills_delete_if_owner_or_admin on amux.team_skills
  for delete using (amux.is_team_admin_or_owner(team_id));

create or replace function amux.team_skills_status_admin_only()
returns trigger
language plpgsql
as $$
begin
  if NEW.status is distinct from OLD.status
     or NEW.superseded_by is distinct from OLD.superseded_by then
    if not amux.is_team_admin_or_owner(NEW.team_id) then
      raise exception 'team owner or admin access required' using errcode = '42501';
    end if;
  end if;
  return NEW;
end;
$$;

drop trigger if exists team_skills_status_admin_only on amux.team_skills;
create trigger team_skills_status_admin_only
  before update on amux.team_skills
  for each row
  execute function amux.team_skills_status_admin_only();
