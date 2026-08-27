# App 数据浏览器 — 在控制面里看线上数据

- **Date**: 2026-08-27
- **Status**: Draft，待评审。决策逐条落定见 §8。
- **Branch**: `docs-apps-self-serve-gitea-fc`
- **Path**: `docs/specs/2026-08-27-app-data-browser-design.md`
- **Scope**: 数据 app 的控制面里，按表浏览、翻页、单行编辑/删除其**线上** Postgres 数据。
- **Builds on**: `docs/specs/2026-08-27-apps-first-class-design.md`（控制面、权限档位）
- **Non-goals**: 自由 SQL、join / 聚合、批量修改、DDL、导入导出、本地开发用的数据库

> 沿用同系列的规矩：**所有对现网行为的陈述都带 `file:line`**，实现时以代码为准。

---

## 1. 现状（已核对代码）

数据 app 的 Postgres 在 `finalizeDeploy` 时由 `provisionAppPostgres` 建出来
（`services/fc/src/lib/provisioning/app-postgres.ts:136`），三个对象：

| 对象 | 命名 | 来源 |
|---|---|---|
| 库 | `tc_org_<orgIdHex>` | `pg-name.ts:38` |
| schema | `app_<slug>_<idHex>` | `pg-name.ts:26` |
| 角色 | `app_<idHex>` | `pg-name.ts:19` |

角色被授予的是**它自己 schema 内的一切**，并且 `search_path` 钉死在该 schema 上
（`app-postgres.ts:41-46`）。也就是说「只能看自己的数据」这条**在 Postgres 层已经成立**，
不需要在应用层再实现一遍。

两件必须知道的事：

1. **表不是 finalize 建的。** provisioner 只建库、schema、角色；表由应用**首次被请求**时
   自己建（`templates/tanstack-postgres/src/db.ts` 里内联的 `create table if not exists`，
   注释明写 "The provisioner does NOT run app migrations"）。所以「刚部署完、还没人访问过」
   的 app 有 schema、没有表。这是正常状态，不是故障。
2. **角色的密码每次部署都会重置**（`app-postgres.ts:29-31`），且只写进 FC 函数的 env，
   云端不保存。所以控制面**没有**这个角色的密码可用 —— 这直接决定了 §3 的连接方式。

---

## 2. 入口与门槛

**判据：`needsDatabase(app.type) && app.fcEndpoint != null`**

- `needsDatabase` 排除 `static_web` / `slides`，它们本来没有库（`app-deploy.ts:215`）。
- `fcEndpoint` 只在 finalize 成功时写入、部署失败也不清除，所以**非空 ⇔ 至少上线过一次**
  ⇔ schema 和角色已经存在。不需要为了判断"有没有库"额外连一次数据库。

不满足时，控制面里这一块**不显示为可点击的空壳**，而是直接说明原因：静态类型的 app 说
"这个类型没有数据库"，未部署的说"首次部署后可用"。

**schema 存在但一张表都没有**，是上面说的正常中间态。列表处直接写
「还没有表 —— 应用首次被访问时创建」，不要让它长得像错误。

---

## 3. 怎么连（不引入任何新凭证）

控制面没有 app 角色的密码（§1.2），所以走 FC 手上的 `APPS_DB_ADMIN_URL`，
连上目标 org 库之后在事务里 **`SET LOCAL ROLE app_<idHex>`** 降权执行
（为什么必须是 `SET LOCAL` 见本节末尾）。

**为什么这样是安全的，以及为什么早先的设计里那个网关角色现在不需要了：**

自由 SQL 方案里，用户输入会被当语句执行，他可以塞一句 `RESET ROLE` 把降权撤销 ——
admin 是超级用户，降权是可逆的。所以那版设计必须引入一个非超级用户的网关角色
（`tc_query_gw`，被 `GRANT` 各 app 角色、自身对任何 schema 无权限），让 `RESET ROLE`
落回一个什么都看不见的地方。

**本设计不接受任何用户 SQL**：每一条语句都由服务端拼装，标识符（schema / 表 / 列）
只能来自 `information_schema` 的查询结果并再次校验，值一律走绑定参数。注入面因此不存在，
`SET ROLE` 从"防注入"降级为**纵深防御** —— 万一从 `appId` 解析 schema 的代码写错了，
Postgres 那层还能兜住，不至于串到别的 app 的数据。

每个查询固定包在一个事务里，用 **`SET LOCAL`**：

```sql
BEGIN READ ONLY;                          -- 编辑操作用 BEGIN（可写），见 §5
  SET LOCAL ROLE app_<idHex>;
  SET LOCAL statement_timeout = '5s';
  <唯一的那条语句>
COMMIT;
```

**`SET LOCAL` 不是风格问题。** FC 到 Postgres 是**模块级缓存的连接池**
（`app-postgres.ts:169` 的 `_adminSql`）。在池化连接上执行普通的 `SET ROLE`，
角色会**留在那条连接上泄漏给下一个借用者** —— 下一个请求可能属于另一个 app，
甚至另一个团队。`SET LOCAL` 随事务结束自动回退，所以必须先 `BEGIN` 再 `SET LOCAL`，
顺序不能反。

连接的目标库是 `tc_org_<orgIdHex>`。org 从哪来见 §3.1 —— **不是现查的**。

### 3.1 `apps.org_id`：数据落在哪个库，是要存下来的事实

新增一列 `apps.org_id uuid`（可空）。

`apps` 表原本没有 org 列，finalize 用 `resolveTeamOrgId(team_id)` 现查
（`supabase-repo.ts:3281`）。但那个函数回答的是**「这个 team 现在属于哪个 org」**，
而我们需要的是**「这个 app 的 schema 当初建在哪个库里」** —— 两者会分叉：

- `reject_team_reassignment` 守的是行在 team 之间搬迁
  （`baseline.sql:1802` 一带），**没有任何约束守 `teams.oid` 本身**，FC 里也没有
  改它的代码路径 —— 也就是没人拦。
- `teams.oid` 还是可空的（`db/schema/teams.ts:32` 注明首个团队创建时留空），
  意味着它本来就是个后填的字段。

一旦 `oid` 被改过（哪怕只是运维手工订正一次），后果是**故障伪装成正常态**：
数据浏览器去 `tc_org_<新>` 找，schema 在 `tc_org_<旧>` 里，而
`ensureOrgDatabaseExists` 会按需把新库建出来，于是查到"没有表" ——
和 §2 里"刚部署、还没被访问过"完全无法区分。

**重新部署更严重**：finalize 若每次重新推导，`oid` 改过之后的那次部署会在新库里
建一套全新的空 schema，应用带着空数据库上线，用户看到的是数据没了。

所以这一列不只是缓存，它**反过来决定行为**：

| 时机 | 行为 |
|---|---|
| 首次 finalize | `resolveTeamOrgId` 推导 → 建库/schema/角色 → **把结果写进 `apps.org_id`** |
| 之后每次 finalize | **优先用存下来的 `org_id`**，不再推导。数据在哪就往哪部署 |
| 数据浏览器 | 读 `apps.org_id`；为 null 才回退推导（本列之前部署的老行），且回退要留一行日志 —— 那是唯一的歧义情况 |

**不加外键。** 它记录的是"数据去了哪"，性质接近一条日志而不是活的租户指针；
`on delete set null` 反而会在删 org 时悄悄抹掉指向数据的唯一线索。

**日志红线**：SQL 文本和返回的行**都不写日志**。那是用户的业务数据。

---

## 4. 读：表清单与翻页

### 4.1 表清单

从 `information_schema.tables` 取该 schema 下的 `BASE TABLE`，附带每张表的：
列名与类型（`information_schema.columns`）、主键列（`table_constraints` +
`key_column_usage`）。主键是否存在决定这张表能不能编辑（§5.3）。

### 4.2 行

- **翻页用 keyset，不用 `OFFSET`。** 按主键排序、`WHERE pk > :last` 往后翻。
  大表上 `OFFSET 10000` 会让 Postgres 扫掉前一万行；而这是别人的生产库。
  没有主键的表退化成 `OFFSET`（只读，翻不深也无所谓）。
- **单页上限 100 行，硬编码**，不给"每页 1000"的选项。
- **不给总行数。** `count(*)` 在大表上是全表扫描，5 秒超时会先到。UI 显示
  "还有更多"而不是"共 N 条"。要精确计数的人需要的是 SQL，不是这个功能。
- 列排序、单列过滤（等于 / 包含 / 为空）可以有，都在服务端拼，值走参数。

### 4.3 值的呈现

`json` / `jsonb` 折叠展示；`bytea` 只显示字节数不显示内容；`timestamptz` 按浏览器时区
渲染并在 tooltip 里给 UTC 原值。超长文本截断并可展开 —— 截断在**前端**做，服务端
返回完整值，否则复制出来的是残缺数据。

---

## 5. 写：只能单行

### 5.1 允许的操作

- 编辑**一行**的若干列
- 删除**一行**

### 5.2 不允许的

- **批量**（多选删除、按条件更新）。表格 UI 让批量误操作太容易，而这是生产数据。
- **任何 DDL**。改表结构必须走代码和部署 —— 否则线上的表和 `db.ts` 里那份内联 DDL
  会分叉，而那份 DDL 是应用下次冷启动时用来建表的。
- 建表、建库、改角色。

### 5.3 没有主键的表：只读

没有主键就没有安全的"这一行"—— `update … where title = 'x'` 可能命中多行。
这类表照常浏览，编辑与删除按钮置灰，并说明原因（"这张表没有主键，无法定位单行"）。

模板建的 `items` 有 `id uuid primary key`，但用户自己加的表未必有。

### 5.4 执行形态

编辑走显式的"进入编辑态"，提交时带一次确认，语句形如：

```sql
UPDATE <schema>.<table> SET <col> = $1, … WHERE <pk> = $n
```

`WHERE` 只按主键，**永远不按用户看到的其他列**。事务不加 `READ ONLY`，
但 `statement_timeout` 照旧。执行后回读该行并刷新，让用户看到真实结果而不是乐观更新
—— 触发器和默认值会改写他写进去的东西。

---

## 6. 权限

| 档位 | 能做 |
|---|---|
| `view` | 看不到这个功能 |
| `prompt` | 浏览表和行（只读） |
| `admin` | 加上单行编辑与删除 |

`prompt` 能读是刻意的：§5.2 给它的定义是"能让 agent 干活"，而一个能改代码却看不见数据的人
（或 agent）没法调试 —— 他会用最糟的方式去看，在生产代码里加一句 `console.log(await sql...)`
然后部署上去。给只读反而更安全。

---

## 7. 接口

只做 supabase backend；pg-repo 按既定做法给 `ApiError(501)` stub。

| 方法 | 路径 | 档位 |
|---|---|---|
| GET | `/v1/apps/:appId/data/tables` | `prompt` |
| GET | `/v1/apps/:appId/data/tables/:table/rows` | `prompt` |
| PATCH | `/v1/apps/:appId/data/tables/:table/rows/:pk` | `admin` |
| DELETE | `/v1/apps/:appId/data/tables/:table/rows/:pk` | `admin` |

`:table` 在服务端**必须**先在该 schema 的 `information_schema.tables` 里查得到才继续，
不能直接拼进语句。

---

## 8. 决策与被否决的方案

| 决策 | 选择 | 理由 |
|---|---|---|
| 自由 SQL vs 表格 | **表格** | 用户决定。副作用是注入面消失，网关角色不再需要（§3） |
| 库不存在时 | **不让看** | 用户决定。判据 `fcEndpoint != null`（§2） |
| 谁能读 | **`prompt`** | 看不见数据就没法调试，替代方案更危险（§6） |
| 能不能写 | **能，仅单行** | 改错一行是第二高频用途；批量误操作风险太高（§5） |
| 无主键的表 | **只读** | 无法安全定位单行（§5.3） |
| 连接方式 | **admin + `SET LOCAL ROLE`** | 角色密码每次部署重置且云端不存（§1.2）；`SET LOCAL` 是因为连接是池化的（§3） |
| org 从哪来 | **新增 `apps.org_id`，finalize 时写入** | 现查回答的是"team 现在属于哪个 org"，不是"数据建在哪个库"（§3.1） |
| 重新部署时的 org | **用存下来的，不重新推导** | 重新推导会在新库建空 schema，应用带着空数据库上线（§3.1） |
| `apps.org_id` 外键 | **不加** | 它是历史事实不是活指针；`set null` 会抹掉指向数据的唯一线索 |
| ~~网关角色 `tc_query_gw`~~ | 不做 | 只在有用户 SQL 时才必要 |
| ~~总行数~~ | 不给 | 大表上 `count(*)` 全表扫描 |
| ~~OFFSET 翻页~~ | 用 keyset | 深翻会扫掉前面所有行，这是生产库 |
| ~~本地数据库替代~~ | 不做 | 用户决定：要看的就是线上 |

---

## 9. 验收标准

1. 静态类型的 app、以及从未部署过的数据 app：控制面里这一块给出**原因**，不是空列表。
2. 刚部署、从未被访问过的 app：显示"还没有表"，不是报错。
3. 被访问过之后：能看到 `items`，翻页正常，第 101 行需要翻页才出现。
4. `prompt` 成员能浏览，编辑与删除按钮不可用；`admin` 两者都能。
5. 编辑一行后回读，看到的是数据库里的真实值（含触发器/默认值的改写）。
6. 一张没有主键的表：能浏览，编辑被禁用并说明原因。
7. **跨 app 不可达**：手工把请求里的 `appId` 换成同团队另一个 app 的，返回的是那个 app 的
   表；换成别的团队的，404。任何情况下都不会在一个 app 的响应里出现另一个 app 的数据。
8. 服务端日志里搜不到查询返回的任何字段值。
9. **改 org 不会让数据失踪**：把某个已部署 app 所属 team 的 `teams.oid` 改成另一个 org，
   数据浏览器仍然看得到原来的表（因为读的是 `apps.org_id`），再次部署也仍然落在原库 ——
   而不是建出一套空 schema。
