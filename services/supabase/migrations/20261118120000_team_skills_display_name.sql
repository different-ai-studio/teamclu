-- Display name for a team skill, separate from its slug.
--
-- The slug is the install folder (`~/.agents/skills/<slug>`), the URL segment,
-- and SKILL.md `name`. It stays `^[a-z0-9][a-z0-9-]{1,63}$` so the same id is
-- a legal directory on Windows, macOS, and Linux (no NFD/NFC split, no
-- case-only collisions, no Windows device names in the generated id).
--
-- A Chinese personal skill such as 整车成本智能表格 is shared under an ASCII
-- slug. This column keeps the title the author already had. Null means "show
-- the slug", which is every row published before this column existed.

alter table amux.team_skills
  add column if not exists display_name text;

alter table amux.team_skills
  drop constraint if exists team_skills_display_name_len;

alter table amux.team_skills
  add constraint team_skills_display_name_len
  check (
    display_name is null
    or (
      char_length(display_name) between 1 and 120
      and display_name !~ '[[:cntrl:]]'
    )
  );
