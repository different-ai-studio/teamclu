# ClawHub 卸载必须清掉 permission.skill

> 目标落位：`docs/architecture/clawhub-uninstall-clears-skill-permission.md`
> 状态：**本 pass 落地 P0 + 相关 P1（zip 覆盖拒绝、Settings 权限 fail-closed、ClawHub 已安装集、auto-follow 401）。**
> 前置阅读：`docs/architecture/team-skills-registry.md`（slug 即内容身份、lockfile / origin.json / `permission.skill` 管线）。

`permission.skill` is keyed by slug, and a slug is reusable. Team uninstall already
forgets the entry (`clear_skill_permission`). ClawHub uninstall did not, so an
allow granted to pack A silently governs pack B that later reuses the name.

## 1. 要解决什么

**P0 — slug-reuse grant.** `clawhub_uninstall` (`apps/desktop/src/commands/clawhub.rs`)
removes the pack directory and the lockfile row, then returns. Team uninstall
(`team_skill_uninstall`) does the same **and** calls `clear_skill_permission`.
`set_skill_permission_ask` only inserts when the key is absent. Sequence:

1. User installs ClawHub skill `deploy-check`, later sets `permission.skill["deploy-check"] = "allow"`.
2. User uninstalls it. Directory + lockfile go away; the allow stays in `opencode.json`.
3. User (or auto-follow) installs a different pack under the same slug.
4. Install writes `ask` only if the key is missing → old allow applies to new code.

The comments at `clawhub.rs` ~405–417 already describe this exact failure mode.
They were written for the helper; ClawHub uninstall never called it.

**Related P1s in this pass** (same permission / origin / installed-set surface):

| # | Bug | Why it belongs with P0 |
|---|---|---|
| 1 | Zip import silently `remove_dir_all`s an existing slug; local sanitizer duplicates `sanitize_zip_path`; no `origin.json` | Same slug-reuse / traversal / bookkeeping contract as ClawHub install |
| 2 | Settings `putDaemonPermissions` returns `null` when the daemon is down; `SkillsSection` still `setSkillPermissions(updated)` | Fail-open on a permission write, same family as leftover allow |
| 3 | ClawHub marketplace unions every folder under skills roots as "installed" | Team packs look ClawHub-installed; Uninstall then errors (`source == team`) |
| 4 | `TeamSkillAutoFollow` swallows every reconcile error, including 401 | Expired session looks like "nothing to do"; packs drift with no signal |

## 2. 不改什么

- MQTT protocol, Caddy, NanoMQ, Supabase schema, refresh-token rotation, daemon runtime, FC routes.
- `apps/daemon/**`, `services/fc/**`.
- `crates/teamclu-skillpack` — read-only reuse (`sanitize_zip_path`, `write_origin`, `build_manifest`, `apply_zip_mode` via the existing ClawHub unpacker).

## 3. P0 — `clawhub_uninstall` 调 `clear_skill_permission`

### 3.1 行为

After a successful lockfile row removal, call `clear_skill_permission(&workspace_path, &slug)` —
the same helper team uninstall already uses. It:

- no-ops when `opencode.json` is missing, unparseable, or has no entry for the slug
  (the daemon watches this file; a no-op rewrite would restart the runtime);
- removes only that slug; leaves `permission.bash` and other skill keys alone.

`clawhub_uninstall` already refuses `source == team` (those must go through
`team_skill_uninstall`, which also clears the server-side install record).
Permission clear runs only on the ClawHub path that actually deletes the pack.

Workspace-shaped limitation is accepted, same as team uninstall: packs are
global (`~/.agents/skills/<slug>`), `permission.skill` is per-workspace, and the
command is handed one path. Other workspaces keep their entry. Documented, not
fixed here.

### 3.2 测试

Analog of `uninstall_forgets_the_skills_permission` in `team_skills.rs`:

- HOME + workspace with `opencode.json` carrying `deploy-check: allow` and `other: allow`
- lockfile row `source: clawhub`
- `clawhub_uninstall` → `deploy-check` gone, `other` and `permission.bash` stay

Optional sibling: missing / unparseable config still succeeds (helper already
guarantees this; P0 test is the grant-reuse one).

## 4. P1.1 — Zip import: no silent overwrite, one sanitizer, origin.json

`import_skill_from_zip` (`apps/desktop/src/commands/skillssh.rs`) today:

- uses a local `sanitize_skill_zip_path` that happens to match
  `teamclu_skillpack::sanitize_zip_path` today, and will drift;
- `remove_dir_all`s `~/.agents/skills/<slug>` if it exists;
- writes no `.clawhub/origin.json`.

### 4.1 Overwrite

Match `clawhub_install`: refuse unless `force == true`.

```
Already installed: ~/.agents/skills/<slug> (use force=true to overwrite)
```

New optional arg `force: Option<bool>` (Tauri: omitted → `None` → false).
Frontend keep current invoke (no force) so a second import of the same slug
surfaces the error instead of clobbering a team / ClawHub / hand-written pack.
A confirm-and-retry-with-force dialog is leftover, not this pass.

### 4.2 Sanitizer

Delete the local copy. Unpack through `clawhub::extract_zip_to_dir` (already
calls `sanitize_zip_path` + `apply_zip_mode`). Two unpackers on different `zip`
crate majors still share one path rule; zip import should not be a third copy.

### 4.3 `origin.json`

Team inspect treats `registry != "team"` as `foreign` and will not overwrite.
A zip import without origin looks like `missing` — auto-follow may install a
team pack over it. Write origin after copy:

| field | value |
|---|---|
| `version` | `ORIGIN_VERSION` |
| `registry` | `"import"` (not `"team"`, not the ClawHub URL) |
| `slug` | derived folder name |
| `installedVersion` | `"1"` |
| `files` | `build_manifest` of what we just copied |

No lockfile row. A zip import is not a ClawHub install; P1.3 would otherwise
have to special-case another source. Origin is enough for the team contract.

### 4.4 Tests

- existing slug + `force=false` → error, bytes unchanged
- existing slug + `force=true` → replaced, origin written
- zip entry `../../outside.txt` is not written outside the extract / skills root

## 5. P1.2 — Settings permission writes fail closed

`putDaemonPermissions` (`packages/app/src/lib/daemon-local-client.ts`) returns
`null` on `ok: false` (daemon down, status 0, HTTP error) and does **not** throw.

`SkillDetail.tsx` already fails closed:

```
const saved = await putDaemonSkill(...)
if (saved === null) throw new Error('daemon rejected the update')
```

`SkillsSection.tsx` `handleDefaultPermissionChange` / `handleSkillPermissionChange`
await the put, then `setSkillPermissions(updated)` regardless. The toggle looks
saved; `opencode.json` never changed.

Fix: same null check, `setError(...)`, do not update local state. The Allow /
Ask / Deny buttons read `skillPermissions`, so the UI stays on the last known
server value.

Do **not** change `putDaemonPermissions` itself to throw — other callers and
the `null` contract stay. Only the Settings writer that claimed success.

## 6. P1.3 — ClawHub installed-set is lockfile `source=clawhub` only

`ClawHubMarketplace.loadInstalled` today:

1. unions every key in `.clawhub/lock.json` (team + ClawHub);
2. unions every directory under workspace/home `.claude/skills` and `.agents/skills`.

A team pack therefore shows **Installed**, and Uninstall calls `clawhub_uninstall`,
which errors `"came from the team registry — uninstall it there"`.

Lockfile `source`:

- `"clawhub"` → ClawHub
- `"team"` → team registry
- absent → ClawHub (entries written before the team registry; see `LockfileEntry`)

Helper `clawhubInstalledSlugs(lock)` keeps `source == null | "" | "clawhub"`.
Drop the filesystem scan. Test: mixed lockfile → only ClawHub slugs; team slug
on the explore list still shows Install, not Installed.

## 7. P1.4 — Auto-follow must not swallow 401

`reconcileSkills` catches the initial `listTeamSkills` failure and returns, so
offline is not read as "the team removed everything". That is correct for
network blips. A 401 / `missing_auth` is not a blip — the session is dead and
the next tick will fail the same way.

`TeamSkillAutoFollow` then `.catch(() => {})`s the whole reconcile, including
auth.

Fix:

1. `isCloudAuthError` next to `CloudApiError` (`status === 401` or `code === "missing_auth"`).
2. `reconcileSkills` rethrows auth errors; still swallows everything else.
3. The component toasts once per `teamId` (ref, reset on team switch) so a 10
   minute timer does not spam. Other errors stay silent.

## 8. 本 pass 明确不做（leftover）

| Item | Why later |
|---|---|
| Settings create/edit via FS vs daemon | Separate writer path; not the fail-closed bug |
| Rust `pack_and_upload` 401 retry | Daemon/FC adjacent; out of desktop-only scope |
| Dead skills.sh discovery (`discover_skill_directory` et al. in `skillssh.rs`) | Unreachable; delete in a cleanup pass |
| Expo / iOS skill permission | Desktop-only this pass |
| E2E expansion | Unit/component tests cover the grant-reuse and UI claims |
| Diagnostics `teamclu-team/skills` string | Copy-only |
| Zip import confirm-and-`force` dialog | Command refuses; Settings already shows the invoke error |
| Cross-workspace permission clear | Same limitation as team uninstall; needs a workspace enumerator |
| `clawhub_check_updates` iterating team lockfile rows | Related installed-set smell; not a grant bug |

## 9. 落地清单

| Path | Change |
|---|---|
| `apps/desktop/src/commands/clawhub.rs` | `clear_skill_permission` on uninstall + test |
| `apps/desktop/src/commands/skillssh.rs` | `force`, shared unpacker, `origin.json`, tests |
| `packages/app/src/components/settings/SkillsSection.tsx` | null → error, no local write |
| `packages/app/src/components/settings/__tests__/SkillsSection.test.tsx` | daemon-down does not flip the toggle |
| `packages/app/src/lib/clawhub/types.ts` | `source` + `clawhubInstalledSlugs` |
| `packages/app/src/components/settings/ClawHubMarketplace.tsx` | lockfile-only installed set |
| `packages/app/src/lib/backend/cloud-api/http.ts` | `isCloudAuthError` |
| `packages/app/src/stores/team-share-browser.ts` | rethrow 401 |
| `packages/app/src/components/TeamSkillAutoFollow.tsx` | toast expired session |

Tests: `cargo test` for `clawhub` / `skillssh`; vitest for the TS files above.
