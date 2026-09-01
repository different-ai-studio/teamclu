-- Audit: which installed version the publisher's working copy was based on.
-- Distinct from expectedLatestVersion (CAS guard) — a stale_dirty publish may
-- cut v5 from a draft based on v3 while the registry was already at v4.

alter table amux.team_skill_versions
  add column if not exists published_from_version integer;

alter table amux.team_skill_versions
  add constraint team_skill_versions_published_from_positive
  check (published_from_version is null or published_from_version >= 1);

comment on column amux.team_skill_versions.published_from_version is
  'Installed/baseline version the publisher''s working copy was built from when this version was cut.';
