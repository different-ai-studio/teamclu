-- Atomic revert: re-publish an earlier version's content as the new latest.
-- Same lock + CAS shape as amux.publish_team_skill_version.

create or replace function amux.revert_team_skill_version(
  p_team_id uuid,
  p_slug text,
  p_target_version integer,
  p_changelog text default null
)
returns amux.team_skill_versions
language plpgsql
security definer
set search_path = amux, public
as $$
declare
  v_skill amux.team_skills%rowtype;
  v_source amux.team_skill_versions%rowtype;
  v_actor uuid;
  v_next integer;
  v_version amux.team_skill_versions%rowtype;
  v_changelog text;
begin
  if not amux.is_team_member(p_team_id) then
    raise exception 'not a member of this team' using errcode = '42501';
  end if;

  v_actor := amux.current_actor_id_for_team(p_team_id);
  if v_actor is null then
    raise exception 'not a member of this team' using errcode = '42501';
  end if;

  select * into v_skill
  from amux.team_skills
  where team_id = p_team_id and slug = p_slug
  for update;

  if not found then
    raise exception 'skill not found: %', p_slug using errcode = 'P0002';
  end if;

  if v_skill.upstream_subscribed then
    update amux.team_skills
    set upstream_subscribed = false,
        upstream_detached_at = now(),
        updated_at = now()
    where id = v_skill.id
    returning * into v_skill;
  end if;

  if p_target_version = v_skill.latest_version then
    raise exception 'v% is already the latest version', p_target_version
      using errcode = '23505';
  end if;

  select * into v_source
  from amux.team_skill_versions
  where skill_id = v_skill.id and version = p_target_version;

  if not found then
    raise exception 'version % not found', p_target_version using errcode = 'P0002';
  end if;

  v_changelog := nullif(trim(coalesce(p_changelog, '')), '');
  if v_changelog is null then
    v_changelog := format('Reverted to v%s', p_target_version);
  end if;

  v_next := v_skill.latest_version + 1;

  insert into amux.team_skill_versions (
    skill_id,
    version,
    content_hash,
    size,
    changelog,
    summary,
    when_to_use,
    when_not_to_use,
    requires,
    created_by,
    published_from_version,
    blob_scope,
    object_path,
    upstream_version
  ) values (
    v_skill.id,
    v_next,
    v_source.content_hash,
    coalesce(v_source.size, 0),
    v_changelog,
    v_source.summary,
    v_source.when_to_use,
    v_source.when_not_to_use,
    v_source.requires,
    v_actor,
    case when v_skill.latest_version > 0 then v_skill.latest_version else null end,
    coalesce(v_source.blob_scope, 'team'),
    v_source.object_path,
    v_source.upstream_version
  )
  returning * into v_version;

  update amux.team_skills
  set latest_version = v_next,
      summary = v_source.summary,
      when_to_use = v_source.when_to_use,
      when_not_to_use = v_source.when_not_to_use,
      requires = v_source.requires,
      updated_at = now()
  where id = v_skill.id
    and latest_version = v_skill.latest_version;

  if not found then
    raise exception 'stale_team_skill_base: registry moved concurrently'
      using errcode = '23505';
  end if;

  return v_version;
end;
$$;

revoke all on function amux.revert_team_skill_version(uuid, text, integer, text) from public;
grant execute on function amux.revert_team_skill_version(uuid, text, integer, text) to authenticated, service_role;
