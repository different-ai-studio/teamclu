# App 数据浏览器 Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans or subagent-driven-development to implement this plan task-by-task.

**Goal:** 数据 app 的控制面里按表浏览线上 Postgres 数据，`admin` 可单行编辑/删除。

**Spec:** `docs/specs/2026-08-27-app-data-browser-design.md`（下称"设计"）。**理由都在那里，本文只讲怎么做。**

**Base:** `docs-apps-self-serve-gitea-fc`。从它起分支，PR base 也设成它。

---

## 三条不能违反的红线

写在最前面，因为它们各自对应一种能上生产事故的写法：

1. **`SET LOCAL ROLE`，不是 `SET ROLE`，而且必须在 `BEGIN` 之后。**
   FC 到 Postgres 是模块级缓存的连接池（`app-postgres.ts:169`）。普通 `SET ROLE`
   会留在连接上泄漏给下一个借用者 —— 下一个请求可能是另一个 app、另一个团队。
2. **任何标识符都不许来自请求体直接拼接。** 表名列名只能来自本 schema 的
   `information_schema` 查询结果，用完再校验一次；值一律绑定参数。
3. **SQL 文本和返回的行都不进日志。** 那是用户的业务数据。错误日志只记
   SQLSTATE 和表名，不记 SQL、不记参数、不记行。

---

## 只做 supabase backend

业务逻辑只写 `services/fc/src/lib/supabase-repo.ts`。每新增一个路由调用的 repo 方法，
在 `services/fc/src/lib/pg-repo/apps.ts` 放一行 `ApiError(501)` stub，否则
`pg-repo-parity.test.ts` 会红（它按路由调用点反推）。测试写在
`services/fc/test/supabase-repo.test.ts` 与 `routes-apps.test.ts`。

## SDLC

不跑 `cargo` / `pnpm rust:*`（本任务也不需要）。`pnpm typecheck`、`pnpm lint`、
`npx vitest run <file>`、`services/fc` 下 `npx tsx --test <file>` 照跑。
每个 Task 停一下；仅在用户明确要求时 commit；勿 push、勿开 PR。

---

## Task 0（阻塞项，先做完）：`apps.org_id`

设计 §3.1。**这一条要先落，否则后面所有查询都可能指向错误的库。**

**Files:**
- 新增 `services/supabase/migrations/20260827020000_apps_org_id.sql`
- Modify: `services/fc/src/lib/supabase-repo/shared.ts`（`APP_COLUMNS` + `mapApp`）
- Modify: `services/fc/src/lib/supabase-repo.ts`（`finalizeDeploy`）
- Test: `services/fc/test/supabase-repo.test.ts`

**Step 1 — 迁移**

```sql
alter table amux.apps add column if not exists org_id uuid;
comment on column amux.apps.org_id is
  '数据 app 的 schema 实际建在哪个 org 库（tc_org_<hex>）。finalize 首次成功时写入，之后不再推导。不是活的租户指针，故意不加外键。';
```

**不加外键**（设计 §8）。**不回填**：老行留 null，读路径按 null 回退推导。

**Step 2 — Failing tests**
- 首次 finalize 成功后，行上的 `org_id` == 当时 `resolveTeamOrgId` 的返回值
- **第二次 finalize：即使 `teams.oid` 已被改成别的 org，provision 收到的仍是存下来的那个**
  （这条是本任务的全部意义所在，务必显式断言 provision 的入参）
- 静态类型 app 的 `org_id` 保持 null

**Step 3 — 实现**

`finalizeDeploy` 里现在是 `orgId: await this.resolveTeamOrgId(existing.team_id)`
（`supabase-repo.ts:3281`）。改成：

```
const orgId = existing.org_id ?? await this.resolveTeamOrgId(existing.team_id)
```

并在成功那次 update 里连同 `deployed_auth_mode` 一起写回 `org_id: orgId`。
`APP_COLUMNS` 要带上 `org_id`，否则 `existing` 里读不到它。

**mapApp 是否要暴露给客户端**：不要。它是服务端的部署账本，客户端没有用途，
暴露只会多一个要维护的契约字段。

---

## Task 1: 取行的 org 库连接

**Files:** 新增 `services/fc/src/lib/provisioning/app-data-db.ts`；测试
`services/fc/test/provisioning/app-data-db.test.ts`

现有的 `getAppsAdminExecutor` 返回 `Promise<void>`，取不了行，且指向
`APPS_DB_ADMIN_URL` 命名的维护库而不是 org 库。新写一个：

```ts
runAppQuery(orgId, appId, { readOnly }, fn): Promise<T>
```

内部：`withDatabaseName(adminUrl, orgDatabaseName(orgId))` 取得 org 库连接（复用
`app-postgres.ts` 已有的两个 helper），然后

```
BEGIN [READ ONLY]
SET LOCAL ROLE <appRoleName(appId)>
SET LOCAL statement_timeout = '5s'
<fn 里的唯一一条语句>
COMMIT
```

**Step 1 — Failing tests**（用 pglite，仓库里已有先例）
- 事务结束后连接上的 `current_user` 回到原样（证明 `SET LOCAL` 没泄漏）
- `readOnly: true` 时 `INSERT` 抛错
- 超时能触发（`SET LOCAL statement_timeout='1ms'` + `pg_sleep`）

**Step 2 — 实现。** 池复用 `app-postgres.ts` 的做法，但**按库缓存**：不同 org 是不同库，
一个池不能混用。

---

## Task 2: 表与列的内省

**Files:** `app-data-db.ts`（新增函数）、同一个测试文件

`listTables(orgId, appId)` 返回每张 `BASE TABLE` 的：表名、列（名 + `data_type` +
`is_nullable`）、主键列名数组。三个 `information_schema` 查询，schema 名走绑定参数。

**主键为空数组的表在返回值里要显式标出**（`editable: false`），前端据此置灰编辑
（设计 §5.3）。

---

## Task 3: 读行 —— keyset 翻页

**Files:** `app-data-db.ts`、测试

`readRows(orgId, appId, { table, after?, sort?, filter?, limit })`。

- **keyset，不是 OFFSET**：`WHERE (pk) > (:after) ORDER BY pk LIMIT n`。
  设计 §4.2 讲了为什么 —— 这是别人的生产库，深翻 OFFSET 会扫掉前面所有行。
- 无主键的表退化成 OFFSET（只读，翻不深无所谓）。
- `limit` 服务端硬顶 **100**，请求里给再大也截断。
- **不实现总行数**。
- 表名/列名先在 Task 2 的结果里查得到才允许进入语句。

**Step 1 — Failing tests**：101 行的表第一页给 100 行且带 `nextCursor`；
第二页拿到第 101 行；`limit=1000` 仍然只回 100。

---

## Task 4: 改与删 —— 只按主键、只单行

**Files:** `app-data-db.ts`、测试

`updateRow` / `deleteRow`，`WHERE` **只**用主键列，事务不加 `READ ONLY`。

**Step 1 — Failing tests**
- 更新后**回读该行返回**（设计 §5.4：触发器和默认值会改写用户写的值，不回读就是在骗他）
- 更新影响行数 ≠ 1 时抛错并回滚
- 无主键的表调用直接抛错，不构造语句
- 请求里塞一个不存在的列名 → 拒绝，不进语句

---

## Task 5: repo 方法 + 路由 + 501 stub + OpenAPI

**Files:** `supabase-repo.ts`、`routes/apps.ts`、`pg-repo/apps.ts`、
`docs/openapi/teamclu-api.v1.yaml`、`test/routes-apps.test.ts`

| 方法 | 路径 | 档位 |
|---|---|---|
| GET | `/v1/apps/:appId/data/tables` | `prompt` |
| GET | `/v1/apps/:appId/data/tables/:table/rows` | `prompt` |
| PATCH | `/v1/apps/:appId/data/tables/:table/rows/:pk` | `admin` |
| DELETE | `/v1/apps/:appId/data/tables/:table/rows/:pk` | `admin` |

档位判定复用 `resolveAppCallerPermissionForApp`。**orgId 读 `apps.org_id`**
（Task 0 落的列）；为 null 才回退 `resolveTeamOrgId`，并留一行日志 ——
那是本列之前部署的老行，也是唯一会指错库的情况（设计 §3.1）。

入口门槛（设计 §2）：`needsDatabase(type) && fcEndpoint != null`，不满足返回一个
**能区分原因**的 409（静态类型 / 尚未部署），不要用 404 混过去 —— 前端要据此显示不同文案。

**Step 1 — Failing route tests**：`view` 档 404；`prompt` 能读、PATCH 得 404；
`admin` 两者都行；静态 app 得到 409 且 code 可区分。

---

## Task 6: 客户端接线

**Files:** `packages/app/src/lib/backend/types.ts`、
`packages/app/src/lib/backend/cloud-api/apps.ts`

`AppDataTable` / `AppDataRows` 类型 + 四个 `AppsBackend` 方法。

---

## Task 7: 控制面 UI

**Files:** `packages/app/src/components/apps/AppControlPanel.tsx` 或新增子组件、
`packages/app/src/locales/{en,zh-CN}.json`、测试

- 左侧表清单，右侧行表格，底部"加载更多"（不是页码 —— 没有总数）
- `prompt` 只读；`admin` 每行有编辑/删除，各带一次确认
- 无主键的表：编辑禁用并说明原因
- 值渲染按设计 §4.3：json 折叠、bytea 只显示字节数、timestamptz 本地时区 + tooltip 原值、
  超长文本**前端**截断（服务端返回完整值，否则复制出来是残缺数据）

**三种空态各有各的文案**，别共用一个"暂无数据"：
1. 静态类型 → 这个类型没有数据库
2. 未部署 → 首次部署后可用
3. 已部署但无表 → 还没有表，应用首次被访问时创建（设计 §2，这是正常状态不是故障）

改 locale **必须文本编辑**，禁止 parse-and-dump（会引入重复 key）。新 key 要同时
落到两个 locale 文件，否则 `i18n-parity` 会红。

---

## Task 8: 验收（对齐设计 §9）

逐条跑设计 §9 的 8 条。其中两条 vitest 覆盖不了，必须到真实环境做：

- **第 7 条 跨 app 不可达**：手工改请求里的 `appId` 指向同团队另一个 app，只能拿到那个
  app 的表；指向别团队的，404。
- **第 8 条 日志无数据**：查一次之后在服务端日志里搜返回值里的字符串，搜不到。
- **第 9 条 改 org 不失踪**：手工把某个已部署 app 所属 team 的 `teams.oid` 改成另一个
  org，浏览器仍看得到原表，再次部署仍落在原库。

---

## Execution order

```
Task 0（apps.org_id）             ← 阻塞：不先落，后面都可能查错库
   └── Task 1（连接 + SET LOCAL ROLE）
          ├── Task 2 → Task 3 → Task 4    内省 / 读 / 写
          └── Task 5（repo + 路由）
                 └── Task 6 → Task 7      客户端 → UI
                                 └── Task 8 验收
```

---

## Out of scope（**不要实现**，理由见设计 §8）

- 自由 SQL、join、聚合、`count(*)` 总行数
- `tc_query_gw` 网关角色（只在有用户 SQL 时才需要）
- 批量修改/删除、任何 DDL、建表建库
- 无主键表的编辑
- OFFSET 深翻页
- 用本地数据库替代线上数据
- 导入 / 导出 / CSV
