# App 的 Gitea 账号鉴权 · 第一期实施计划

- **Date**: 2026-11-16（同日评审后修订，改动见文末「评审修订」）
- **Spec**: `docs/specs/2026-11-16-app-platform-identity-design.md`（决策编号沿用 spec §0）
- **Branch**: `task/gitea-de-shi-yong-fa`（spec + 本计划）；实现按下面 4 个 PR 拆分，各自开分支
- **环境**: 只上 self-host。数据库迁移两边都跑（belayo 也要，因为 FC 的权限判断会依赖它），Gitea 相关只在 self-host 打开

## 目标与验收

第一期做完，在 self-host 上对**新建的 app** 能完成这套流程：

1. 真人 A 在桌面端建 app，A 自动是 admin。
2. A 在 app 成员里给真人 B 授 `write`、给 agent X 授 `write`、给真人 C 授 `read`。
3. B 在**任意目录**执行 `git clone https://<git host>/<owner>/tc-app-<id>`（带不带 `.git` 都行）、改代码、`git push`，
   全程不输入任何密码；Gitea 里记录的推送人是 B（`u<B 的 uuid>`）。
4. X 在会话里 `git push`，Gitea 记录的推送人是 X 自己，不是 A。X 用 `nohup git push &` 这类后台方式推，
   要么仍然记在 X 名下，要么被拒绝，**不会**记到 A 名下。
5. C 能 clone，`git push` 被拒；C 用 `git push origin HEAD:refs/for/main -o topic=… -o title=…` 能提 PR。
6. 没被授权的 agent Y 在会话里 `git push`：失败，并且输出里有一行说明「agent Y 没有应用「…」的权限，请在 应用 → 成员 里授权」。
7. 没被授权的同 team 成员：app 设为「团队可见」时能 clone，设为「仅自己」时返回 not found。
   新加入 team 的成员不用等对账就能 clone 团队可见的 app。
8. A 关掉桌面端以后，终端里的 git 照常能用；A 在桌面端退出登录后，终端里的 git 在 1 分钟内失效并提示重新登录。
9. 从公网带伪造的 `X-WEBAUTH-USER` 访问 Gitea 返回 401；除 Caddy 以外的容器连不上 `gitea:3000`；
   把一个 app 的 `fc_endpoint` 指向内部入口并带伪造头访问，不能以别人的身份操作 Gitea。
10. 用旧版 daemon 打开新建的 app，seed、push、部署都和现在一样能用。
11. 老 app（`teamclaw-apps/tc-app-*`）在第一期里**不变**，继续走 SSH deploy key；第一期验收通过后再一次性迁移。

## 总体拆分

| PR | 内容 | 依赖 | 可以单独上线吗 |
|---|---|---|---|
| **PR1** 权限 | 数据库迁移、FC 权限判断、权限改名、OpenAPI、桌面端权限页能选 agent | 无 | ✅ 两套环境都上，用户只看到权限改名、能给 agent 授权 |
| **PR2** 同步到 Gitea | Gitea 命名、建用户/org/team、同步协作者、定时对账、新 app 建在 org 下（开关控制） | PR1 | ✅ 开关默认关；打开后只是 Gitea 里多了用户和协作者，现有 SSH 路径不受影响 |
| **PR3** 网关 | 4 个 `/v1/git/*` 端点、Caddy、compose 网络、Gitea 配置、冒烟测试 | PR2 | ✅ 上线后 HTTPS git 可以用命令行验证，客户端还没接 |
| **PR4** 客户端 | `amuxd git-credential` 全局模式、桌面端写 git token、checkout 改 HTTPS、没权限时的提示 | PR3 | 发版后在 self-host 打开开关 |

FC 新增两个环境变量，按 CLAUDE.md 的要求同时加进 `deploy/self-host/docker-compose.yml` 的 `fc.environment` 和
`deploy/belayo/cloud-api.env.keys`，并让 `services/fc/test/deploy-env-parity.test.ts` 通过：

- `GITEA_ACCOUNT_AUTH`（`off` 默认 / `on`）：总开关。belayo 不设值。
- `GIT_TOKEN_SECRET`：git 专用 token 的签名密钥。没设时，或 `GITEA_ACCOUNT_AUTH` 不是 `on` 时，`/v1/git/token` 返回 503（桌面端静默忽略，不写凭证、不改全局 git 配置）。

---

## PR1 · 权限：agent 可授权 + read / write / admin

### 1.1 数据库迁移

新文件 `services/supabase/migrations/20261117000000_app_access_actor_grants.sql`：

```sql
-- 1) 被授权人的外键 members → actors：agent actor 也能被授权
alter table amux.app_member_access drop constraint app_member_access_member_id_fkey;
alter table amux.app_member_access add constraint app_member_access_member_id_fkey
  foreign key (member_id) references amux.actors(id) on delete cascade;
comment on column amux.app_member_access.member_id is
  'Grantee actor id (member or agent) in the app''s team. Named member_id for history.';

-- 2) 授权人的外键同样改成 actors：agent 建的 app 里 agent 是 admin，可以再授权给别人（决策 10）
--    先确认现有约束名和 on delete 行为，照原样重建

-- 3) 权限改名
alter table amux.app_member_access drop constraint app_member_access_permission_level_check;
update amux.app_member_access set permission_level = case permission_level
  when 'view' then 'read' when 'prompt' then 'write' else permission_level end;
alter table amux.app_member_access add constraint app_member_access_permission_level_check
  check (permission_level in ('read','write','admin'));

-- 4) 被授权的 actor 必须和 app 在同一个 team，且不能是 external
create or replace function amux.app_member_access_same_team() returns trigger ...
create trigger app_member_access_same_team before insert or update on amux.app_member_access ...

-- 5) RLS：被授权的 agent 也能读到自己的授权行
--    原策略 app_member_access_select 用 member_id = amux.current_member_id()，agent 读不到
drop policy app_member_access_select on amux.app_member_access;
create policy app_member_access_select on amux.app_member_access for select to authenticated using (
  member_id = (select amux.current_actor_id_for_team(a.team_id) from amux.apps a where a.id = app_id)
  or exists (select 1 from amux.apps a where a.id = app_id
             and a.created_by_actor_id = amux.current_actor_id_for_team(a.team_id)));
```

- 已核对不用改的：`is_team_member`（`baseline.sql:2123`）、`current_actor_id_for_team`（`:1348`）、
  `actor_has_app_access`（`:66`）都按 actor 查，对 agent 成立；`apps_select_if_visible` 走的是它们，
  所以 agent 被授权后自动能看到这个 app。
- 不加索引，不碰 `amux.agent_member_access`。

### 1.2 pgTAP

- 改 `services/supabase/tests/002_rls.sql` 里用到 app 权限 `'view'` / `'prompt'` 的断言。
  `009_agent_visibility.sql`、`013_gateway_agent_admin_owner_rpc.sql` 是 agent 使用权限，逐条确认后再动。
- 新增 `services/supabase/tests/0xx_app_access_actor_grants.sql`：
  - agent actor 可以被授 `write`，之后 `actor_has_app_access` 为真、agent 能 select 到这个 app 和自己的授权行；
  - agent 作为授权人写入成功；
  - 跨 team 的 actor 授权被触发器拒绝；
  - `view` / `prompt` 写入被 check 约束拒绝；回填后的旧数据是 `read` / `write`。
- 按记忆里的坑：本机 OrbStack 用和 CI 相同的镜像**从零重建**库再跑全部 pgTAP；迁移角色在 CI 和 self-host 不同（self-host 要是 owner）。

### 1.3 FC

文件：`services/fc/src/lib/supabase-repo.ts`、`services/fc/src/lib/routes/apps.ts`。

- `APP_PERMISSION_LEVELS`（`:503`）改成 `read` / `write` / `admin`，加 `normalizeAppPermissionLevel()`：
  过渡期把输入里的 `view` / `prompt` 换成新值，读接口只返回新值。
- `resolveAppPermission`（`:6264` 起）：去掉 `if (!callerMemberId) return null`，改按 `callerActorId` 查
  `app_member_access`，让被授权的 agent 拿到对应级别。
- 所有 `rank = { view, prompt, admin }` 和门槛 `"prompt"`（`:5935`、`:5992`、`:5999`、`:6644`、`:6718`、
  `:6775`、`:6814`、`:6901`、`:6917` 等）改成 `read` / `write`。用 `rg '"prompt"|"view"' supabase-repo.ts` 逐个过，
  **跳过 agent 使用权限相关的**（`list_connected_agents`、agent access 那一组）。
- `setAppAccess`（`:6584` 附近）：
  - 校验被授权的 actor 属于 app 的 team；agent 必须已经绑定账号（`actors.user_id is not null`），否则 `422 agent_not_connected`；
  - 授权人可以是 agent（现在写的是 `manager.callerMemberId`，改成调用者的 actor id）。
- `listAppAccess` 返回值加 `actorType`、`connected`（agent 是否有账号），给界面用。
- 建 app 的接口加可选参数 `grantActorIds`（建 app 时顺手授 `write`，见 1.5）。
- **不改** `resolveAppGitCredentialActor` 里 agent 走团队级粗权限拿 deploy key 的那条路（已定：第一期不动）。

### 1.4 OpenAPI 和测试

- `docs/openapi/teamclu-api.v1.yaml`：app 权限相关的枚举和描述（约 10 处）改成 read / write / admin；
  说明被授权人和授权人都可以是 agent。
- `services/fc/test/routes-apps.test.ts`、`services/fc/test/supabase-repo.test.ts`：改权限名；新增 agent 被授权后能读 app 数据、
  agent 作为 admin 能授权、未绑定账号的 agent 授权返回 422、旧值输入被换成新值。

### 1.5 桌面端

- `packages/app/src/lib/backend/types.ts:1469`：`AppPermissionLevel = "read" | "write" | "admin"`。
- `packages/app/src/components/apps/AppAccessTabContent.tsx`：选项、默认值（`write`）、说明文案
  （「read 可查看和下载代码；write 可改代码；admin 可部署和授权」），中英文 locale 一起改（locale 只能文本编辑，见记忆）。
- 成员选择器（`packages/app/src/lib/daemon/daemon-agent-admin.ts` 的 `listTeamMembersForAccess`）加入 team 里的 agent，
  **agent 排在前面，可以一键授 `write`**；未绑定账号的 agent 置灰，提示「这个 agent 还没连上」。
- 建 app 的对话框加一组可选项「同时授权给这些 agent」，列出 team 里已连上的 agent，**默认都不勾**（决策 6：手动授权）。
- 测试：`AppAccessTabContent.test.tsx`、`AppControlPanel.test.tsx`、建 app 对话框的测试。

### 1.6 上线

self-host 和 belayo 都跑迁移；FC 和桌面端随常规发版。旧版桌面端在权限下拉框里会看到不认识的 `read` / `write`，自动更新后消失。

---

## PR2 · 同步到 Gitea

### 2.1 命名和 Gitea 客户端

文件：`services/fc/src/lib/provisioning/gitea.ts`。

- 命名函数（uuid 去横线、小写）：
  - `giteaUserName(authUserId) = "u" + hex`（33 位）
  - `giteaOrgName(orgId) = "o" + hex`，`orgId` 取 **`amux.apps.org_id`**（现有的非空列，app 的租户指针）
  - `giteaTeamName(teamId) = "t" + hex`
  - 仓库名不变：`appRepoName(appId) = tc-app-<appId>`
- **仓库归属不再写死 `GITEA_OWNER`**。现在客户端所有按仓库的操作都用 `opts.owner`（`:96`、`:122`、`:139` …）。
  改成按 app 解析：`repoRef(app) → { owner, repo }`，从 `apps.git_remote_url`（SSH 地址）解析出 owner；解析不出时退回 `GITEA_OWNER`。
  这样老 app（`teamclaw-apps`）和新 app（`o<uuid>`）走同一套代码，现有的 deploy key 接口对两者都能用。
- 新增管理操作（都用现有的管理员令牌）：
  - `ensureUser(name, fullName)`：不存在就建；邮箱用 `<name>@users.noreply.<git host>`，不暴露真实邮箱；
    随机密码，`must_change_password=false`；已存在就只更新 `full_name`。
  - `ensureOrg(name)`：`visibility=private`。
  - `ensureTeam(org, name)`：`permission=read`、`units=["repo.code","repo.pulls"]`、`includes_all_repositories=false`。
  - `setTeamMembers(org, team, userNames[])`、`addTeamRepo` / `removeTeamRepo`。
  - `setCollaborator(owner, repo, user, permission)`、`removeCollaborator(...)`、`listCollaborators(...)`。
  - Owners team 里只有 FC 服务账号，不加任何真人或 agent。

### 2.2 同步模块

新文件 `services/fc/src/lib/provisioning/gitea-sync.ts`，只暴露一个入口：

```ts
syncAppToGitea(appId): Promise<void>
```

它从数据库算出这个 app「应有」的状态，再把 Gitea 改到一致。**只处理 owner 是 `o<uuid>` 的仓库，老 app 直接跳过。**

- 协作者 = 创建者（admin，可能是 agent）+ `app_member_access` 里每个有账号的 actor（按 `actors.user_id` 算用户名，权限照搬）；
  多出来的协作者移除（FC 服务账号除外）；
- `visibility=team` 时，`t<teamId>` 这个 team 存在于仓库所属 org、成员是该 team 所有有账号的 actor、对仓库是 read；
  `personal` 时把这个 team 从仓库上摘掉；
- 每个涉及的用户 `ensureUser`，显示名取 `public.users.nickname`，agent 用 actor 显示名加「· agent」。

调用点（都在业务操作成功之后调，失败只记日志、不回滚业务操作）：
- 建 app、授权 / 改权限 / 撤销、改可见范围；
- **成员加入 team、被移出 team**：对这个 team 里所有团队可见的 app（移出时是所有 app）逐个同步。
  加入时不同步的话，新成员要等对账后才能 clone 团队可见的 app。

### 2.3 定时对账

- FC 里加一个定时任务（和现有定时任务放一起；没有就用 `setInterval` + 进程内锁，self-host 只有一个 FC 实例），
  每 10 分钟对所有托管在 `o<uuid>` 下、`provision_status='ready'` 的 app 跑一遍 `syncAppToGitea`。
- 只在 `GITEA_ACCOUNT_AUTH=on` 时运行。

### 2.4 新 app 建在 org 下，库里的地址不变

- `createAppRepo`（`gitea.ts:95`）加参数 `owner`。开关为 `on` 时用 `giteaOrgName(app.org_id)`，先 `ensureOrg`；
  为 `off` 时保持 `GITEA_OWNER`。
- **`apps.git_remote_url` 继续存 SSH 地址，`git_auth_kind` 继续是 `gitea_deploy_key`。**
  旧版 daemon 看到 HTTPS 地址会把它当成导入的外部仓库去要 token，所以库里的值不能变。
- app 的读接口（详情、列表、`app-git-credential` 的响应）多返回两个字段，由 `repoRef` 现算：
  - `gitHttpUrl`：`https://<git host>/<owner>/<repo>.git`
  - `gitAccountAuth`：开关为 `on` 且 owner 是 `o<uuid>` 时为 `true`
  旧客户端忽略它们；新客户端看到 `gitAccountAuth` 才用 HTTPS（PR4.3）。OpenAPI 同步加上。
- 公网的 git 主机名来自现有的 `GITEA_ROOT_URL` / `GITEA_DOMAIN`，不新增环境变量。

### 2.5 老 app

第一期不碰老 app：不迁仓库、不加协作者。`repoRef(app)` 对它们解析出 `teamclaw-apps`，`gitAccountAuth` 为 `false`，
现有的 deploy key 路径照常工作。

### 2.6 测试

`services/fc/test/gitea-sync.test.ts`：用假 Gitea 客户端，覆盖授权、改权限、撤销、可见范围切换、成员加入和移出、
未绑定账号的 agent 被跳过、多余协作者被移除、agent 是创建者、老 app 被跳过。

---

## PR3 · 网关和端点

### 3.1 FC 端点

按 CLAUDE.md 新增业务端点的顺序：先写 OpenAPI，再写 repository contract、路由、实现、测试。
新路由文件 `services/fc/src/lib/routes/git.ts`，token 的签发和校验放 `services/fc/src/lib/git-token.ts`
（照 `apps-auth-session.ts`、`agent-management-grant.ts` 用 `jose` 的写法）。

**`POST /v1/git/token`**（桌面端调用，带当前 TeamClu 会话）
- 签一个 HS256 JWT：`aud=teamclu-git`、`sub`=账号 id、`epoch`=账号当前的 `git_token_epoch`（没有就是 0）、30 天过期。
- 返回 `{ token, expiresAt, gitHost, userName }`。

**`POST /v1/git/token/revoke`**（桌面端退出登录时调用）
- 把账号 `app_metadata.git_token_epoch` 加一（服务端 `auth.admin.updateUserById`，按 key 合并，不覆盖别的字段）。
  这个账号所有机器上的 git token 都会失效；其他机器上的桌面端下次启动时自动重新签。

**`GET /v1/git/authz`**（只给 Caddy 调；OpenAPI 标 `x-internal: true`）
- 从 `Authorization: Basic` 取出密码：
  1. 能按 `aud=teamclu-git` 验过签名和过期时间 → 再比对 `epoch` 和账号当前值；
  2. 否则当 TeamClu 登录 token，用现有的校验（`auth.getUser`；配置了 `TRUSTED_EXTERNAL_JWT_SECRET` 时走现有的本地校验）。
- 通过：`200`，响应头 `X-WEBAUTH-USER: u<sub hex>`。失败：`401`，`WWW-Authenticate: Basic realm="TeamClu"`。
- 缓存：`sha256(token) → 用户名`，60 秒；账号被禁用时返回 401。不判断仓库权限，那是 Gitea 的事。

**`GET /v1/git/access?repo=<owner>/<repo>`**（helper 调用，凭证和 authz 相同）
- 返回 `{ appName, permission: "read"|"write"|"admin"|null, actorName, actorType }`，只用来打印提示。
- 调用者不是这个 app 所在 team 的成员时返回 404，不泄露 app 是否存在。

### 3.2 Caddy

`deploy/self-host/caddy/Caddyfile` 的 Gitea 站点块换成下面这样。这份配置 2026-11-16 已用 Caddy 2.10.0 + Gitea 1.22.6
在本机端到端测过（spec §9.8）：

```caddyfile
{$CADDY_SITE_SCHEME}{$GITEA_DOMAIN} {
	{$CADDY_SITE_TLS}
	request_header -X-WEBAUTH-USER

	@git path_regexp git ^/[^/]+/[^/]+(\.git)?/(info/refs|git-upload-pack|git-receive-pack)$
	handle @git {
		forward_auth fc:<port> {
			uri /v1/git/authz
			copy_headers X-WEBAUTH-USER
		}
		reverse_proxy gitea:3000 {
			header_up -Authorization
		}
	}
	handle {
		respond 404
	}
}

# FC 调 Gitea 管理 API 的内部入口，不发布到宿主机
http://:8081 {
	request_header -X-WEBAUTH-USER
	reverse_proxy gitea:3000
}
```

- 镜像是 `caddy:2`（`docker-compose.yml:709`）。上线前确认线上实际版本，和本机测的 2.10 差得多就再跑一遍 3.5。
- Git LFS 不在放行范围内，第一期不支持。

### 3.3 compose 网络

`deploy/self-host/docker-compose.yml` 现在没有定义网络，全在默认网络里。改成：

```yaml
networks:
  default: {}
  gitea-net: {}                      # 不要加 internal: true
services:
  gitea:   { networks: [gitea-net] }            # 不再加入 default
  caddy:   { networks: [default, gitea-net] }
  fc:      # 不加入 gitea-net；GITEA_URL 改成 http://caddy:8081
```

- **不用 `internal: true`**：本机实测，只挂在 internal 网络上的容器，发布的端口从宿主机连不上，SSH 2222 会失效。
- **FC 不进 `gitea-net`**：FC 的应用访问代理会把客户端请求头转发给 `apps.fc_endpoint`，而这个字段能被应用创建者改写（spec §6）。
  FC 直连 Gitea 的话，就能被用来带着伪造的身份头访问 Gitea。
- 其他容器能访问 `caddy:8081`，但身份头会被剥掉，效果等同于今天访问没开代理头鉴权的 Gitea。

### 3.4 Gitea 配置

`docker-compose.yml` 的 gitea 环境变量加：

```
GITEA__service__ENABLE_REVERSE_PROXY_AUTHENTICATION: "true"
GITEA__service__ENABLE_REVERSE_PROXY_AUTHENTICATION_API: "false"
GITEA__service__ENABLE_REVERSE_PROXY_AUTO_REGISTRATION: "true"   # 兜底，FC 会先建好用户
GITEA__service__DISABLE_REGISTRATION: "true"
GITEA__security__REVERSE_PROXY_AUTHENTICATION_USER: "X-WEBAUTH-USER"
```

**3.2、3.3、3.4 必须在同一次部署里生效。** 先开代理头鉴权、后隔离网络，中间那段时间任何能连到 Gitea 的容器都能冒充任何人。
`deploy/self-host/init/gitea-bootstrap.sh` 里如果有建 org / 用户的逻辑，确认不会和新命名冲突，并且改走 `http://caddy:8081`。

### 3.5 冒烟测试

`deploy/self-host/smoke/run-e2e.sh` 加：
1. 不带凭证 `git ls-remote https://<git host>/<owner>/<repo>.git` → 401。
2. 带伪造头 `-c http.extraHeader="X-WEBAUTH-USER: <某个有权限的用户>"`、不带凭证 → 401。
3. 带伪造头 + 另一个只读账号的 token 去 push → 被拒（身份以 token 为准）。
4. 带测试账号的 token → 能 `ls-remote`（带和不带 `.git` 各一次）；没权限的仓库 → not found。
5. Basic 里填 Gitea 的真实用户名密码 → 认证失败。
6. 在 fc、postgrest 等容器里 `curl http://gitea:3000` → 连不上。
7. `curl -H "X-WEBAUTH-USER: <管理员>" http://caddy:8081/api/v1/user`（不带令牌）→ 401。
8. `https://<git host>/` 和 `/api/v1/version` → 404。

### 3.6 其他

- `services/fc/src/lib/apps-vanity.ts` 的 `proxyToApp`：转发前删掉 `x-webauth-*`（和现有删 `x-teamclu-*` 的地方放一起），加测试。
- 另开一个 issue：`amux.apps.fc_endpoint` 能被应用创建者通过 RLS 直接改写，等于可以让 FC 代理到任意内部地址。
  不在本期范围内，但要有人跟。
- `services/fc/test/routes-git.test.ts`：token 的签发、过期、epoch 吊销；authz 的两种 token、缓存、禁用账号；access 的各种权限和 404。

---

## PR4 · 客户端

### 4.1 真人的 git token（桌面端写，helper 读）

- 文件 `<amuxd home>/git-token.json`，权限 0600（Windows 上只给当前用户 ACL），内容：
  `{ gitHost, userId, userName, token, expiresAt }`。不用系统钥匙串（已定）。
- 桌面端：
  - 登录成功后、以及每次启动时：文件不存在、`userId` 不是当前用户、或者剩余有效期不足 7 天 → 调 `POST /v1/git/token` 重写。
  - 退出登录：调 `POST /v1/git/token/revoke`，再删文件。切换账号同理。
  - 实现放 Tauri 命令（`apps/desktop/src/commands/` 下新建 `git_token.rs`），前端在 `packages/app/src/stores/auth-store.ts`
    的登录 / 退出流程里调用。

### 4.2 `amuxd git-credential` 全局模式

文件：`apps/daemon/src/cli/git_credential.rs`、`apps/daemon/src/cli/mod.rs`。

- 现有的 `--app <id>` 模式（导入仓库的 token）保持不变；不带 `--app` 时进入全局模式。
- `get` 请求：`host` 不是已知的 Gitea 主机就输出空、退出 0（fail open，让 git 用别的 helper）。已知主机来自
  `git-token.json` 的 `gitHost`，以及 daemon 缓存的 `<amuxd home>/git-host`（daemon 拿到带 `gitAccountAuth` 的 app 时写入）。
- 选身份：
  1. 环境里**有** `TEAMCLU_RUNTIME_CONTEXT_SOCK`（daemon 已经下发给每个 agent host）→ agent 环境：
     连这个 socket 的 `/internal/runtime-context/cloud-token`（`apps/daemon/src/http/runtime_context_unix.rs`，按进程祖先认人）。
     拿到就用它，用户名取 JWT 的 `sub`。**拿不到就失败**：输出空，stderr 一行
     `[amuxd git] 无法确认 agent 身份（后台进程？），请在前台执行 git`，不读 `git-token.json`。
  2. 环境里**没有**这个变量 → 真人：读 `git-token.json`。过期或不存在 → 输出空，stderr 一行「请打开 TeamClu 桌面端登录」。
- 输出 `username=u<sub hex>`、`password=<token>`。`store` / `erase` 忽略。
- **没权限时的提示**：`get` 的输入里带 `path`（靠 `useHttpPath`），helper 用同一个 token 调 `GET /v1/git/access?repo=…`
  （超时 2 秒，失败就跳过），`permission` 为 null 时在 stderr 打
  `[amuxd git] <actorType>「<actorName>」没有应用「<appName>」的权限，请在 应用 → 成员 里授权`。
- Windows 没有 Unix socket：agent 身份走现有的 TCP + bearer 路由，安全性和现在 skills 拿 cloud token 一样，接受。

### 4.3 git 配置

- **全局**（桌面端登录后、daemon 启动时，幂等地写）：
  ```
  git config --global credential.https://<git host>.helper ""
  git config --global --add credential.https://<git host>.helper "<amuxd 绝对路径> git-credential"
  git config --global credential.https://<git host>.useHttpPath true
  ```
  第一行的空值清掉这个主机已有的 helper，避免 macOS 自带的 osxkeychain 把 token 存下来、过期后重放导致 401。
  `GITEA_PUBLIC_URL` 是 `http://` 的部署，token 接口返回 `gitScheme: "http"`，这三行改用 `credential.http://<git host>`。
  amuxd 路径用 `<amuxd home>/bin/amuxd` 这种稳定路径，自更新后不用改配置。
- **app checkout**（`apps/daemon/src/sync/app_git.rs`）：app 带 `gitAccountAuth: true` 时，`origin` 设成 `gitHttpUrl`，
  不写 `core.sshCommand`，checkout 本地也写一份上面的 helper 配置（没装全局配置、或者 agent 的 HOME 不同也能用）。
  打开或下载 app 时检查一次：远端地址和 `gitHttpUrl` 不一致就改过来（老 app 迁移后靠这一步自动切换）。
- **daemon 自己的 git 操作**（seed push、部署前 fetch）继续用 `GIT_SSH_COMMAND` + JIT deploy key，地址用库里的 SSH 地址，
  第一期不改。`GIT_SSH_COMMAND` 只影响 SSH，所以要显式把 SSH 地址传给这些命令，不能用 `origin`。

### 4.4 测试

- daemon：`git_credential` 的单测覆盖：主机过滤、有环境变量时走 socket、socket 拒绝时**不**退回真人、没有环境变量时读文件、
  token 过期、access 提示。`app_git` 的单测覆盖 `gitAccountAuth` 的 checkout 配置和 daemon 内部操作仍走 SSH。
- 桌面端：auth-store 登录 / 启动 / 退出时调用 git token 命令的测试。

### 4.5 上线

1. 发桌面端和 amuxd 新版本。
2. self-host 设 `GIT_TOKEN_SECRET`、`GITEA_ACCOUNT_AUTH=on`，重建 fc（记忆：改 env 要 `--force-recreate`）。
3. 新建 app，按「目标与验收」逐条走一遍，其中第 10 条用一台没升级的 daemon 验。

---

## 第一期之后：老 app 一次性迁移

第一期验收通过后，一次把所有老 app 迁过去，之后再下线 deploy key。

**步骤**（一个可重复执行的脚本，放 `services/fc/scripts/migrate-legacy-app-repos.ts`，先 `--dry-run` 出清单）：

1. 对每个仓库还在 `teamclaw-apps` 下的 app：
   1. `ensureOrg(o<app.org_id>)`；
   2. Gitea `POST /api/v1/repos/teamclaw-apps/tc-app-<id>/transfer`，`new_owner = o<org>`；
   3. `git_remote_url` 改成新 owner 下的 SSH 地址（`git_auth_kind` 不变）；
   4. `syncAppToGitea(appId)`。
2. 新版 daemon 打开或下载 app 时发现 `gitHttpUrl` 变了，自动改本地 checkout 的 remote 和 helper 配置（PR4.3）。
3. 全部迁完、确认没有旧版 daemon 在用之后：删除 JIT deploy key 接口和 `amuxd git-ssh`，清掉残留的 deploy key，关闭 SSH 2222，
   去掉 `resolveAppGitCredentialActor` 里 agent 的团队级权限，daemon 自己的 git 操作改走 HTTPS。

**迁移前要实测的**：
- Gitea 转移仓库后，旧路径是否自动重定向（HTTP 和 SSH 各测一次）。重定向可用时，还没更新的 checkout 也不会立刻断。
- 转移会不会带走仓库上已有的 deploy key、webhook。
- 脚本中途失败后重跑是否安全（每一步都要能重复执行）。

**时机**：选一个没人在部署的时间，先在 self-host 上跑；脚本输出每个 app 的结果，失败的单独重跑。

## belayo 上线（以后）

第一期合并后，belayo 只会执行 PR1 的迁移（belayo 的迁移要手动跑，`RUN_MIGRATIONS=1`），`GITEA_ACCOUNT_AUTH` 不设，
其余改动在 belayo 上不生效：`gitAccountAuth` 恒为 false，`/v1/git/token` 因为开关没开（也没有 `GIT_TOKEN_SECRET`）返回 503（桌面端静默忽略），
self-host 的 Caddyfile、compose 和 bootstrap 脚本 belayo 都不读。要在 belayo 上打开，按下面的顺序做。

belayo 的 Gitea 在一台专用节点上（私网，无公网 IP），HTTP 经 Dokploy 的 Traefik 以 `git.service.ucar.cc` 对外，
SSH 走专用 TCP entrypoint（`docs/specs/2026-09-11-belayo-dokploy-target-architecture.md`）。

### B1 · 网络隔离（前置条件，不满足就不能开）

Gitea 认任何能连到它 HTTP 端口的请求里的 `X-WEBAUTH-USER`，`REVERSE_PROXY_TRUSTED_PROXIES` 拦不住（spec §9.1 第 10 行）。
self-host 靠 compose 网络隔离；belayo 的 Gitea 节点和 Dokploy 集群在同一个 VPC 里，**VPC 里的其他服务都能直连它的 3000 端口**，
包括部署在 VPC 里的用户应用（应用的 FC 函数配置了 VPC，见 `readAppsFcVpcConfig`）。所以：

1. 查清 Traefik 跑在哪几个节点上（Dokploy manager / worker），以及 Gitea 节点安全组现在的入站规则。
2. 安全组只允许 Traefik 所在节点访问 Gitea 节点的 3000 端口；SSH 端口规则不变。
3. 从 VPC 里另一台机器（不是 Traefik 节点）`curl http://<gitea 私网地址>:3000/api/healthz`，必须连不上。

做不到（比如 Traefik 节点不固定、安全组不能按来源收窄），belayo 就不开代理头鉴权，改走 spec §9.2 的退路：
FC 为每个账号签发短期 Gitea 令牌，网关把 Basic 改写成这个令牌。这条退路第一期没有实现。

### B2 · Traefik：对外的 git 入口

对应 self-host Caddyfile 的 Gitea 站点块（§3.2）。Traefik 没有「按路径直接返回 404」的写法，拆成两个 router：

```yaml
http:
  routers:
    gitea-git:
      rule: Host(`git.service.ucar.cc`) && PathRegexp(`^/[^/]+/[^/]+(\.git)?/(info/refs|git-upload-pack|git-receive-pack)$`)
      entryPoints: [websecure]
      middlewares: [gitea-drop-identity, gitea-forward-auth, gitea-drop-authorization]
      service: gitea
      priority: 100
    gitea-closed:
      rule: Host(`git.service.ucar.cc`)
      entryPoints: [websecure]
      service: noop@internal          # 或一个只返回 404 的服务
      priority: 1
  middlewares:
    gitea-drop-identity:
      headers:
        customRequestHeaders:
          X-WEBAUTH-USER: ""          # 空值 = 删除客户端带来的头
    gitea-forward-auth:
      forwardAuth:
        address: https://teamclaw-api.ucar.cc/v1/git/authz
        authResponseHeaders: [X-WEBAUTH-USER]
    gitea-drop-authorization:
      headers:
        customRequestHeaders:
          Authorization: ""           # 有效的 Basic 会压过代理头（spec §9.1 第 8 行）
```

上线前要实测的（和 self-host 的 §9.8 一样逐项过）：

- middleware 按列出的顺序执行：先删身份头，再 forwardAuth，最后删 `Authorization`。forwardAuth 要拿到原始的 `Authorization`，
  所以删除必须排在它后面。
- `authResponseHeaders` 会用鉴权服务返回的值覆盖请求里的同名头；鉴权失败（401）时 Traefik 把 401 和 `WWW-Authenticate` 原样回给 git。
- `PathRegexp` 在 belayo 的 Traefik 版本里可用（v3 起有；v2 要写成 `PathPrefix` + `Path` 组合或换成 `Path` 正则语法）。
- forwardAuth 的 `address` 走公网域名会多一跳；能走 Dokploy 内网地址（FC 服务的 swarm 服务名）更好，但要确认 Traefik 能解析。

### B3 · FC 访问 Gitea 管理 API 的内部入口

公网域名只放行 git 路径之后，FC 现在的 `GITEA_URL`（公网域名）就调不通 API 了。对应 self-host 的 `caddy:8081`：

- 方案一：Traefik 再开一个只在内网 entrypoint 上的 router，`Host` 用内部域名，挂 `gitea-drop-identity`，转给 Gitea；
  FC 的 `GITEA_URL` 指向它。
- 方案二：FC 直连 Gitea 节点的私网地址。**不推荐**：B1 收窄安全组后 FC 节点本来就连不上；放开 FC 节点又会把
  「FC 应用代理转发客户端头 + `fc_endpoint` 可被改写」的口子带回来（spec §6）。

无论哪种，入口都必须删掉 `X-WEBAUTH-USER`。

### B4 · Gitea 配置和 bot

belayo 不跑 `gitea-bootstrap.sh`，手动做：

1. Gitea 的 `app.ini`（或容器环境变量）加上与 self-host 相同的四项：`ENABLE_REVERSE_PROXY_AUTHENTICATION=true`、
   `ENABLE_REVERSE_PROXY_AUTHENTICATION_API=false`、`ENABLE_REVERSE_PROXY_AUTO_REGISTRATION=true`、
   `REVERSE_PROXY_AUTHENTICATION_USER=X-WEBAUTH-USER`。**必须在 B1、B2 都生效之后再改**，否则中间那段时间谁都能冒充谁。
2. bot 提为站点管理员：`PATCH /api/v1/admin/users/<bot>`，`{"admin": true, "login_name": "<bot>", "source_id": 0}`。
3. 用 bot 自己的密码新签一个 token，scopes `["write:repository","write:organization","write:user","write:admin"]`，
   替换 Dokploy 里的 `GITEA_TOKEN`。旧 token 的 scope 改不了。
4. 验证：新 token 调 `GET /api/v1/admin/users?limit=1` 返回 200。

### B5 · Dokploy 环境变量

变量名已在 `deploy/belayo/cloud-api.env.keys` 里，只需在 Dokploy 填值并重新部署 Cloud API：

| 变量 | 值 |
|---|---|
| `GITEA_ACCOUNT_AUTH` | `on` |
| `GIT_TOKEN_SECRET` | `openssl rand -hex 32`，之后不要换（换了所有桌面端的 git 凭证都会失效） |
| `GITEA_PUBLIC_URL` | `https://git.service.ucar.cc` |
| `GITEA_URL` | B3 的内部入口 |
| `GITEA_TOKEN` | B4 第 3 步的新 token |

### B6 · 冒烟测试

`deploy/self-host/smoke/gitea-gateway-smoke.sh` 的前 5 项可以直接对 belayo 跑：

```bash
GITEA_GATEWAY_URL=https://git.service.ucar.cc GITEA_TOKEN=<bot token> SKIP_CONTAINER_CHECKS=1 \
  sh deploy/self-host/smoke/gitea-gateway-smoke.sh
```

后 2 项（容器间直连）在 belayo 上换成：

- 从 VPC 内一台非 Traefik 节点访问 Gitea 节点的 3000 端口：必须连不上（B1 第 3 步）。
- 从 FC 节点经 B3 的内部入口带伪造的 `X-WEBAUTH-USER` 调 `/api/v1/user`（不带令牌）：必须 401。

再按「目标与验收」走一遍真人和 agent 的推送，确认 Gitea 记下的推送人正确。

### B7 · 顺序和回滚

顺序：B1 → B2 → B3 → B5（先不填 `GITEA_ACCOUNT_AUTH`）→ B4 → B6 → 最后填 `GITEA_ACCOUNT_AUTH=on`。

回滚：先把 `GITEA_ACCOUNT_AUTH` 清空（客户端回到 SSH），再在 Gitea 上关掉 `ENABLE_REVERSE_PROXY_AUTHENTICATION`，
最后再动 Traefik。**Gitea 的代理头鉴权和 Traefik 的网关必须一起回滚或先关 Gitea 一侧**，否则网关撤了而 Gitea 还认代理头，等于任何人都能冒充任何人。

## 回滚

| 出问题的地方 | 回滚方式 |
|---|---|
| 新 app 建在 org 下有问题 | `GITEA_ACCOUNT_AUTH=off`：新 app 回到 `teamclaw-apps`；已建的 org 仓库库里存的本来就是 SSH 地址，deploy key 照常能用 |
| 网关有问题 | Caddy 回到 `reverse_proxy gitea:3000`，同时 Gitea 关掉 `ENABLE_REVERSE_PROXY_AUTHENTICATION`。**两者必须一起回滚**，否则没有网关时开着代理头鉴权等于任何人能冒充任何人 |
| helper 有问题 | `GITEA_ACCOUNT_AUTH=off` 后接口不再返回 `gitAccountAuth`，daemon 下次打开 app 时把 checkout 改回 SSH；删掉全局的 `credential.https://<git host>.*` |
| 权限迁移 | 反向 `update`：`read → view`、`write → prompt`，外键改回 `amux.members`（先删掉授权给 agent、或由 agent 授权的行） |

## 工作量粗估

| PR | 估计 |
|---|---|
| PR1 | 3 天（迁移 + pgTAP 从零重建、FC 门槛逐个过、桌面端权限页和建 app 对话框） |
| PR2 | 3–4 天（Gitea 客户端改造、同步、对账） |
| PR3 | 3 天（四个端点、Caddy、网络、冒烟测试，self-host 上实测） |
| PR4 | 3–4 天（helper、桌面端 token、checkout 配置、Windows） |

## 已定事项（2026-11-16）

1. **git 凭证存文件**：`<amuxd home>/git-token.json`，权限 0600，不用系统钥匙串。
2. **旧 deploy key 路径里 agent 的团队级权限第一期不动**，等老 app 迁移完、下线 deploy key 时一起去掉。
3. **老 app 第一期不动**，第一期完成后一次性迁移，不做「先在 `teamclaw-apps` 下加协作者」的过渡。
4. **agent 建的 app，admin 就是 agent 自己**（保持现状）；让它建 app 的真人不会自动得到权限。

## 评审修订（2026-11-16）

| # | 原方案 | 问题 | 改成 |
|---|---|---|---|
| 1 | 真人的 git 密码是另签的一份 GoTrue 登录会话，存在 0600 文件里 | 同用户进程读走就是整个账号被接管，且永不过期；和 10/10 否决 `cloud-token` 文件的理由相同 | FC 签发 git 专用 token（30 天，可吊销），PR3.1、PR4.1 |
| 2 | FC 加入 Gitea 的网络 | FC 的应用代理转发客户端头，`fc_endpoint` 可被创建者改写，能带伪造身份头访问 Gitea | FC 不进这个网络，走 Caddy 内部入口，PR3.2、3.3、3.6 |
| 3 | Gitea 的网络设 `internal: true` | 实测发布的端口会失效，SSH 2222 不通 | 去掉 `internal`，PR3.3 |
| 4 | 认不出 agent 祖先就按真人处理 | agent 的后台进程被过继后会以真人身份推送 | agent 环境里认证失败就拒绝，PR4.2 |
| 5 | 新 app 的库里存 HTTPS 地址和新的 auth kind | 旧版 daemon 会把它当成导入的外部仓库 | 库里不变，接口加 `gitHttpUrl` / `gitAccountAuth`，PR2.4 |
| 6 | — | agent 没有默认权限后，新 app 上「让 AI 改代码并推送」会断，且只报 not found | 建 app 时可勾选授权、权限页一键授权、helper 打明确提示，PR1.5、PR4.2 |
| 7 | — | agent 建的 app 创建者是 agent | 保持现状（已定事项 4）；授权人外键改成 actors，PR1.1 |
| 8 | Caddy 正则只匹配带 `.git` 的地址 | 不带 `.git` 的 clone 地址 404 | `.git` 可选，PR3.2 |
| 9 | 只在移除成员时同步 | 新成员要等对账才能 clone 团队可见的 app | 加入 team 也触发同步，PR2.2 |
| 10 | 从 `teams.oid` 查 app 的组织 | `amux.apps.org_id` 早就有，是 app 的租户指针 | 直接用 `apps.org_id`，PR2.1 |
| 11 | Caddy 配置留给冒烟测试验证 | 这是安全核心 | 已在本机端到端实测通过，spec §9.8 |

## 代码评审修订（2026-11-16，PR #1888）

| # | 问题 | 改成 |
|---|---|---|
| 1 | agent 被授予 `read` 后拿只读 deploy key，没授权的 agent 反而走团队级路径拿可写 key | `read` 授权不再收窄 agent 的 deploy key；团队级路径本身仍按已定事项 2 保留到 deploy key 下线 |
| 2 | 在另一台机器退出登录后，本机 token 已被吊销但本地看不出来，git 一直 401 | 桌面端定期用 `/v1/git/authz` 核验，被拒就重新签（`git_credential_verify`） |
| 3 | Gitea 的成员、协作者、team 列表只读第一页（50 条） | 翻页读全（`giteaListAll`） |
| 4 | 删除 app 只撤 deploy key、归档改名，原协作者仍能 clone 归档仓库 | 归档前移除全部协作者和 team 关联（`removeAllAppAccess`） |
| 5 | `/v1/git/authz` 的缓存没有上限；GoTrue 临时故障被缓存成「拒绝」60 秒 | 缓存上限 5000 条、先清过期项；临时故障不缓存 |
| 6 | daemon 把调用方传来的 `gitHttpUrl` 的主机直接记成可信主机 | 只认云端 `GET /v1/git/host` 返回的主机；helper 不对 `http` 降级应答 |
| 7 | 加入 / 移出 team 的请求同步等待整个团队的 Gitea 同步，且每个 app 重复同步一遍团队成员 | 一轮同步里组织、账号、team 各只处理一次；请求最多等 3 秒，同步在后台做完 |
| 8 | helper 每次 `get` 都先问一次 Cloud API | 「有权限」的结果缓存 10 分钟；连接超时 0.7 秒、总超时 1.5 秒 |
| 9 | 退出登录时，正在进行的 token 同步可能在清空之后又写回一个有效 token | 退出先等同步结束再吊销，同步发现已退出就不写 |
| 10 | `/v1/git/access` 在路由里直接查表 | 挪到 `supabase-repo/app-git-access.ts` |

已经删除的 app 不会被追溯处理：这次修改之前删除的归档仓库上，协作者关系还在，上线时要手工清一次。
