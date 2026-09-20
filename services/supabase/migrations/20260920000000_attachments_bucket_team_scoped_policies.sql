-- Stop the `attachments` bucket from being enumerable, and stop one team
-- writing into another team's prefix.
--
-- The bucket is public on purpose (20260530000001_attachments_bucket_public.sql):
-- attachment URLs are persisted into message content and idea.attachment_urls,
-- and every client renders them as a plain fetch with no bearer. The
-- confidentiality model is the unguessable object path
-- (`<team>/<session>/<uuid>/<file>`), the same capability model as `avatars`.
--
-- That model only holds if paths cannot be listed, and they could be.
-- `attachments_public_read` granted SELECT on the whole bucket to `public`.
-- Serving `/object/public/...` never consults RLS, so the policy did nothing
-- for the URLs it was added for; what it did do was open
-- `POST /storage/v1/object/list/attachments` to anyone holding the anon key —
-- which is handed to every deployed app's browser bundle. Listing walks
-- team -> session -> object, and each listed path is a working public URL.
--
-- So the bucket stays public, and existing URLs keep resolving. On a public
-- bucket storage-api (v1.54.1, checked against the real service) answers every
-- by-path read without consulting RLS — `/object/public`, and equally the
-- authenticated download, HEAD and `/object/info` routes. Knowing a path still
-- means being able to read it; that is the capability model, and the only way
-- to change it is to make the bucket private.
--
-- What RLS does govern is the two operations that leak or forge paths: listing,
-- and upload (the INSERT check plus the read-back storage-api does for an
-- upsert). Both are scoped to members of the team named by the first path
-- segment. Every uploader (web, iOS, Expo, daemon) already writes
-- `<team_id>/...`, and `amux.is_team_member` counts agent actors, so the
-- daemon's uploads pass as well.
--
-- The SELECT policy is replaced rather than dropped because FC uploads with the
-- caller's token and `upsert: true`, and storage-api requires the uploader to
-- be able to read back the row it writes. With no SELECT policy at all, every
-- upload would fail.
--
-- `CASE` rather than `regex AND cast`: Postgres does not promise to evaluate
-- AND operands in order, and a first segment that is not a uuid must read as
-- "no access", not as a cast error that fails the whole listing.

drop policy if exists attachments_public_read on storage.objects;

-- Subsumed by the team-scoped read below (idea attachments live under
-- `<team_id>/ideas/...`, so the first segment is still the team).
drop policy if exists team_members_can_download_idea_attachments on storage.objects;

drop policy if exists attachments_team_member_read on storage.objects;
create policy attachments_team_member_read on storage.objects
for select to authenticated
using (
  bucket_id = 'attachments'
  and case
        when split_part(name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then amux.is_team_member(split_part(name, '/', 1)::uuid)
        else false
      end
);

-- `authenticated_can_upload` only checked the bucket, so any signed-in user
-- could plant objects under any team's prefix.
drop policy if exists authenticated_can_upload on storage.objects;

drop policy if exists attachments_team_member_upload on storage.objects;
create policy attachments_team_member_upload on storage.objects
for insert to authenticated
with check (
  bucket_id = 'attachments'
  and case
        when split_part(name, '/', 1) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        then amux.is_team_member(split_part(name, '/', 1)::uuid)
        else false
      end
);
