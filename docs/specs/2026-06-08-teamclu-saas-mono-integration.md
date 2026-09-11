# teamclu × saas-mono 登录与租户整合 —— 统一 Spec & 执行计划

> **状态（2026-07-15）：已过时，保留为历史记录。** 本文的落地目标环境
> （独立 RDS `supabase_db`、其 Supabase 网关、`services/supabase/s4/` 下的
> live 克隆 runbook）已整体下线，S4「切流」一节不再可执行，所引脚本亦已删除。
> 登录/租户模型本身仍在 Cloud API 代码中沿用（见 `services/fc/src/lib/supabase-repo/`）。
> 当前部署分为 self-host Compose 测试环境和 Belayo Dokploy 生产环境，见
> [`docs/deployment/full-backend-stack.md`](../deployment/full-backend-stack.md) 与
> [`docs/specs/2026-09-11-belayo-dokploy-target-architecture.md`](./2026-09-11-belayo-dokploy-target-architecture.md)。

**单一事实来源**。状态：实施中。最后更新 2026-06-08。
**分支**：`agent/saasmono-integration`（worktree `.worktrees/saasmono-integration`）。
**提交**：`934613fa`(S1) · `647597d1`(S2) · `349375ff`(S3)。

---

## 1. 目标

让 teamclu 复用 saas-mono 的 `public.orgs` 做租户真相源、共用一套登录（GoTrue），
两个产品最终跑在 **saas-mono 的阿里云自建 Supabase** 上：saas-mono 占 `public`，
teamclu 全部业务表搬到 `amux` schema 隔离。

## 2. 锁定的决定

| # | 决定 |
|---|---|
| D1 | saas-mono 的自建 Supabase **当家**，teamclu 迁入（单实例/单 GoTrue/单 auth.users） |
| D2 | 租户：**单 org/user**；org=租户边界，team=org 内协作单元 |
| D3 | **保留 teams 表**，加 `oid` 外键 → `public.orgs(id)`（1 org:N team，FK 列非 join 表） |
| D4 | **不重命名 team_id**（客户端继续用 teamId，零大改） |
| D5 | 登录：统一一个 GoTrue，JWT `app_metadata.org_id` 当租户上下文 |
| D6 | **不做数据迁移**（按全新状态设计） |
| D7 | **Better-Auth 保留不退役**，与 GoTrue 并存（account/session/user/verification/jwks 不动） |

## 3. 目标架构

```
saas-mono 自建 Supabase（唯一实例 / 唯一 GoTrue / 唯一 auth.users）
├── public  (saas-mono 拥有)
│   ├── orgs   ← 唯一租户真相源
│   ├── users  ← auth_user_id→auth.users, org_id→orgs（单 org/user）
│   ├── plans
│   └── account/session/user/verification/jwks ← Better-Auth（保留）
└── amux   (teamclu 拥有，35 张业务表)
    ├── teams        ← 加 oid → public.orgs(id)
    ├── actors / team_members / sessions / messages / ...（team_id 不变）
    └── (RAG: ag_catalog/mem0/dataset_* 按需装扩展后迁入)
租户隔离：amux.teams.oid 传递性归属唯一 org + RLS teams_org_guard + is_team_member
登录：GoTrue 签发 token，amux_access_token_hook 注入 app_metadata.org_id + memberships + acl
```

---

## 4. 当前状态总表（← 看这里就不乱）

| 阶段 | 内容 | 状态 | 落点 |
|---|---|---|---|
| **S1** | `public.orgs` + `plans` 桩 + `update_audit_columns()` | ✅ **已上 prod 47.x** | 迁移 `20260608000000` |
| **S3A** | `public.users` 子集镜像 + `app.current_org_id()` + orgs RLS | ✅ **已上 prod 47.x** | 迁移 `20260608020000` |
| **S2** | 35 业务表 public→amux + teams.oid + 重写 64 函数 | ✅ **已应用 47.x**（35 表/64 函数，users 正确留 public） | 迁移 `20260608010000` |
| **S2d** | FC 默认 schema=amux + 41 个 .rpc→`.schema('public')` | 🟢 改好 + typecheck 干净 —— ⬜ **待部署 FC** | FC 5 文件 |
| **S3B** | provisioning 默认 team + hook 注 org_id + teams_org_guard | ✅ **已应用 47.x**（hook 实测返回正常） | 迁移 `20260608030000` |
| **S3-FC.1** | create_team 加 p_oid + FC createTeam 传 token org_id | ✅ DB 已应用 47.x；FC 代码改好 ⬜ **待部署** | 迁移 `20260608040000` + supabase-repo.ts |
| **S3-FC.2** | 匿名 lazy-provision 个人 org（createTeam 路径，无 org 时 ensure_personal_org） | ✅ **已上 prod**（public-only）+ 干跑功能验证 + FC typecheck 干净 | 迁移 `20260608050000` + supabase-repo.ts |
| **S3-FC.3** | claim_team_invite 换 org（严格单 org，best-effort GC 个人 org） | ✅ **已应用 47.x** + 场景干跑验证（C 换 org+个人 org/team GC+入新 team） | 迁移 `20260608060000` |
| **S4** | 在 saas-mono 实例落地 + 切流 | ✅ **live RDS 已完成**（2026-06）；⬜ FC 切 live 待做 | 见 `services/supabase/s4/LIVE-CLONE.md` |

**47.x 此刻实况**（无活跃流量，已直接切 DB 侧）：35 张业务表已在 `amux`，`teams.oid`、`teams_org_guard`、org_id 注入的 `amux_access_token_hook`、`create_team(p_oid)`、`ensure_personal_org`/`ensure_org_default_team` 全部就位；`public` 留 orgs/plans/users 镜像 + 5 张 Better-Auth。
运维收尾：
- ✅ **PostgREST 暴露 amux 已完成**（authenticator.pgrst.db_schemas = `public, storage, graphql_public, amux`，已 reload，curl `Accept-Profile: amux` 返回 200）。
- ⬜ **部署本分支 FC（含 S2d + S3-FC）** → 合并 **PR #409** 自动触发（GHA on `services/fc/**`）。合并后即完成 47.x 切换。

---

## 5. 执行计划（线性，含验证/回滚）

### ✅ 已完成
- **S1 / S3A** 已应用 prod 并验证（表/函数/策略/触发器就位，回滚事务实测插入通过，零残留）。

### ⬜ Step A — FC 代码收尾（S2d 校验 + S3-FC，可现在做，不碰实例）
1. worktree 装依赖 → 跑 `pnpm --filter fc typecheck` + FC 测试，给 S2d 的 41 处 .rpc 改动兜底。
2. 写 S3-FC：org onboarding/首登流程调用 `app.ensure_org_default_team(org_id)`；FC 从 JWT `app_metadata.org_id` 解析租户上下文（替代信客户端传的 team 作租户边界）。
3. 闸门：typecheck + FC 测试全绿。
4. 回滚：纯代码，分支可弃。

### ⬜ Step B — 在自有服务器（MCP 连接的那台）应用 S2+S3B（协同切窗口，⚠️ 不可灰度）
没有单独的 testsupa；47.x 就是我们的环境。**三件事同一窗口一起做**（否则 FC 旧 `.from()` 默认 public 即刻全断）：
1. 我经 MCP 跑迁移 `20260608010000`(S2) + `20260608030000`(S3B) + `20260608040000`(create_team p_oid)。
2. 你改 47.x PostgREST 容器 `PGRST_DB_SCHEMAS` 加 `amux`（保留 public）+ 重启。
3. 你部署带 S2d + S3-FC 的 FC。
4. 闸门：26 个 SQL RLS 测试 + FC 测试 + 登录冒烟（token 带 org_id、hook 没挂）+ 租户隔离冒烟。
5. 回滚：SET SCHEMA 反向 + drop teams.oid/守卫 + FC 默认 schema 改回 + PGRST 还原 + hook 还原。
> 我能做：MCP 跑迁移。我不能做：改 PostgREST 容器 env、部署 FC（需你操作）。所以这步卡在你这两个运维动作上，不在 testsupa。

### ✅ Step D — live RDS（S4 生产，2026-06 已完成）

**路径**：`test RDS` → `live RDS`（均为 RDS `supabase_db`，不是空库 `postgres`）。

**Runbook**：`services/supabase/s4/LIVE-CLONE.md` + `./live-clone.sh`。

与 47.x 旧 layout **不同**（勿用 `transplant-amux.sh` / repo bootstrap）：

| 对象 | 实况 |
|---|---|
| 业务表 | **37** 张，全在 **`amux`** |
| RLS helper + RPC | **`amux.*`**（无 `app` schema） |
| 额外 public 函数 | 仅 **`public.claim_team_invite`**（FC auth） |
| saas-mono `public` 表 | **172 张不变** |
| `storage.*` | 未动 |

PostgREST：`PGRST_DB_SCHEMAS` 含 `amux`（RDS + rest 容器）+ GRANT + smoke `Accept-Profile: amux`。

**待办**：FC `SUPABASE_URL` 指向 live（`https://<partner-supabase-host>`）。

### Legacy Step D — 47.x → 其他 saas-mono 实例

**前置（PG 版本 / 扩展差集）= ✅ 通过**：用户确认 saas-mono 生产实例**与 47.x 完全一致**（同 PG 18.3、同扩展 age 1.6.0/pgvector 0.8.1.2/pg_cron/pg_net、同 Supabase 自建），`amux` 在 saas-mono 不存在（无命名冲突）。仅剩运维确认：GoTrue `JWT_SECRET` 统一、saas-mono PGRST 加 `amux`。

**落地方式（澄清）**：S4 **不是在 saas-mono 上重跑 S2 的"move-all-except-keep-list"**——那会把 saas-mono 自己的 public 表也搬进 amux。正确做法是**把 47.x 的 `amux` schema 整体移植过去**：
1. `pg_dump --schema=amux --schema-only`（不带数据，符合 D6）从 47.x → 导入 saas-mono 的 `amux`（含 35 表 + `amux.actor_directory` 视图 + teams.oid + RLS 策略/触发器）。
2. public 侧只补 teamclu 需要的函数与策略（`app.*`、`current_org_id`、`ensure_personal_org`、`amux_access_token_hook`、`create_team(p_oid)`、`claim_team_invite`、orgs RLS）——**orgs/plans/users 镜像跳过**（saas-mono 已有真表；用其真实 DDL，注意 plans 桩/users 子集要对齐）。
3. saas-mono PGRST 加 `amux`；FC 切 `SUPABASE_URL` + 统一 `JWT_SECRET`；切流。
4. 闸门：登录冒烟 + 建队（teams.oid 盖对）+ 租户隔离 + 邀请认领换 org。

---

## 6. 风险登记

| 风险 | 级别 | 缓解 |
|---|---|---|
| ~~S3B hook 改 live 致登录中断~~ | ✅ 已不适用 | 当前托管 GoTrue **不支持** custom access token hook → hook 不被调用，token 无 org_id/memberships/acl；已核实无 RLS/策略依赖这些声明、唯一消费者 app.jwt_memberships 是死代码 → 全走 fallback（ensure_personal_org / current_org_id→public.users）。FC 冒烟已证建队+租户隔离正常。acl 仅 MQTT（不强制）。日后换托管再启用（grant 已就位） |
| 协同切窗口（S2+PGRST+FC 必须同时） | 🔴 | Step C 窗口；Step B 先预演 |
| PostgREST 暴露 amux（PGRST_DB_SCHEMAS 容器 env，非 config.toml） | 🔴 | Step B/C 清单 |
| ~~saas-mono PG 大版本对齐~~ | ✅ 解除 | 用户确认 saas-mono 生产与 47.x 完全一致（PG 18.3） |
| ~~扩展差集（age/pgvector/pg_cron/pg_net）~~ | ✅ 解除 | 同上，扩展一致 |
| S4 用 amux schema 移植（pg_dump）而非重跑 S2-move | 🟡 | Step D：move-all-except-keep-list 不能用于 saas-mono 的 public |
| 迁移漏视图（actor_directory）→ 已补 `20260608070000` | ✅ 已修 | S2 只搬 BASE TABLE；视图单独搬 + 修引用它的函数 |
| FC S2d 未 typecheck | 🟡 | Step A |
| plans/users 子集镜像 vs saas-mono 全表对齐 | 🟡 | Step D 前对齐 DDL |
| JWT secret 统一 | 🟡 | Step D |

**已消除**：多团队→单 org 收敛、team_id→oid 客户端大改、跨实例数据迁移（因 D3+D6）。

## 7. 关键技术事实（避免重复踩）

- prod 47.x = 生产，自建 Supabase，PG **18.3**；supabase-admin MCP 指向它。
- `apply_migration` 缺 DATABASE_URL 不可用 → 用 `execute_sql` 应用；干跑 = 整段塞 DO 块末尾 `raise exception` 原子回滚。
- 42 张 public 表：搬 amux 35 张；留 public 7 张（orgs/plans + 5 张 Better-Auth）。
- 函数留 public，只重写函数体 `public.<表>→amux.<表>`（64 个）+ search_path 补 amux；因此 41 个 FC `.rpc` 要 `.schema('public')`。
- saas-mono signup 的 orgId 是**必填输入**（org 先存在，不在 signup 建 org）→ provisioning = 挂到已有 org 时建默认 team。
- create_team RPC 签名：`(p_name, p_slug, p_litellm_team_id, p_ai_gateway_endpoint, p_display_name)` → S3-FC 加 `p_oid`。
- claim_team_invite(p_token)：①认领预建匿名 member 槽（target_actor_id，校验 is_anonymous，给该匿名用户发 session）②已登录/匿名用户 `auth.uid()` 直接加入 invite 的 team（插 actor/member/team_members）。

## 8. 匿名登录 & 协作边界（决定：仅本组织内 / 严格单 org）

teamclu 用 GoTrue 匿名用户（`auth.users.is_anonymous`），首启 bootstrap 建个人 team。
整合后：

**匿名 = 一人个人 org（lazy-provision，已实现 S3-FC.2）**
- createTeam 路径：caller 无 org 时调 `public.ensure_personal_org()`（幂等：建个人 org + `public.users(auth_user_id, org_id)`，受 `uq_users_auth_user_id` 唯一约束保单 org/user + 并发兜底）。
- 首个 team = 客户端 bootstrap 显式调的 `POST /v1/teams`，被 S3-FC.1 用该个人 org 盖 `oid`（**不另建默认 team,避免重复**）。`app_metadata.org_id` 由 hook 从 public.users 注入 token。
- `ensure_org_default_team`（S3B）保留给"saas-mono 已有 org → 建默认 teamclu team"那条路径。

**升级（匿名→正式邮箱/手机/Apple）**
- GoTrue 升级保留同一 `auth.users.id` → org_id + 数据**无缝继承**，零迁移。✅ 天然干净。

**协作边界 = 仅本组织内（严格单 org）**
- 用户的所有 actors/teams 都在其唯一 org 内；`teams_org_guard`（oid = current_org_id）**保持不变**。
- **invite-claim = 换 org**：用户认领指向 org Y 的 team 邀请时，其 org 重置为 Y，原匿名个人 org X（及其默认 team）并入/弃用。
- ✅ **已实现（S3-FC.3，迁移 `20260608060000`）**：`claim_team_invite` 的 member 路径在加入 invite team 后把 claimer 的 `public.users.org_id` 改成该 team 的 `oid`（`app_metadata.org_id` 由 hook 从 public.users 注入下次 token），并 best-effort GC 弃用的一人个人 org（删 `amux.teams where oid=旧org` 级联 + 删 org；包 exception，GC 失败不影响认领）。场景干跑验证通过。
