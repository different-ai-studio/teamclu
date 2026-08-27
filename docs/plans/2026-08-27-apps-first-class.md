# Apps 提升为一等公民 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or subagent-driven-development to implement this plan task-by-task.

**Goal:** 把 app 从"侧栏里的一个列表"变成一等对象：第一列常驻可展开、多会话、独立控制面、per-member 权限分级、多机协作同一个 repo、删除时回收资源。

**Spec:** `docs/specs/2026-08-27-apps-first-class-design.md`（下称"设计"）。**每个决定的理由都在那里，本文只讲怎么做。**

**Base:** 本计划建立在 `docs-apps-self-serve-gitea-fc` 之上（commit `94495c8a` 起）。从它起分支，PR 的 base 也设成它，不要设 main。

**Tech Stack:** FC TypeScript (`services/fc`)、Supabase SQL migrations、amuxd Rust (`apps/daemon`)、React/Zustand (`packages/app`)、Gitea REST API。

---

## 只做 supabase backend

**本次变更不动 `pg-repo` / Drizzle / Postgres 后端**（未来会去掉）。业务逻辑只写在：

- `services/fc/src/lib/supabase-repo.ts`
- `services/fc/src/lib/supabase-repo/shared.ts`

**但有一个守卫会拦你**：`services/fc/test/pg-repo-parity.test.ts` 从路由调用点反推出必须存在的 repo 方法，并断言 pg-repo 全都有。它的注释写得很清楚——正确做法**不是**把方法加进 `ROUTE_METHODS_NOT_ON_PG`（"该列表正常应保持为空"），而是：

> 每新增一个路由调用的 repo 方法，在 `services/fc/src/lib/pg-repo/apps.ts` 里放一个显式 `ApiError(501)` stub，并写一句"supabase-only（见 2026-08-27-apps-first-class 计划）"。

一行一个，`pgMethodKeys()` 会把 stub 算作已实现，CI 就是绿的，而且将来删 pg-repo 时这些 stub 跟着一起走。

**测试写在**：`services/fc/test/supabase-repo.test.ts`、`services/fc/test/routes-apps.test.ts`。**不要**再往 `pg-repo-apps.test.ts` 加本次的用例。

---

## SDLC 约束（这个 worktree）

- **不跑 `cargo` / `pnpm rust:*`**——所有 worktree 共用一个 `CARGO_TARGET_DIR`，会卡在 file lock。Daemon 侧：写测试与实现，**Rust 编译/测试留到 preview 做一次**。
- FC / 前端照跑：`pnpm typecheck`、`pnpm lint`、`npx vitest run <file>`、`services/fc` 下 `npx tsx --test <file>`。
- **每完成一个 Task 停一下；仅在用户明确要求时 `git commit`。勿 push、勿开 PR。**

---

## Task 0（前置，先做完再往下）：部署 Gitea 并验证第一层

设计 §8 / §9.4。**这一块没跑通之前不要开始 Task 2**——它会改到 `app_git.rs` / `deploy-key.ts` / `getAppGitCredential`，正是下面几个 Task 要动的文件。

**Files:**
- Modify: `deploy/self-host/docker-compose.yml`（新增 gitea 服务；目前只有 345-347 行三个空的透传变量）
- Modify: `deploy/self-host/.env.example`（`GITEA_*` 已在 200-202，补说明与默认值）
- Modify: `services/fc/s.yaml`（env 三写的另一处，已有 94-96 行）

**Steps:**
1. 起 gitea 服务，建 org（`GITEA_OWNER`）、建 bot 账号与 token（`GITEA_TOKEN`）。
2. **把 SSH 端口暴露到用户笔记本可达的地址**——不是只在 compose 内网。这是 §9.4 那条零验证的假设。
3. 验证第一层端到端：建 app → seed push 成功 → `git-head` 读到 sha → deploy 成功 → 站点可达。
4. **重点验这三处**（它们只有单元测试撑着，从没碰过真 Gitea）：
   - remote 是 `ssh_url` 而不是 `clone_url`
   - deploy key 是 `BEGIN OPENSSH PRIVATE KEY` 而不是 PKCS#8
   - 第一次 build 之后 checkout 停在**分支上**（不是 detached HEAD），第二次 deploy 不被 `ERR_DIRTY` 拒
5. 跑 `services/fc` 下 `npx tsx --test test/deploy-env-parity.test.ts`（env 三写的守卫）。

**这一步发现的任何问题，改在第一层（当前分支），不要绕过。**

---

## Task 1: 权限读写 API（supabase-only）

设计 §5.1。表已存在：`app_member_access(app_id, member_id, permission_level ∈ view|prompt|admin, granted_by_member_id)`，Drizzle 侧 `services/fc/src/db/schema/apps.ts:61` 也有定义（本次不用它）。

**Files:**
- Modify: `services/fc/src/lib/supabase-repo.ts` — `listAppAccess` / `setAppAccess` / `removeAppAccess`
- Modify: `services/fc/src/lib/routes/apps.ts` — `GET|PUT|DELETE /v1/apps/:appId/access`
- Modify: `services/fc/src/lib/pg-repo/apps.ts` — 三个 501 stub
- Modify: `docs/openapi/teamclu-api.v1.yaml`
- Test: `services/fc/test/routes-apps.test.ts`、`services/fc/test/supabase-repo.test.ts`

**Step 1 — Failing test：只有 `admin` 能授权**
非 creator 且无 `admin` 的成员调 `PUT …/access` 返回 404（沿用现有"看不见就 404"的口径，不要 403——那会泄漏 app 存在）。

**Step 2 — 实现**
授权侧的 creator 判定复用刚加的 `isAppCreator(teamId, createdByActorId)`（`supabase-repo.ts`），creator 恒等于 `admin`。

**Step 3 — 客户端接线**
`packages/app/src/lib/backend/types.ts` 加 `AppMemberAccessRow` / `AppsBackend` 方法；`packages/app/src/lib/backend/cloud-api/apps.ts` 接 `GET|PUT|DELETE /v1/apps/:appId/access/:memberId?`。

**Step 4 — 验证**
`npx tsx --test test/routes-apps.test.ts test/supabase-repo.test.ts test/pg-repo-parity.test.ts`

---

## Task 2: 凭证按档位下发

设计 §5.2。**这是最容易做错的一个 Task**：`prompt` 发的是**写** key，不是只读——理由见设计 §5.2 的引用块（只读会让 agent 改完推不上去，工作死在本地）。

**Files:**
- Modify: `services/fc/src/lib/supabase-repo.ts` — `getAppGitCredential`
- Test: `services/fc/test/supabase-repo.test.ts`

**Step 1 — Failing tests**
- `view` → `getAppGitCredential` 返回 null
- `prompt` → 拿到 key，且 `read_only` 为 false
- `admin` → 同上
- 无 access 行且非 creator → null

**Step 2 — 实现**
把现在那道 `if (!(await this.isAppCreator(...))) return null` 换成查 `app_member_access` 的档位；creator 视为 `admin`。保留 `git_auth_kind !== GITEA_AUTH_KIND → null`（导入的 app 没有我们的仓库）。

---

## Task 3: 部署与 finalize 从 creator-only 改为 `admin`

设计 §5.2。这是**推翻前稿 §5.6** 的地方。

**Files:** `services/fc/src/lib/supabase-repo.ts`（`deployApp` / `finalizeDeploy`）、`services/fc/test/supabase-repo.test.ts`

**Step 1 — Failing tests**：`prompt` 成员 `deployApp` → 404；`admin` 成员 → 202。
**Step 2 — 实现**：同 Task 2 的档位查询。
**Step 3**：`docs/openapi/teamclu-api.v1.yaml` 里 deploy / finalize 的描述要改（现在写的是 creator-only）。

---

## Task 4: 撤权即撤 key

设计 §6.3。依赖 Task 5（key 标题带 actorId），**但可以先写测试**。

**Files:** `services/fc/src/lib/provisioning/deploy-key.ts`、`services/fc/src/lib/supabase-repo.ts`、`services/fc/test/provisioning/deploy-key.test.ts`

**Steps:**
1. `deploy-key.ts` 加 `revokeActorDeployKeys(gitea, appId, actorId)`：`listDeployKeys` 过滤该 actor 前缀 → `deleteDeployKey`。best-effort，逐个 try/catch（沿用 `sweepExpiredDeployKeys` 的写法）。
2. `removeAppAccess` / 降级到 `view` 时调用它，**不等 TTL**。
3. 保留现有过期 sweep 作兜底。

---

## Task 5: 归属——key 标题带 actorId

设计 §6.2。服务端已有 `callerActorId`。

**Files:** `services/fc/src/lib/provisioning/deploy-key.ts`（`jitDeployKeyTitle:149`、`issueJitDeployKey`）、`services/fc/test/provisioning/deploy-key.test.ts`

标题格式定为 `jit-<actorId>-<ms>-<nonce>`。

**这里有个静默陷阱。** `expiredJitDeployKeyIds` 现在按 `title.slice(prefix).split("-")[0]` 取时间戳——加了 actorId 之后它会取到 actorId，`Number.parseInt` 返回 `NaN`，函数直接把这把 key 判成"不是我们的"跳过，**过期清扫从此永久失效，而且不报错**。

**现有测试抓不到它**：`expiredJitDeployKeyIds` 的用例喂的是硬编码的旧格式标题，`jitDeployKeyTitle` 的用例只验唯一性——**两者之间没有 round-trip**。所以改格式的同时必须补一条：用 `jitDeployKeyTitle()` 真实生成的标题喂给 `expiredJitDeployKeyIds`，断言过期的那把被选中。

---

## Task 6: 归属——commit 身份写进 repo-local config

设计 §6.1/§6.2。**Daemon 侧，本 worktree 不编译。**

**Files:** `apps/daemon/src/sync/app_git.rs`、`apps/daemon/src/sync/app_seed.rs`、`apps/daemon/src/http/apps.rs`（seed body 加字段）、`packages/app/src/lib/daemon-local-client.ts`（`seedDaemonApp` 传当前用户）

现在 `GIT_USER_NAME`/`GIT_USER_EMAIL`(`app_git.rs:17-18`) 是写死的 `TeamClu`，且用 `-c` **只作用于 seed 那一次 commit**。改成 seed 时 `git config user.name/user.email` 写进**该仓库的 `.git/config`**，值取当前 TeamClu 用户；之后 agent 和用户的每次 commit 自动带上。桌面端在 seed 请求里带上身份。

---

## Task 7: 多机协作——按需 clone

设计 §5.4。

**Files:** `packages/app/src/stores/apps-store.ts`、`packages/app/src/lib/app-session.ts`、`packages/app/src/stores/apps-store.test.ts`

打开一个自己不是创建者的 app 时：拿凭证 → daemon `clone_app_repo`（`apps/daemon/src/http/apps.rs:313` 已有）→ 绑 workdir。本地已有 checkout 就跳过。脏工作区复用现有 `ERR_DIRTY` 闸，不新造。

---

## Task 8: 第一列——Apps 可展开 + 新建

设计 §2.1。**NavRail 的第一个折叠交互**，没有先例可抄（`TeamShareNavSection` 是常展开的固定子行）。

**Files:** `packages/app/src/components/sidebar/NavRail.tsx`、新增子组件、`packages/app/src/components/sidebar/__tests__/`

要点：展开 ≠ 选中（点标题行切第二列，点三角折叠）；展开区**自身限高滚动**（不能让第一列整体变长，底部设备卡片和设置会被顶出视野）；折叠态存 `localStorage`；选中的 app 变化时自动展开并滚到它。

---

## Task 9: 第二列——改成该 app 的 session 列表

设计 §2.2。

**Files:** `packages/app/src/components/sidebar/SidebarSecondColumn.tsx:17`、**删除** `packages/app/src/components/sidebar/AppsListColumn.tsx` 及其测试、`packages/app/src/lib/backend/types.ts`（`listAppSessions` 已有）

删 `AppsListColumn` 时，把它那 8 个操作按设计 §2.3 分流：3 个进第一列行内，5 个进 Task 10 的控制面。**不要**让第二列在"没选中 app"时退回应用列表。

---

## Task 9b: 一个 app 多个 session

设计 §4.1。现网 `app-session.ts:4` 写死 "exactly one session"；`ensureAppSession` 在无 session 时会自动建一个。改完后：**只有创建流程**仍走 `startAppFirstSession`（带 opening message）；其余时候用户从第二列显式选 session 或点「新建会话」。

**Files:**
- Modify: `packages/app/src/lib/app-session.ts` — 更新注释；拆出 `createAppSessionShell(app)`（空会话，无 opening message）；`ensureAppSession` 改为**只**打开已有最近 session，不再隐式创建
- Modify: `packages/app/src/stores/apps-store.ts` — `sessionIdByAppId` 降级为「上次打开的 session」提示，不再当作 1:1 绑定
- 新增: `packages/app/src/components/sidebar/AppSessionsColumn.tsx`（或 Task 9 内联）— 复用 `listAppSessions` + `SessionListColumn` 的行样式；标题行 `+` 调 `createAppSessionShell`
- Modify: `packages/app/src/components/sidebar/AppsListColumn.tsx` 里点击 app 的行为（删列前迁走）— 第一列选中 app → 第二列列 session，**不要**一点就 `ensureAppSession` 跳进 thread
- Test: `packages/app/src/lib/__tests__/app-session-workspace.test.ts`、新列 helper 测试

**要点：** 不做运行态互斥（§4.2 单独 Task 14）；创建 app 后仍自动开第一个 session（`CreateAppDialog` 不变）。

---

## Task 10: 控制面（独立 surface）

设计 §2.4。**不要做成 `RightPanel` 的第 6 个 tab**（现有 5 个 tab 全是会话尺度）。

**Files:** 新增 `packages/app/src/components/apps/AppControlPanel.tsx`、顶栏 icon、与 `RightPanel` 互斥的显示逻辑

判定：**「第一列当前选中的 app」`??`「当前 session 的 `appId`」**。**不要按 workspace 路径判定。**

面板内容：状态与地址、重命名、Reseed、移动目录（Task 12）、登录方式（Task 13）、权限（Task 1 的 UI）、删除（Task 11）。

---

## Task 11: 删除

设计 §7.1–§7.3。

**Files:** `services/fc/src/lib/supabase-repo.ts`（`deleteApp`）、`services/fc/src/lib/routes/apps.ts`（`DELETE /v1/apps/:appId`）、pg-repo 501 stub、`packages/app/src/lib/backend/cloud-api/apps.ts`（`deleteApp`）、`packages/app/`（对话框，替换现在的 `comingSoon` 空壳）、OpenAPI

**真删**：FC 函数 + HTTP 触发器、OSS `code.zip`、GoTrue OAuth client。
**保留**：Postgres schema 与角色、本机目录、**Gitea 仓库**——但要 ① 撤掉该仓库上所有 key ② `PATCH repo { archived: true }` ③ 改名加 `deleted-` 前缀 ④ 仓库地址记进被归档的 workspace 行。
**顺手**：归档那行会变孤儿的 workspace（`apps.workspace_id` 是 `SET NULL`，反向没有清理）。
会话按 DB 现有语义 `SET NULL` 保留历史，不要动。

对话框措辞见设计 §7.3——**不要写"代码已为你保留"**。

---

## Task 12: 移动目录

设计 §3.2/§3.3。**Daemon 侧，本 worktree 不编译。**

**Files:** `apps/daemon/src/sync/app_git.rs` 或新模块、`apps/daemon/src/http/apps.rs`（新端点）、`apps/daemon/src/config/layout.rs:103`（`team_state_dir` 下存覆盖 json）、`resolve_workdir`（先查覆盖再走派生）

真搬整个目录（含 `.git` / `node_modules`）：同盘 `rename`，跨盘 `copy + verify + delete`；**失败保留原目录且不改指针**。UI 上标注**"本机路径" + 设备名**。

---

## Task 13: authMode 入口 + 待重新部署

设计 §7.4。后端整套已就绪，前端零入口。

**Files:** 控制面里的 select、`packages/app/src/stores/apps-store.ts`、`packages/app/src/locales/{en,zh-CN}.json`

**这一条不能静默**：OAuth env 在 `finalizeDeploy` 注入，所以改一个已上线 app 的 authMode，**线上函数仍是旧 env、站点依然全公开**，直到重新部署。改完立刻标「待重新部署」并给「立即重新部署」按钮。

改 locale 时**必须文本编辑**，禁止 parse-and-dump（会引入重复 key）。

---

## Task 14: 部署前的活跃 turn 确认

设计 §4.2。互斥不做，只在部署入口查一次。

**Files:** `packages/app/src/stores/apps-store.ts`、`packages/app/src/lib/app-deploy-confirm.ts`（复用现有确认弹窗的形状）、daemon 暴露 `workspace_has_active_turn`（`apps/daemon/src/runtime/supervisor.rs:1161` 已有，目前只用于推迟 refresh）

**只确认不硬拦。**

---

## Task 15: `features.apps` 注释

设计 §7.5。一句话的事，但别漏：在 `services/fc/src/lib/feature-profiles.ts` 的 `apps` 字段上写明「关闭只是没有入口，既有 app 的会话/workspace/已部署站点照常可用」。

---

## Task 16: 验收（对齐设计 §12）

逐条跑设计 §12 的 7 条。其中 1–3 必须在**真实 Gitea + 两台机器**上做，vitest 覆盖不了。

---

## Execution order

```
Task 0（Gitea 部署 + 验证第一层）   ← 阻塞所有后续
   │
   ├── Task 1 → Task 2 → Task 3        权限（supabase-only）
   │              └── Task 5 → Task 4  归属 key → 撤权撤 key
   ├── Task 6                          commit 身份（daemon）
   ├── Task 7                          按需 clone（依赖 Task 2）
   │
   ├── Task 8 → Task 9 → Task 9b → Task 10   IA（前端，可与后端并行）
   │                       ├── Task 11 删除
   │                       ├── Task 12 移动目录
   │                       └── Task 13 authMode
   ├── Task 14                         部署前确认
   └── Task 15                         flag 注释
                                        └── Task 16 验收
```

---

## Out of scope（**不要实现**，理由见设计 §11）

这些在质询里被逐条否决过，看起来都很自然，**不要重新推导**：

- 第一列所有模块都可展开
- 第二列保留应用列表、选中后再切 session
- app 设置做成 `RightPanel` 的第 6 个 tab
- 按 workspace 路径判定"是否在 app 里"
- 创建 app 时让用户选目录
- session 级别的运行态互斥
- **用 session participant 做授权主体**（含 agent 与外部渠道 actor）
- **`prompt` 发只读 key**（会造出"改完推不上去"的死路）
- 给用户开 Gitea 账号 / per-team org / SSO
- 删除时把 Gitea 仓库或 Postgres schema 一起删
- 删除时导出长期只读 key 给用户
- commit signing（不可抵赖）、部署历史与回滚、自定义域名、环境变量面板
