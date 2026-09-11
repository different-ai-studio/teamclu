# Knowledge-only team sync via Supabase Storage — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 团队 knowledge 继续用现有 amuxd sync 引擎（冲突语义不变），blob 后端从阿里云 OSS 换皮到 Supabase Storage；删除 `oss` / `managed_git` / `custom_git` 三选一的**开通向导**与 git 同步路径，`share_mode` 列降级为「knowledge 同步是否已启用」的单一开关。

**Architecture:** 今日「OSS sync」已是 `amuxc_*` 元数据（Postgres）+ `/sync/*` 预签名 + daemon `sync/oss` 引擎。真正的阿里云依赖只在 [`services/fc/src/lib/oss.ts`](services/fc/src/lib/oss.ts)（S3 客户端指 `oss-cn-*.aliyuncs.com`）。换皮 = 把该层换成与 [`skills-storage.ts`](services/fc/src/lib/skills-storage.ts) 同构的 Supabase Storage signed URL；引擎、manifest、CAS、conflict sidecar、团队目录 + workspace symlink **不动**。

---

## 执行状态（2026-08-07 更新）

| Task | 状态 | commit |
|---|---|---|
| 0 · 修高水位推进 | ✅ 已完成 | `80f2d32f` |
| 1 · Blob 后端 → Supabase Storage | ✅ 已完成 | `0f13f84d` |
| 2 · 收窄前缀到 knowledge | ✅ 已完成 | `35ed6cb5` |
| 3 · `share_mode` 降级为单一开关 | ✅ 已完成 | `b363e907` |
| 4 · 删除 git / 三模式向导 | ⏸ **未动** | — |
| 5 · 删死掉的 `_meta` admin 路由 | ✅ 已完成 | `a12f3e06` |
| 6 · 客户端体验对齐 knowledge-only | ⏸ **未动** | — |
| 7 · 迁移 runbook | 📄 文档已写，**执行未做** | `85283ede` |
| 8 · 清理与门禁 | ◐ 测试已对齐，验证清单见下 | 分散在上述 commit |

**Task 4 / 6 为什么没做：** 这两个 Task 要删的正是当时工作区里正在被改的文件
（`EnableShareWizard.tsx` / `TeamGitConfig.tsx` / `TeamOssSyncStatus.tsx` /
`Settings.tsx`）。Task 4 会整个删掉 `TeamGitConfig.tsx`，那会连同未提交的改动
一起没掉。需要先确认那批改动的去向。

**Task 7 为什么只写不跑：** plan 的硬切安全设计是「先搬 blob → 跑完整性校验 →
校验通过才发 PR1」。一次性跑完等于把这个设计作废，代价是线上文件静默丢失。
runbook 在 `docs/deployment/knowledge-blob-migration.md`，执行是人的决定。

### Task 8 验证清单执行结果

- [x] pull 失败后 `last_server_seq` 不推进 — `next_high_water` 单测
- [x] `SyncStatus.failed` 存在并贯通到前端 store 与 CLI；**UI 展示未做**（在 `TeamOssSyncStatus.tsx`，属 Task 6 territory）
- [x] FC prepare/download 不再需要 `ACCESS_KEY_ID`（`/sync/*` 路径已零 `@aws-sdk` 引用）
- [x] 已 `verified` 的 hash 不触发存储查询 — `prepare: a verified blob short-circuits without touching storage`
- [x] daemon ALLOWED 仅 `knowledge/`；五个 retired 前缀 wire 仍接受
- [x] `team_skill_roots` 含 `~/.agents/skills`
- [ ] `share_mode` 非空的团队走同一视图 — **Task 4 未做**
- [ ] 非 owner 在 Knowledge 列的只读说明 — **Task 6 未做**
- [x] `TEAM_BLOBS_STORAGE_BUCKET` 在 `s.yaml` 和 compose 两处都声明
- [ ] bucket 在 self-host / belayo / copilot361 上确认存在 — **待执行**（runbook step 1）
- [x] prod-canary 探针已改为 `/v1/config/public`
- [ ] 双端 knowledge 冲突行为抽测 — **待执行**（需两台机器）

### 测试结果

- daemon `cargo test --bin amuxd`：**1039 passed / 0 failed**
- desktop `cargo test --lib oss_sync`（需 `CLOUD_API_URL`）：**20 passed / 0 failed**
- FC `npm test`：新增/改动用例全绿。仓库既有的 5 个红是本 plan 之前就存在的：
  `deploy-env-parity` 的三条（`FC_SUPABASE_*` / `TRUSTED_EXTERNAL_JWT_SECRET`
  来自 `9cf5db90`）、`enableShareMode switches mode on the same team`（DB 触发器
  本来就禁止改，contract 测试与新语义相悖，属 Task 8 尾巴）、
  `getWorkspaceConfig.llm proxies gateway models`

---

## Agreed decisions

第一轮 grill（2026-08-07 上午）：

| 项 | 结论 |
|---|---|
| 产品面 | skills / MCP / env 继续 Cloud API，不靠团队盘 |
| knowledge | 必须本地树（RAG） |
| 远程 | 唯一 Supabase Storage |
| 引擎 | 复用现有 OSS sync 换皮，不新写第三条路径 |
| 本地布局 | 保留「团队一份副本 + 多 workspace symlink」 |

第二轮 grill（2026-08-07 下午）——**以下结论推翻或收紧了第一轮的若干条，实施时以此表为准**：

| 项 | 结论 | 推翻了什么 |
|---|---|---|
| 开通 | **保留开关**，复用现有 `share_mode` 列；Knowledge 第二列在未开启时引导开启 | 推翻「无向导；有团队即有」——无条件放开会让**所有存量团队**在每台成员机器上凭空创建目录并开始 tick |
| `share_mode` 语义 | 开启写 `oss`（ENUM 只有三值且 `guard_team_share_mode()` 锁死修改）；加列注释说明历史名称；**开了不可关闭** | — |
| `GET /share-mode` | 恒返回 `oss`，**不是 `storage`** | 推翻 Task 3 原方案。客户端 `normalizeShareStatus`（`team-share.ts:22-42`）会把未知值潰成 `mode: null`，`TeamSection.tsx:156,180-190` 据此渲染**开通向导**——正是本 plan 要删的那个 |
| 同步前缀 | 最终**只剩 `knowledge/`**；`_meta/` `_feedback/` 一并 retire | 推翻「`_meta`/`_feedback` 本 phase 仍同步」。见下方「前缀的真相」 |
| 旧 blob | 切换前**强制迁移**，不做双读；**硬切**，不做 sync 暂停机制 | 「双读可选」不成立——见下方「为什么硬切需要 Task 0」 |
| self-host 存储 | 先用现有 file backend（ECS 本地盘）验证；Task 1 就写死迁移阈值 | — |
| 前置修复 | **新增 Task 0**：修 `last_server_seq` 无条件推进 | 新增。这是硬切唯一有效的兜底 |

### 前缀的真相（为什么 `_meta` / `_feedback` 也要 retire）

- **`_feedback/`：纯死目录。** 全仓唯一涉及它的是 `team_git.rs:249` 建空目录、`:106-107` 的 gitignore 白名单、和两个路径校验测试。**零写入代码。**
- **`_meta/`：有两条路径，同步的那条即将没人写。**
  - 同步的那份：`_meta/members.json` 只有 `team_git.rs:466-473` 在 join 时写——**git 模式限定**，Task 4 删掉 git 路径后就没人写了。
  - 真正在用的那份：FC 用 `ossPut`/`ossGet` **直连阿里云 OSS key**（`admin-handlers.ts:60,109,188,217`），服务 `/register`、`/token`、`/apply`（`app.ts:156-160`），**不走 `amuxc_files` manifest**。
  - 这三条路由**已经死了**：`/register`、`/apply` 全仓零调用方；`/token` 唯一的非定义引用是 `prod-canary.yml:56-57` 的存活探针，且只断言"空 body 返回 400"、**不走 `ossGet` 分支**。它那套 `_meta/members.json` → owner/manager/editor/member 的角色体系，与今天 `team_members.role` / `actors` 的体系完全平行、零交集。`services/fc/test/` 零覆盖。
  - → 一并删除（Task 5）。**但这不等于 `_meta` 的阿里云依赖归零**：`handleManagedGitSetupLitellm`（`admin-handlers.ts:217`）仍读 `_meta/team.json`，且 `_registry/auth.json` 被两条路由读写。本 plan 只保证 **`/sync/*` 路径**零依赖阿里云——见「已知遗留」。

### 为什么硬切需要 Task 0

`sync-handlers.ts:596-623` 的 download **从不验证对象是否存在**，只查 `amuxc_blobs` 的数据库行就无条件签发 URL。切到空 bucket 后服务端返回 **200 + 指向不存在对象的签名 URL**。

而 daemon 侧 `engine.rs:174-179`：

```rust
let pulled = pull_phase(content_root, &key, fc, &mut state, pull_items).await;
if let Some(seq) = snapshot_seq {
    state.last_server_seq = seq;   // ← 不看 pulled 是否等于 pull_items.len()
}
```

高水位**无条件推进**。下一 tick 用 `since_seq = last_server_seq` 拉 manifest，服务端 `oss-sync.ts:342` 是 `gt(changeSeq, afterSeq)`——**失败的文件永远不会再出现在 manifest 里**。配套事实：

- 失败不计入 `stats.deferred`，tick 照常返回 `Ok`
- `SyncStatus`（`dispatch.rs:238-245`）**没有 failed / error 字段**，UI 只看到 `pulled` 偏小
- 重试只包住 FC 的 batch 调用，不包 blob GET；404 不算 transient（`is_transient` 只认 429/503/timeout）
- 首次拉取失败 = 本地什么都不留，之后也不补
- 恢复只能人工删 `~/.amuxd/teams/<id>/sync/state.json` 的 `lastServerSeq`

**所以硬切的代价不是"报错后重试"，是"同步报成功、文件静默不更新"。** 且先迁后发 / 先发后迁两种顺序都会踩到——不存在"窗口后自动恢复"这个选项。

Task 0 把这个风险类别整体消掉，比校验脚本、双读、停机窗口加起来都有效。它同时是一个**独立于本次切换的现存 bug**：今天任何一次网络抖动都会触发。

---

## Non-goals

- 不做 git 三方合并
- 不把 skills/MCP/env 搬回文件同步
- 不引入 MinIO / 第二套对象存储 / 新 sync 协议
- 本 plan 不改 RAG / Tantivy 本身
- **不修 pg-repo 的 `enableShareMode` 权限洞**（见「已知遗留」）——单开 PR，避免混淆本 plan 的风险面

---

## 现状速查（实施前必读）

```
daemon tick() ──► FC /sync/manifest|prepare|complete|download|delete
                      │
                      ├─ Postgres: amuxc_files / amuxc_blobs / versions（已有）
                      └─ Blob PUT/GET: oss.ts → 阿里云 OSS（要换）
```

- 引擎：[`apps/daemon/src/sync/oss/engine.rs`](apps/daemon/src/sync/oss/engine.rs)
- 前缀：[`path_validator.rs`](apps/daemon/src/sync/oss/path_validator.rs) — `.mcp/` `_secrets/` 已 retired，`RETIRED_PREFIXES` 机制现成（wire 接受、scanner 不推、pull skip）
- 门闩：[`team_link.rs`](apps/daemon/src/team_link.rs) — `share_mode` 非空才 `Enabled`（**保留此语义**）
- Skills 先例：[`skills-storage.ts`](services/fc/src/lib/skills-storage.ts) 已用 Supabase Storage + 同一 `amuxc_blobs` 路径约定

---

## Task 0: 修高水位推进 —— 硬切的前置兜底

> **必须先于 Task 1 上线并观察数日。** 与 PR1 同批发就等于没有兜底：硬切当天它自己还没被验证过。

**Files:**
- Modify: `apps/daemon/src/sync/oss/engine.rs`（`:174-179` 高水位推进）
- Modify: `apps/daemon/src/sync/dispatch.rs`（`SyncStatus` 加 `failed` 计数）
- Test: daemon sync 单测——构造一个 pull 失败，断言 `last_server_seq` 未推进且下一 tick 会重新拉到它

**Step 1: 失败就不推进高水位**

```rust
if let Some(seq) = snapshot_seq {
    // 只有整批 pull 成功才推进。否则下一 tick 会重新拉到同一批并重试——
    // 代价只是对已成功的文件多做一次版本比对（needs_download 会跳过，不重传）。
    if pulled == pull_items.len() {
        state.last_server_seq = seq;
    }
}
```

**Step 2: `SyncStatus` 加 `failed` 计数**，让失败第一次变得可观测（今天只有 `warn!` 日志）。

**Step 3: 单测**
- pull 失败 → `last_server_seq` 保持旧值
- 下一 tick 的 manifest 请求带的是**旧** `since_seq`，该文件仍在结果里

**Step 4: Commit**

```bash
git commit -m "fix(sync): stop advancing the high-water mark past a failed pull"
```

---

## Task 1: Blob 后端抽象 → Supabase Storage

**Files:**
- Create: `services/fc/src/lib/team-blob-storage.ts`（从 skills-storage 抽出通用 signed URL）
- Modify: `services/fc/src/lib/sync-handlers.ts`（prepare/download 改调新 helper，不再 `getS3Client`）
- Modify: `services/fc/src/lib/skills-storage.ts`（薄封装调同一 helper，避免两套）
- Modify: **`deploy/belayo/cloud-api.env.keys` 和 `deploy/self-host/docker-compose.yml` 的 `environment:` 两处都要加** `TEAM_BLOBS_STORAGE_BUCKET`；顺手补上今天缺失的 `SKILLS_STORAGE_BUCKET`
- Test: `services/fc/test/` 新增或扩展 sync prepare/download 单测（mock storage）

> **两个部署目标都要声明。** `s.yaml:103-113` 明写 `s deploy` 会**整个覆写 environment map**——没声明的 env 到不了生产。`SKILLS_STORAGE_BUCKET` 今天两边都没声明，靠 default 活着，已经违反了 CLAUDE.md 的要求。

**Step 1: 抽出存储 helper**

```ts
// team-blob-storage.ts — 与 skills 同构
export const TEAM_BLOBS_BUCKET = () =>
  process.env.TEAM_BLOBS_STORAGE_BUCKET || "team-blobs";

export async function createBlobUploadUrl(objectPath: string): Promise<string> { /* createSignedUploadUrl upsert */ }
export async function createBlobDownloadUrl(objectPath: string, expiresIn = 900): Promise<string> { /* createSignedUrl */ }
export async function headBlob(objectPath: string): Promise<{ size: number } | null> { /* list+search like skills */ }
```

对象路径保持现有 `teams/<teamId>/blobs/sha256/<aa>/<bb>/<hash>`（`amuxc_blobs.oss_key` 列名不改，避免大迁移；注释注明 historical name）。

**Step 2: sync-handlers 换皮**

- `prepare` / `prepare-batch`：`presignedPut = await createBlobUploadUrl(ossKey)`
- `download` / `download-batch`：`presignedGet = await createBlobDownloadUrl(ossKey)`
- 删除本路径对 `@aws-sdk/client-s3` / `oss.ts` 的依赖

**Step 3: dedupe 改成先问数据库**

今天 `prepare` 靠 **HEAD 阿里云对象 + 比对 size** 决定 `requiresUpload`。换后端后等价能力只能靠 `list + search`，而 knowledge sync 的调用频率比 skills 高一个量级（skills 是安装时一次，sync 是每 tick 每个变更文件）。

→ **`prepare` 先查 `amuxc_blobs` 那一行的 `verified`，只有行不存在或未 verified 时才去问存储。** 数据库是权威（CAS 的 hash 已保证内容唯一），`headBlob` 只用于兜底。这样每 tick 的存储调用量不升反降，`verified` 的含义也从"我刚 HEAD 过"变成"曾经确认写入成功"——后者才是它实际被当作的东西。

**Step 4: 单测**

- mock `createBlobUploadUrl` / `createBlobDownloadUrl`
- 断言 prepare 返回的 URL 来自 mock，且不再要求 `ACCESS_KEY_ID`
- 断言已 `verified` 的 hash **不触发**任何存储查询

**Step 5: self-host 运维 + 磁盘阈值**

- 在 Supabase 创建 private bucket `team-blobs`（新建，不与 `team-skills` 共用，避免 RLS/policy 纠缠）
- **逐个部署确认 bucket 真实存在**：self-host / belayo / copilot361。bucket 是 SQL migration 建的（见 `20260806010000_team_skills_storage_bucket.sql`），而 belayo 是**手工迁移 + `_selfhost` 账本**——未必跑过
- **写死迁移阈值**：self-host 的 storage 是 `STORAGE_BACKEND: file` + `FILE_STORAGE_BACKEND_PATH: /var/lib/storage`（`deploy/self-host/supabase/docker-compose.yml:277-316`），落在 ECS 本地盘、和 Postgres 同盘。CAS 只增不减（`cron.ts:66-90` 的 GC 只清 7 天前的**孤儿** blob，被引用的历史版本永久保留）。→ **加磁盘告警，并在 runbook 写明：storage volume 达到 20GB 或盘容量 50% 时必须迁 `STORAGE_BACKEND: s3`。** 没有阈值的"后面会迁"，实际结局是盘满了才迁。
- 验证：本地 FC 对一测试 team 跑 prepare → PUT → complete → download

**Step 6: Commit**

```bash
git commit -m "feat(fc): serve team sync blobs from Supabase Storage"
```

---

## Task 2: 收窄同步前缀到 knowledge

**Files:**
- Modify: `apps/daemon/src/sync/oss/path_validator.rs`
- Modify: `apps/desktop/src/commands/oss_sync/path_validator.rs`（镜像）
- Modify: `apps/daemon/src/config/global_team_store.rs` (`SHARED_PREFIXES`)
- Modify: `services/fc/src/lib/sync-path.ts`（服务端校验镜像）
- **Modify: `apps/daemon/src/config/roles_skills.rs`（`collect_team_skill_paths`）— 见 Step 2，不可省略**
- Test: daemon path_validator 单测；FC sync-path 单测

**Step 1: 更新 ALLOWED / RETIRED**

```rust
pub const ALLOWED_PREFIXES: &[&str] = &["knowledge/"];
pub const RETIRED_PREFIXES: &[&str] = &["skills/", ".mcp/", "_secrets/", "_meta/", "_feedback/"];
```

`RETIRED` 必须继续**在 wire 上被接受**：pull 循环里是 `validate(&item.path).map_err(SyncError::from)?`，硬 `?`，而 `SyncError::InvalidPath` 是非瞬时错误、永不自愈。一条遗留记录就会中止整个 manifest apply，把本该继续同步的 `knowledge/` 一起带走。

**Step 2: 同时把 `~/.agents/skills` 纳入 `team_skill_roots()` —— 否则是静默功能回归**

retire `skills/` 会让 Claude runtime 的团队 skill **直接消失**：

- `claude_skills.rs:22-55` 只消费 `team_skill_roots()` 的结果建 `.claude/skills/` symlink，**空了就在 `:24` prune 掉全部 team symlink**
- `collect_team_skill_paths`（`roles_skills.rs:349-390`）在 `:384-390` 无条件 push `teamclu-team/skills`，**且返回值不含 `~/.agents/skills`**
- registry 装出来的 skill 落在 `~/.agents/skills`，只能经 `skills.paths` 到 OpenCode（`supervisor.rs:579-595`），**到不了 `claude_skills` 这条 symlink 路径**

→ 把 `~/.agents/skills` 加进 `collect_team_skill_paths` 的返回值。这和前缀收窄是**同一次行为变更的两半**，不能拆到后续 PR。

**Step 3: 跑既有 daemon/FC 单测，修断言**

**Step 4: Commit**

```bash
git commit -m "refactor(sync): narrow file sync to knowledge/ only"
```

---

## Task 3: `share_mode` 降级为单一开关

> **不是废除门闩。** 门闩保留，只是从「三选一模式」简化成「开 / 未开」。

**Files:**
- Modify: FC `GET /v1/teams/:id/share-mode` + OpenAPI
- Modify: `services/fc/src/lib/routes/team-share.ts`（`POST` 保留并简化，`DELETE` → 410）
- Migration: **只加注释，不改数据**
- Test: FC team-share 单测

**目标语义：**

- `share_mode IS NULL` → 未启用 knowledge 同步
- `share_mode` 非空（任意值）→ 已启用
- `POST /share-mode` **保留**，但只接受/写入 `oss`
- `DELETE /share-mode` → **410**（Q3 决定：开了不可关闭）
- `GET /share-mode` → 恒返回 `{ mode: "oss", ... }`

**为什么是 `oss` 而不是 `storage`：** `amux.team_share_mode` 是只有三值的 ENUM（`baseline.sql:55`），且 `guard_team_share_mode()`（`:1994-2003`）拒绝修改已设置的值。更要命的是客户端 `normalizeShareStatus`（`team-share.ts:22-42`）会把未知值**潰成 `mode: null`**，`TeamSection.tsx:156,180-190` 据此渲染开通向导——返回 `storage` 会让所有已启用的团队显示成"未开通"并弹出本 plan 正要删的向导。

**Step 1: 加列/类型注释**

```sql
COMMENT ON COLUMN amux.teams.share_mode IS
  'Historical name. Today it only means "team knowledge sync is enabled"; the only backend is Supabase Storage. Values other than oss are legacy rows.';
COMMENT ON TYPE amux.team_share_mode IS
  'Historical. See teams.share_mode — the three values no longer select a backend.';
```

**不要写 `UPDATE teams SET share_mode = 'storage'`**：`'storage'` 不在 ENUM 里，且触发器会拒绝修改已设置的值。这条语句会失败两次。

**Step 2: `POST` 简化为写 `oss`；`DELETE` 返回 410**

权限保持 **owner-only**（`supabase-repo.ts:760` 的 `requireCallerTeamOwner`）。

**Step 3: 单测**

**Step 4: Commit**

```bash
git commit -m "feat(team-share): reduce share_mode to a single knowledge-sync switch"
```

---

## Task 4: 删除 git / 三模式向导

**Files:**
- Remove: `EnableShareWizard` 的三模式选择（改为单一「启用团队知识库同步」确认）
- Remove: `TeamGitConfig.tsx`
- Modify: `TeamSection.tsx` — 分支条件从 `isOss = shareMode === 'oss'` 改成**「非空」**
- Remove or stub: `apps/desktop/src/commands/team_share/enable.rs` 的 `enable_managed_git` / `enable_custom_git`
- Remove/停用: daemon `team_shared_git` 在团队共享目录路径上的 setup/sync
- Modify: desktop `team_sync_proxy` — git 相关 command 返回明确错误或转发到 `oss_sync_now`

**为什么分支要改成「非空」：** `share_mode` 是 `managed_git` / `custom_git` 的存量团队按新逻辑算"已启用"，但 `TeamSection.tsx:194-197` 是按 `=== 'oss'` 分支的——他们会被路由到正要删的 `TeamGitConfig`。改成「非空」后三类团队走同一个视图，**不用动数据库**。

**Step 1: UI 去掉三模式向导**
**Step 2: 分支条件改「非空」，删 `TeamGitConfig`**
**Step 3: daemon 启动路径不再 `setup_or_sync_shared_dir` for git modes**
**Step 4: OpenAPI 更新；changelog**

**Step 5: Commit**

```bash
git commit -m "feat(team-share): remove git share modes and the three-way wizard"
```

---

## Task 5: 删除死掉的 `_meta` admin 路由 + 同步改 canary

**Files:**
- Remove: `services/fc/src/lib/admin-handlers.ts` 的 `handleRegister` / `handleToken` / `handleApply`
- Modify: `services/fc/src/app.ts:156-160`（去掉路由注册）
- **Modify: `.github/workflows/prod-canary.yml:56-57`**
- Modify: `docs/deployment/full-backend-stack.md:379-380`
- **Remove: `services/fc/src/lib/sts.ts` 整个文件** —— 唯一导入方是 `admin-handlers.ts:6-11`，调用点只在 `handleRegister:72-74` 和 `handleToken:105-124`。删掉这两条路由后无任何调用方。连带可移除 `@alicloud/sts20150401` / `@alicloud/openapi-client` 依赖（注意 `index.ts:68` 另有独立的 `process.env.ROLE_ARN` 用法，别一起删）
- **保留: `services/fc/src/lib/oss-store.ts`** —— 不能删，见下
- Remove: `oss-store.ts` 的 `verifyTeam`（`:63`）—— **已经是死代码**，全仓只有定义和 import；文件头注释「used by the AI/managed-git handlers」已过时。`ossInfo` 在删掉本 Task 的路由后同样变死代码，一并清理

**`oss-store.ts` 为什么必须留：** 它还有两条**本 plan 不动**的路由在用，且都读写阿里云上的 `teams/<id>/_registry/auth.json`：

- `handleResetSecret`（`/reset-secret`，`app.ts:158`）—— `:138,143,153,154`
- `handleManagedGitSetupLitellm`（`/managed-git/setup-litellm`，`app.ts:161`）—— `:203,204,211,217`，**且 `:217` 仍读 `_meta/team.json`**

所以 `_registry` 是活的，`_meta/team.json` 也仍有一个读者。这直接影响完成定义的措辞——见下方「已知遗留」。

> `/managed-git/setup-litellm` 与 Task 4 要删的 managed_git 模式是否相关、删模式后它是否还需要，**实施时需确认**。本 plan 不动它。

**canary 必须同批改：** 现在它断言 `POST /register` 和 `POST /token` 返回 **400**，路由删掉后会返回 404，CI 直接红。换成仍然活着的免鉴权端点（如 `/v1/config/public`）。**别只删路由不动 canary**——那会变成部署后才发现的失败，而第一反应通常是怀疑部署本身。

**Commit:**

```bash
git commit -m "chore(fc): delete the dead _meta admin routes and retarget the canary"
```

---

## Task 6: 客户端体验对齐 knowledge-only

**Files:**
- `packages/app/src/stores/team-share.ts`
- `packages/app/src/components/settings/team/*`
- `packages/app/src/components/sidebar/TeamShareListColumn.tsx`（Knowledge 第二列）
- i18n：去掉「选择 OSS / Git」文案；同步状态改称「团队知识库」

**Knowledge 第二列承担两件事：**

1. **未启用 → 引导开启。** 按角色分文案：owner 看到可点的「启用团队知识库同步」；**普通成员看到只读说明「该团队尚未启用，请联系管理员」**——开启是 owner-only（`supabase-repo.ts:760`），给成员一个点不动的按钮比不显示更糟。
2. **已启用且有失败 → 显示「N 个文件未能同步」+ 重试入口。** 消费 Task 0 加的 `failed` 计数；重试 = 回退 `lastServerSeq` 并触发一次 tick。放在这里而不是 Settings 的同步面板——Settings 是排查用的，这个信息要出现在用户**看文件的地方**。

**验证：**

- 新团队：Knowledge 列显示引导；owner 点击后 workspace 下出现 `teamclu-team/knowledge`
- 非 owner 成员：看到只读说明，无可点按钮
- 两台设备改同一 md → 仍出现既有 conflict sidecar 行为
- skills / MCP / env UI 仍走 Cloud API，不写回 `skills/` 目录同步

**Commit:**

```bash
git commit -m "feat(ui): knowledge-only team share copy, gating and failure surface"
```

---

## Task 7: 迁移与兼容

**Files:**
- Migration runbook（`docs/` 短文或更新 `team-mcp-and-env-cloud.md`）
- 迁移完整性校验脚本

**Step 1: 写迁移 runbook**

硬切顺序（Q13：不做 sync 暂停机制）：

1. 跑 `rclone` 把 `teams/*/blobs/**` 从阿里云 bucket 拷进 Supabase bucket
2. **跑完整性校验脚本**：遍历 `amuxc_blobs` 每一行的 `oss_key`，逐个确认对象在新 bucket 里存在，输出缺失清单
3. 校验通过（或缺失清单被明确接受）后，才发 PR1
4. 依赖 Task 0 兜住窗口期内的失败——**没有 Task 0 就不要硬切**

**Step 2: managed_git / custom_git 存量队**

最后一次把 `knowledge/` 检出后放进本地 team dir，靠 sync push 进 Storage。

**Step 3: self-host（api.teamclu-dev）先切，确认无阿里云密钥时 sync 仍可用**

**Step 4: belayo / copilot361 评估**——本 plan 只保证 `/sync/*` 路径不依赖阿里云；attachments / apps 仍用 `oss.ts`

**Commit:**

```bash
git commit -m "docs: knowledge storage migration runbook"
```

---

## Task 8: 清理与门禁

**Files:**
- 测试：删掉 EnableShareWizard 三模式用例；更新 TeamShareSection / daemon team_link / FC share-mode tests
- `docs/openapi/teamclu-api.v1.yaml` 与契约测试
- CI：`pnpm daemon:test`、`services/fc` node test、相关 vitest
- 可选 rename：`sync/oss` → `sync/team_files`（大 diff，**另 PR**）

**验证清单：**

- [ ] **pull 失败后 `last_server_seq` 不推进，下一 tick 会重试**（Task 0 的核心断言）
- [ ] `SyncStatus.failed` 在 UI 上可见
- [ ] FC prepare/download 无 `ACCESS_KEY_ID` 仍通过
- [ ] 已 `verified` 的 hash 不触发存储查询
- [ ] daemon ALLOWED 仅 `knowledge/`；`skills/` `_meta/` `_feedback/` 进 retired，且 wire 仍接受
- [ ] retire `skills/` 后 Claude runtime 仍能看到 registry 装的 team skill
- [ ] `share_mode` 非空的团队（含 git 存量）都走同一个同步状态视图
- [ ] 非 owner 成员在 Knowledge 列看到的是只读说明
- [ ] `TEAM_BLOBS_STORAGE_BUCKET` 在 `s.yaml` 和 compose 两处都已声明
- [ ] 目标 bucket 在 self-host / belayo / copilot361 上都确认存在
- [ ] prod-canary 通过（探针已改）
- [ ] 双端 knowledge 冲突行为与换皮前一致（抽测）

**Commit:**

```bash
git commit -m "test: align team-share suite with storage-only knowledge sync"
```

---

## 建议 PR 切分

| PR | 内容 | 风险 |
|---|---|---|
| **PR0** | **Task 0 高水位修复 + `failed` 计数** | 低 — 独立 bug 修复。**必须先发并观察数日**，它是硬切的唯一兜底 |
| PR1 | Task 1 blob → Supabase Storage | **高** — 硬切：上线瞬间旧 blob 不可达，依赖 PR0 的重试兜底 + 迁移脚本已跑完并通过校验 |
| PR2 | Task 2 前缀收窄（含 `team_skill_roots` 修复） | 中 — 漏掉 `~/.agents/skills` 就是 Claude team skill 的静默回归 |
| PR3 | Task 3–4 share_mode 降级 + 删向导 | 中 — 产品行为变化 |
| PR4 | Task 5 删死路由 + canary | 低 |
| PR5 | Task 6 UI | 中 |
| PR6 | Task 7–8 迁移文档 + 测试清理 | 低 |

---

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| **硬切窗口内 pull 失败 → 永久静默丢失** | **Task 0**（高水位不越过失败）+ 迁移完整性校验脚本。二者缺一不可 |
| Supabase Storage 吞吐/限流不如阿里云 OSS | 保持现有 batch + `BLOB_CONCURRENCY`；监控 429；Task 1 Step 3 的 dedupe 改动会**降低**调用量 |
| self-host blob 落在 ECS 本地盘且只增不减 | Task 1 Step 5 的磁盘告警 + 写死阈值；到线即迁 `STORAGE_BACKEND: s3` |
| 目标 bucket 在某个品牌部署上不存在 | Task 1 Step 5 逐个部署确认；env 两处都声明 |
| `oss_key` 列名与 `share_mode` 值名误导后续开发 | 列/类型注释（Task 3 Step 1）；rename 另 PR |
| attachments / apps 仍用 `oss.ts` | 明确 scope：本 plan 只切 `/sync/*` |

---

## 已知遗留（不在本 plan 范围）

- **pg-repo 的 `enableShareMode` 没有权限检查。** `pg-repo/teams.ts:152-170` 没有 `ctx` 形参、不调 `requireTeamOwner`，路由层也不查——`BACKEND_KIND=postgres` 下任何通过鉴权的调用者（含非成员）都可能开启别人团队的 share mode，而这个动作**不可逆**。同一个 `disableShareMode` 两个后端却都是 owner-only，说明是遗漏而非设计。生产走 supabase 后端，所以现网大概率未被利用。**单开 PR 修**（加 `ctx` + `requireTeamOwner` + 非 owner 被拒的测试）。
  > 此结论由代码结构推断，未做运行时验证，也未通读 `/v1/teams/:id/*` 的全部中间件链。动手前值得先坐实。
- **`_registry/auth.json` 与 `_meta/team.json` 仍在阿里云上。** 删掉三条死路由后，`oss-store.ts` 依然被 `/reset-secret`（`admin-handlers.ts:138,143,153,154`）和 `/managed-git/setup-litellm`（`:203,204,211,217`）使用。要让 FC 完全脱离阿里云，还需要把这两条路由的 `_registry` / `_meta` 存储也迁走——**另开 plan**。
- `oss.ts` 仍服务 apps 部署（`index.ts:24`）与 attachments（`pg-repo/attachments.ts:6`）。sync 改完后 `ACCESS_KEY_SECRET` 只剩 `oss.ts:22` 内部使用（`ACCESS_KEY_ID` 另在 `index.ts:63`、`provisioning/fc-client.ts:51` 直接读 env）。
- `ChatPanel.tsx:954` 仍有监听 `${TEAM_REPO_DIR}/_meta/provider.json` 的死分支（该文件早已删除）
- `apps/desktop/src/commands/team.rs:110-120` 的 `workspace_read_team_meta` 已注册但前端无调用方

---

## 完成定义

1. **`/sync/*` 路径**零依赖阿里云 OSS 凭证与 git remote。
   > 刻意不写成「FC 零依赖阿里云」——那不成立，而且**验收时才发现比现在写清楚贵得多**。`oss.ts` 仍服务 apps 部署（`index.ts:24`）和 attachments（`pg-repo/attachments.ts:6`）；`oss-store.ts` 仍服务 `/reset-secret` 与 `/managed-git/setup-litellm` 的 `_registry/auth.json` + `_meta/team.json`。这些都在本 plan 范围外。
2. `share_mode` 降级为单一开关；无三模式向导；owner 可一键启用，成员看到明确说明。
3. 冲突/版本语义与现 OSS sync 一致（复用引擎）。
4. **pull 失败不再永久静默丢失**——失败会重试，且在 UI 上可见。
5. skills / MCP / env 仍仅 Cloud API。
