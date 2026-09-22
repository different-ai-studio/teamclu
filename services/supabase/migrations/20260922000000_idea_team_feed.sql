-- Ideas as a team feed: a like per (idea, actor), images on the post itself,
-- and one read that carries the counts a feed row renders.
--
-- Why images move onto the idea. `idea_activities.attachment_urls` already
-- existed, so the iOS create sheet posted the pictures as a follow-up
-- 'progress' activity with a synthetic "Attached 2 images." body. That reads
-- as a comment on the board, and a feed row would have had to reach into the
-- first comment to find the post's own picture. A post owns its images.
--
-- Why a like is not a reaction table. Only one kind, one per member, toggled
-- off by taking it back: the natural key IS the uniqueness constraint, so
-- there is no surrogate id and "have I liked this" is a primary-key lookup.
-- A richer set of reactions would need a kind column and a different key; it
-- is not what this models.

create table if not exists amux.idea_likes (
  idea_id uuid not null references amux.ideas(id) on delete cascade,
  team_id uuid not null references amux.teams(id) on delete cascade,
  -- Denormalised so the policies below can call `is_team_member` without
  -- joining ideas on every row, matching idea_activities.
  actor_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (idea_id, actor_id)
);

alter table amux.idea_likes enable row level security;

drop policy if exists idea_likes_select_if_team_member on amux.idea_likes;
create policy idea_likes_select_if_team_member on amux.idea_likes
  for select to authenticated
  using (amux.is_team_member(team_id));

-- A member may only add their own like, and only to an idea in the same team
-- the row claims — without the EXISTS, `team_id` is caller-supplied and a
-- member of team A could like an idea in team B by labelling the row A.
drop policy if exists idea_likes_insert_own on amux.idea_likes;
create policy idea_likes_insert_own on amux.idea_likes
  for insert to authenticated
  with check (
    amux.is_team_member(team_id)
    and actor_id = amux.current_actor_id_for_team(team_id)
    and exists (
      select 1 from amux.ideas i
      where i.id = idea_likes.idea_id
        and i.team_id = idea_likes.team_id
    )
  );

drop policy if exists idea_likes_delete_own on amux.idea_likes;
create policy idea_likes_delete_own on amux.idea_likes
  for delete to authenticated
  using (
    amux.is_team_member(team_id)
    and actor_id = amux.current_actor_id_for_team(team_id)
  );

grant select, insert, delete on amux.idea_likes to authenticated;

-- Images on the post. Same column type and default as idea_activities, so the
-- two carry attachments identically.
alter table amux.ideas
  add column if not exists attachment_urls text[] not null default '{}'::text[];

-- One read for a page of the feed, counts included. Without it the client
-- renders N rows and then asks N times how many comments and likes each has.
--
-- Plain STABLE SQL, not SECURITY DEFINER: RLS decides what it aggregates, and
-- every member may read the whole team's ideas anyway. Also not plpgsql — a
-- generic plan on a keyset scan is the shape that produced the session-list
-- timeout, and there is nothing here that needs procedural code.
--
-- Comments are 'progress' activities. 'status_change' and 'reorder' are
-- bookkeeping the feed does not count as somebody having said something.
create or replace function amux.idea_feed(
  p_team_id uuid,
  p_archived boolean default false,
  p_limit integer default 50,
  p_before_updated_at timestamptz default null,
  p_before_id uuid default null
)
returns table (
  id uuid,
  team_id uuid,
  workspace_id uuid,
  created_by_actor_id uuid,
  title text,
  description text,
  status text,
  archived boolean,
  sort_order integer,
  attachment_urls text[],
  created_at timestamptz,
  updated_at timestamptz,
  comment_count bigint,
  like_count bigint,
  liked_by_me boolean
)
language sql
stable
set search_path to 'amux', 'public', 'auth'
as $$
  select
    i.id,
    i.team_id,
    i.workspace_id,
    i.created_by_actor_id,
    i.title,
    i.description,
    i.status,
    i.archived,
    i.sort_order,
    i.attachment_urls,
    i.created_at,
    i.updated_at,
    (select count(*)::bigint
       from amux.idea_activities a
      where a.idea_id = i.id
        and a.activity_type = 'progress')                    as comment_count,
    (select count(*)::bigint
       from amux.idea_likes l
      where l.idea_id = i.id)                                as like_count,
    exists (select 1
              from amux.idea_likes l
             where l.idea_id = i.id
               and l.actor_id = amux.current_actor_id_for_team(i.team_id))
                                                             as liked_by_me
    from amux.ideas i
   where i.team_id = p_team_id
     and i.archived = coalesce(p_archived, false)
     -- Keyset, not OFFSET: the feed is ordered newest-first and rows move as
     -- people comment, so an offset page would skip and repeat.
     and (
       p_before_updated_at is null
       or p_before_id is null
       or (i.updated_at, i.id) < (p_before_updated_at, p_before_id)
     )
   order by i.updated_at desc, i.id desc
   -- 200 is the API's page ceiling; the extra row is the one FC fetches
   -- past the page to learn whether there is a next one.
   limit least(greatest(coalesce(p_limit, 50), 1), 201);
$$;

revoke all on function amux.idea_feed(uuid, boolean, integer, timestamptz, uuid) from public;
grant execute on function amux.idea_feed(uuid, boolean, integer, timestamptz, uuid) to authenticated;

-- Toggle in one round trip, and hand back what the row has to redraw so the
-- client doesn't refetch the page to learn its own like landed.
--
-- Deliberately not SECURITY DEFINER: the policies above still apply, so this
-- resolves the caller's actor id for convenience, not for privilege. A caller
-- outside the team reads no idea row and gets `idea not found` — the same
-- answer as a genuinely missing id, which is what we want it to be.
create or replace function amux.set_idea_like(p_idea_id uuid, p_liked boolean)
returns table (like_count bigint, liked_by_me boolean)
language plpgsql
volatile
set search_path to 'amux', 'public', 'auth'
as $$
declare
  v_team_id uuid;
  v_actor_id uuid;
begin
  select i.team_id into v_team_id from amux.ideas i where i.id = p_idea_id;
  if v_team_id is null then
    raise exception 'idea not found' using errcode = 'P0002';
  end if;

  v_actor_id := amux.current_actor_id_for_team(v_team_id);
  if v_actor_id is null then
    raise exception 'caller is not a member of this team' using errcode = '42501';
  end if;

  if coalesce(p_liked, false) then
    -- Liking twice is the same as liking once, not an error: two taps racing
    -- from two devices must not 409.
    insert into amux.idea_likes (idea_id, team_id, actor_id)
    values (p_idea_id, v_team_id, v_actor_id)
    on conflict (idea_id, actor_id) do nothing;
  else
    delete from amux.idea_likes l
     where l.idea_id = p_idea_id
       and l.actor_id = v_actor_id;
  end if;

  return query
    select (select count(*)::bigint
              from amux.idea_likes l
             where l.idea_id = p_idea_id),
           exists (select 1
                     from amux.idea_likes l
                    where l.idea_id = p_idea_id
                      and l.actor_id = v_actor_id);
end;
$$;

revoke all on function amux.set_idea_like(uuid, boolean) from public;
grant execute on function amux.set_idea_like(uuid, boolean) to authenticated;

-- Attaching pictures to a post, as its own function rather than a fifth
-- parameter on create_idea. That one is SECURITY DEFINER and has been amended
-- since the baseline, so recreating it here means reproducing a body that has
-- already drifted; and a defaulted fifth parameter does not overload cleanly
-- for PostgREST, which calls by name — the existing four-argument call would
-- become ambiguous rather than continuing to work.
--
-- FC calls this straight after create when a post carries pictures. Not one
-- transaction: if it fails the post exists without its images, which is
-- visible and fixable, rather than a half-written row.
--
-- Only the author. A shared board lets anyone move an idea along (that is what
-- update_idea is for); the pictures are part of what someone posted.
create or replace function amux.set_idea_attachments(
  p_idea_id uuid,
  p_attachment_urls text[]
)
returns void
language plpgsql
volatile
security definer
set search_path to 'amux', 'public', 'auth'
as $$
declare
  v_team_id uuid;
  v_author_id uuid;
  v_actor_id uuid;
begin
  select i.team_id, i.created_by_actor_id
    into v_team_id, v_author_id
    from amux.ideas i
   where i.id = p_idea_id;

  -- SECURITY DEFINER read, so a non-member would otherwise learn from a
  -- different error message that the id exists. One answer for both.
  if v_team_id is null or not amux.is_team_member(v_team_id) then
    raise exception 'idea not found' using errcode = 'P0002';
  end if;

  v_actor_id := amux.current_actor_id_for_team(v_team_id);
  if v_actor_id is null or v_author_id is distinct from v_actor_id then
    raise exception 'only the author can change a post''s attachments'
      using errcode = '42501';
  end if;

  update amux.ideas
     set attachment_urls = coalesce(p_attachment_urls, '{}'::text[]),
         updated_at = now()
   where id = p_idea_id;
end;
$$;

revoke all on function amux.set_idea_attachments(uuid, text[]) from public;
grant execute on function amux.set_idea_attachments(uuid, text[]) to authenticated;
