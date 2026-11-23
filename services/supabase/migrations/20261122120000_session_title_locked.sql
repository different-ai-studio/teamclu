-- A person who renames a session locks that title. Generated titles
-- (the daemon's pi setTitle path) may replace a title only while the
-- lock is off, in one UPDATE so an in-flight rename cannot be overwritten.
-- The lock is never cleared by a generated write.

alter table amux.sessions
  add column if not exists title_locked boolean not null default false;

comment on column amux.sessions.title_locked is
  'True after a person renames the session. Generated titles update only while this is false.';

create or replace function amux.apply_generated_session_title(
  p_session_id uuid,
  p_title text
)
returns table (
  applied boolean,
  title text,
  title_locked boolean
)
language plpgsql
volatile
security invoker
set search_path = amux, public
as $$
declare
  v_title text;
  v_locked boolean;
begin
  update amux.sessions as s
     set title = p_title
   where s.id = p_session_id
     and s.title_locked = false
  returning s.title, s.title_locked into v_title, v_locked;

  if found then
    applied := true;
    title := v_title;
    title_locked := v_locked;
    return next;
    return;
  end if;

  select s.title, s.title_locked
    into v_title, v_locked
    from amux.sessions as s
   where s.id = p_session_id;

  if not found then
    return;
  end if;

  applied := false;
  title := v_title;
  title_locked := v_locked;
  return next;
end;
$$;

revoke all on function amux.apply_generated_session_title(uuid, text) from public;
grant execute on function amux.apply_generated_session_title(uuid, text) to authenticated, service_role;
