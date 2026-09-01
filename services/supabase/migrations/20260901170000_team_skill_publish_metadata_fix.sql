-- Follow-up to 20260901150000: honor empty guidance fields on publish and derive
-- published_from_version from the CAS baseline instead of a client-supplied value.

create or replace function amux.publish_team_skill_version(
  p_team_id uuid,
  p_slug text,
  p_expected_latest_version integer,
  p_content_hash text,
  p_size bigint,
  p_changelog text,
  p_summary text default null,
  p_category text default null,
  p_when_to_use text default null,
  p_when_not_to_use text default null,
  p_requires jsonb default null,
  p_published_from_version integer default null
)
returns amux.team_skill_versions
language plpgsql
security definer
set search_path = amux, public
as $$
declare
  v_skill amux.team_skills%rowtype;
  v_actor uuid;
  v_next integer;
  v_version amux.team_skill_versions%rowtype;
  v_summary text;
  v_category text;
  v_when_to_use text;
  v_when_not_to_use text;
  v_requires jsonb;
begin
  if p_expected_latest_version is null or p_expected_latest_version < 0 then
    raise exception 'expectedLatestVersion must be a non-negative integer'
      using errcode = '22023';
  end if;

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

  if v_skill.latest_version <> p_expected_latest_version then
    raise exception 'stale_team_skill_base: expected v%, registry is v%',
      p_expected_latest_version, v_skill.latest_version
      using errcode = '23505';
  end if;

  if v_skill.upstream_subscribed then
    update amux.team_skills
    set upstream_subscribed = false,
        upstream_detached_at = now(),
        updated_at = now()
    where id = v_skill.id
    returning * into v_skill;
  end if;

  v_summary := coalesce(nullif(trim(p_summary), ''), v_skill.summary);
  v_category := coalesce(nullif(trim(p_category), ''), v_skill.category);
  -- Empty string is a real answer ("cleared"), distinct from NULL ("keep").
  v_when_to_use := coalesce(p_when_to_use, v_skill.when_to_use);
  v_when_not_to_use := coalesce(p_when_not_to_use, v_skill.when_not_to_use);
  v_requires := coalesce(p_requires, v_skill.requires);

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
    blob_scope
  ) values (
    v_skill.id,
    v_next,
    p_content_hash,
    coalesce(p_size, 0),
    p_changelog,
    v_summary,
    v_when_to_use,
    v_when_not_to_use,
    v_requires,
    v_actor,
    case when p_expected_latest_version > 0 then p_expected_latest_version else null end,
    'team'
  )
  returning * into v_version;

  update amux.team_skills
  set latest_version = v_next,
      summary = v_summary,
      category = v_category,
      when_to_use = v_when_to_use,
      when_not_to_use = v_when_not_to_use,
      requires = v_requires,
      updated_at = now()
  where id = v_skill.id
    and latest_version = p_expected_latest_version;

  if not found then
    raise exception 'stale_team_skill_base: registry moved concurrently'
      using errcode = '23505';
  end if;

  return v_version;
end;
$$;

revoke all on function amux.publish_team_skill_version(
  uuid, text, integer, text, bigint, text, text, text, text, text, jsonb, integer
) from public;

grant execute on function amux.publish_team_skill_version(
  uuid, text, integer, text, bigint, text, text, text, text, text, jsonb, integer
) to authenticated, service_role;
