# 团队 Skill 退役与硬删

- **Date**: 2026-09-16
- **Status**: APPROVED
- **Scope**: Cloud API（FC + RLS）、桌面端 Team Share skills 列表/详情、OpenAPI、registry 设计文档勘误
- **Non-scope**: MQTT 加速对账、blob GC、发布审批、per-member skill ACL、iOS / Expo 管理面、强制「先退役再硬删」
- **Extends**: `docs/architecture/team-skills-registry.md` §5（鉴权）和 P3（deprecated UI）
- **Related**: `docs/openapi/teamclu-api.v1.yaml` `deleteTeamSkill` / `updateTeamSkill`、`docs/features/06-skills-roles-marketplace.md` §25、knowledge ACL 的 `requireTeamAdmin`

---

## 0. 一句话

默认动作是退役（包还在，agent 还能用）。硬删是管理员二次确认后的不可逆操作。两者都只给团队 owner / admin。发布、发新版、卸载自己的包，仍对任意成员开放。

---

## 1. 现状

Registry、删除 API、成员/daemon 对账、输入 slug 确认框都已经存在。缺的是产品分层和权限收口。

| 能力 | 现状 |
|---|---|
| `DELETE /v1/teams/:id/skills/:slug` | 硬删 registry 行；`team_skill_versions` / `team_skill_installs` cascade |
| 对账 | 行消失 → `retiredSlugs` → 卸包；脏包 `kept`；拉列表失败 fail-closed |
| 列表垃圾桶 | `DeleteTeamSkillDialog` 已写好；`deletableSlug` 被写死为 `undefined` |
| 详情 Delete | 只删个人 pack，registry 路径只有 Uninstall |
| `PATCH` `status: deprecated` | API 有；P3 UI 未完成 |
| 鉴权 | 2026-08-13 起任意成员可 update / delete（`20260813000000_team_skills_member_writes.sql`） |

硬删没有 tombstone 表。列表里没有 = 被删了。不要为 skills 引入知识库那套 OSS tombstone：skills 已经离开 team-sync，权威在 Postgres。

---

## 2. 决策

| # | 决定 | 为什么不是另一个 |
|---|---|---|
| D1 | 两级生命周期：退役默认，硬删高摩擦 | 原架构把 `deprecated` 写成主退休路径，正是因为「正在跑的流程突然失能，比多留一个废 skill 更糟」。硬删管线已经存在，不必再造一套。 |
| D2 | 允许跳过退役直接硬删 | 测用 slug、发错的包不值得先打标。摩擦靠输入 slug，不靠强制两步。 |
| D3 | 「团队管理员」= owner 或 admin（`current_team_role` RPC；`roles_users` SoT，不是直接读 `team_members.role`） | 与知识库 ACL 同一道门：前端 `canManageTeam`，后端 `requireTeamAdmin`。不是 owner-only，也不是 `admin` 不含 owner。 |
| D4 | `owner_actor_id` 不能退役、不能硬删 | 那是负责人展示，不是写 ACL。比 issue-1026「创建者或 admin」更紧，也比 2026-08-13「任意成员」更紧。 |
| D5 | 只收口退役和硬删。发布 / 发新版 / revert / 改 summary 等仍对成员开放 | 2026-08-13 翻案的理由仍成立：registry 是团队资产，成员发现错步却改不了，唯一出口是换 slug 发重复品。发布门是必填字段，不是审批人。 |
| D6 | 卸载仍是 per-actor | 「我不要」和「团队不要了」必须分开。管理员卸自己的包，不等于删 registry。 |
| D7 | 应用层 + RLS/trigger 同时拦 | FC 用调用者 JWT 打 Supabase，RLS 会生效；只藏 UI 不够。PATCH 同一端点既改元数据又改 status，RLS 的 USING 分不清列，status 变更用 trigger。 |
| D8 | 不做 blob GC、不做 MQTT | 内容寻址 + 市场命名空间不能随便扫。对账最多慢约 10 分钟，本范围不修。 |

---

## 3. 生命周期

```
published ──退役──► deprecated ──恢复──► published
    │                    │
    └────硬删────► 行消失（版本与安装记录 cascade）
                         ▲
                    deprecated 也可直接硬删
```

**退役。** 只从 `published` 出发。`PATCH` `{ status: "deprecated", supersededBy?: slug | null }`。对账把它当普通 registry 行：不进 `retiredSlugs`，不卸包，不自动安装 `supersededBy`。列表 muted + Archive 角标；详情提示替代者。安装按钮保持可点、样式降为次要（现状已是 muted）——旧流程可能还依赖它。`draft` 不提供退役，只提供硬删。

**恢复。** 只从 `deprecated` 回到 `published`。管理员 `PATCH` `{ status: "published", supersededBy: null }`。不回到 `draft`。

**硬删。** `DELETE`。输入 slug 确认。本机立刻 reconcile；其他成员下一次 10 分钟 tick 卸包。脏包 `kept`，变成个人 skill，toast 告诉操作者。当前会话不立刻丢工具，要 Apply / 新 session。Daemon 侧不做脏改保护（已有不对称）：宿主 agent 下次对账会卸掉。

---

## 4. 权限矩阵

| 操作 | member | owner / admin |
|---|---|---|
| 浏览、安装给自己、卸载自己 | 是 | 是 |
| 发布 / 发新版 / revert / 改 summary·category·when_to_use 等 | 是 | 是 |
| 转交 `ownerActorId` | 是 | 是 |
| 给团队 `visibility=team` 的 agent 装/卸 | 现有规则（agent owner 或团队 admin） | 同左 |
| `PATCH` `status` / `supersededBy` | **否 → 403** | 是 |
| `DELETE` registry 行 | **否 → 403** | 是 |

403 文案：`team owner or admin access required`（与 knowledge ACL 同句，便于前端识别）。错误码 `forbidden`。

Daemon 以 agent actor 鉴权，不是 `team_members` 里的 owner/admin，不能走这两条写路径。这是预期：托管 agent 不对账删除 registry。

---

## 5. API 与存储

不新增端点。继续用：

- `PATCH /v1/teams/{teamId}/skills/{slug}` — 退役 / 恢复 / 改元数据
- `DELETE /v1/teams/{teamId}/skills/{slug}` — 硬删

### 5.1 应用层（`services/fc/src/lib/supabase-repo.ts`）

在 repository 上实现与 knowledge ACL 相同谓词的 `requireTeamAdmin(teamId)`：

1. `resolveCallerActorForTeam(teamId)` — 解析调用者 actor
2. `rpc("current_team_role", { target_team_id: teamId })` — 与 knowledge ACL 相同，`roles_users` 为 SoT
3. 返回值不是 `owner`/`admin` → `ApiError(403, "forbidden", "team owner or admin access required")`

调用点：

- `deleteTeamSkill`：一律先 `requireTeamAdmin`。PostgREST 在 RLS 挡住 DELETE 时经常 0-row 静默成功、不抛 42501，所以 403 必须来自这一层，不能靠 delete 的 error。
- `updateTeamSkill`：patch 含 `status` 或 `supersededBy`（含显式 `null`）时先 `requireTeamAdmin`；只改 summary 等则不过这道门。trigger 若仍以 `42501` 拒绝，把 supabase-js error 映射成 `ApiError(403, "forbidden", …)`（`revertTeamSkillVersion` 已有同样映射；当前 `updateTeamSkill` / `deleteTeamSkill` 还没有）。

本轮不强制把 knowledge-acl 的私有函数抽出来复用；谓词必须相同。

### 5.2 RLS / trigger

新 migration（`services/supabase/migrations/`，日期戳按落地日）：

1. `drop policy team_skills_delete_if_member`；重建 `team_skills_delete_if_owner_or_admin`：`using (amux.is_team_admin_or_owner(team_id))`。**不要**加回 `owner_actor_id = current_actor` 旁路。
2. `team_skills_update_if_member` 保持成员可 UPDATE（元数据仍开放）。
3. `BEFORE UPDATE` trigger：若 `NEW.status IS DISTINCT FROM OLD.status` 或 `NEW.superseded_by IS DISTINCT FROM OLD.superseded_by`，且 `not amux.is_team_admin_or_owner(NEW.team_id)`，则 `raise exception ... errcode = '42501'`。

### 5.3 OpenAPI

`deleteTeamSkill` 与 `updateTeamSkill` 的 description 写明：改 `status` / `supersededBy`、以及 DELETE，需要团队 owner 或 admin。403 已在 responses 里，不新增 shape。

### 5.4 文档勘误

`docs/architecture/team-skills-registry.md` §5 现在写「发版 / 撤回 / 改元数据 / 删除都对任何成员开放」。改成：删除和 `status`/`supersededBy` 仅 owner/admin；其余成员写路径不变。注明本 spec 为这次翻案的出处。

---

## 6. UI

不新开一页。Coral 不用于退役/硬删（`AGENTS.md` 品牌强调色白名单里没有 destructive）。

### 6.1 第二列列表

`TeamShareListColumn` 读 `useTeamPermissions().canManageTeam`。

```
deletableSlug =
  canManageTeam && origin === 'registry' ? slug : undefined
```

含从市场 adopt 进来的 registry 行。个人 pack 不是这条路径。

Hover 垃圾桶 → 已有 `DeleteTeamSkillDialog`。成员行不出现该控件。

列表不放退役入口，避免滚动误触。

### 6.2 第三列详情

顶栏 **卸载** 语义不变：只卸当前 actor，全员可见（`team-installed`）。

管理员的团队级动作放正文底部，和顶栏卸载分开：

| 当前 status | 底部动作 |
|---|---|
| `published` | 次要按钮「退役」 |
| `deprecated` | 次要按钮「恢复发布」 |
| `draft` / `published` / `deprecated` | 文字链「从团队移除…」→ 同一个输入 slug 对话框 |

成员看不到这三块。

**退役对话框**比硬删轻：确认即可，可逆，不要输入 slug。可选「替代 skill」下拉，选项为本团队其他 `status = published` 的 slug；可空。提交 `PATCH { status: "deprecated", supersededBy }`。

**硬删对话框**补一句：其他成员通常在 10 分钟内卸包；本机有未发布改动会留下个人副本。确认按钮继续用 destructive variant。

**恢复**不需要对话框：一次 PATCH。失败 toast。

已有的 superseded 提示条（详情顶、点 slug 跳转）保留，对全员可见。

### 6.3 Store

- `deleteTeamSkill` 已接 API + reconcile。改掉「Deliberately ungated: any member can delete」注释。不必在 store 里再读 `canManageTeam`——安全边界在 API；UI 藏按钮。
- 新增 `deprecateTeamSkill(slug, supersededBy)` 和 `restoreTeamSkill(slug)`，形状对齐 `deleteTeamSkill`：调 API → `loadSection('skills')` → `SKILLS_CHANGED_EVENT`。详情不自己拼 PATCH。

---

## 7. 对账（不改算法）

`retiredSlugs` / `planReconcile` / dirty `kept` / fail-closed 保持原样：

- 退役：行还在 → 不是 retired
- 硬删：行不在 → retired → 卸；脏则 kept
- `listTeamSkills` 抛错 → 不卸任何包
- 操作者自己按删除：`selfDeleted` 避免「团队移除了 xxx」toast；kept 仍要告诉他本地副本还在

当前会话的 skill 工具集仍走 `RefreshChangeKind::Skills` pending，不 idle auto-apply。

---

## 8. 测试

**FC 仓库层**（新测试，走真实 `requireTeamAdmin` 或可注入的 membership stub）：

- member `deleteTeamSkill` → 403，行仍在
- member `updateTeamSkill({ status: "deprecated" })` → 403
- member `updateTeamSkill({ summary: "…" })` → 200
- admin `deleteTeamSkill` → 204
- admin 退役 + `supersededBy` → 200，status 变为 deprecated

路由层现有「PATCH 把 body 传给 repo」测试保留；鉴权不在路由。

**RLS / trigger**（`services/supabase/tests/` 新 pgTAP。mocked FC 仓库测不到这两层）：

- 非 admin `DELETE` 被 RLS 挡住（0 行删除，行仍在）
- 非 admin `UPDATE status` 被 trigger 挡住
- 非 admin `UPDATE summary` 仍成功
- admin `DELETE` 真正删行

**前端**：

- member：registry 行 `deletableSlug` 为 `undefined`，详情无退役/硬删
- admin：registry 行 `deletableSlug === slug`，详情有退役和「从团队移除」
- 现有 `team-share-skill-retired.test.ts`、`team-share-delete-team-skill.test.ts` 继续绿

---

## 9. 明确不做

- 知识库式 tombstone
- 硬删后回收 Storage / `amuxc_blobs`
- MQTT 把 10 分钟 tick 提前
- 把发布改回审批
- skill owner 旁路
- 强制先退役再硬删
- iOS / Expo 管理 UI
- 给「受影响 Agent 数」做确认框（issue-1026 提过；本轮不阻塞。需要的话另开）

---

## 10. 落地文件（实现时对照）

| 层 | 文件 |
|---|---|
| 契约 | `docs/openapi/teamclu-api.v1.yaml` |
| 应用 | `services/fc/src/lib/supabase-repo.ts`（`deleteTeamSkill` / `updateTeamSkill`） |
| 测试 | `services/fc/test/`（仓库层 403/200）；现有 `team-skills.test.ts` 路由测试不动鉴权 |
| RLS | `services/supabase/migrations/<date>_team_skills_admin_retire.sql` + pgTAP |
| Store | `packages/app/src/stores/team-share-browser.ts` |
| 列表 | `packages/app/src/components/sidebar/TeamShareListColumn.tsx` |
| 详情 | `packages/app/src/components/teamshare/SkillDetail.tsx` |
| i18n | `packages/app/src/locales/en.json`、`zh-CN.json` |
| 设计勘误 | `docs/architecture/team-skills-registry.md` §5 |
