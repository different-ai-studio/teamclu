# Hangzhou production per-account App Git alignment

**Status (2026-11-28): prepared, not enabled.** This is the release and acceptance record for the production Git host `gitea.teamclu.cn` and SSH endpoint `git-ssh.teamclu.cn:32222`. The older `git.service.ucar.cc` address in the 2026-11-16 design is historical.

## Verified configuration difference

| Boundary | Observed production state | Required state before account auth |
| --- | --- | --- |
| Cloud API | GitOps image source `89c1c48` contains the feature; `cloud-api/prod` declares `GITEA_URL`, `GITEA_OWNER`, `GITEA_TOKEN` only. Public `/v1/git/host` returns `503 git_host_unavailable`. | `GITEA_PUBLIC_URL=https://gitea.teamclu.cn/`, a secret-backed `GIT_TOKEN_SECRET`, and `GITEA_ACCOUNT_AUTH=on` only in the final activation stage. Read back the running Pod environment by **key/presence only**. |
| Public HTTPS | ALB and Kong route `gitea.teamclu.cn` to Gitea. TLS is valid; the route has no trusted identity translation. | Route only an allowlisted Git/PR API surface through a proxy that removes all inbound `X-WEBAUTH-*`, calls Cloud API `/v1/git/authz`, forwards only the returned `X-WEBAUTH-USER`, and removes `Authorization` upstream. Refuse every unlisted path. |
| Gitea | `ROOT_URL=https://gitea.teamclu.cn/`; public SSH advertises `git-ssh.teamclu.cn:32222`. Reverse-proxy account auth is absent. | Enable proxy authentication and API authentication with the same trusted header; disable local registration/password fallback. Do this only after every direct HTTP path to Gitea is isolated. Preserve SSH service and existing deploy keys. |
| Internal management API | Cloud API currently targets Gitea directly. | Point `GITEA_URL` at an internal header-stripping proxy. Remove Cloud API and untrusted workload access to Gitea Pod port 3000. Prove a nontrusted Pod/VPC workload cannot connect. |
| DNS/TLS/IaC | AliDNS records and ALB 443 certificate are live; Terraform owner found no resource change needed. | Keep current DNS and certificate bindings. NetworkPolicy and live negative probes still decide the HTTP trust boundary. |
| Identity projection | Source `89c1c48` reads App platform tables but projects an org-visible grant only to actors of the App's linked team. | Ship the org-wide read projection fix in this branch before enabling account auth; verify production migrations, tables and triggers by read-only metadata query. |

The Cloud API endpoint returns 503 whenever `GITEA_ACCOUNT_AUTH` is off **or** `GITEA_PUBLIC_URL` has no valid host. `/v1/git/token` additionally requires `GIT_TOKEN_SECRET`. A 200 from `/v1/git/host` proves configuration, not permissions.

## Release order and gates

1. Confirm production migration ledger and actual objects for `20261117000000`, `20261120120000`, `20261125200000`, `20261126100000`, `20261126200000`, `20261127100000`, and `20261127200000`. If absent, stop: those migrations backfill existing App permissions and need a separately reviewed data-change scope. The currently exposed Supabase MCP has no Hangzhou project.
2. Release the Cloud API source fix for org-visible account projection, with targeted and FC suite tests, through the required source PR and image process. Pin the immutable production image. The existing image `89c1c48` does not contain this fix.
3. Deploy and verify a private Gitea HTTP boundary: only the trusted Git proxy can reach Gitea port 3000. Cloud API's management calls use a separate header-stripping internal endpoint. Preserve SSH `32222`, its service and NetworkPolicy. Run negative connectivity and forged-header probes before changing Gitea authentication.
4. Route public HTTPS Git and the specifically approved PR API paths through trusted auth. Validate unauthorized, forged-header, non-Git-path and Basic-password requests are rejected. Verify auth failure prompts the Git credential helper and that upstream never receives the client's Basic credential.
5. Enable Gitea reverse-proxy identity settings after steps 3–4; verify its effective configuration from the running Pod. Add `GITEA_PUBLIC_URL` and secret-backed `GIT_TOKEN_SECRET` to Cloud API with account auth still off. Verify key presence without printing values and that `/v1/git/host` remains 503.
6. Create a dedicated acceptance org/team, human accounts and App repo, with no customer App mutations. Check projected Gitea users, org and read/collaborator permissions. Set `GITEA_ACCOUNT_AUTH=on` last, roll Cloud API, then run the matrix below. Do not infer a release from a merged PR or healthy Pod alone.

## Acceptance matrix to record

Record UTC time, exact image digest/commit, GitOps revision, test account role, repo ID, command/HTTP status, and a redacted server-side audit reference for each row. Keep tokens, private keys, clone URLs with userinfo, and customer data out of the record.

Run `services/fc/scripts/accept-prod-git-account-auth.sh` after setting `TEAMCLU_GIT_TEST_REPO_URL` and the dedicated `TEAMCLU_GIT_{ADMIN,WRITE,READ,OUTSIDER}_TOKEN` variables in a private shell. Optionally set `TEAMCLU_GIT_PERSONAL_REPO_URL` to check an ungranted personal App. The script creates two acceptance branches in the dedicated repo and prints their hashes for a separate Gitea pusher-audit readback; remove those branches after recording evidence. It does not exercise an existing App's SSH publish, which needs its desktop/daemon workflow.

| Principal and action | Expected |
| --- | --- |
| Public `GET /v1/git/host` | 200; `gitHost=gitea.teamclu.cn`, `gitScheme=https` |
| App creator/admin: HTTPS clone, fetch, push | Allowed; Gitea push actor is that account |
| Explicit write account: HTTPS clone, fetch, push | Allowed; Gitea push actor is that account |
| Read account and same-org other-team account: clone, fetch | Allowed; push rejected |
| Account outside org or without grant on personal App: clone, fetch, push | Rejected without leaking private repo metadata |
| No credential, forged `X-WEBAUTH-USER`, valid credential plus forged identity header | First two rejected; last acts only as authenticated account |
| Removed last org membership or revoked App grant | Read/write withdrawn after sync; reconciler restores any missed projection |
| Existing shared-owner App: SSH deploy-key fetch, seed/push and publish | Succeeds through `git-ssh.teamclu.cn:32222`; stored SSH remote and `gitea_deploy_key` unchanged |

## Rollback

Clear `GITEA_ACCOUNT_AUTH` first and confirm `/v1/git/host` is 503 and new clients receive SSH behavior. Leave `GIT_TOKEN_SECRET` in the secret store during triage; never print it. Keep existing App SSH remotes and deploy keys. If the trusted proxy fails, restore the previous public route only with Gitea proxy identity authentication disabled; retain the header-stripping internal management path until Gitea auth is off. Reconcile/undo test fixtures in the dedicated acceptance org only. Record actual running revisions after rollback.

## Open evidence

- ACK private API was not reachable from this workstation on 2026-11-28. Obtain an approved in-cluster observer path for Pod environment key presence, NetworkPolicy behavior, Gitea effective settings, migration metadata and running image digest.
- The production acceptance org/accounts and old-App SSH publish have not yet been exercised. These require the source and GitOps PR/release sequence above.
- Repository rules prohibit pushing branches or opening PRs until the user explicitly requests it. Staged local commits are reviewable preparation, not a production deployment.
