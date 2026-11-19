-- Team skill ids may be the Chinese title itself.
--
-- 整车成本智能表格 is the registry id, the install directory, and the SKILL.md
-- name. The previous check allowed only [a-z0-9-]. That branch stays, so every
-- row already stored (including ASCII ids and older pinyin ids) still passes.
-- New Unicode ids must be NFC, 2-64 characters, at most 255 UTF-8 bytes, and
-- free of path separators, controls, and Windows-forbidden characters.
--
-- Windows device names are rejected by the API on create, not here. A check
-- that newly forbids `con` would fail the migration if such a row exists.
-- Nothing in this file rewrites or deletes existing slugs.

create or replace function amux.team_skill_slug_chars_ok(slug text)
returns boolean
language plpgsql
immutable
set search_path = pg_catalog
as $$
declare
  n int;
  i int;
  cp int;
begin
  if slug is null then
    return false;
  end if;
  n := char_length(slug);
  if n < 2 or n > 64 then
    return false;
  end if;
  if octet_length(slug) > 255 then
    return false;
  end if;
  if slug is distinct from normalize(slug, NFC) then
    return false;
  end if;
  if right(slug, 1) = '-' then
    return false;
  end if;
  for i in 1..n loop
    cp := ascii(substr(slug, i, 1));
    if cp <= 31 or cp = 127 or (cp between 128 and 159) then
      return false;
    end if;
    if cp in (160, 12288, 65279) then
      return false;
    end if;
    if cp between 8203 and 8205 or cp in (8232, 8233) then
      return false;
    end if;
    if cp between 8234 and 8238 or cp between 8294 and 8297 then
      return false;
    end if;
    if cp < 128 then
      if cp = 45 then
        if i = 1 then
          return false;
        end if;
      elsif not (cp between 48 and 57 or cp between 97 and 122) then
        return false;
      end if;
    end if;
  end loop;
  return true;
end;
$$;

alter table amux.team_skills
  drop constraint if exists team_skills_slug_format;

alter table amux.team_skills
  add constraint team_skills_slug_format
  check (
    slug ~ '^[a-z0-9][a-z0-9-]{1,63}$'
    or amux.team_skill_slug_chars_ok(slug)
  );
