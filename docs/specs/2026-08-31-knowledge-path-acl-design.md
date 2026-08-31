# Knowledge 目录级权限（Path ACL）设计

- **Date**: 2026-08-31
- **Status**: IMPLEMENTED — 服务端、daemon、桌面端设置页均已落地（见 §9 的验收状态）
- **Scope**: `services/fc/`（判据、五个同步端点、管理 API、审计）、`services/supabase/migrations/`、`apps/daemon/`（`sync/oss/`）、`packages/app/`（设置页授权界面）、`docs/openapi/teamclu-api.v1.yaml`
- **Extends**: `docs/adr/0008-knowledge-sync-p0-p1-scope.md` —— 本设计**扩大**了该 ADR 冻结的范围，0008 的 freeze 清单必须同批更新（见 §8）
- **Related**: `docs/architecture/obsidian-compatible-knowledge.md`（忽略规则三层来源）、`docs/architecture/knowledge-sync-push-notify.md`

---

## 0. 安全叙事——先读这一节

这一节放在最前面而不是附录，是刻意的。这个功能极容易被对内对外说成它不是的东西。

**Knowledge 内容在服务端是明文的。** ADR-0008 已经定死：`engine.rs` 的 `prepare_upload` 里 `cipher_hash == plain_hash`，字节原样上传；对象存储里躺的就是可读的 Markdown。本设计**不改变这一点**。

因此，本功能提供的是：

- ✅ **团队内的访问控制**——张三看不到 `knowledge/hr/`
- ❌ **不防运维**——有 MinIO 或数据库访问权的人能读全部内容
- ❌ **不防我们自己**——TeamClu 的服务端可读全部内容
- ❌ **不是端到端加密**——真 E2E 含密钥分发，是独立立项，与本设计无关

**撤权的承诺边界。** 撤权只能保证「不再分发新内容」，不能保证「收回已分发的内容」。撤权前落到对方磁盘上的明文，客户端会尽力删除，但对方可以拒绝删（跑一个改过的 daemon，或提前把文件拷走）。

**对外措辞统一为「停止同步」，禁止使用「撤回」「收回」「吊销访问」。** 一个主打防内部窥探的功能，如果承诺了做不到的撤回，第一次出事就是信任崩塌。我们真正能交付的是**可追溯**（§4.7 的审计），不是不可能的收回。

> **写给下一个改这块的人**：如果你正准备在文案、销售材料或 UI 里写「敏感目录受保护」——先回来读这一节。一旦有客户因为「有权限管理」把真正敏感的东西放进 knowledge，我们就承担了一个从没打算承担的责任。

---

## 1. 背景

### 1.1 今天是团队级「全有或全无」

同步链路上唯一的鉴权判据是「你是不是这个团队的成员」，三条证据：

| 事实 | 证据 |
|------|------|
| 鉴权只解析到 team + actor，之后不再判断 | `services/fc/src/lib/sync-auth.ts:100` `authenticateSyncCall` —— 拿到 `actorId` 就放行，后续 handler 只用 `teamId` |
| manifest 查询没有 path 这个维度 | `services/fc/src/lib/pg-repo/oss-sync.ts:324` —— WHERE 只有 `team_id` + `change_seq > afterSeq` |
| 下载按内容哈希取，路径根本不在鉴权面上 | `services/fc/src/lib/sync-handlers.ts:844` `handleSyncDownload` —— 入参是 `contentHash`，不是 path |

`team_members.role`（`services/fc/src/db/schema/teams.ts:71`）确实存在，但整条同步链路一次都没读过它。

### 1.2 现有的「不同步某目录」不是权限

客户端有三层忽略规则（`apps/daemon/src/sync/oss/ignore_rules.rs:1`）：内置规则、团队共享的 `knowledge/.amuxignore`、本机的 `.syncignore.local`。pull 侧确实会跳过（`engine.rs:224`）。

但它是**自愿的、客户端的**：文件照样在服务端，任何人删掉一行规则就能全量拉下来。它解决的是「我不想要」，不是「你不许要」。

### 1.3 规模现实

设计前查了线上库（自托管 ECS，`amux.amuxc_files`）：

- 最大的真实知识库 **11 个 live 文件**（团队 Quiet Hare），其余全是 e2e 测试残留
- 多人团队最大 **7 个 member**（Curious Cougar）
- **agent 数量普遍是 member 的 3–5 倍**（Quiet Hare 3 人 15 agent；Calm Viper 3 人 12 agent）

这三个数字在本文档里各有用处：前两个用来**定容量上限**（§3.1 的 64 条规则上限、§4.7 的审计留存策略都按这个量级取值），第三个直接推翻了一个看起来合理的设计（§2 的 D2）。

**它们不用来推迟实施**——本设计按一次性全量实现推进（§9）。

---

## 2. 决策记录

评审时逐条对，每条都写了「为什么不是另一个选项」。

### D1 — 威胁模型：防团队内主动翻看

不是降噪，不是合规。**服务端强制**是必需的，客户端过滤不算数。

> 若只为降噪，正确答案是把 `.amuxignore` 做成 UI 能勾的开关，一天做完，不需要本文档任何一节。这条决定了后面所有的成本。

### D2 — 权限主体：`actor_id`，但 v1 只写 member 的 actor

**agent 继承召唤它的人，不单独授权。**

评审过「agent 作为独立主体」（比如「财务 agent 能读 `finance/`，人不能」），**这个语义在当前架构下做不出来**：

agent 拿到 knowledge 的方式是一个符号链接——`ensure_workspace_knowledge_link`（`apps/daemon/src/runtime/supervisor.rs:829`）在每个 workspace 里建 `team-knowledge` → `~/.amuxd[-<brand>]/teams/<id>/shared/knowledge`。agent 用普通文件工具读它。

**一台设备上只有一棵树，跑在这台设备上的所有 agent 看到的东西完全一样。** 没有任何 per-agent 的文件系统闸门。文件要么在这台机器的盘上（设备主人和他所有 agent 都能读），要么不在（谁都读不到）。

推论：**控制设备主人的权限，就等于控制了他的所有 agent。** 这也是为什么 §1.3 的「agent 比人多」不构成做 agent 级 ACL 的理由——它反而说明按人授权的杠杆更大。

表的主体列仍然是 `actor_id` 而不是 `member_id`，这样将来若真要引入 agent 级语义（需要按 agent 物化 knowledge 子树，会打破「一团队一设备一棵树」的不变量，Obsidian 打开的团队树也会碎掉——那是独立立项）不需要迁移。

另有一个已知冲突记在这里：定时任务触发的 agent 必须默认 full access（无人值守，等审批就跑不过）。agent 级 ACL 会跟这条直接打架，D2 的选择顺带避开了它。

### D3 — 权限轴：存权限位，v1 只实现「不可见」

存储层直接留权限位，抄 Sync-in 的形状（`SPACE_OPERATION` = `a`dd / `m`odify / `d`elete，冒号拼接存 varchar）。

**v1 只实现「不可见」**（无权限 = 不下发）。「只读」（文件照常下发但拒绝上传）的难点不在服务端，在客户端 UX：用户在 Obsidian 里编辑完、同步失败、看不懂为什么。那是独立一块工作量。

留位不留实现，是因为迁移比重新设计贵。

### D4 — 粒度：任意深度前缀

不做例外覆盖（`knowledge/hr/` 禁但 `knowledge/hr/public/` 放行）。例外覆盖会让 manifest 的过滤从「几个 NOT LIKE」变成需要排序求值的规则引擎，而 manifest 是最热的端点。

三条机械规则，按防误伤定死：

1. `path_prefix` **强制以 `/` 结尾**。否则 `knowledge/hr` 会误匹配 `knowledge/hr-public/`。
2. 匹配按**路径分段边界**，不是裸字符串前缀。
3. 每团队规则条数**上限 64**。每条规则在 manifest 查询上加一个 `NOT LIKE`；按 §1.3 的规模，64 条是「永远够用」和「SQL 保持平凡」的交点。

### D5 — 合并语义：白名单 + 交集

**有规则的前缀默认对所有人关闭**，只有 `amuxc_path_acl_grants` 里列出的 actor 能看。多条规则命中同一路径时取**交集**（最严的赢）。

为什么不是黑名单：白名单的失败模式是「有人看不到该看的」——会被立刻投诉然后修好；黑名单的失败模式是「忘了加规则」——要等到泄漏才发现。在 D1 的威胁模型下，默认必须是「关」。

直接推论：**新加入团队的成员，在管理员显式授权前看不到任何受限目录。** 这是正确行为，不是 bug。

### D6 — 撤权：停止分发 + 尽力删除，措辞降级

见 §0。审计（§4.7）是这个功能真正交付的东西。

### D7 — 不向客户端下发受限前缀

**这是与本设计早期草案的关键差异，评审时请重点看。**

早期草案让服务端在 manifest 响应里回 `deniedPrefixes`，客户端喂进 ignore 层。在 D1 确定为「防内部窥探」之后，这条变成了**主动把「有一个叫 `knowledge/hr/salary/` 的目录」告诉不该知道的人**——目录名本身经常就是敏感信息。

改为：服务端拒绝时带 `code: 'PathForbidden'`，daemon 收到就把该路径记进本地的「别再试」集合，不再重试、不报红（§5.2）。

两边好处都拿到：目录名只有在用户**自己恰好创建了那个路径**时才会被间接感知——而这种情况下他本来就知道自己写了什么；同时彻底没有重试风暴。

### D8 — 对非空目录建规则 = 群体撤权，必须显式确认

白名单语义下，管理员在已有内容的 `knowledge/hr/` 上建一条只给 alice 的规则，意味着团队里其他所有人**立刻失去**已经躺在他们磁盘上的那些文件。这是本功能最危险的操作。

API 必须带 `confirmRevokeExisting: true`，且**响应里返回「本次影响 N 个文件、M 个成员」**。

不选「禁止对非空目录建规则」：那会逼人先把文件挪出去再挪回来，制造更多事故。

### D9 — 审计落库，不进 stdout

现有 `logSyncEvent`（`services/fc/src/lib/sync-log.ts`）只是 `console.log(JSON.stringify(...))` 打到 stdout，字段里有 `contentHash` 但**没有 path**，自托管上进的是 docker logs——不可查询、不留存。它不是审计。

新表 `amuxc_access_log`，**只记受限前缀相关的事件**。按 §1.3 的规模，量小到可忽略，而它回答的正是事后唯一会被问的问题：**「这份文件泄露了，撤权之前谁拿到过？」**

不记全部 sync 访问：那会把一个防内部窥探的功能变成一个日志量问题。

### D10 — 管理面：owner/admin 限定，API + 桌面端 UI

不允许普通成员把自己创建的目录设为受限——权限会散落到没人管得清。

---

## 3. 数据模型

**迁移落在 `services/supabase/migrations/`。** 线上 `BACKEND_KIND=supabase`（已在 `deploy/self-host/.env` 核实；`docker-compose.yml:274` 的默认值也是 `supabase`），自托管的迁移由 `deploy/self-host/init/apply-migrations.sh` 从该目录按字典序扫描应用。`services/fc/src/db/migrations/`（drizzle）同步补一份，供 postgres 后端使用。

### 3.1 `amux.amuxc_path_acl` — 受限前缀

```sql
create table amux.amuxc_path_acl (
  id          uuid primary key default gen_random_uuid(),
  team_id     uuid not null references amux.teams(id) on delete cascade,
  path_prefix text not null,          -- 'knowledge/hr/'，强制以 / 结尾
  created_by  uuid not null references amux.actors(id) on delete restrict,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  constraint amuxc_path_acl_prefix_uniq unique (team_id, path_prefix),
  constraint amuxc_path_acl_prefix_shape check (
    path_prefix like 'knowledge/%' and path_prefix like '%/'
  )
);
create index idx_amuxc_path_acl_team on amux.amuxc_path_acl (team_id);
```

`check` 约束把 D4 的两条机械规则钉在数据库层：必须在 `knowledge/` 下（与 `path_validator.rs` 的 `ALLOWED_PREFIXES` 一致），必须以 `/` 结尾。64 条上限在应用层校验（DB 层做要写触发器，不值得）。

### 3.2 `amux.amuxc_path_acl_grants` — 谁能看

```sql
create table amux.amuxc_path_acl_grants (
  acl_id      uuid not null references amux.amuxc_path_acl(id) on delete cascade,
  actor_id    uuid not null references amux.actors(id) on delete cascade,
  permissions varchar(32) not null default 'a:m:d',   -- D3：留位，v1 不读
  granted_by  uuid not null references amux.actors(id) on delete restrict,
  granted_at  timestamptz not null default now(),
  primary key (acl_id, actor_id)
);
create index idx_amuxc_path_acl_grants_actor on amux.amuxc_path_acl_grants (actor_id);
```

拆成两张表而不是在 `amuxc_path_acl` 上放一个 `uuid[]`：授权和撤权是**审计对象**（谁在什么时候把谁加进来的），数组存不下 `granted_by` / `granted_at`。多一张表换一个说得清的授权历史，值。

`permissions` 按 D3 留位。**v1 的代码不读这一列**——读它就意味着实现了「只读」，那是另一个版本。

### 3.3 `amux.amuxc_access_log` — 受限内容访问审计

```sql
create table amux.amuxc_access_log (
  id          bigserial primary key,
  team_id     uuid not null references amux.teams(id) on delete cascade,
  actor_id    uuid not null references amux.actors(id) on delete cascade,
  path_prefix text not null,        -- 命中的规则前缀，不是完整路径
  path        text,                 -- 完整路径，download/versions 有，manifest 无
  action      text not null,        -- 'manifest' | 'download' | 'upload' | 'delete' | 'versions'
  allowed     boolean not null,     -- 放行还是拒绝——拒绝同样要记
  at          timestamptz not null default now()
);
create index idx_amuxc_access_log_team_at on amux.amuxc_access_log (team_id, at desc);
create index idx_amuxc_access_log_prefix on amux.amuxc_access_log (team_id, path_prefix, at desc);
```

**拒绝也记**：一个成员反复尝试访问自己没权限的目录，本身就是需要被看见的信号。

留存 180 天，由一个 FC cron 清理。**注意：cron 是 compose 的独立 profile，自托管当前未启用**——所以第一版靠手工清理，不要在文档或对外材料里把「自动清理」说成已有能力。启用 cron profile 是独立的 ops ticket。

---

## 4. 服务端设计

### 4.1 判据收敛在一个模块

**新增 `services/fc/src/lib/sync-acl.ts`，所有权限判断只从这里出。**

这条是硬要求，不是风格偏好。理由有二：其一，将来若换后端（Nextcloud 之类的评估结论见 §10.4），要迁移的就是这一个模块和两张表；其二，权限逻辑一旦散进各个 handler，就不可能再证明它们一致。

```ts
/** 该 caller 在该 team 下不可见的前缀。空数组 = 无限制（绝大多数团队）。 */
export async function deniedPrefixesFor(teamId: string, actorId: string): Promise<string[]>

/** 路径是否落在任一受限前缀下。按分段边界匹配。 */
export function isDenied(path: string, deniedPrefixes: string[]): string | null   // 返回命中的前缀，供审计用

/** 命中的规则前缀（无论是否放行），供审计判断「这次访问是否涉及受限内容」。 */
export async function matchingPrefixFor(teamId: string, path: string): Promise<string | null>
```

`deniedPrefixesFor` 带 **10s TTL 缓存**，照抄 `sync-guards.ts` 里 `countCache` 的写法。代价是撤权到生效有最多 10s 延迟——在 D6 已经承认「撤权不保证收回已下发内容」的前提下，这个延迟不改变任何安全属性。

**性能红线：`deniedPrefixesFor` 返回空数组时，所有下游查询必须与今天逐字相同。** manifest 是最热的端点，不能让一个 99% 团队用不到的功能给它加常驻开销。

### 4.2 五个挂载点，八个端点

批量端点是单条 handler 的薄壳——`sync-handlers.ts:1281` 起的四个 batch 端点全部 fan-out 到单条实现（源码注释里写死了 "batch literally invokes the single handler"）。**所以判据只写进单条 handler，八个端点自动全覆盖。**

| 端点 | 位置 | 改动 |
|------|------|------|
| `/sync/manifest` | `sync-handlers.ts:385` | denied 非空时给查询追加 `NOT LIKE`（supabase 分支 `.not('path','like',...)`；postgres 分支在 `pg-repo/oss-sync.ts:340` 的 `baseFilter` 上挂 `notLike`） |
| `/sync/upload/prepare` | `sync-handlers.ts:524` | 命中 → 403 `PathForbidden`。插在 `:542` 的 `isRejectedSyncPath` 旁边，那里的 422 就是现成先例 |
| `/sync/delete` | `sync-handlers.ts:900` | 同上 |
| `/sync/versions` | `sync-handlers.ts:998` | 同上（按 path 查历史，同样会泄露内容） |
| `/sync/download` | `sync-handlers.ts:844` | 见 §4.3 |

`/sync/upload/complete` 不单独挂：它的前置 `prepare` 已经挡住，且 complete 拿的是 `sessionId`，session 行本身是 prepare 建的。

**双后端要求**：`resolveBackendKind()` 的两个分支都要实现（仓库规则见 `backend-kind.ts` 的注释）。线上跑的是 supabase 分支，postgres 分支是镜像实现，约 15 行。

### 4.3 download 按 hash 取，需要可达性检查

这是唯一需要动脑的一处。`handleSyncDownload` 的入参是 `contentHash`，路径不在参数里——**只过滤 manifest 是「藏起来」，不是「挡住」**：知道 hash 的人仍然能拿到内容。

判据改为：**这个 team 里、这个 hash、且路径不在该 caller 的 denied 前缀下的行，存在吗？**

需要同时查两处：

- `amuxc_files`（当前版本指针）
- `amuxc_file_versions` join 回 `amuxc_files` 取 path（历史版本的 blob 只被版本表引用）

denied 为空时整个可达性查询跳过（§4.1 的性能红线）。

### 4.4 管理 API

写进 `docs/openapi/teamclu-api.v1.yaml`（仓库规则：先定义契约，再实现）。

```
GET    /v1/teams/:id/knowledge-acl          列出规则 + 授权人
POST   /v1/teams/:id/knowledge-acl          建规则   { pathPrefix, actorIds[], confirmRevokeExisting? }
PATCH  /v1/teams/:id/knowledge-acl/:aclId   改授权人 { addActorIds[], removeActorIds[] }
DELETE /v1/teams/:id/knowledge-acl/:aclId   删规则（前缀重新对全团队开放）
POST   /v1/teams/:id/knowledge-acl/preview  干跑，返回影响面，不落库
```

owner/admin 限定，复用 `pg-repo/team-mcp.ts:180` 的 `isTeamAdmin` 模式（`role === 'owner' || role === 'admin'`）。

**`POST` 对非空前缀的行为（D8）**：

1. 不带 `confirmRevokeExisting` → **409**，body 里带 `{ affectedFiles: N, affectedMembers: M }`
2. 带 `confirmRevokeExisting: true` → 建规则，响应里同样返回 N/M

`/preview` 存在的唯一目的是让 UI 能在用户按下按钮**之前**显示影响面（§6）。

### 4.5 授权后如何让文件重新出现

**问题**：客户端的 `last_server_seq` 按 `snapshotSeq` 单调前进。被 ACL 过滤掉的行，其 `change_seq` 已经被越过去了——后来给某人加权限，他永远不会再看到那些旧行。

**解法：授权时抬水位，零客户端改动。**

在 `POST` / `PATCH` 的同一个事务里：

```sql
-- 与写入路径同一个水位不变量：先 bump oss_change_seq
update amux.team_workspace_config
   set oss_change_seq = oss_change_seq + 1
 where team_id = $1
returning oss_change_seq;

update amux.amuxc_files
   set change_seq = $newSeq
 where team_id = $1 and path like $prefix || '%';
```

为什么这样就够：

- **新获权的人**：本地 state 里没有这些路径的条目 → `engine.rs:272` 的 `needs_download` 走 `None => true` 分支 → 下载
- **其他所有人**：`item.version > ls.synced_version` 不成立（version 没变，只有 change_seq 变了）→ 空转跳过

代价是一次 manifest 突发（这些行会出现在全团队的下一次 manifest 里）。按 §1.3 的规模，可忽略；即使一个目录几千个文件，也是分页的、且对其他人全是 no-op。

keyset 分页对「多行共享同一个 change_seq」是支持的（`pg-repo/oss-sync.ts:322` 的注释明确写了这一点，靠 `id` 破平局）。

### 4.6 撤权路径

服务端侧撤权是自动的——规则一建，`deniedPrefixesFor` 下次就把它算进去（最多 10s 缓存延迟），manifest 不再下发，download 可达性检查开始拒绝。

本地已有副本的清理在客户端（§5.3）。**服务端不能也不该假设它一定发生**（D6）。

### 4.7 审计写入点

在 §4.2 的五个挂载点上，**只有当 `matchingPrefixFor` 返回非 null 时**才写 `amuxc_access_log`——也就是说，不涉及任何受限前缀的普通同步流量完全不产生审计行。这是 D9 的量控手段。

manifest 是批量的，不可能一行一条。规则：**manifest 每次调用，对每个「该 caller 有权访问的受限前缀」记一条**（`action='manifest'`, `path=null`），语义是「此人在此刻同步了这个受限目录」。这正是「撤权前谁拿到过」需要的粒度。

---

## 5. 客户端（amuxd）设计

### 5.1 客户端不是安全边界

先明确：**服务端过滤是唯一的执行点。** 本节的所有内容都是体验优化——消掉重试红灯、让撤权真的把文件从盘上拿走。一个改过的 daemon 可以跳过本节全部逻辑，但它拿不到服务端不给的数据。

### 5.2 403 自学：`PathForbidden`

`map_fc_response`（`apps/daemon/src/sync/oss/fc_client.rs:622`）已经把 403 映射成 `SyncError::Auth`。新增区分：body 里 `code == 'PathForbidden'` → 新的 `SyncError::PathForbidden(path)`。

engine 侧，prepare/delete 的批量结果处理（`engine.rs:955` 的 `record_item_error`）对这个错误**不走 `record_item_error`**——那会让文件保持 dirty、每个 tick 重试、UI 一直红。改为：

1. 把路径写进 `LocalSyncState` 的新集合 `forbidden: HashMap<String, ForbiddenPath>`（与 `quarantined` 同级，`#[serde(default)]` 保证老 state 文件能加载）
2. 该路径进入本地 ignore 判据，push 侧不再尝试
3. 不计入错误统计，不报红

**清除时机**：授权恢复后要能自愈。`forbidden` 条目带 `attempts` 和 `last_tried_at`，**每 24 小时或 daemon 重启后重试一次**。这里刻意不做得更聪明——服务端没有、也不该有一个「通知你被授权了」的推送通道（那本身就会泄露目录存在）。授权后最坏 24 小时自愈，管理员想立刻生效可以让对方重启客户端。

### 5.3 撤权的本地清理，以及为什么它不会误删别人的文件

这是本节最需要小心的一处。

engine 判断「文件被本地删除」的依据是「在 sync state 里、但不在扫描结果里」（`locally_deleted_paths`）。**如果撤权后直接删文件而不做别的，下一个 tick 就会把它当成本地删除，广播墓碑，删掉每个有权限的队友的磁盘副本。**

现有代码已经有对应的保护：`engine.rs:1614` 把墓碑候选列表过滤了一遍 `rules.is_ignored_with_ancestors` —— 被忽略的路径永远不会变成墓碑。这正是 §5.2 让受限路径进入本地 ignore 判据的第二个理由。

清理顺序因此必须是：

1. 先把前缀加入本地 ignore 判据
2. 再删本地文件
3. 再删 state 条目

**顺序反了就是一次团队级数据丢失。** 实现时这三步必须在同一个函数里，且带一条说明它为什么不能拆的注释。

清理的触发：**每 30 分钟把 manifest 的窗口从增量放宽到全量**
（`RECONCILE_INTERVAL_SECS`，`engine.rs`）。

这一条与本设计初稿不同，实现时换成了更简单也更确定的做法，记录原因：

初稿写的是「对可疑路径调 `/sync/versions`，拿到 403 即判定被撤权」。它需要先有
一套「哪些路径可疑」的启发式，而任何基于「它没出现在 manifest 里」的推断都很危险
——manifest 本来就是增量的（`afterSeq`），一个文件本来就不会每次都出现。

**撤权对增量同步是不可见的**：被撤权后那些行不是「带着已删除标记回来」，而是
干脆不再返回，这跟「什么都没变」在 `afterSeq` 查询下完全无法区分。所以真正需要的
不是探测，而是**一次完整的 manifest**：从 seq 0 drain 一遍，服务端会返回这个调用者
**能看到的全部**（包括墓碑行）。本地 state 里有、而这份全量清单里没有的路径，就是
被撤权的。

代价几乎为零：pull 循环对已持有的版本本来就跳过（`item.version > synced_version`
不成立），所以放宽窗口只增加 manifest 的分页量，不增加任何实际下载。

半小时这个值是有意的折中：撤权本来就不承诺收回已下发的副本（§0），缩短窗口买到的
真实保护很有限，而每个 tick 都做全量 drain 会让最热的查询永久正比于整个知识库。

> **实现注记**：`apply_revocations` 必须只在**完整 drain**（`nextCursor == null`）
> 之后调用，且传入的必须是全量路径集合。拿一页增量结果喂给它，等于把「不在这一页里」
> 判成「不再有权限」——那会删掉整个知识库。函数的文档注释里写死了这条。

### 5.4 `LocalSyncState` schema 变更

新增 `forbidden` 字段，`#[serde(default)]`。**不提升 `SCHEMA_VERSION`**——老 daemon 读新 state 文件时会忽略这个未知字段，与 `quarantined` 当初的处理一致（见 `state.rs` 里 `quarantined` 的注释）。

---

## 6. 桌面端 UI

设置页 → 团队 → 「知识库权限」，owner/admin 可见。

- 规则列表：前缀、被授权的人、创建时间
- 新建：选目录（从已同步的 knowledge 树里选，不让手输，避免拼错前缀）+ 勾人
- **影响面确认屏**——本节最重要的一屏。用户按「创建」之前，调 `/preview` 显示：

  > 此操作将限制 `knowledge/hr/`。
  > **7 名成员中的 6 名将失去访问权**，他们本地已同步的 **23 个文件**会在下次同步时从各自设备上删除。
  > 此操作不会删除服务器上的内容，也**无法收回已被复制走的副本**。

  最后一句是 §0 的措辞纪律在 UI 上的落点，不是可选的文案润色。

**受限目录在无权成员的界面里完全不存在**——不显示锁、不显示占位（D7）。

设置页里的弹层必须传 `container`：设置页是模态 dialog，默认 portal 到 body 的弹层永远打不开（这个坑本仓库踩过）。

---

## 7. 明确不做

- **「只读」权限**——权限位已留（D3），实现是独立版本
- **agent 级授权**——见 D2，需要先改「一团队一设备一棵树」的架构
- **例外覆盖**（子目录反向放行）——见 D4
- **per-file 权限**——只有前缀
- **「看得见但打不开」**——权限等于不下发
- **加密隔离**——见 §0，真 E2E 是独立立项
- **审计日志的自动清理**——依赖未启用的 cron profile，第一版手工

---

## 8. 与 ADR-0008 的关系

ADR-0008 的 freeze 清单里没有目录级 ACL，而本设计**明确扩大了 knowledge 同步的范围**。

**必须同批更新 0008**，在「明确不做（freeze）」一节旁边加一条说明：目录级 ACL 已由本设计纳入范围。

理由很实际：0008 那份清单被写下来，就是为了防止「下个 session 把 P2/P3 悄悄拉回同一波」。不更新它，下一个读到 0008 的 session 会理直气壮地把这个功能推回去。

同时 0008 §「安全叙事」的表述与本文档 §0 必须保持一致——两处都说「服务端与对象存储可读的团队共享盘」。

---

## 9. 实施顺序与验收

按一次性全量实现推进。顺序按**风险从低到高**排，但不切版本。

1. 迁移 + `sync-acl.ts` 判据模块 + 单元测试（不接任何端点，纯函数先测透）
2. 五个端点挂判据 + `amuxc_access_log` 写入
3. 管理 API + `/preview` + change_seq 抬水位
4. daemon：`PathForbidden` 自学 + `forbidden` 状态
5. daemon：撤权本地清理（**§5.3 的三步顺序**）
6. 桌面端 UI

### 一条必须记录的节奏差异

**服务端强制是发版即生效，客户端部分要等 daemon 分发到每台设备。**

所以验收必须先验服务端：在没有任何客户端改动的情况下，用一个被拒的账号直接打 `/sync/manifest` 和 `/sync/download`，确认拿不到数据。**这一条通过，安全边界就已经真实存在了**；客户端的 4/5/6 步是体验，不是保护。

不要在客户端全量升级之前，对外宣称「已升级的客户端才受保护」——那是反的。

### 验收清单

- [ ] 无 ACL 规则的团队，manifest SQL 与改动前逐字相同（比对 query plan）
- [ ] 被拒成员：manifest 不含受限路径；直接用已知 hash 打 download 被拒；versions 被拒；prepare/delete 被拒
- [ ] 授权后，新获权成员在一次 tick 内拿到全部历史文件；其他成员该 tick 无实际下载
- [ ] 对非空前缀建规则，不带 `confirmRevokeExisting` 返回 409 且 N/M 正确
- [ ] 撤权后被拒成员本地文件消失，**且有权限的成员本地文件完好**（这条验的是 §5.3 的顺序，必须真跑双端）
- [ ] `PathForbidden` 不产生重试、不报红、24h 后重试一次
- [ ] 受限前缀相关访问全部落 `amuxc_access_log`，含被拒事件；无关流量不产生审计行
- [ ] pgTAP：新表不撞现有 `has_table` 断言；若加断言需同步改 plan 数

---

## 10. 风险

### 10.1 manifest 性能

manifest 是最热的端点。§4.1 的红线（denied 为空时查询逐字不变）是硬要求，评审时请专门看这一条的实现。

### 10.2 §5.3 的顺序错误 = 团队级数据丢失

这是本设计里唯一一个「写错了会删别人文件」的地方。实现时必须有测试覆盖「撤权后队友的文件还在」。

### 10.3 措辞滑坡

§0 的措辞纪律没有技术手段保证。唯一的防线是把它写在文档最前面，以及在 UI 文案（§6）里落一次。

### 10.4 为什么不用现成的开源网盘

评审过 Nextcloud + Group Folders、ownCloud Infinite Scale、Seafile CE、Pydio Cells、SFTPGo、Sync-in。结论是都不适用，理由记录如下，避免重复评估：

| 项目 | 否决理由 |
|------|---------|
| Seafile CE / Pydio Cells Home | **目录级权限在付费版**，开源版没有 |
| ownCloud Infinite Scale | S3 模式下盘上不是可读文件树，Obsidian 打不开（PosixFS 仍标 experimental） |
| SFTPGo | 权限模型很贴，但它是 MFT/SFTP 服务器，**没有双向同步客户端** |
| Sync-in | 读过源码：**只有本地 POSIX 存储，无 S3**（`files.config.ts:85` 的 `dataPath` + `node:fs`）；**数据库锁死 MySQL**（`dialect: 'mysql'`），我们整栈是 Postgres |
| Nextcloud + Group Folders | 功能上唯一全中的（开源版有目录 ACL，桌面端同步成普通文件树）。否决理由是**集成成本**：要维护第二套身份体系并与 `actors`/`team_members` 双向 provisioning，胶水代码远超本设计；且自托管 ECS 已承载 Supabase 全家桶 + EMQX + MinIO + FC，再加 PHP-FPM + Redis + MySQL 不现实 |

**值得借鉴而非引入的**：Sync-in 的权限位形状（`a:m:d` 冒号拼接，挂在「space root」= 前缀上）已被 D3 采纳；它与 Nextcloud Group Folders 的模型几乎同构——两个独立项目收敛到同一形状，说明这个形状是对的。

若将来 knowledge 的需求扩展到版本审计、在线预览、外部分享链接、回收站、跨团队引用，应重新评估 Nextcloud。届时对比才公平。
