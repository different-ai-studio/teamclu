# App 平台 P1 — Gitea 移出平台（实施方案）

父 spec：`2026-11-24-app-platform-infra-decoupling-design.md` 的 §6，以及 §8 里 P1 那一行。
P0（驱动接口）已合并（#2014）。本文把 P1 拆成几步，每一步都能单独合并。

## 0. 目标与约束

**目标**：平台只认一条部署契约：客户端构建 → 上传产物 → `finalize(revision)`。
代码放在哪个 git、谁能 push，归 TeamClu 产品层（forge 集成）管。平台代码里不出现 Gitea。

**约束**（沿用父 spec §8）：

- 每一步都能单独合并，**都不改对外行为**。具体是：`/v1/apps*` 的响应字段、错误码保持原样；
  Gitea app 的建仓、push、部署体验保持原样。daemon、`crates/teamclu-apps`、桌面端、iOS 都不用改。
- 只有最后一步碰数据库结构，而且只做**加法**（新表 + 回填）。旧列不在 P1 删除。

**退出标准**：

1. `test/app-platform/boundary.test.ts` 新增一条规则：除 `lib/forge/**` 和白名单外，
   不得出现 Gitea 标识（`gitea`、`GITEA_`、`deploy-key`）。白名单只有两类：
   - 组装根：`src/index.ts`、`app-platform/deps.ts`；
   - 团队成员加入路径：`supabase-repo/auth.ts`，它属于 TeamClu 层。
2. `supabase-repo.ts` 里 grep 不到 `gitea`。
3. Gitea app 和导入 app 走同一条 preflight / deploy / finalize 代码路径。两者的差别只在于是否注册了 forge 守卫。

## 1. 现状耦合（2026-11-25，main `a10e92e47`）

### 1.1 可以整文件搬走（约 2000 行）

| 文件 | 行 | 职责 |
|---|---|---|
| `provisioning/gitea.ts` | 611 | Gitea API 客户端（org、仓库、HEAD、compare、归档、协作者） |
| `provisioning/gitea-sync.ts` + `gitea-sync-runner.ts` | 364 | 把 TeamClu 授权同步成 Gitea 协作者和 team；心跳里的修复 |
| `provisioning/deploy-key.ts` + `deploy-key-expiry.ts` | 505 | JIT deploy key 的签发、吊销、过期清扫 |
| `routes/git.ts` + `git-token.ts` | 384 | `/v1/git/token`、`/revoke`、`/host`、`/authz`（Caddy forward_auth）、`/access` |
| `supabase-repo/app-git-access.ts` | 93 | 回答「Gitea 为什么拒绝你」的提示 |
| `app-git-credential.ts` | 93 | 导入的 http 仓库所存的 token。它不属于 Gitea，但同属 forge |

### 1.2 嵌在平台流程里（`supabase-repo.ts` 69 处，加上周边文件）

| # | 位置 | 现在做什么 |
|---|---|---|
| B1 | `createApp`（:5222–5357） | 没配 Gitea 就返回 503；建 org 和仓库；写 `git_remote_url` / `git_auth_kind`；调 `giteaSync.app`；失败返回 `502 gitea_provision_failed`；产生 `provision_status=repo_created` |
| B2 | `preflightAppDeploy`（:5767）、`deployApp`（:5845）、`finalizeDeploy`（:5979） | Gitea app 要求 revision == 远端 HEAD == `gitCommitSha`；其余 app 要求 revision 是 `sha256:` 摘要。finalize 写 `git_commit_sha` |
| B3 | `getAppGitHead`（:6751）、`GET /v1/apps/:id/git-head` | 读远端 HEAD 和未部署的提交数；客户端部署前的复核也调它 |
| B4 | 授权变更：可见性（:5580）、授权（:6960/:6985）、入队（:1476/:1773），以及 `auth.ts` 3 处 | 触发 `giteaSync.app/team`；移除授权时顺带吊销 deploy key |
| B5 | git-credential 相关：repo 方法（:1292、:6555–6744）和 `/v1/apps/:id/git-credential*` 四条路由 | 签发、吊销 deploy key；`git_auth_kind` 在 `gitea_deploy_key` / `git_https` / null 之间切换 |
| B6 | 删除 app（`app-delete.ts`、:7656–7672） | 撤掉 Gitea 访问、吊销全部 key、归档并改名仓库 |
| B7 | 响应拼装（`supabase-repo/shared.ts` :173–208）、`runtime-info` 的 `commit`（:6288） | 输出 `gitRemoteUrl` / `gitHttpUrl` / `gitAuthKind` / `commit` |
| B8 | 组装与心跳：`index.ts` 的 `makeGiteaDeps` / `makeTeamGiteaSync`；`routes/apps.ts` 心跳里的 `giteaReconcile` 和 deploy key 过期清扫 | |
| B9 | 语义残留：`app-permission.ts` 的 `inheritedGiteaLevel`，以及若干注释 | |

### 1.3 数据

涉及 `amux.apps` 的三列：`git_remote_url`、`git_auth_kind`、`git_commit_sha`。
授权表 `app_member_access`（迁移 20261117 / 20261120）只是**命名**对齐了 Gitea，结构是通用的，不动。

## 2. 目标结构

```
services/fc/src/lib/
  app-platform/            # 平台：不知道 git
    hooks.ts               # 新增：AppLifecycleHooks 接口（平台定义，forge 实现）
  forge/                   # 新增：TeamClu 的 forge 集成
    index.ts               # makeForgeHooks(env) → AppLifecycleHooks | null
    gitea/                 # 1.1 的文件整体搬进来（client / sync / deploy-key / expiry）
    git-routes.ts          # 原 routes/git.ts，加上 apps.ts 里四条 git-credential 路由和 git-head
    app-git-access.ts
    imported-http.ts       # 原 app-git-credential.ts
```

### 2.1 `AppLifecycleHooks`（平台定义接口，平台只调接口）

接口在 `app-platform/hooks.ts`（P1.2 已实现）。按 app 的生命周期分组：

| 组 | 方法 | 说明 |
|---|---|---|
| 建 app | `assertCanHostRepo()`、`provisionRepo(app)`、`provisionFailed(msg, details)` | 平台把 `provisionRepo` 返回的 `remoteUrl` / `authKind` 写回 app 行；失败时平台先记 `provision_status=error`，再抛 forge 给的错误（Gitea：`502 gitea_provision_failed`） |
| 授权 | `appAccessChanged(appId)`、`teamAccessChanged(teamId)`、`memberWriteRevoked(appId, memberId)` | 都是 best-effort，失败不影响触发它的那次变更 |
| 代码访问 | `hostsRepo(app)`、`issueCredential`、`revokeCredential`、`repoHead` | 原 `mintAppGitCredential`、`getAppGitHead` 的逻辑 |
| 删除 | `releaseRepo(app)` | 由 `teardownAppResources` 的 `releaseRepo` 回调调用 |
| 响应 | `decorate(app)` | `mapApp(row, forgeFields)` 的第二个参数，Gitea 输出 `gitAccountAuth` / `gitHttpUrl` |

心跳另有 `ForgeHeartbeat { before, after }`：`before` 在平台任务前跑（deploy key 过期清扫，`started + 8s`），
`after` 在平台任务后跑（每十分钟一次的 Gitea 修复，`started + 50s`），各自返回要并入响应体的字段。

组装：`createSupabaseBusinessRepository({ forge })` 接收一个 `AppLifecycleHooksFactory`
（`(ctx: { serviceRoleClient }) => AppLifecycleHooks`），默认 `noForge()`：导入和本地 app 照常，
需要托管仓库的 app 返回 `503 repo_hosting_unavailable`。`index.ts` 传入 `forgeFromEnv()`，
`routes/index.ts` 把 `forgeHeartbeatFromEnv()` 交给 `registerApps`。

部署守卫（`deployGuard`）留到 P1.3 加。

### 2.2 revision 通用化

平台对 revision 只检查**格式**：`sha256:<hex>`（内容摘要）或 40 位 git SHA，其它一律返回 400。
「这个 SHA 必须是远端 HEAD」这条规则由 forge 的 `deployGuard` 负责。**服务端校验保留，只是换了一层。**

> 与父 spec §6 的差异：§6 写的是「HEAD 复核挪到客户端，平台端删掉」。这里改成挪进 forge 守卫，
> 原因是 §8 要求每一步都不改对外行为。如果删掉服务端校验，旧客户端或绕过 daemon 的调用方就能把
> 没 push 的代码部署上线，「线上 = 仓库里的某个提交」这条保证就没了。客户端那道复核
> （`deploy.rs:301`）照旧保留，两道并存。见 §5 决策 1。

新增 `apps.deployed_revision` 列，每次 finalize 都写，值是 git SHA 或 `sha256:` 摘要。
`git_commit_sha` 继续写、继续输出，因为 daemon 的 `records.rs` 和 runtime-info 的 `commit` 都在读它；
它的值在 `deployGuard("finalize")` 通过后由 forge 给出。P1 不删这一列。

## 3. 步骤

每步一个 PR，按顺序合并。前四步不涉及迁移。

### P1.1 搬家：Gitea 模块进 `lib/forge/`（纯移动）

- 用 `git mv` 把 1.1 的 9 个文件搬到 `lib/forge/**`，更新 import，测试文件同步改路径。
- `routes/git.ts`，以及 `routes/apps.ts` 里的 4 条 git-credential 路由和 git-head 路由，移到 `forge/git-routes.ts`，
  在 `routes/index.ts` 注册。路径不变。
- 边界测试加上规则：「`gitea` 标识只能出现在 `lib/forge/**` 和白名单里」。
  **这一步先带着已知例外清单启用**，清单是 `supabase-repo.ts`、`supabase-repo/shared.ts`、`app-delete.ts`、
  `app-permission.ts`、`routes/apps.ts`、`index.ts`。后续每一步删掉对应的例外，到 P1.4 结束时清零。
- 验收：全量测试通过，行为不变；`git diff -M` 以 rename 为主。

### P1.2 钩子：建 app / 授权 / 删除 / 心跳 / 响应字段

- 新增 `app-platform/hooks.ts`；`forge/index.ts` 实现 `makeForgeHooks()`，把现有的 gitea client、sync runner、deploy key 包起来。
- B1：`createApp` 里建仓那一段整体移进 `hooks.appCreated`。没配 Gitea 时返回 503 的规则也交给 forge：
  缺配置时 `makeForgeHooks` 返回一个只做一件事的钩子，即非导入 app 一律抛 503。平台不再知道这条规则。
- B4：所有 `giteaSync.*` 和 `revokeAppMemberDeployKeysIfGitea` 的调用点，换成 `hooks.accessChanged`。
  `auth.ts` 里入队时的同步属于 TeamClu 层，改为调用 forge 导出的 `syncTeam`（在白名单内）。
- B6：`app-delete.ts` 里的 Gitea 分支换成 `hooks.appDeleting`。
- B7：`shared.ts` 里 `gitHttpUrl` 的计算移进 `hooks.decorate`，字段名和取值不变。
- B8：心跳里的 `giteaReconcile` 和 deploy key 清扫合并成 `hooks.heartbeat`；`index.ts` 的 `makeGiteaDeps` /
  `makeTeamGiteaSync` 收进 `makeForgeHooks`。
- B9：`inheritedGiteaLevel` 改名为 `inheritedRepoLevel`，移进 forge，平台的权限模型不再引用它。
- 测试：
  - 用假钩子跑一遍 createApp / 授权 / 删除的契约测试，断言调用序列（沿用 P0 `fake.ts` 的写法）；
  - 现有的 Gitea 测试改为测 `makeForgeHooks`。

### P1.3 部署：revision 通用化 + forge 守卫

- B2：删掉三处 `if (git_auth_kind === GITEA_AUTH_KIND)`，换成两步：
  1. 平台做格式检查（`sha256:` 或 40 位 hex）；
  2. `await hooks.deployGuard?.(app, stage, { revision, gitCommitSha })`。
- forge 守卫的规则：
  - Gitea app：做原来的 HEAD / gitCommitSha 比对，错误码和文案原样（`409 revision_mismatch`）；
  - 非 Gitea app：要求 `sha256:`，保住现在「导入 app 必须给内容摘要」的 400。
- `finalizeDeploy` 写不写 `git_commit_sha`，改由守卫的返回值决定。`deployed_revision` 这一列要到 P1.5 才加，
  所以这一步只保留现有的 `git_commit_sha` 写入路径，不新增列。
- B3：`getAppGitHead` 整体移进 forge。git-head 路由已在 P1.1 移走。
- 测试：三个阶段 × 四种情况（Gitea 守卫通过、HEAD 变了、导入 app 给的不是摘要、没注册守卫）的矩阵；客户端 crate 的测试不动。

### P1.4 收尾：边界清零

- 删除边界测试里的例外清单；`supabase-repo.ts` 里 grep `gitea` 结果为 0。
- 更新父 spec：§6 修正 HEAD 复核的去向；§8 标明 P0 已合并，并记录 P1 进度。

### P1.5 数据：forge 关联搬到新表（唯一的迁移，只做加法）

```sql
create table amux.app_forge_repos (
  app_id      uuid primary key references amux.apps(id) on delete cascade,
  kind        text not null,          -- 'gitea' | 'git_https'
  remote_url  text not null,
  created_at  timestamptz not null default now()
);
alter table amux.apps add column deployed_revision text;
-- 回填：git_remote_url 非空的行 → app_forge_repos；git_commit_sha → deployed_revision
```

- RLS：读权限与 `amux.apps` 一致（`actor_has_app_access`）；写只走 service role（forge 层）。
- forge 改为读写新表。`apps.git_remote_url` / `git_auth_kind` **读两处、只写一处**：
  优先读新表，新表没有时再回落到旧列，用来兜住迁移窗口里还在跑旧代码的 FC 实例。
  旧列留到 P3（独立 schema）时一并删除。
- self-host 和 belayo 各跑一次迁移和 pgTAP。回填用幂等的 upsert，可以重跑。
- 对应父 spec §9 第 6 条「一次性回填、不做双写」：这里仍然不双写，只多了一段过渡期的读回落。

## 4. 验证

- 每一步：FC 全量测试 + `tsc`；P1.2 和 P1.3 新增假钩子的契约测试。
- P1.3、P1.5 合并前，在 self-host 换镜像跑 E2E（手法见记忆 `reference_app_platform_selfhost_e2e`）：
  - Gitea app：成员建 app → push → agent 部署 → 改代码但不 push，再部署 → 期望返回 `409 revision_mismatch`；
  - 导入 app、容器 app：跑现有的 35 + 16 项；
  - 删除 app 后，Gitea 仓库被归档改名，deploy key 清空。
- P1.5 另外要求：迁移前后 `/v1/apps` 的响应逐字段 diff 为空。

## 5. 需要拍板

1. **服务端 HEAD 校验是保留在 forge 守卫里（推荐），还是按父 spec §6 删掉、只靠客户端？**
   保留的话，对外行为不变，平台仍然不懂 git。删掉能少一次 Gitea API 调用，但旧客户端就能部署没 push 的代码。
2. **P1.5 搬表放在 P1 里做，还是推到 P2 和 `app_links` 一起做？**
   推荐放在 P1 末尾。forge 字段和 team 关联是两回事，分开迁移，各自都能回滚。
3. **`app-git-credential.ts`（导入 http 仓库的 token）算 forge 还是平台？** 推荐算 forge，因为它回答的也是「代码从哪拉」的问题。
