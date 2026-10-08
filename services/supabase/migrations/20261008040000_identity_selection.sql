-- Pick which of your identities to act as.
--
-- docs/plans/2026-10-08-staff-only-identity-model.md (T5).
--
-- An email user signs in with their real email, which is the account of their
-- FIRST identity; identities minted later by invites sit on synthetic
-- `<id>@teamclu.email` accounts nobody can sign in to directly. Phone login
-- already offers an account picker; these two functions give every signed-in
-- caller the same choice:
--   * amux.list_my_identities()      — the caller's person's identities;
--   * amux.mint_identity_session(id) — a refresh token for one of them.
-- Both resolve "the person" through amux.person_identities (same phone, linked
-- email) and, when amux.staff_only() is on, offer only identities TeamClu may
-- act as. Neither can reach an identity of somebody else.

create or replace function amux.list_my_identities()
returns table(user_id uuid, org_id uuid, org_name text, org_logo text, admin_type smallint, is_current boolean)
language sql
stable security definer
set search_path to 'amux', 'public', 'auth'
as $function$
  select u.id, u.org_id, o.name::text, o.logo::text, u.admin_type::smallint, u.id = auth.uid()
    from amux.person_identities(auth.uid()) as p(id)
    join public.users u on u.id = p.id
    left join public.orgs o on o.id = u.org_id
   where auth.uid() is not null
     and u.deleted_at is null
     and exists (select 1 from auth.users au where au.id = u.id)
     and (not amux.staff_only() or u.admin_type >= 2)
   order by (u.id = auth.uid()) desc, o.name nulls last, u.id;
$function$;

comment on function amux.list_my_identities() is
  'Identities of the signed-in person (amux.person_identities: same phone, linked email) that have their own auth account; under amux.staff_only() only admin_type >= 2. One row per org identity, for the login-time org picker.';

revoke all on function amux.list_my_identities() from public;
grant execute on function amux.list_my_identities() to authenticated, service_role;

create or replace function amux.mint_identity_session(p_user_id uuid)
returns text
language plpgsql
security definer
set search_path to 'amux', 'public', 'auth', 'extensions'
as $function$
begin
  if auth.uid() is null then
    raise exception 'identity switch requires authentication' using errcode = '42501';
  end if;
  if not exists (select 1 from amux.list_my_identities() i where i.user_id = p_user_id) then
    raise exception 'not one of your identities' using errcode = '42501';
  end if;
  return auth._mint_session(p_user_id);
end;
$function$;

comment on function amux.mint_identity_session(uuid) is
  'A refresh token for one of the caller''s own identities (as listed by amux.list_my_identities); 42501 for anything else.';

revoke all on function amux.mint_identity_session(uuid) from public;
grant execute on function amux.mint_identity_session(uuid) to authenticated, service_role;
