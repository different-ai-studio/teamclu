# 资料库按角色可见

- **Date**: 2026-10-14
- **Status**: APPROVED — 2026-10-14
- **Scope**: `documents/<单层文件夹>/` 的角色可见性。管理 API、同步判据、桌面端「谁可以看」。沿用现有 Path ACL 的过滤、审计、停止同步和本地清理。
- **Non-scope**: Wiki 编译策略、知识库授权、端到端加密、按 agent 单独授权、任意深层目录、把角色展开成一份成员快照
- **Related**: `docs/specs/2026-08-31-knowledge-path-acl-design.md`、`docs/specs/2026-09-01-team-sync-two-roots-design.md`、`docs/specs/2026-09-15-org-roles-permissions-design.md`、`docs/specs/2026-09-20-llm-wiki-maintainer-p0-design.md`

---

## 0. 一句话

财务、人事各自是资料库里的一个顶层文件夹。文件夹可以绑一组组织角色，团队成员只要拥有其中任一角色就能同步它。拥有者始终能看。管理员能改规则，但不能因为是管理员就看到内容。

---

## 1. 目标

| # | 要求 | 落点 |
|---|------|------|
| 1 | 财务资料只有财务和老板能看，人事资料只有人事和老板能看 | 顶层文件夹 + 角色并集（§3 D1–D3） |
| 2 | 人换岗后权限跟着角色走，不用再逐个勾人 | 同步时读 `roles_users`，不把角色展开成成员快照（§5） |
| 3 | 没被授权的人看不到文件夹里的文件，也看不到这个限制的存在 | 现有 manifest 过滤和 `PathForbidden`（§5.4） |
| 4 | 收紧已经有文件的文件夹时，管理员先看到会影响谁 | 预览 + `confirmRevokeExisting`（§6） |
| 5 | 拿掉角色之后停止继续下发，并尽力删掉本机副本 | 现有 `apply_revocations`（§5.3） |

验收用这两个文件夹就够：

| 文件夹 | 谁能同步 |
|--------|----------|
| `documents/财务/` | 角色 `finance`、角色 `owner` |
| `documents/人事/` | 自建角色（例如 `hr`）、角色 `owner` |

人事不是系统角色。管理员在组织里建好角色，再把它勾到文件夹上。本设计不新增种子角色。

---

## 2. 今天长什么样

| 事实 | 证据 | 和本设计的关系 |
|------|------|----------------|
| 资料库是 `documents/`，知识库是 `knowledge/` | `docs/specs/2026-09-01-team-sync-two-roots-design.md` | 只给资料库的顶层文件夹加角色规则 |
| 目录权限已经按前缀过滤 manifest、下载、上传、删除、历史 | `services/fc/src/lib/sync-acl.ts` 的 `aclViewFor` | 判据仍只从这里出，五个同步挂载点不改 |
| 授权对象是成员 actor | `amuxc_path_acl_grants.actor_id` | 新规则改记角色。旧的按人规则留着，直到管理员把它改成角色 |
| 组织角色已经存在：`owner`、`admin`、`member`、`finance`，以及自建角色 | `public.roles` / `public.roles_users`，`GET /v1/teams/{teamId}/roles` | 直接引用，不另做一套「资料库角色」 |
| 角色挂在组织上，一份人可以同时有多个角色 | `docs/specs/2026-09-15-org-roles-permissions-design.md` | 先是这个团队的成员，再看他在 `teams.oid` 下的有效角色 |
| 内容在服务端是明文。撤权是停止分发，加上本机尽力删除 | Path ACL 设计 §0、`apply_revocations` | 原样沿用。界面写「停止同步」 |

一台电脑上的 agent 和这台电脑的主人看到同一棵树。控制主人的角色，就控制了他的 agent。本设计不给 agent 单独授权。

---

## 3. 决策

### D1 — 一个资料库文件夹是 `documents/` 下的一层目录

`documents/财务/`、`documents/人事/` 这种。前缀必须匹配 `^documents/[^/]+/$`，并且以 `/` 结尾。

下面这些都不是本设计里的文件夹规则：

- `documents/` 本身
- `documents/财务/工资/`
- `knowledge/` 下的任何路径
- 直接放在 `documents/` 根上的文件

根上的散落文件继续对整个团队可见。敏感文件放进文件夹里再设规则。建出文件夹不会自动变敏感，限制是管理员单独做的一步。

### D2 — 授权对象是组织角色，命中任一角色即可

一条规则记下若干 `role_id`。成员的有效角色里只要有一个在名单上，整个文件夹及其子目录都对他可见。

有效角色：`roles_users.status = active`，`roles.status = active`，`roles.org_id` 等于该团队的 `teams.oid`，`store_id` 为空。停用的角色不放行。

角色必须属于这个组织。写进别的组织的 `role_id` 返回 400。

### D3 — 拥有者固定可见，管理员不固定可见

老板就是系统角色 `owner`（拥有者）。每条文件夹规则都包含本组织的 `owner` 角色，服务端在写入时补上，响应里也总是带上。客户端去掉它，服务端仍写回。

判据另有一道：调用者拥有有效的 `owner` 时，所有角色规则都放行，即使授权行丢了。

`admin` 可以创建、修改、删除规则，这和现在的 `canManageTeam` 相同。同步判据不因为 `admin` 放行。管理员要看财务文件夹，必须另外拥有 `finance` 或 `owner`。

`member` 不出现在角色勾选里。整个团队都能看，等于不设规则。

### D4 — 一个文件夹只有一组观众

同一条 `documents/` 规则之间不允许父子重叠。`documents/财务/` 和 `documents/财务/工资/` 算重叠。`documents/财务/` 和 `documents/财务公开/` 不算，因为匹配按路径分段，前缀以 `/` 结尾。

新建或修改规则时，只要和本团队另一条 `documents/` 规则重叠，就返回 409，不写入。先删掉嵌套的那条，再设文件夹规则。已有的重叠数据不自动删除。

知识库上的旧规则不参与这个重叠检查。

### D5 — 不把角色展开成人

勾选「财务」写的是角色 id。之后被赋成财务的人，下一次同步就能看到；被拿掉财务的人，服务端随即停止下发，本机副本在下一次完整对账时删除（§5.2、§5.3）。不在授权当时把当时的成员抄进 `amuxc_path_acl_grants`。

### D6 — 安全承诺与 Path ACL 相同

服务端明文、不防运维、不防持有对象存储权限的人。停止同步之后，已经拷走的文件收不回来。对外和界面都写「停止同步」，不写「撤回」「收回」「吊销访问」。

没被授权的人的 manifest 里没有这些路径。下载、上传、删除、历史版本仍返回 `PathForbidden`，响应里不带目录名清单。

---

## 4. 数据

新表，和按人授权分开：

```sql
create table amux.amuxc_path_acl_role_grants (
  acl_id      uuid not null references amux.amuxc_path_acl(id) on delete cascade,
  role_id     uuid not null references public.roles(id) on delete restrict,
  granted_by  uuid not null references amux.actors(id) on delete restrict,
  granted_at  timestamptz not null default now(),
  primary key (acl_id, role_id)
);
```

`amuxc_path_acl` 仍是规则本身（`team_id`、`path_prefix`）。一条规则要么有角色授权，要么有成员授权，不能两者都有。写成角色规则时，删掉该 `acl_id` 上的 `amuxc_path_acl_grants` 行。

删除自定义角色时，若仍被文件夹引用，`ON DELETE RESTRICT` 让删除失败。组织角色的 `DELETE` 在这种情况下返回 409。管理员先从文件夹上拿掉该角色。`owner` 本来就不能删。

迁移落在 `services/supabase/migrations/`。postgres 后端的 drizzle 迁移同步一份表结构。线上判据仍在 `services/fc/src/lib/sync-acl.ts`，同步 handler 不各写一遍。

---

## 5. 谁能看

### 5.1 判据

`loadView` 对调用者的每个规则：

1. 这条规则有角色授权：调用者拥有有效 `owner`，或拥有其中任一有效角色 → 放行。否则该前缀进入 `denied`。
2. 这条规则只有成员授权：行为与现在相同，有 `amuxc_path_acl_grants` 行才放行。
3. 角色查询失败：整次 `aclViewFor` 失败关闭，不把受限内容放出来。和现在的 ACL 查询失败相同。

没有规则的路径，包括 `documents/` 根上的文件，对团队成员可见。

同一调用者先要通过现有的团队成员鉴权。财务角色不会让一个非本团队的人同步本团队的文件夹。同组织的另一个团队要另设自己的规则。

### 5.2 角色变化何时生效

成员角色 `PUT` 成功后：

- 对该组织下的每个团队调用现有的 `invalidateTeamAcl`。10 秒缓存不能把刚拿掉的角色再放行一轮。
- 这次新增的角色会让他新看到某些文件夹时，对这些前缀做现有的 `resurfacePrefix`（只抬 `change_seq`，不抬 `version`）。否则他的客户端游标已经走过这些行，文件夹不会出现。被加上 `owner` 时，该组织每个团队里所有角色规则的前缀都要抬。
- 这次拿掉的角色不抬序号。下一次完整 manifest 不再列出这些文件。

文件夹规则本身的创建、加角色、删除，同样走现有的缓存失效。加角色或删掉整条规则时 `resurfacePrefix`。

### 5.3 本地副本

daemon 协议不变。完整 manifest 里没有、本地 state 里还有的已同步文件，继续由 `apply_revocations` 处理：先标记 forbidden，再删 state，再删磁盘。顺序保持现在这样，避免把一个人的撤权同步成团队墓碑。

已经拷贝到资料库以外的文件，删除覆盖不到。

### 5.4 同步挂载点

manifest、upload prepare、delete、versions、download 的可达性检查保持现有挂载。本设计只改变 `loadView` 如何决定 `denied`。`denied` 为空时，下游查询与今天相同。

审计仍写 `amuxc_access_log`：受限前缀上的放行和拒绝都记，非受限流量不记。

### 5.5 Wiki

本设计不改维护器。角色规则仍然是一条 `documents/` Path ACL。现有预检已经拒绝与任何 `documents/` ACL 相交的白名单，所以 `documents/财务/` 一旦设了规则，就不会被编译进全员可见的 `knowledge/wiki/`。整批停止还是跳过该文件夹，留给后面的 Wiki 设计。

---

## 6. 管理 API

先写进 `docs/openapi/teamclu-api.v1.yaml`。调用者必须是团队的 owner 或 admin。名单接口也只对他们开放，因为文件夹名本身可能敏感。普通成员不需要这份名单，他们的文件树里只出现自己能同步的路径。

| 方法 | 路径 | 作用 |
|------|------|------|
| `GET` | `/v1/teams/{teamId}/document-libraries` | 列出 `documents/<单层>/` 上的规则。角色规则带角色 `{id, code, name, status}`。同一形状上还没转换的按人规则带成员 id，并标成按人授权 |
| `POST` | `/v1/teams/{teamId}/document-libraries/preview` | 预览影响，不写入 |
| `POST` | `/v1/teams/{teamId}/document-libraries` | 创建，或把同一前缀上的按人规则改成角色规则 |
| `PUT` | `/v1/teams/{teamId}/document-libraries/{aclId}` | 替换角色集合 |
| `DELETE` | `/v1/teams/{teamId}/document-libraries/{aclId}` | 删除规则。文件回到团队可见，并 `resurfacePrefix` |

写入体：

```json
{ "pathPrefix": "documents/财务/", "roleIds": ["<finance-role-uuid>"], "confirmRevokeExisting": true }
```

`roleIds` 可以是空数组，表示只有拥有者能看。服务端始终把本组织的 `owner` 并进存储的集合。

预览和写入返回：

```json
{ "affectedFiles": 12, "affectedMembers": 3 }
```

`affectedFiles` 是该前缀下未删除的文件数。`affectedMembers` 是会失去同步的成员数，不计 agent。一个人现在能看、写入之后不能看，才算进去。拥有者算现在能看、之后也能看。

`affectedFiles > 0` 且 `affectedMembers > 0` 时，缺少 `confirmRevokeExisting: true` 返回 409，不写入。只加角色、没有人失去访问时，不需要确认，并执行 `resurfacePrefix`。

其他错误：

| 情况 | 状态 |
|------|------|
| 前缀形状不符 §3 D1 | 400 |
| 角色不属于本组织，或角色已停用 | 400 |
| 与另一条 `documents/` 规则重叠 | 409 |
| 本组织找不到 `owner` 系统角色 | 500，不创建一条老板看不见的规则 |
| 非 owner/admin | 403 |

现有 `/v1/teams/{teamId}/knowledge-acl` 继续服务知识库规则。它不接受 `roleIds`。新建 `documents/` 前缀改走上面的接口，旧接口再创建 `documents/` 规则时返回 400。已经存在的 `documents/` 按人规则仍可从旧接口修改成员或删除；若该规则已经写成角色授权，旧接口的修改返回 409。嵌套的 `documents/` 旧规则只能删除，不能再新建。`DELETE /document-libraries/{aclId}` 也可以删掉同一顶层前缀上的按人规则。

---

## 7. 界面

只给 owner/admin 显示。入口在资料库顶层文件夹的菜单里，标题用「谁可以看」。

- 没有规则：说明当前团队成员都能同步，并可以改成按角色。
- 角色规则：列出角色名。拥有者一项固定勾选，不能取消。其余勾选来自本组织的有效角色，不含 `owner` 和 `member`。`admin`、`finance` 和自建角色都在里面。
- 同一前缀上还是按人规则：说明「当前仍按成员授权」，保存按角色的选择会替换它，并走确认。
- 收紧会让人失去访问、且文件夹里已有文件：确认框写出影响的文件数和成员数，按钮写「停止同步」。

设置里放同一份列表，避免只能在文件树里一处一处找。知识库的按人授权页保持不动。

文件树上的锁标记继续只给能管理团队的人看。能看财务文件夹的财务成员看到的是普通文件夹，没有「你被特别授权」的提示。

---

## 8. 验收

1. 只有 `finance` 的成员能同步 `documents/财务/`，不能同步 `documents/人事/`。只有 `hr` 的成员相反。两个角色都有的人两个都能同步。
2. `owner` 两个文件夹都能同步。请求体里不传 `owner`，存下来的规则仍含 `owner`。
3. 只有 `admin`、没有 `finance` 也没有 `owner` 的成员：能改规则，manifest 里没有 `documents/财务/` 下的文件，按 hash 下载返回 `PathForbidden`。
4. 给一个成员加上 `finance` 之后，他已经走过的游标仍能拉到该文件夹里的现有文件。拿掉 `finance` 之后，服务端立刻不再下发。本机副本在下一次完整 manifest 对账时按 `apply_revocations` 删除，且不产生团队墓碑。对账间隔是现在的 30 分钟，本设计不把它改短。
5. 停用 `finance` 角色后，只持有该角色的成员不再能同步财务文件夹。`owner` 仍能同步。
6. 在已有 `documents/财务/工资/` 规则时创建 `documents/财务/` 返回 409。`documents/财务/` 与 `documents/财务公开/` 可以同时存在。
7. `documents/报表.pdf` 在财务文件夹已设规则时，对没有财务角色的成员仍可见。
8. 非本团队成员即使拥有组织的 `finance` 角色，也不能同步这个团队的财务文件夹。
9. 角色查询失败时，这次同步失败，不退回「全部可见」。
10. 把 `documents/财务/` 放进 Wiki 白名单时，现有维护器预检失败，整批不发布。
