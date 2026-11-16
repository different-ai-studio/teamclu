# App 的 Gitea 鉴权 — 共享 TeamClu 身份 + 按账号鉴权的 git

- **Date**: 2026-11-16
- **Status**: Draft（方向已拍板，待核实项见 §9）；第一期实施计划：`docs/plans/2026-11-16-app-gitea-account-auth-phase1.md`
- **Branch**: `task/gitea-de-shi-yong-fa`
- **Builds on**: `docs/specs/2026-08-27-apps-self-serve-gitea-fc-design.md`
- **Scope（第一期）**: 真人和 agent 在 Gitea 里各有自己的身份；在 TeamClu 桌面端建 app、管权限；
  真人在终端、agent 在会话里用 git 命令操作仓库，push 记在各自名下。Gitea 退为存储。
- **原则：最小改动。** 不建新表。身份和组织全部复用 TeamClu 现有的；真人的 git 凭证是 FC 签发的 git 专用 token；
  Gitea 里的名字由 TeamClu 的 id 直接算出来，不存映射。
- **Non-goals（第一期）**: Gitea 网页、纯命令行用法（§5a 方式 1）、PR 进产品、老仓库迁移、
  下线 deploy key、belayo、非 TeamClu 用户、独立部署的服务。

## 0. 已拍板的决策

| # | 问题 | 决定 |
|---|---|---|
| 1 | 用户体系 | **共享 TeamClu 的组织和用户**：组织 = `public.orgs.id`，账号 = `auth.users.id`。app 不建自己的账号表，也不做自己的登录 |
| 2 | 部署形态 | 代码上作为 **FC 内的一个模块**（独立路由前缀 `/v1/git/*`），以后可以拆出去。第一期没有新表 |
| 3 | CLI | 以后做 **`amuxd app …` 子命令**；第一期只扩展 `amuxd git-credential` |
| 4 | agent | agent 有**独立账号**（它自己的 daemon 账号），和真人地位相同：单独授权、单独出现在 push 记录里 |
| 5 | 第一期范围 | **只做 TeamClu 界面 + git 命令，不开放 Gitea 网页** |
| 6 | agent 的 app 权限 | **没有默认权限，和真人一样在 app 成员里手动授权。** 建 app 只给创建者 admin；不按 `amux.agents.owner_member_id` 自动给主人的 agent 授权 |
| 7 | app 权限分级 | **改成 `read` / `write` / `admin`，和 Gitea 仓库协作者完全一致**（原 `view` → `read`，`prompt` → `write`）。只改 app 权限；agent 使用权限（`amux.agent_member_access`，「能不能和这个 agent 对话」）保留 `view` / `prompt` / `admin` |
| 8 | 数据库和令牌 | **最小方案**：只改 `amux.app_member_access` 一张表；不建 `app_grants`、Gitea 映射表、refresh token 表。**真人的 git 密码是 FC 签发的 git 专用 token**（只能用于 git，30 天），不是完整的登录会话；agent 用 daemon 现有的登录 token（2026-11-16 评审后修订，原因见 §4） |
| 9 | 落地节奏 | git 凭证存文件（不用钥匙串）；旧 deploy key 路径里 agent 的团队级权限第一期不动；老 app 第一期不动，完成后一次性迁移 |
| 10 | agent 建的 app | 创建者是 agent 自己，agent 是 admin（保持现状）；让它建 app 的真人不会自动得到权限 |

## 1. 现状与问题

- Gitea 只有一个 org `teamclaw-apps`，每个 app 一个仓库 `tc-app-<appId>`。FC 用一个
  管理员令牌（`GITEA_TOKEN`）完成所有操作。
- git 凭证全是一次性的 JIT deploy key（`GET /v1/apps/:id/git-credential`），通过
  `core.sshCommand = <amuxd> git-ssh --app <id> --` 注入（`apps/daemon/src/sync/app_git.rs:412`、
  `apps/daemon/src/cli/git_ssh.rs`）。每次 push 都要连本机 daemon 现取 key；回收是惰性的。
- 结果：
  - Gitea 不知道是谁在操作，push 挂不到人身上；
  - 在 TeamClu 给的 checkout 之外 clone 不了；
  - `app_member_access.member_id` 的外键指向 `amux.members`（`baseline.sql:6128`），agent actor 塞不进去，
    agent 只能拿到团队级的粗粒度权限。
- 部署拓扑：self-host 用 Gitea 1.22（sqlite），前面是 Caddy
  （`deploy/self-host/docker-compose.yml:234`、`caddy/Caddyfile:144`），SSH 2222 端口直接对外。
  belayo 由 Traefik 转发到一台外部托管的 Gitea（`deploy/belayo/README.md:78`）。

## 2. 总体结构

```
git push https://<git host>/<owner>/<repo>.git
  └─ git 要凭证 → amuxd git-credential（只对 Gitea 域名生效）
       ├─ 在 agent 环境里（环境变量带 runtime-context socket）→ 经 socket 按进程祖先认证，
       │    拿 daemon 账号的登录 token；认证失败就拒绝，不退回真人
       └─ 否则 → 读 `<amuxd home>/git-token.json` 里真人的 git 专用 token
       返回 username=u<账号 uuid>，password=<token>
  └─ Caddy：先丢掉客户端带来的身份头 → forward_auth → FC /v1/git/authz 验 token
       → X-WEBAUTH-USER: u<账号 uuid> → 删掉 Authorization → Gitea 按用户名判断仓库权限
```

- **FC**：验 token、给真人签 git 专用 token、把 app 权限同步到 Gitea。**FC 不在 Gitea 的网络里**，
  调 Gitea 管理 API 要经过 Caddy 的一个内部入口（§6）。
- **鉴权网关**：不另写服务，用 Caddy 的 `forward_auth`。git 包数据不经过 FC。
- **Gitea**：只有 Caddy 能直接访问；只认 Caddy 注入的用户头。

## 3. 数据模型：只改一张表

身份直接用 TeamClu 的表，不复制：

- **组织** = `public.orgs.id`；app 所属组织直接用现有的 `amux.apps.org_id`（非空，2026-09-23 起就是 app 的租户指针，
  `20260923200000_apps_org_id_tenant_pointer.sql`）。它和 `teams.oid` 不一致时以 `apps.org_id` 为准。
- **账号** = `auth.users.id`，真人和 agent 都是（agent 就是它自己的 daemon 账号）。
- **app 权限** 继续以 actor 为单位：app 属于一个 team，一个账号在这个 team 里只有一个 actor，
  通过 `amux.actors.user_id` 对应到账号。

**唯一的迁移：改 `amux.app_member_access`**

```sql
-- 1. 外键从 members 改成 actors，agent actor 就能被授权
alter table amux.app_member_access drop constraint app_member_access_member_id_fkey;
alter table amux.app_member_access add constraint app_member_access_member_id_fkey
  foreign key (member_id) references amux.actors(id) on delete cascade;
-- 1b. 授权人也可能是 agent（agent 建的 app 里 agent 是 admin，决策 10）
--     granted_by_member_id 的外键同样从 members 改成 actors
-- 2. 权限改名（决策 7）
alter table amux.app_member_access drop constraint app_member_access_permission_level_check;
update amux.app_member_access set permission_level = case permission_level
  when 'view' then 'read' when 'prompt' then 'write' else permission_level end;
alter table amux.app_member_access add constraint app_member_access_permission_level_check
  check (permission_level in ('read','write','admin'));
```

- 列名 `member_id` 暂不改（改名会动到所有查询）；加注释说明它现在可以是任何 actor。是否改成 `actor_id` 在实施计划里定。
- 被授权的 actor 必须和 app 在同一个 team：FC 写入时校验，再加一个触发器兜底。
- RLS：`app_member_access_select` 现在只认真人 member（`member_id = amux.current_member_id()`），要改成按 actor 判断，
  被授权的 agent 才能读到自己的授权行。`is_team_member`、`current_actor_id_for_team`、`actor_has_app_access` 本来就按 actor 查，不用改。
- FC 读权限的地方要放开 agent：`resolveAppPermission` 现在对 agent 直接返回 null
  （`supabase-repo.ts:6276` 附近的 `if (!callerMemberId) return null`）。
- **不建**：`app_grants`、`gitea_users`、`gitea_orgs`、team 映射表、`refresh_tokens`、`device_codes`。

**Gitea 里的名字由 id 直接算出来**（不存映射，id 不变所以名字也不变）：

| TeamClu | Gitea 名字 | 长度 |
|---|---|---|
| 账号 `auth.users.id` | 用户 `u` + 去掉横线的 uuid | 33 |
| 组织 `public.orgs.id` | org `o` + uuid | 33 |
| team `amux.teams.id` | org 下的 team `t` + uuid | 33 |
| app | 仓库 `tc-app-<appId>`（沿用现有命名） | — |

2026-11-16 用 Gitea 1.22.6 实测：33 位的用户名、org 名、team 名都能建；用户名上限是 40 位（41 位返回 `422 [Username]: MaxSize`）。
调 Gitea API 只用名字，不需要它的内部 uid。

## 4. 令牌

| 谁 | git 密码 | 寿命 | 存在哪 |
|---|---|---|---|
| 真人 | **FC 签发的 git 专用 token**：HS256 JWT，`aud=teamclu-git`，`sub`=账号 id，带一个 `epoch` | 30 天 | `<amuxd home>/git-token.json`（0600） |
| agent | daemon 账号现有的 TeamClu 登录 token（GoTrue JWT） | 约 1 小时，daemon 自己续 | 只在 daemon 内存里，经 `runtime-context.sock` 发给 agent 进程 |

**为什么真人不直接用登录会话**（2026-11-16 评审时改的）：`git-token.json` 是同一个系统用户下任何进程都能读的文件。
2026-10-10 否决 daemon 的 `cloud-token` 文件就是因为 0600 挡不住同用户下的其他 AI 工具。如果里面放的是完整的登录会话，
被读走就等于整个账号被接管，而且 self-host 的 GoTrue 没配会话期限，这份会话永不过期。git 专用 token 被读走只能用于 git，30 天后失效。
**做不到的**：同用户进程冒充真人做 git，这一点任何方案都防不了（内核看来它和你的终端没有区别），只能缩小损失范围。

FC 新增的端点：

- `GET /v1/git/authz`（只给 Caddy `forward_auth` 调）：从 Basic 里取出密码，依次按两种 token 验：
  1. `aud=teamclu-git` 的 git token：验签名、过期时间，再比对 `epoch` 和账号当前的 `git_token_epoch`；
  2. 否则当 TeamClu 登录 token，用现有的校验。
  通过就返回 `200 + X-WEBAUTH-USER: u<sub 的 uuid>`，否则 `401 + WWW-Authenticate: Basic`。账号状态和 epoch 缓存 60 秒。
- `POST /v1/git/token`（桌面端调用，带当前 TeamClu 会话）：签发 git token，返回 `{ token, expiresAt, gitHost, userName }`。
- `POST /v1/git/token/revoke`（桌面端退出登录时调用）：把账号的 `git_token_epoch` 加一，这个账号所有机器上的 git token 立刻失效；
  其他机器上的桌面端下次启动时自动重新签。
- `GET /v1/git/access?repo=<owner>/<repo>`（helper 调用，用同一个 token）：返回调用者对这个仓库对应 app 的权限和 app 名称，
  只用来打印清楚的错误提示（§5）。

`git_token_epoch` 存在账号的 `app_metadata` 里（`auth.users.raw_app_meta_data`），不加表也不加列。签名密钥是新的环境变量
`GIT_TOKEN_SECRET`。

这套做法不依赖 GoTrue 会话，所以用户会话由合作方签发的环境（代码里的 `TRUSTED_EXTERNAL_JWT_SECRET` 路径）也能用。
§9.3 里「另签一份 GoTrue 会话」的实测结果保留作记录，**不再采用**。

## 5. 两种身份怎么拿到 token

**agent**：agent 的账号就是 daemon 账号。helper 通过 `runtime-context.sock` 的 cloud-token 接口向 daemon 要当前的登录 token；
这个接口已经按内核给的进程祖先认人，只发给 daemon 拉起的 agent host 的后代。

**真人：桌面端登录即完成。** 桌面端登录成功后调 `POST /v1/git/token`，把结果写进 `<amuxd home>/git-token.json`（0600）。
helper 直接读这个文件，不用续期、不用联网、不用文件锁。桌面端每次启动时，token 剩余不足 7 天就重新签一个；
退出登录时调 `revoke` 并删掉文件。token 过期或文件不存在 → helper 在 stderr 提示「请打开 TeamClu 桌面端登录」。

**关掉桌面端以后 git 照常能用**，最长 30 天不打开桌面端也行。真人这条路只依赖三样东西：`git-token.json`、
`amuxd` 这个可执行文件、云端的 FC 和 Caddy；不依赖桌面端进程，也不依赖 daemon 进程。
agent 那条路需要 daemon 在运行，这本来就是 agent 运行的前提。

**同一台机器上用哪个身份**：
- 环境里有 `TEAMCLU_RUNTIME_CONTEXT_SOCK`（daemon 下发给每个 agent host，子进程都会继承）→ 这是 agent 环境，
  **必须**经 socket 按进程祖先认证拿 agent 的 token；**认证失败就拒绝，不退回真人身份**。
  原因：agent 用 `nohup`、后台方式起的 git，父进程退出后会被过继给 1 号进程，祖先链断了；如果这时退回真人，
  agent 的推送就记到了真人名下。
- 环境里没有这个变量 → 用 `git-token.json` 里的真人身份。

环境变量只用来判断「该走哪条路」，真正的认证仍然靠进程祖先。agent 故意去掉这个变量，效果等同于直接读 `git-token.json`，
属于上面说的防不了的那一类。

**没权限时的提示**：全局配置里打开 `credential.https://<git host>.useHttpPath=true`，git 会把仓库路径传给 helper。
helper 拿到 token 后调一次 `GET /v1/git/access`，没有任何权限时在 stderr 打一行，例如
`[amuxd git] agent「小助手」没有应用「订单看板」的权限，请在 应用 → 成员 里授权`。否则用户只会看到 Gitea 的 `Repository not found`。

## 5a. 以后：两种使用方式（产品期望，第一期不做）

### 方式 1：只用命令行，不装桌面端

```
$ amuxd app create test1          # 没登录 → 浏览器去 TeamClu 网站注册/登录 → 回到终端
? 应用类型  › 静态网页 / 幻灯片 / 带数据库的应用 / 导入已有仓库
? 可见范围  › 只有我 / 团队
✓ 已创建 test1，代码在 ./test1
$ cd test1 && git commit -am … && git push
$ amuxd app deploy
```

要补的：CLI 登录（浏览器回跳 / 设备码，登录后同样签一个 git token，和第一期的 `git-token.json` 格式一致）、
`amuxd app` 不依赖 daemon 的独立模式（部署编排已在 `crates/teamclu-apps/src/deploy.rs:269`，
通过 cloud / daemon 两个 trait 抽象）、交互式 create、新用户的组织怎么来。

### 方式 2：装了桌面端

界面建 app、管权限；agent 用 `amuxd app deploy` 或 MCP `manage_app` 部署；终端里 git 靠同一个
credential helper。第一期做完，方式 2 里的 git 部分就成立了；`amuxd app` 按调用方区分身份留到以后
（现在不管谁调用都用 daemon 的 agent 账号，`apps/daemon/src/cli/app.rs:1`）。

## 6. git 和网关

**用户和 agent 的 git 只走 HTTPS。** 桌面端登录后、daemon 启动时，幂等地写只对 Gitea 域名生效的全局配置：

```
git config --global credential.https://<git host>.helper ""
git config --global --add credential.https://<git host>.helper "<amuxd 绝对路径> git-credential"
git config --global credential.https://<git host>.useHttpPath true
```

第一行的空值清掉这个主机已有的 helper：macOS 自带的 osxkeychain 会把 token 存下来，过期后拿出来重放，导致 401。

**库里的仓库地址不变。** `apps.git_remote_url` 继续存 SSH 地址，`git_auth_kind` 继续是 `gitea_deploy_key`；
app 接口多返回 `gitHttpUrl` 和 `gitAccountAuth: true`，新版客户端看到才把 checkout 的 remote 设成 HTTPS。
原因：旧版 daemon 看到 HTTPS 地址会把它当成导入的外部仓库去要 token。daemon 自己的 seed push、部署前 fetch
继续走 SSH + 一次性 deploy key，第一期不改。

**网关**（Caddy，2026-11-16 用 Caddy 2.10 + Gitea 1.22.6 本机端到端实测通过，结果见 §9.8）：

```caddyfile
{$CADDY_SITE_SCHEME}{$GITEA_DOMAIN} {
	{$CADDY_SITE_TLS}
	request_header -X-WEBAUTH-USER                  # 客户端带来的身份头一律丢掉
	@git path_regexp git ^/[^/]+/[^/]+(\.git)?/(info/refs|git-upload-pack|git-receive-pack)$
	handle @git {
		forward_auth fc:<port> {
			uri /v1/git/authz
			copy_headers X-WEBAUTH-USER
		}
		reverse_proxy gitea:3000 {
			header_up -Authorization                # 有效的 Basic 会压过代理头（§9.1 第 8 行）
		}
	}
	handle {
		respond 404                                 # 网页、/api/* 第一期不对用户开放
	}
}

# 只给 FC 调 Gitea 管理 API 的内部入口：不发布到宿主机，永远剥掉身份头
http://:8081 {
	request_header -X-WEBAUTH-USER
	reverse_proxy gitea:3000
}
```

- **只放行 git 协议路径**，`.git` 后缀可有可无。网页和 `/api/*` 对用户一律 404：Gitea 的 admin 协作者能通过 API
  改协作者、加 deploy key、加 webhook，放开就能绕过 TeamClu 的权限管理。
- Git LFS 第一期不支持（它的路径不在放行范围内）。
- 仓库级权限仍由 Gitea 判定（依据是同步过去的协作者和 team，§7），网关只负责「你是谁」。

**Gitea 配置**：`ENABLE_REVERSE_PROXY_AUTHENTICATION=true`；`…_API` 不开；
`…_AUTO_REGISTRATION=true` 只作兜底（FC 授权时会先建好用户）；关闭本地注册和密码登录。

**网络隔离是唯一的防线。** `REVERSE_PROXY_TRUSTED_PROXIES` 不限制谁能发代理头（§9.1 第 10 行）。所以：

- Gitea 单独放进一个 compose 网络，**只有 Caddy 同时在这个网络里**。不要用 `internal: true`：
  实测只挂在 internal 网络上的容器，发布的端口从宿主机连不上，SSH 2222 会失效。
- **FC 不加入这个网络**，`GITEA_URL` 改成 `http://caddy:8081`。原因：FC 的应用访问代理（`apps-vanity.ts` 的 `proxyToApp`）
  会把客户端请求头原样转发给 `apps.fc_endpoint`，而应用创建者有权直接改 `amux.apps` 整行
  （`authenticated` 有 UPDATE，策略 `apps_update_if_creator`，`fc_endpoint` 上没有触发器保护）。
  FC 要是能直连 Gitea，创建者把 `fc_endpoint` 指向 `http://gitea:3000`、再带上伪造的 `X-WEBAUTH-USER` 访问自己的应用域名，
  就能冒充任何人。经过内部入口后，这条路上的身份头会被剥掉。
- 加两道保险：`proxyToApp` 转发前删掉 `x-webauth-*`；`fc_endpoint` 能被客户端改写是现存问题，单独开 issue 修。

**PR**：第一期顺带能用 AGit：`git push origin HEAD:refs/for/main -o topic=<x> -o title=<…>`（只需要 read）。
`amuxd app pr`、TeamClu 里的 PR 列表留到以后。

## 7. 同步到 Gitea 与权限对齐

| TeamClu | Gitea |
|---|---|
| 组织 | org `o<uuid>` |
| team | org 下的 team `t<uuid>`，只用来承载「团队可见 = 队友 read」 |
| app | org 下的仓库 |
| 账号（真人 / agent） | 用户 `u<uuid>`；显示名同步 `public.users.nickname` / actor 显示名，agent 带「· agent」后缀 |

**权限对齐**（决策 7 之后两边同名，照搬即可）：

| 我们 | 产品里能做什么 | Gitea | 在 Gitea 里能做什么 |
|---|---|---|---|
| 创建者（隐含 admin，`supabase-repo.ts:6276`） | 同 admin | 协作者 **admin** | 同下 |
| `admin` | 部署、授权、改设置和环境变量 | 协作者 **admin** | 读写代码；仓库设置被网关收住 |
| `write`（原 `prompt`） | 改代码、读写 app 数据和文件、查看环境变量名（改环境变量要 admin，`supabase-repo.ts:6917`、`:6937`） | 协作者 **write** | clone、push 任意分支（含 main）、合并 PR |
| `read`（原 `view`） | 能看到、能下载代码 | 协作者 **read** | clone、pull、AGit 提 PR，不能直接 push |
| 团队可见，没有单独授权 | 队友 read（`supabase-repo.ts:6325`） | team `t<uuid>` 对该仓库 **read** | 同 read |
| 仅自己可见，没有单独授权 | 看不到 | 无 | 仓库返回 404 |
| TeamClu 组织管理员 | 对 app 没有隐含权限 | **不进** Gitea Owners | Owners 里只放 FC 服务账号 |

- **「部署」不是 Gitea 的概念**，继续由 FC 按 `admin` 判断。
- **组织管理员不能映射成 Gitea Owners**：Owners 能看到 org 下所有仓库，会越权。
- **write 能直接 push main**，和现在一样。以后要「write 只能提 PR」，用 Gitea 分支保护，第一期不做。

**同步方式**（没有映射表，靠名字推导 + 对账）：
- 建 app、授权、撤销、改可见范围时，FC 在同一个请求里调 Gitea 管理 API（需要时先建 org / team / 用户）；
  失败不回滚业务操作，留给对账。
- 定时对账：遍历 app 和 `app_member_access`，算出每个仓库应有的协作者和 team，与 Gitea 现状比对后修正。
- 成员被移出 team 时 actor 级联删除，`app_member_access` 跟着删，但 Gitea 协作者要等 FC 同步或对账才会移除。
  **成员加入和移出 team 的接口都要触发同步**（加入时要把他加进 team `t<uuid>`，否则「团队可见」的 app 要等对账后才能 clone），对账作兜底。
- **agent 没有默认权限带来的变化**：现在 agent 靠团队级的 deploy key 能直接推；第一期之后，新 app 上没被授权的 agent 推不上去。
  界面要补：建 app 的对话框里可以勾选「同时授权给这些 agent」（默认不勾）；权限页里 team 的 agent 排在前面、一键授权；
  加上 §5 的 helper 提示。
- **agent 建的 app**（决策 10）：创建者是 agent，agent 是 admin；让它建 app 的真人不会自动得到权限（团队可见时是 read）。
  agent 可以再授权给别人，所以授权人的外键也要改成 actors（§3）。
- commit 作者：amuxd 在 checkout 里把 `user.name` / `user.email` 写成当前身份；网关和 Gitea 记下的 pusher 才是可信记录。

**权限改名的影响范围**（只涉及 app 权限）：
- 数据库：只有 `app_member_access` 的 check 约束（`baseline.sql:4146`），见 §3 的迁移。
  `can_prompt_agent`、`list_connected_agents` 里的 `'prompt'` / `'view'` 属于 agent 使用权限，不改。
- FC：`supabase-repo.ts` 的 `APP_PERMISSION_LEVELS`、`resolveApp*Access` 的门槛（`"prompt"` → `"write"`）。
- OpenAPI：app 相关接口约 10 处。
- 桌面端：`AppPermissionLevel`、`AppAccessTabContent.tsx` 的选项和文案、测试。iOS、Expo、daemon 不受影响。
- 兼容旧客户端：过渡期 FC 写接口同时接受旧值并换成新值，读接口只返回新值。

## 8. 落地顺序

### 第一期

1. **权限（FC + 桌面端）**：§3 的迁移；FC 放开 agent 的权限判断、改权限名、写入时校验同 team；
   桌面端权限页改名，成员选择器里能选 agent。
2. **同步到 Gitea（FC）**：新 app 建在 `o<uuid>` 下；授权变更同步成协作者和 team；定时对账。老 app 暂不迁。
3. **网关（self-host）**：`/v1/git/authz`、`/v1/git/token`、`/v1/git/token/revoke`、`/v1/git/access`；§6 的 Caddy 配置；
   Gitea 开代理头鉴权、放进只有 Caddy 能进的网络，FC 改走内部入口；冒烟测试覆盖伪造头和直连。
4. **凭证（桌面端 + daemon）**：桌面端登录后写 `git-token.json`、退出时吊销并删除；`amuxd git-credential` 全局模式
   （agent 走现有的 cloud-token socket，真人读文件）；写好全局 helper 配置；新版客户端把 checkout 的 remote 设成 HTTPS，
   旧的 `core.sshCommand` checkout 继续可用。

做完的效果：在桌面端建 app、给真人或 agent 授权；真人在任意终端 `git clone / pull / push`，
agent 在会话里 `git push`，Gitea 里分别记在各自名下；AGit 提 PR 也能用。

### 以后

- **老仓库一次性迁移**（第一期验收通过后）：`teamclaw-apps/tc-app-*` 转到各自 org、改成账号鉴权，daemon 自动改本地 remote；之后下线 deploy key。第一期里老 app 完全不动。
- 下线 JIT deploy key 和 `amuxd git-ssh`，关闭 SSH 2222，清理残留 key。
- PR 进产品：`amuxd app pr`、TeamClu 里的 PR 列表。
- 纯命令行（§5a 方式 1）。
- belayo（取决于 §9.2）。
- 以后要把 app infra 拆成独立服务时，再考虑自己签发 token。

## 9. 待核实

1. ~~Gitea 1.22 的 git smart HTTP 认不认反向代理头~~ **已实测，认。**（2026-11-16，Gitea 1.22.6
   官方 darwin-arm64 二进制、sqlite。self-host 镜像 `gitea/gitea:1.22` 对应的就是 1.22.x。）

   | # | 请求 | 结果 |
   |---|---|---|
   | 1 | 不带凭证 clone 私有仓 | 401，git 去要用户名 |
   | 2 | `X-WEBAUTH-USER: alice` clone | ✅ 成功 |
   | 3 | 同上 push | ✅ 成功，动态里 pusher 记为 alice |
   | 4 | `X-WEBAUTH-USER: bob`（无权限） | `Repository not found`，权限照常生效 |
   | 5 | `X-WEBAUTH-USER: carol`（不存在） | 当场自动建号；邮箱是占位值，要靠 `X-WEBAUTH-EMAIL` 传 |
   | 6 | API `/api/v1/user` 带头 | 返回 alice |
   | 7 | 头=alice，Basic=alice:错误密码 | ✅ 成功：Basic 失败后退回代理头 |
   | 8 | 头=bob，Basic=alice:正确密码 | ✅ 以 alice 身份成功：**有效的 Basic 优先于代理头** |
   | 9 | 头=bob（只读），`git push origin HEAD:refs/for/main -o topic=… -o title=…` | ✅ 创建 PR#1，作者 bob。AGit 只需要读权限 |
   | 10 | `REVERSE_PROXY_TRUSTED_PROXIES=10.255.255.255/32`，从 127.0.0.1 带头访问 | ⚠️ **仍然成功**。这个设置只管 X-Forwarded-For 里的真实 IP，不限制谁能发代理头 |
   | 11 | 建 33 位的用户名 / org 名 / team 名 | ✅ 都能建；用户名 41 位返回 422 MaxSize |

2. **belayo 的外部 Gitea 能不能关掉直连入口**，只留 Traefik。根据第 10 行，只要有任何一条直连路径，
   任何人都能冒充任何人。关不掉的话，belayo 只能改用「FC 为每个账号签发短期 Gitea 令牌，网关把 Basic 改写成这个令牌」。
3. ~~self-host GoTrue 能不能用服务端权限签出新会话~~ **能，但评审后不再采用这个方案（§4 改成 FC 签发 git 专用 token）；以下结果留作记录。**（2026-11-16 在本机用独立的 GoTrue v2.194.0 +
   Postgres 17 容器实测；self-host 是 v2.188.1。FC 的手机号登录已经在生产里走同一条路，见 §4。）
   - ① 同一个用户签两次，得到两份不同的会话（`session_id` 不同），`sub`、`aud=authenticated`、`role=authenticated`
     都和正常登录一样，FC 现有的 JWT 校验直接认。没配 SMTP 时 `generate_link` 也返回 200，不会发信。
   - ② 两份会话各自续期互不影响；git 会话 `logout?scope=local` 后只有它失效，桌面端会话照常续期。
   - ③ **共用一份会话确实会出事**：桌面端连续续期两次后，helper 拿落后两代的旧 refresh token 去续期，
     返回 `400 refresh_token_already_used`，**桌面端随后用最新的 token 续期也是 400，整份会话被吊销**。
     落后一代不会出事：GoTrue 对「当前有效 token 的上一代」永远放行并返回当前 token。
   - ④ 连续签 60 次没有被限流。
   - ⑤ **副作用**：签会话会作废该用户正在等待的邮箱验证码。用户刚在另一台设备上收到登录码、还没输入时，
     FC 为他签了 git 会话，那个码就会返回 `403 otp_expired`。所以只在 `git-session.json` 里没有可用 git 会话时才签；
     发生时用户重新获取验证码即可。手机号登录现在也有同样的副作用。
4. ~~GoTrue 的 refresh token 复用窗口~~ 两个 git 进程同时续期：由 ③ 可知，同时续期的两方最多落后一代，
   GoTrue 会放行。helper 仍然加文件锁，避免续期结果写回文件时互相覆盖。
5. ~~没有邮箱的账号~~ 只有手机号的员工在 GoTrue 里也有一个合成邮箱（`phone-auth.ts` 的 `syntheticEmail(phone)`），
   签 git 会话用它即可，和手机号登录现在的做法一样。
6. ~~是不是每个 agent 都对应唯一一个 `auth.users`~~ **是，一对一，但 agent 可能还没有账号。**（2026-11-16 查代码和迁移；
   self-host 的 SSH 当时连不上，没有查线上数据。）
   - 同一个 team 里一个账号最多一个 actor：唯一索引 `actors_team_user_idx (team_id, user_id)`（`baseline.sql:5183`）。
   - 所有创建 agent actor 的地方，`user_id` 要么是**当场新建**的 daemon 账号（`daemon.<uuid>@amuxd.run`），要么是空；
     没有任何路径把已有账号挂到另一个 agent 上。
   - 换设备、轮换凭证（invite 带 `target_actor_id`）**沿用这个 agent 原来的账号**，只吊销旧会话
     （`20261102000000_agent_account_owner_roles.sql` 的 reuse-or-mint 逻辑；2026-08-19 之前的版本会删掉旧账号再新建）。
     所以 Gitea 用户名 `u<uuid>` 对一个 agent 是稳定的。
   - 同一台机器加入两个 team，是两个 agent、两个账号、两个 Gitea 用户。app 本来就按 team 归属，不影响。
   - **例外**：按设备创建的 agent（`ensure_agent_for_device`，`20260812120000`、`20260824120000`）先建出
     `user_id` 为空的 actor，等 daemon 认领邀请后才绑定账号。没绑定账号的 agent 没有 Gitea 身份：
     界面上的成员选择器要把它置灰（提示「这个 agent 还没连上」），同步到 Gitea 时跳过。
   - agent 被移出 team、账号被删除后，Gitea 里的用户会成为孤儿，由对账把它的协作者权限清掉。
7. sqlite 版 Gitea 在多 org、多用户写入下的并发表现，必要时切 Postgres。
8. ~~Caddy 的指令顺序（先剥头、`forward_auth`、`copy_headers`、`header_up`）~~ **已实测，§6 的配置可用。**
   （2026-11-16，Caddy 2.10.0 + Gitea 1.22.6 + 一个假的 authz 服务，本机端到端。）

   | # | 请求 | 结果 |
   |---|---|---|
   | 1 | 不带凭证 `ls-remote` | 401，git 去要用户名 |
   | 2 | 只带伪造的 `X-WEBAUTH-USER: alice`，不带凭证 | 401：伪造头被丢掉 |
   | 3 | alice 的 token clone、push | ✅ 成功 |
   | 4 | 伪造头 = alice，token 是只读的 bob，push | 被拒（`pre-receive hook declined`）：身份以 token 为准 |
   | 5 | 地址不带 `.git` | ✅ 可用 |
   | 6 | Basic 里填 Gitea 的真实用户名密码 | `Authentication failed`：Authorization 到不了 Gitea |
   | 7 | 网页 `/`、`/api/v1/version`、`/alice/demo` | 都是 404 |
   | 8 | 内部 API 入口带伪造的 `X-WEBAUTH-USER: root` 调 `/api/v1/user` | 401：身份头被剥掉 |
   | 9 | 只读的 bob 用 AGit 提 PR | ✅ 建出 PR |
9. ~~`internal: true` 的网络能不能发布端口~~ **不能**（2026-11-16 本机实测：容器只挂在 internal 网络上时，
   `-p` 发布的端口从宿主机连不上）。所以 Gitea 的网络不设 `internal`。
10. **belayo 的用户会话是不是由合作方签发**（`TRUSTED_EXTERNAL_JWT_SECRET` 路径）。§4 的 git token 不依赖 GoTrue 会话，
    两种情况都能用，但 `/v1/git/authz` 验 agent 的登录 token 时要走对应的校验路径。

## 10. 风险

- **网关被绕过就能冒充任何人。** 对策：Gitea 只在和 Caddy 共用的网络里，FC 也不直连；Caddy 丢掉客户端的身份头、
  删掉 Authorization；冒烟测试覆盖伪造头和直连。
- **同用户进程能读走 `git-token.json`。** 防不了，只能缩小损失：token 只能用于 git、30 天过期、退出登录即吊销（§4）。
- **agent 的推送记到真人名下。** 对策：agent 环境里认证失败就拒绝，不退回真人身份（§5）。
- **移除成员后还有活着的 token。** 对策：`/v1/git/authz` 检查账号状态和 epoch（缓存 60 秒）；Gitea 协作者由同步和对账移除，
  即使 token 还有效也推不上去。
- **`git_token_epoch` 被覆盖**：它存在 `app_metadata` 里，实现时要确认没有代码整体覆盖 `raw_app_meta_data`
  （现有的写法都是合并：`claim_team_invite` 用 `||`，GoTrue 管理接口按 key 合并）。
- **新 app 上没授权的 agent 推不了代码**，和现在的习惯不同。对策见 §7 的界面补充和 helper 提示。
