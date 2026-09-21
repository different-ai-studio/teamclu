# GoTrue auth email templates

The four OTP emails GoTrue sends (login, signup, email change, recovery).
`templates-server` (caddy) serves this directory on the internal docker
network, and GoTrue fetches the file over HTTP at send time — so an edit here
is live as soon as the box has the file. No container restart, no rebuild.

Constraints, all of them learned the hard way:

- **Static files, no includes.** The four are near-identical by hand; when you
  change the layout, change all four.
- **Inline styles and table layout only.** No `<style>` block, no flexbox or
  grid — mail clients drop them.
- **`{{ .Token }}` is the only variable used.** These are OTP-only emails; the
  flows that would carry `{{ .ConfirmationURL }}` are not enabled.
- **"10 分钟内有效" is copy, not behaviour.** The real window is
  `GOTRUE_MAILER_OTP_EXP` in `../docker-compose.yml` (600s; GoTrue's own
  default is 86400). Change one and change the other.
- **The all-in-one image copies this directory too**
  (`../../all-in-one/Dockerfile`, `COPY … /opt/teamclu/email-templates`), so
  edits here reach that build as well.

The subject lines live next to the template URLs in `../docker-compose.yml`.
