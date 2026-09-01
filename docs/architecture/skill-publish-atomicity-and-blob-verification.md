# Skill 发布原子性与包体校验

> 目标落位：`docs/architecture/skill-publish-atomicity-and-blob-verification.md`
> 状态：**本轮落地**（应用层）。drizzle / supabase 表默认值迁移、pg-repo `listTeamSkillInstallerActorIds`、MQTT 加速本轮不做。
> 前置阅读：[`team-skills-registry.md`](./team-skills-registry.md) §5 / §6，[`skills-marketplace.md`](./skills-marketplace.md) §5.1 / §8.1。

## 1. 要解决什么

发布 v1 和「包体真的在、而且是声称的那一份」目前是两件没绑在一起的事。几个已经在代码里核实过的缺口：

1. **v1 不是事务。** `createTeamSkill` 先插 `team_skills` 再插 `team_skill_versions`。adopt 已经用 txn（Path B）/ 补偿删除（Path A）把这个坑填了；本地发布还没有。失败模式：skill 行在、版本行不在 → 读起来是 "v1"、下载 404、slug 被占、无法重发。
2. **发布不要求 verified blob。** prepare/complete 把 `amuxc_blobs.verified` 翻成 true，但 create / createVersion 只检查 `contentHash` 非空。可以登记一个从未上传的哈希。
3. **complete 只比对 size。** HEAD/list 对得上字节数就把行标 verified。同 size 不同内容会过。
4. **Path A `prepareTeamSkillBlob` 不返回 `verified`。** 路由 `if (!prepared.verified)` 把缺省当成需要上传。同一个 zip 第二次 prepare 仍发 presigned PUT，内容寻址去重名存实亡。Path B 返回 `verified`。
5. **`whenToUse` / `whenNotToUse` 在 OpenAPI 和 `requirePublishFields` 里是选填，表上 NOT NULL 且无 DEFAULT。** 省略时插入 NULL → Postgres `23502`。市场表已经是 `NOT NULL DEFAULT ''`。

## 2. v1 创建必须在一个事务里

adopt 的注释已经写清了为什么：

> Committing the skill row and then failing on the version row leaves a skill stuck at "v1" with no v1 to download, and — because the slug is now taken — no way to re-adopt it either.

本地 `POST /v1/teams/:id/skills` 是同一对插入，同一条失败模式。

| 后端 | 做法 |
|---|---|
| Path B (`pg-repo`) | `db.transaction`：skill 行 + version 行，和 adopt / createVersion 一样 |
| Path A (`supabase-repo`) | PostgREST 没有跨语句事务。版本插入失败则按 id 补偿删除刚建的 skill 行（与 adopt 同一形状）。真正的 RPC 事务本轮不做 |

校验（slug / 发布门 / changelog / **verified blob**）全部发生在写入之前。事务里不再做网络 I/O。

`POST .../versions`（v2+）Path B 已经在事务里；不改语义，只加 verified 检查。

## 3. 发布门：verified blob

客户端顺序不变：prepare →（需要时）PUT → complete → POST skill / versions。服务端现在拒绝第三步没做完的第四步。

```
createTeamSkill / createTeamSkillVersion
  contentHash 必须是 64 hex（小写）
  amuxc_blobs(team_id, content_hash).verified = true
  否则 422 blob_unverified
```

市场订阅版本（`blob_scope='marketplace'`）不走这条：字节在 `marketplace/blobs/…`，不在 `amuxc_blobs`。adopt / 惰性对齐 / revert 复制已有版本的 blob 指针，不重新上传。revert 不重新要求 complete。

## 4. complete：先 size，再 hash

`POST .../skill-blobs/complete`（及市场孪生 `.../admin/marketplace/skill-blobs/complete`）：

1. 对象必须存在，`stat.size` 必须等于登记的 size。否则 `422 blob_missing`（已有）。
2. **再读字节算 sha256。** digest 必须等于 `contentHash`。否则 `422 blob_hash_mismatch`，不标 verified。
3. 然后才把 `amuxc_blobs.verified` 翻成 true（团队包）。市场 complete 没有账本行，hash 通过即视为 verified。

实现落在现有 `BlobStorage` 上：S3 `GetObject` 流式 hash，Supabase Storage `download` 后 hash。不新造存储、不把 zip 送进业务 API 的请求体。

**上限。** 包体 `size > 16 MiB` 时本轮仍只比 size（FC / 函数内存）。技能 zip 实际远小于这个数。超过的包能标 verified，但没有内容证明——见 §8。

## 5. Path A `verified` 与 Path B 对齐

`POST .../skill-blobs/prepare` 的 `requiresUpload = !prepared.verified`。

Path B 已经 `SELECT verified` 并返回。Path A 的 `prepareTeamSkillBlob` 在 `upsert ... ignoreDuplicates` 之后必须再读那一行，返回 `{ contentHash, size, ossKey, verified }`。`ignoreDuplicates` 保留已有行的 `verified=true`，所以第二次 prepare 同一个哈希会跳过 PUT。

这是内容寻址去重能工作的全部原因。缺了 `verified`，每个发布者都重新上传一份已经在桶里的字节。

## 6. 发布门里的 whenToUse / whenNotToUse

registry 文档 §6 曾经把这两个当必填，后来改成选填：空是一个真实答案，占位文案比空更糟。OpenAPI `TeamSkillPublish` 和 `requirePublishFields` 已经是选填。

表是 `when_to_use text NOT NULL`、无 DEFAULT。省略 → 应用层送 `undefined` → 驱动插 NULL → `23502`。

**对齐市场表：应用层缺省 `''`，OpenAPI 保持选填。**

```
未传 / undefined  → 存 ''
传 ""             → 存 ''
传空白            → trim 后存 ''
传非空            → trim 后存
```

`summary` / `category` / `changelog` 仍必填且非空。

drizzle schema 加上 `.default("")` 与市场表同构，标明意图。**本轮不生成 drizzle 迁移，也不改 supabase 的 `ALTER COLUMN ... SET DEFAULT`。** 线上表仍是 NOT NULL 无 DEFAULT；保护来自应用层插入 `''`。pglite bootstrap（`test/db/team-skills-bootstrap.ts`）补上 `DEFAULT ''`，让测试库和市场表一致。

## 7. 安装鉴权（OpenAPI 补第四道门）

代码里的门是四道，OpenAPI 只写了三道。真实规则（`assertCanInstallFor` / `assertCanInstallTeamSkillFor`）：

1. 目标是调用者自己的 member actor → 放行
2. 目标是调用者**拥有的 agent**（personal 或 team）→ 放行。成员自己的机器是 agent 不是 member；桌面端分享/发布要把安装记在那台机器的 actor 上
3. 目标是 `visibility='team'` 且调用者不是 owner → 要团队 admin
4. 目标是别人的 member actor → 一律拒绝

本轮只改 OpenAPI 描述，不改门本身。

## 8. 本轮不做（留下的债）

| 项 | 为什么留下 |
|---|---|
| drizzle 迁移给 `team_skills.when_to_use` / `when_not_to_use` 加 `DEFAULT ''`（postgres） | 应用层已经送 `''`；生成迁移会碰 `services/fc/src/db/migrations` 的整条链。线上无 DEFAULT 仍靠应用层 |
| supabase `ALTER COLUMN SET DEFAULT ''` | 同上，Path A 也靠应用层 |
| Path A `createTeamSkill` 做成 RPC 真事务 | 补偿删除覆盖主失败模式；RPC 要 supabase 迁移 |
| `listTeamSkillInstallerActorIds` 的 pg-repo 实现 | 只服务 MQTT 加速，MQTT 本轮不动 |
| MQTT 加速（`actor_notify` 把下次对账提前到现在） | 不做只是慢 10 分钟，registry 文档 §12 已标 |
| complete 对 >16 MiB 的包只比 size | 避免在 FC 里读进大对象。真要内容证明再加流式上限或服务端 KMS |
| 下载时再验 `verified` | 见下载契约 §5；新发布已经被 §3 挡住 |

## 9. 落地顺序

OpenAPI-first，然后两边 repo，然后测试：

1. OpenAPI：download 路径；元数据 GET summary；install 四道门；marketplace list 的 `limit`
2. Path A prepare 返回 `verified`
3. complete 在 size 之后 hash
4. createTeamSkill 包进事务 / 补偿删除，且要求 verified blob
5. createTeamSkillVersion 要求 verified blob
6. `whenToUse` / `whenNotToUse` 缺省 `''`
