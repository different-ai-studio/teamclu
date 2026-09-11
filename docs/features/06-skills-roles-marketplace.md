# TeamClu 功能详解 · 第 6 篇：Skills × Roles 体系与市场

> 版本基线：当前 `main`（`package.json` v0.4.1-beta.51）。
> 读者：要接手技能/角色/市场这块的工程师。
> 关联：`docs/architecture/team-skills-registry.md`、`docs/architecture/skills-marketplace.md`、
> `docs/architecture/slash-command-picker.md`、`docs/architecture/team-skill-package-download-contract.md`、
> `docs/architecture/team-skills-agent-install-explicit-update.md`、
> `docs/architecture/skill-publish-atomicity-and-blob-verification.md`、
> `docs/architecture/clawhub-uninstall-clears-skill-permission.md`。

---

## 0. 一句话定位

**Skill 是 agent 的一份可复用能力包**，本质是一个带结构化元数据的目录，核心是 `SKILL.md`。**Role 是 skill 的命名组合**，让同一支 agent 在不同场景下表现出不同的专长。**市场是 skill 的分发渠道**，让一支新团队开箱就有东西可用。

三者是同一件事的三个尺度：单个能力（skill）、能力的场景组合（role）、能力的来源与更新（市场/注册表）。

理解这块的关键是接受一个判断：**skill 不是「给 agent 的提示词片段」，而是「团队可以拥有、版本化、审计的资产」。** 这个判断决定了它为什么不能走全量文件同步（第 4 篇），为什么要有发布门，为什么要有自动跟随。

---

## 1. 为什么 skill 需要这么重

### 1.1 现状之前：两个字段，正则抠行

系统曾经认识的 skill 元数据只有 `name` 和 `description` 两个字段，而且不是 YAML 解析，是正则抠行：

- `packages/app/src/lib/git/skill-loader.ts:14` 一条 regex；
- `apps/daemon/src/config/roles_skills.rs:175` 一个 `strip_prefix("description:")`。

于是「干什么、什么时候别用、触发词、依赖什么」全挤进 description 一个自由文本里。内置的 `macos-control` 就是标本：description 里塞了 `Note: NEVER invoke this skill for...` 和 `Trigger words: ...`，旁边的 `compatibility` 字段没有任何代码读。

没有结构，就没法比较、没法去重、没法分类。这是问题的第一半。

### 1.2 现状之前：每人全量，噪音大

`teamclu-team/skills/` 全量同步到每个成员机器，`collectTeamSkillPaths()` 把整个目录喂给加载器。团队里任何人加的 skill，所有人的 agent 上下文里都有。这是问题的第二半。

### 1.3 明确不解决：保密

现有加密是一个团队一把 `ossTeamSecret`，全体成员共用，防的是云厂商不是同事。注册表**不引入成员间的可见性隔离**；ACL 留作后续扩展位。这一条写清楚很重要，否则会被误以为「按人隔离 skill」。

---

## 2. Skill 的结构与来源

### 2.1 目录结构

每个 skill 是 `<dir>/<skill-slug>/SKILL.md`。frontmatter 是元数据，正文是给 agent 的指令。

注册表引入的结构化 frontmatter：

```yaml
---
name: deploy-check
description: 部署前检查清单        # 保留，老解析器仍能读
owner: 张三
category: devops
when_to_use: |
  发布前确认 CI 绿、迁移已跑、回滚方案就绪。
when_not_to_use: |
  不要用于本地开发环境；不要用于 hotfix 流程（走 hotfix-deploy）。
requires:
  - platform: any
  - mcp: none
version: 3
source: team
---
```

`name` 和 `description` **保留**，保证向后兼容——这是很关键的一条：结构化字段是新增的，不是替换。

### 2.2 来源与优先级

每个 skill 有一个 `source` 标记。扫描时按优先级去重，**同名 skill 高优先级覆盖低优先级**：

| 优先级 | 路径 | source |
|---|---|---|
| 1 | `<workspace>/.teamclu/skills/` | `local` / `builtin` / `clawhub` |
| 2 | 用户全局 `~/.agents/skills` | 同上 |
| 3 | 团队注册表（经 daemon 或前端） | `team` |

为什么优先级是工作区 > 全局 > 团队？因为越靠近当前工作的越具体。一个项目专用的 skill 覆盖同名团队 skill，是符合直觉的。

一个容易忽视的细节：**两种安装来源（ClawHub 个人市场、团队注册表）落到同一个 `~/.agents/skills` 目录**。所以必须有一条边界区分「谁该负责谁」——这就是 lockfile entry 里的 `source: "clawhub" | "team"` 字段的作用。没有它，团队对账会误删 ClawHub 装的东西。

---

## 3. 团队 Skills Registry

### 3.1 数据模型

三张表（`services/supabase/migrations/`）：

**`team_skills`** — 每个 skill 一行：

| 列 | 说明 |
|---|---|
| `id` | uuid |
| `team_id` | 团队 |
| `slug` | 团队内唯一，`^[a-z0-9][a-z0-9-]{1,63}$` |
| `owner_actor_id` | 负责人，默认发布者，可转交 |
| `summary` | 一句话，≤80 字 |
| `category` | 枚举，不是自由文本 |
| `when_to_use` / `when_not_to_use` | |
| `requires` | jsonb null |
| `status` | draft / published / deprecated |
| `superseded_by` | deprecated 时指向替代者 slug |
| `latest_version` | int |

唯一索引 `(team_id, slug)`。

**`team_skill_versions`** — 追加式版本历史：

| 列 | 说明 |
|---|---|
| `version` | 从 1 递增，唯一索引 `(skill_id, version)` |
| `content_hash` | zip 的 sha256，对应 `amuxc_blobs.content_hash` |
| `size` / `changelog`（必填） | |
| `summary` / `when_to_use` / `when_not_to_use` / `requires` | **快照冗余** |

为什么冗余快照？因为元数据在 `team_skills` 上是「当前状态」，在版本行上是「那一版的事实」。没有快照，改一次描述就把所有历史版本的说明改写了。装了旧版的人应该看到旧版的说明。

**`team_skill_installs`** — 谁装了什么：

| 列 | 说明 |
|---|---|
| `actor_id` | 安装主体 |
| `skill_id` | |
| `installed_version` | |
| `scope` | `global` / `workspace` |
| `workspace_id` | scope=workspace 时必填 |

唯一索引 `(actor_id, skill_id, scope, workspace_id)`。

### 3.2 `actor_id` 泛化两种安装主体

这是本设计不需要额外「指派表」的原因：

| 主体 | 谁来装 | 说明 |
|---|---|---|
| `actor_type = member` | 成员自己 | 自助按需安装，治噪音 |
| `agent.visibility = 'team'` 的 agent actor | **管理员直接装** | 团队共享 agent 是团队资产，不存在个人意志要绕过 |

**服务端记录是期望态，两种主体统一。** 本地 lockfile 是它在某台机器上的投影，冲突时服务端赢。

这一条被自动跟随翻转过。原先写的是「对成员 actor 不是权威、权威是本地 lockfile、允许漂移」——那在手动安装下成立，在自动跟随下不成立：一个成员的第二台机器上没有任何本地记录，它凭什么知道该自动装什么。

代价是成员在 A 机器卸载会传导到 B 机器。这符合「我不再要这个 skill」的本意，接受。顺带修掉当前的幻影安装：列表的 `installed` 直接取服务端记录，于是第二台机器显示「已安装 v3」而盘上空空、且因 `hasUpdate=false` 连补装的入口都没有。

`installed_version` 在自动跟随下会稳态收敛到 `latest_version`，它记的是「这个 actor 现在应该处于哪一版」，不是「用户选择停在哪一版」——**没有 pin 语义**。

### 3.3 API

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/teams/:id/skills` | 列表，带 installed / hasUpdate，支持 category 过滤与搜索 |
| GET | `/v1/teams/:id/skills/:slug` | 详情 + 版本列表 |
| POST | `/v1/teams/:id/skills` | 发布新 skill（两步上传） |
| POST | `/v1/teams/:id/skills/:slug/versions` | 发新版本 |
| POST | `/v1/teams/:id/skills/:slug/versions/:v/revert` | 一键撤回 |
| PATCH | `/v1/teams/:id/skills/:slug` | 改元数据 / 转交 owner / 标 deprecated |
| GET | `/v1/teams/:id/skills/:slug/versions/:v/download` | 签名 URL |
| PUT | `/v1/teams/:id/skills/:slug/install` | 记录安装 |
| DELETE | `/v1/teams/:id/skills/:slug/install` | 记录卸载 |

鉴权：**全部只要求团队成员身份。** 发版 / 撤回 / 改元数据 / 删除都对任何成员开放。

2026-08-13 翻掉了此前「PATCH 和 POST versions 额外要求 owner 本人或团队 owner」的写法。理由：registry 是团队资产，不是发布者的私产。成员发现共享 skill 里有一步是错的却改不了，唯一的出口是换个 slug 发一个近似重复品——那正是本设计要消灭的重复。发布门是必填字段，从来不是审批人。

`owner_actor_id` 保留，含义仍是「谁负责」，不再是权限。落地在三处，必须同时改：`pg-repo/team-skills.ts`（应用层，postgres 后端没有 RLS）、RLS 迁移、以及 `SkillDetail.tsx` 的 `canPublish`。

**`team_skill_installs` 刻意不变**：写安装记录是往某个人的机器上放文件，和改共享内容不是一回事。

---

## 4. 发布门：六个必填字段

这是治「职责不清晰」的**唯一机制**。发布必须交出：

| 字段 | 为什么必填 |
|---|---|
| `owner` | 「这玩意归谁」有答案 |
| `summary` | 限长，逼出一句话说清楚 |
| `category` | 枚举，让同类可比较 |
| `when_to_use` | 从 description 里拎出来 |
| `when_not_to_use` | **最关键**——两个重叠的 skill 只有边界写出来才能并排比较 |
| `changelog` | 每次发版必填，让「谁改了什么」有记录 |

`requires` 选填（不是每个 skill 都有依赖，强制会逼出「无」这种垃圾值）。`slug` / `version` 系统生成。

辅助机制：

- **相似度检查**：发布时和已有 skill 的 summary + when_to_use 做相似度比对，命中阈值**弹提示**「和 `xxx` 有 82% 相似，确认要新建而不是发它的新版本吗」——**警告不阻断**，判断权给发布者，但留记录。
- **`deprecated` 状态**：标记弃用 + `superseded_by` 指向替代者。职责不清晰有一半是「旧的没人敢删」，给一个退休动作比审核便宜得多。
- **不做管理员审核**：审核是人力承诺，现在没有那个人。等 registry 里内容多到真打架了再加——那时候审核的判断依据（when_to_use 冲突）也才存在。

---

## 5. frontmatter 回写（不做就前功尽弃）

**agent 读的是磁盘上的 SKILL.md，不是 Postgres。** registry 里字段再齐整，装到本地还是那坨 description，agent 眼里的职责照样不清晰。所以安装时必须把结构化字段写回 frontmatter。

随之而来的必做项：**换掉两个正则解析器。**

- `packages/app/src/lib/git/skill-loader.ts` — TS 侧；
- `apps/daemon/src/config/roles_skills.rs` — Rust 侧。

`when_not_to_use` 这种多行值一进来，现有正则当场崩。**两边必须同时换**——只改一边的后果是桌面端显示正常、daemon 里 agent 拿到的是截断内容，而且很难查。

---

## 6. 自动跟随

**已装的团队 skill 自动跟随 `latest_version`，不需要用户点。** 理由是团队 skill 更接近团队规范而不是个人依赖——一个成员停在 v1 用着已经被作者改掉的流程，比他被动升到 v3 要糟。

这个决定不是「把 Update 按钮改成自动点一下」。无人值守的覆盖把下面几件事从可选顶成前置条件：

### 6.1 参数

| | 值 | 说明 |
|---|---|---|
| 对账周期 | **10 分钟** | 后台 tick，不是懒刷新 |
| 加速通道 | MQTT `actor_notify()` | 可选，只削等待时间 |
| per-device 关闭开关 | **不做** | |

**为什么不能照抄 `team_cloud_config.rs` 的 TTL。** 那里的 `TEAM_CLOUD_TTL` 是 60 秒，而且是**懒刷新**——挂在 spawn 热路径上按需触发。team MCP / team env 拉的是几 KB JSON，这么做没问题；skills 要下载并解压 zip，挂在 spawn 路径上就是给每次 agent 启动加一段不可预测的延迟。所以 skills 要开真正的后台定时器，周期也拉长到 10 分钟。

**为什么不做 per-device 开关。** 多一个状态就多一类「为什么他有我没有」的排查，而这类问题的排查成本远高于开关本身的价值。不想要某个 skill 的出口是卸载，不是关闭跟随。

### 6.2 对账循环放 daemon

三条理由：

1. team agent 本来就只能在 daemon 做——管理员的机器上不跑那个 agent；
2. `runtime/team_cloud_config.rs` 已经把「后台 reconcile + 文件缓存 + 失败不缩水 + 离线可用」这套模式跑通了，skills 是第三个 `reconcile_*`；
3. **`runtime/refresh_watch.rs` 已经 recursive watch `~/.agents/skills` 并归类成 `RefreshChangeKind::Skills`。** 落盘后当前会话记 pending，不 idle auto-apply；需显式 Apply / reload 才刷新当前会话。同时该 workspace 的 host 会请求滚动替换：已有 session 继续用旧 generation，下一次新 session attach 用新 generation 并重新发现磁盘上的 skills，所以远程/无 UI 也不会永远卡在旧目录。

**代价（唯一的大账）：安装管线要抽成共享 crate。** zip 防穿越解压、frontmatter 回写、lockfile、`permission.skill` 写入现在全在 `apps/desktop/src/commands/{clawhub,team_skills}.rs`，daemon 够不着。`crates/teamclu-types/src/skill_frontmatter.rs` 是这条路的先例。工作量比本设计里所有 UI 加起来都大，排期时不要按「加个定时器」估。

桌面端相应退成两件事：一个「立刻对账」的 IPC，和冲突的呈现。UI 不再自己 `invoke('team_skill_install')`。

### 6.3 对账而非增量

daemon 收到通知后拉的是**该 actor 当前应有的完整清单**，和本地 lockfile 做差集：多的装、少的卸、版本不符的换。理由是通知会丢、daemon 会离线，只处理增量迟早漂移。启动时也跑一次同样的对账。

**对账是主干，MQTT 是加速器。** 推送会丢、daemon 会离线、消息会乱序，任何以推送为主干的设计最终都要再补一条兜底路径；那不如一开始就让兜底路径成为唯一路径，推送只负责削掉等待时间。周期性全量对账天然幂等，丢一条通知的后果仅仅是晚 10 分钟生效。

### 6.4 脏改保护与冲突

自动跟随会覆盖本地文件，所以必须有脏改保护：本地改过的文件不被静默覆盖，而是产生冲突，走 UI 决策。这与知识库的冲突治理是同一套思路（第 5 篇）。

一键撤回：`versions/:v/revert` 把旧版内容重发为 `latest+1`。

---

## 7. 共享 agent 的安装

对 `visibility='team'` 的 agent actor，管理员在市场里点安装，走**同一个 API、不同的 `actorId`**。区别在落盘和触发：

```
管理员点安装
  → PUT /v1/teams/:id/skills/:slug/install  { actorId: <team agent>, version }
  → FC 写 install 记录
  ⋯ 承载该 agent 的 daemon 在下一个对账周期（10 分钟）拉取该 actor 的完整清单
     → 下载解压 → 回写 frontmatter
  → MQTT 通知只是把「下一个周期」提前到「现在」
```

**落到哪个目录**：`agents.default_workspace_id` 对应的 workspace 的 `.teamclu/skills/`。该字段为空时，落 daemon 的团队默认工作区 `~/.amuxd/teams/<team_id>/workspace`——这也是无 workspace 的运行时 spawn 已经在用的兜底。

**未决**：同一个 team agent 是否可能被多台设备同时承载。若可能，对账要按设备幂等（当前设计天然幂等，因为是全量对账），但「装在哪台」的语义要再确认。

---

## 8. 市场（Marketplace）

### 8.1 要解决什么

registry 已经能把一个 skill 分发给全团队，但**进入 registry 只有一个入口**：某个成员自己盘上有一个 skill，走 `sharePersonalSkill` 打包上传发成 v1。于是一支新团队开箱是空的。

设置里有两个外部市场，但它们装到的是**个人盘**，和团队 registry 毫无关系：

| 来源 | 实现 | 落点 |
|---|---|---|
| skills.sh | 扒 HTML + `npx skills add` | `~/.agents/skills`，个人 |
| ClawHub | `https://cn.clawhub-mirror.com` 外部 API | `~/.agents/skills`，个人 |

两个都不受我们控制：页面结构一改抓取就死，镜像站一停市场就空，而且抓回来的条目**没有 registry 要求的那 6 个必填字段**，引入团队时要人现场补一遍表单。

**本设计给 registry 补第二个入口**：一份我们策展的目录，条目天生带齐结构化字段，一键成为团队 skill，并且**订阅上游**——目录发新版，团队跟着走。

### 8.2 三个已定的取舍

| # | 取舍 | 理由 |
|---|---|---|
| 1 | 目录是**第一方的、FC 托管的**，只通过一套发布 API 管理，和任何 git 仓库无关 | 目录内容要能随时改而不发版；self-host 要能自己策展而不 fork 我们的 repo |
| 2 | 引入后是**订阅式**，上游发版自动跟随到团队 `latest_version` | 上游是我们自己，不是任意 GitHub 仓库 |
| 3 | 订阅的**投影做在服务端**，客户端零改动 | 两条对账循环都打 `GET /v1/teams/:id/skills`，让市场的新版在那里就已经是团队的新版 |

第 3 条是本设计能便宜的全部原因。**git 在本设计里不出现在任何位置**——三条被排除的做法都记着理由：客户端直读仓库（凭据要发到每台机器）、把 git 当注册表本身（算下来是负的）、内容即代码（耦合太紧）。

一句话：**市场不是一条新的分发管线，是往 registry 里写行的一个新写入者。**

---

## 9. Roles 与 `/` 弹窗

### 9.1 角色

`lib/roles/` + `RolesSection`、`RolesSkillsSection`。一个 role 是一组 skill 的命名组合 + 角色 markdown，让同一支 agent 适配销售/客服/运维/工程。

角色没有独立分发机制，因为它本质上是「一组技能的命名组合」+ 一段指令。所以它跟着 skill 的机制走。

### 9.2 `/` 弹窗

在聊天输入框输入 `/` 打开 `CommandPopover`，分三组：

| 分组 | 图标 | 写入的 token |
|---|---|---|
| Roles | 人像 | `/{role:<slug>}` |
| Skills | 闪电 | `/{skill:<invocationName>}` |
| Commands | ⌘ | `/{command:<name>}` |

三组数据**并行加载**，加载完成后再合并归类。权限为 `deny` 的 skill 不出现在列表。

Skills 不直接等于 daemon 的 `availableCommands`。主来源是 **workspace 磁盘扫描**：

```
CommandPopover.scanAvailableSkills(workspacePath)
  → loadRolesSkillsWorkspaceState(workspacePath)   // lib/roles/loader.ts
```

Tauri 桌面端优先走 daemon：`GET /v1/workspaces/{workspaceId}/roles-skills` → `amuxd scan_roles_skills_state()`。daemon 不可用时回退到前端 FS 扫描（`loadAllSkills()`，`lib/git/skill-loader.ts`）。加载完成后对 `availableCommands` 逐条归类：能归为 skill 的进 Skills，剩下的进 Commands。

---

## 10. 技能权限

skill 执行工具需要权限。`permission.skill` 是 daemon 侧的规则文件，安装 skill 时会写入（`clawhub.rs` 的管线）。

一个与卸载相关的细节：**卸载 skill 时必须清掉对应的 `permission.skill` 条目**，否则会留下一个指向不存在 skill 的权限规则。`docs/architecture/clawhub-uninstall-clears-skill-permission.md` 记录了这一点。

权限的 UI 呈现统一走 `permission-presentation.ts`（第 2、3 篇）。

---

## 11. 相关 UI

- `SkillsMarketplace.tsx`（约 1295 行）：个人市场骨架，搜索/安装/更新。
- `MarketplacePane.tsx`：团队市场面板（目录浏览、引入、订阅状态）。
- `SkillDetail.tsx`（1242 行）：注册表 skill 详情，含 `canPublish` 判定。
- `SkillFileTree.tsx` / `SkillFileEditor.tsx`：文件树与编辑。
- `SkillsSection.tsx` / `RolesSkillsSection.tsx` / `RolesSection.tsx`：设置页。
- `SkillsDiagnosticsDialog.tsx`：诊断（扫描路径、加载错误）。
- `SkillScanPaths.tsx`：扫描路径展示。
- `TeamSkillAutoFollow.tsx`：成员侧对账组件。
- `RefreshSkillsHeaderButton.tsx`：聊天头部刷新。

---

## 12. 测试与验收

- 发布的六个必填字段校验；
- 相似度提示（警告不阻断）；
- 自动跟随对账：多的装、少的卸、版本不符的换；
- 脏改保护：本地改过的不被静默覆盖；
- 一键撤回：旧版重发为 latest+1；
- 卸载清 `permission.skill`；
- 团队 agent 安装：服务端写记录、daemon 落盘；
- 市场引入 / detach；
- 发布两步：④ 之后对齐看不见（因为读的是 `latest_version`）。

---

## 13. 关键文件索引

```
packages/app/src/
  lib/skills/                      发现、frontmatter、加载、自动跟随
  lib/roles/                       角色加载
  lib/clawhub/                     ClawHub 类型
  lib/git/skill-loader.ts          TS 正则解析器（要换）
  components/settings/SkillsSection.tsx
  components/settings/RolesSection.tsx / RolesSkillsSection.tsx
  components/settings/ClawHubMarketplace.tsx
  components/chat/CommandPopover.tsx
  components/teamshare/SkillDetail.tsx / SkillFileTree.tsx / SkillFileEditor.tsx
  components/teamshare/MarketplacePane.tsx
  components/TeamSkillAutoFollow.tsx
  stores/agents-skills-access-store.ts
apps/daemon/src/
  config/roles_skills.rs            Rust 正则解析器（要换）
  runtime/team_skills.rs            共享 agent 侧对账
  runtime/refresh_watch.rs          监视 ~/.agents/skills
apps/desktop/src/commands/
  clawhub.rs                        包消费端（下载/解压/lockfile/permission）
  team_skills.rs                    团队 skill 安装
crates/teamclu-skillpack/           清单/判脏/换文件/frontmatter 回写（共享）
```

---

## 14. 常见坑

1. **两个正则解析器必须同时换。** 只改一边会让 daemon 拿到截断内容。
2. **frontmatter 回写不能省。** agent 读磁盘，不读 Postgres。
3. **`name` / `description` 要保留。** 向后兼容。
4. **对账而非增量。** 通知会丢。
5. **不做 pin。** 自动跟随会收敛到 latest。
6. **卸载要清 `permission.skill`。**
7. **lockfile 的 `source` 不能省。** 否则团队对账会误删 ClawHub 的东西。
8. **安装管线在桌面侧，daemon 够不着。** 要抽 crate 才能真正 daemon 化。
9. **市场发布分两步。** 一次手滑会在 10 分钟内到达所有订阅团队。
10. **撤回是上线硬门槛。** 没有它不能开订阅。

---

## 15. 市场的数据模型与发布流程

### 15.1 目录侧两张表

**`marketplace_skills`** — 每个目录项一行：

| 列 | 说明 |
|---|---|
| `slug` | 全局唯一 |
| `display_name` / `publisher` | 第一方标识 |
| `summary` / `category` / `when_to_use` / `when_not_to_use` / `requires` | 与 `team_skills` **同构同名** |
| `tags` | text[]，检索用 |
| `status` | draft / published / delisted |
| `latest_version` | int |

字段与 `team_skills` 同构同名，是「一键引入不用填表」的原因。`tags` 和 `category` 分开：category 是枚举、可比较，tags 是自由词、可搜索。

**刻意没有 `adopt_count` 这一列。** 「被多少个团队引入过」从 `team_skills` 数（`count(*) where upstream_slug = X and origin = 'marketplace'`，走一个部分索引）。存成计数列只会漂移，而这个数没有任何路径需要它是精确的实时值。

**`marketplace_skill_versions`** — 追加式，结构照抄 `team_skill_versions`，多 `object_path`。

### 15.2 团队侧加四列

```sql
alter table team_skills
  add column origin text not null default 'local',      -- 'local' | 'marketplace'
  add column upstream_slug text,
  add column upstream_subscribed boolean not null default false,
  add column upstream_detached_at timestamptz;

create index on team_skills (upstream_slug) where origin = 'marketplace';
```

`team_skill_versions` 加三列：`upstream_version`、`blob_scope`（team / marketplace）、`object_path`。

`blob_scope` + `object_path` 是**不复制包体**的开关。团队下载走 `content_hash → amuxc_blobs(team_id) → oss_key → 签名`；订阅项走 `object_path → 签名`，同一个命名空间、同一个签名函数，只省掉了中间那次查表。

**`object_path` 写进团队自己的版本行、而不是每次回目录表查**，是刻意的：这一行一旦写下，它的下载就再也不依赖目录项还在不在、`status` 是什么。优雅降级全靠这一条。

为什么不把目录包体复制进团队命名空间？那样这两列和下载解析器的分支都不用写，代价是一个目录项被 N 个团队引入就在存储里躺 N 份完全相同的字节。整个 blob 层是内容寻址的、存在的意义就是去重，让市场成为唯一一个反着来的写入者说不过去。

### 15.3 一个必须写进代码的断言

包体和团队自己发布的包**共用同一个命名空间**，只是第一段路径不同：

```
team-skills/teams/<teamId>/blobs/sha256/<aa>/<bb>/<hash>   团队发布的包
team-skills/marketplace/blobs/sha256/<aa>/<bb>/<hash>      市场的包
```

`team-blob-storage.ts` 已经为团队包体和知识库 blob 记过同一类账：它们的 object path 是字节相同的（同一套内容寻址），所以没有前缀区分的话，一个 skill 包和一个知识库 blob 会是同一个对象——两边都在时无害，**但一边的 GC 把它删掉时是致命的**。

同样的逻辑对 `marketplace/` 成立，而且更危险：市场的包**刻意不在 `amuxc_blobs` 里**，所以任何「扫 `team-skills` 命名空间、删掉 `amuxc_blobs` 里没有的对象」式的回收，会把整片市场包静默删光，而症状要等到某个团队下一次安装才暴露。

**落地时这是一句断言，不是一段代码**：blob 回收只允许按 `teams/<teamId>/` 前缀遍历，`marketplace/` 前缀由目录侧自己负责。配一个测试锁住它。

---

## 16. 发布 API：为什么分两步

```
① POST /v1/admin/marketplace/skill-blobs/prepare   { contentHash, size }
② PUT  <presignedPut>                              （已存在的内容直接跳过）
③ POST /v1/admin/marketplace/skill-blobs/complete  （HEAD 校验对象真的在，标记 verified）
④ POST /v1/admin/marketplace/skills/:slug/versions （建版本行，published_at = null）
⑤ POST /v1/admin/marketplace/skills/:slug/versions/:v/promote
```

**④ 和 ⑤ 分开是刻意的，它是本设计里唯一一处「第二双眼睛」。**

内容即代码时代，「写」和「生效」天然被一次 PR 合并隔开。纯 API 之后，如果发版是一次调用，那**一次手滑就在 10 分钟内到达每一个订阅团队的每一台机器**。两步把这个窗口还回来：④ 之后版本行存在但惰性对齐看不见它（对齐读的是 `latest_version`，而它只在 ⑤ 动），可以先拉下来验，验完再 ⑤。

代价是发版从一次调用变成两次。这是本设计接受的唯一一处仪式感。

### 16.1 撤回：一步，不是两步

```
POST /v1/admin/marketplace/skills/:slug/versions/:v/revert
  → 用 v 版的 blob 建一个新版本行，直接 promote 成 latest+1
  → changelog 自动填「撤回至 v{n}」
```

blob 是内容寻址的、历史版本全留着，所以这只是一次元数据写入，**零字节上传**。

**和发版刻意不对称：撤回不分两步。** 撤回是止血，让它慢没有道理。发版的两步是防手滑，撤回本身就是在收拾手滑。

**这个端点是自动跟随的上线硬门槛**：手动模式下坏版本的扩散取决于每个人自己点，自动跟随把它压缩成一个对账周期。**没有撤回不能开订阅。**

**刻意不做 `latest_version` 回退**：那会让某些团队的 `installed_version > latest_version`，`hasUpdate` 的比较立刻失去意义。只往前滚是唯一自洽的方向。

### 16.2 鉴权：一个共享密钥，fails closed

沿用 `lib/shared-secret.ts` 的 `sharedSecretMatches` + `x-webhook-secret` 头，新增 `MARKETPLACE_ADMIN_SECRET`，作用域限死 `/v1/admin/marketplace/*`。

那个函数**在密钥未配置时全部拒绝**。`provided !== secret` 的朴素写法会让未配置的部署把空头当成匹配，「看起来有守卫，实际全开」。对本设计这正好是想要的默认值：**不配 `MARKETPLACE_ADMIN_SECRET` = 这台部署没有市场。** 目录表空着、列表端点返回空、客户端隐藏入口。这不是错误状态，是「没开这个功能」。

新增环境变量一个，必须同时进 `services/fc/s.yaml` 和 `deploy/self-host/docker-compose.yml` 的 `environment:` 白名单。

---

## 17. 被换掉的两样东西

内容即代码（把目录源放在仓库、CI 打到 FC）曾是本设计的早期方案，后来换掉了。它带走了两样必须记账的东西：

| 内容即代码提供的 | 纯 API 之后 |
|---|---|
| 策展评审（两个条目职责是否重叠、`when_not_to_use` 写得对不对，在 diff 上判断） | **没有替代品。** 6 个必填字段仍由 API 校验，但那只管「填了没」，不管「填得对不对」 |
| 审计（`git log` / `git blame` 精确到人和时间） | 退化成 `marketplace_skill_versions.created_by` 一列，而且只到**密钥粒度**——密钥是共享的，记不到人 |
| 撤回（`git revert` 再发一版） | revert 端点，语义等价 |
| 生效前的一道人为闸门（PR 合并） | ④/⑤ 两步 |

前两行是真实的净损失。写在这里不是为了翻案，是为了目录内容多起来、开始互相打架的时候，有人能翻到这一节能知道当初的取舍在哪，以及补救的方向是什么。

---

## 18. 一次安装的完整链路

把「点安装」到「agent 能用」展开，能看到所有部件如何配合：

**成员自装：**

```
team_skill_install(slug, version, scope)
  → GET  /v1/teams/:id/skills/:slug/versions/:v/download   拿签名 URL
  → 下载 zip
  → extract_zip_to_dir()          （已有，含路径穿越防护）
  → 回写 frontmatter               （新增）
  → write_skill_origin()          （origin.json 加 source: "team" + teamId）
  → write_lockfile()              （entry 加 source 字段）
  → 写 permission.skill            （已有）
  → PUT .../install                记录到服务端
```

**团队共享 agent：**

```
管理员 PUT .../install { actorId: <team agent>, version }
  → FC 只写 install 记录（管理员机器上不跑那个 agent）
  → 承载该 agent 的 daemon 在下一个对账周期拉取该 actor 的完整清单
  → 下载 / 解压 / 回写 frontmatter / 写 lockfile / 写 permission
  → MQTT actor_notify 把「下一个周期」提前到现在
```

**两者共用同一套管线**（`crates/teamclu-skillpack`），差别只在「谁触发」与「落到哪个 actor 的 scope」。

一个关键点：**下载 URL 是签名 URL，不是公开 URL。** 私有 bucket `team-skills`，签名由 FC 的 service-role 客户端签发。所以客户端必须持有 team 身份。

---

## 19. 成员侧与 agent 侧的对账差异

两种安装主体都要对账，但触发时机不同：

| | 成员侧 | 共享 agent 侧 |
|---|---|---|
| 运行在 | 桌面端（`TeamSkillAutoFollow.tsx`） | daemon（`runtime/team_skills.rs`） |
| 周期 | 10 分钟后台 tick | 随 agent 生命周期 + 对账周期 |
| 落盘目录 | 成员的 `~/.agents/skills` 或 workspace 的 `.teamclu/skills` | agent 的 default workspace 的 `.teamclu/skills` |
| 共用逻辑 | `crates/teamclu-skillpack` | 同 |

为什么要分开？因为成员侧的对账发生在「用户的机器上」，而共享 agent 可能跑在一个没有用户登录的 daemon 上（服务器场景）。两者共用同一套 skillpack 逻辑，但触发时机不同。

一个与前两者都不同的第三个消费者：**daemon 侧还有一个 `runtime/refresh_watch.rs` 在监视 `~/.agents/skills`**，它不负责对账，只负责「文件变了 → 通知会话刷新」。三个东西职责不同，不要混。

---

## 20. 市场引入与订阅

### 20.1 引入（adopt）

```
POST /v1/teams/:id/skills/adopt
  { marketplaceSlug, slug?, version? }
  → 建 team_skills（origin='marketplace', upstream_subscribed=true）
  → 建 team_skill_versions v1（blob_scope='marketplace', object_path=...）
```

`slug` 选填：目录 slug 和团队里已有的撞名时改个名引入，订阅仍按 `upstream_slug` 成立。

### 20.2 订阅的对齐（投影在服务端）

```
GET /v1/teams/:id/skills   ← 每 10 分钟
  → 惰性对齐：订阅项落后就补一行
  → 现有自动跟随管线原样接手
    （签名 URL → 解压 → 回写 frontmatter → 清单 → 判脏 → 换文件）
```

**这是本设计能便宜的全部原因。** 客户端不知道市场存在，它只看到「团队有一个新版本」。两条对账循环（成员/agent）都打同一个端点，所以投影放在服务端之后，两边的代码一行都不用改。

### 20.3 detach

```
POST /v1/teams/:id/skills/:slug/detach
  → 断开订阅，停在当前版本，团队从此拥有它
```

为什么需要 detach？因为团队可能想基于市场版的定制，而定制之后不能再被上游覆盖。detach 把「跟进上游」变成「拥有它」，这是一个明确的所有权变更。

### 20.4 读侧

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/marketplace/skills` | 列表，支持 q / category / cursor；带 adoptedByTeam |
| GET | `/v1/marketplace/skills/:slug` | 详情 + 版本列表 |

`adoptedByTeam` 让市场面板能直接显示「已引入 · 团队 v3 · 跟随中」，不用客户端自己 join。

---

## 21. 目录内容从哪来

**目录没有源文件仓库，也没有后台管理界面。** 它只有一套服务端 API，谁持有运维密钥谁就能写。

这是早期「内容即代码」方案的替换。**本设计不规定调用方，但必须有一个，否则目录永远是空的。** 这是落地时的第一件事，不是可选项。倾向是一个运维 CLI：

```
pnpm marketplace:publish ./path/to/skill-dir --slug deploy-check --changelog "…"
```

读目录里的 `SKILL.md` + 一个 `catalog.yaml`（6 个必填字段），打 zip，跑完 ①–④，把 ⑤ 留给人另外一条命令。

注意它和被否掉的「内容即代码」的区别：这里 `catalog.yaml` 是 CLI 的**输入格式**，不是仓库里的权威副本；skill 目录放在哪台机器的哪个路径都行，发完就没它的事了。

---

## 22. 常见问题

**Q：skill 和 role 的区别？**
A：skill 是一个能力包；role 是一组 skill 的命名组合，让同一支 agent 适应不同场景。role 没有独立分发机制。

**Q：为什么 skill 不能像知识库一样同步？**
A：因为同步是「全量目录可见」模型，而 skill 需要「谁装了什么」这个维度。两者数据形状不同。

**Q：团队 skill 会自动升级吗？**
A：会。10 分钟对账收敛到 latest，没有 pin。脏改会被保护成冲突。

**Q：能不能停在旧版？**
A：不能。这是一个明确的设计选择；不想要新版就反馈或自己发布一个修正版。

**Q：市场被引入后还能改吗？**
A：能。detach 后团队拥有它，但从此不再跟随上游。

**Q：市场的包存在哪里？**
A：与团队包同一个命名空间、不同前缀（`marketplace/` vs `teams/<id>/`）。回收时这个前缀边界不能破。

**Q：为什么发布要分两步？**
A：因为一次手滑会在 10 分钟内到达所有订阅团队。撤回不用分两步。

**Q：谁可以发版 / 撤回？**
A：团队成员全员。registry 是团队资产，不是发布者私产。

**Q：个人市场和团队市场是什么关系？**
A：完全分开。个人市场（ClawHub / skills.sh）装到个人盘，不受团队控制；团队市场是注册表的第二入口。

**Q：skill 能拿到什么权限？**
A：由 `permission.skill` 控制，执行工具时仍需走权限审批（第 2、3 篇）。

**Q：卸载 skill 会清权限吗？**
A：会。这是已修过的一个真实问题。

**Q：斜杠弹窗的 skill 从哪来？**
A：workspace 磁盘扫描（优先走 daemon），再与运行时 availableCommands 合并归类。

---

## 23. 术语

| 术语 | 含义 |
|---|---|
| skill | agent 的能力包（`SKILL.md`） |
| role | skill 的场景组合 |
| registry | 团队 skill 注册表 |
| marketplace | 第一方策展目录 |
| adopt | 把目录项引入团队 |
| detach | 断开订阅，团队拥有 |
| upstream | 目录侧（相对于团队） |
| 自动跟随 | 自动收敛到 latest |
| 对账 | 全量拉取期望态与本地差集 |
| 脏改保护 | 不被静默覆盖 |
| frontmatter 回写 | 把结构化字段写回内存 |
| lockfile | 本机已安装记录 |
| `permission.skill` | skill 工具权限规则 |
| seed | 旧安装记录的迁移映射 |

---

## 24. 维护约定

本文与以下文档强耦合，变动时同步：

- 注册表字段变了 → 第 3、4 节；
- 自动跟随机制变了 → 第 6 节；
- 市场字段/API 变了 → 含第 8、15、16 节；
- roles 机制变了 → 第 9 节；
- skill 安装管线搬到 daemon → 第 6.2 节的「代价」要重写；
- 个人市场与团队市场的关系变了 → 第 8.1、 21 节。

一个写作约定：这块文档最容易变成「产品功能列表」。要按「数据形状 → 分发机制 → 更新机制 → 权限」的顺序写，因为几乎每个问题最后都是回到这四件事。

---

## 25. 一个 skill 的生命周期

**创建。** 两种入口：成员自己盘上有一个 skill 走 `sharePersonalSkill` 打包上传；或从市场 `adopt` 一个目录项。前者 origin='local'，后者 origin='marketplace'。

**发布。** 提交 6 个必填字段 + zip。服务端跑相似度检查（警告不阻断），建 `team_skill_versions` v1。

**分发。** 成员在资产浏览器里看到它，点安装 → 下载/解压/回写/记安装。已装的人自动跟随。

**使用。** agent 加载磁盘上的 `SKILL.md`，按 frontmatter 判断何时用。用户也可以在 `/` 弹窗里手动指定。

**更新。** 作者发新版 → `latest_version` 前进 → 订阅者 10 分钟内对齐。

**冲突。** 本地改过的文件不被静默覆盖，产生冲突待人工决策。

**退役。** 标 `deprecated` + `superseded_by`。装的人会在设置里看到提示。

**撤回。** 坏版本用 revert 把旧版重发为 latest+1。

**卸载。** 删本地文件 + 清 `permission.skill` + 服务端记卸载。因为服务端是期望态，卸载会传导到其它机器。

这条轨迹里有两个容易被忽视的转折。第一，「从 market 引入的项与团队自己发布的项在 `team_skills` 里长得一样」——这是投影在服务端的直接后果，也让下游代码不用分两种。第二，「卸载是团队级的」——因为服务端是权威。这两点都会被新接手的人意外。

---

## 26. Skill 加载器的实现细节

前端的加载链路：

```
CommandPopover.scanAvailableSkills(workspacePath)
  → loadRolesSkillsWorkspaceState(workspacePath)   // lib/roles/loader.ts
  → 优先 daemon: GET /v1/workspaces/{id}/roles-skills
  → 回退: loadAllSkills()                          // lib/git/skill-loader.ts
```

扫描路径按优先级去重（同名高优先级覆盖低）：

| 优先级 | 路径 |
|---|---|
| 1 | `<workspace>/.teamclu/skills/` |
| 2 | `<workspace>/.agents/skills/` |
| 3 | `~/.agents/skills/`（全局） |
| 4 | 内置（builtin） |

内置 skill（如 `macos-control`、`windows-control`、`create-role`）在 `lib/skills/` 里有各自的目录。`lib/skills/auto-follow.ts` 是成员侧自动跟随；`ensure-agents-paths.ts` 确保目录结构存在；`frontmatter.ts` 是解析；`changed-event.ts` 发出变更；`team-skill-summary.ts` 生成摘要；`agents-skills-access.ts` 管访问。

**两个解析器问题**（第 5 节）在这个链路里的具体位置：TS 侧 `lib/git/skill-loader.ts`，Rust 侧 `apps/daemon/src/config/roles_skills.rs`。两边都在被 frontmatter 结构化字段倒逼重构。

---

## 27. 角色系统的细节

Role 的组成：一份角色 markdown（定位、职责、工作方式）；一组被启用的 skill；可选的默认模型/参数。

为什么需要 role？因为同一支 agent 在不同场景下需要不同的专长组合。一个「客服 agent」和一个「运维 agent」可以是同一个 actor，只是挂了不同的 role。

`lib/roles/loader.ts` 负责加载，`create-role` 是内置的创建技能。设置页里 `RolesSection` 管角色的增删改，`RolesSkillsSection` 管「角色↔技能」的结合。role 在 `/` 弹窗里以 `/{role:<slug>}` 的形式写入输入框，等于告诉 agent「这个回合用这个角色」——它不是会话级设置，而是消息级指令。

---

## 28. 与权限系统的交界

Skill 执行工具时的权限有两个层面：

1. **skill 级 permission**：`permission.skill` 规则文件，安装时写、卸载时清；
2. **工具级 permission**：agent 实际调 bash / edit / write 时的确认（第 2 篇）。

两者的关系是：skill permission 决定「这个 skill 在哪些工具上默认放行」，工具级权限决定「实际执行时要不要问」。一个 skill 可以声明它需要哪些工具，但不是声明就等于放行。

这条区分很重要：如果把「skill 声明需要 bash」直接当成「bash 已授权」，那安装一个 skill 就变成了拿到任意命令执行权。**卸载清权限** 是必需的，否则会留下一个指向不存在 skill 的规则，而它的语义是模糊的。

---

## 29. 与其它模块的关系

| 模块 | 交界 |
|---|---|
| 团队同步 | skill 已退出同步前缀，改走注册表 |
| Agent runtime | daemon 加载磁盘 skill，权限走 extension |
| 会话 | `/` 弹窗、角色指令、skill 工具调用 |
| 权限 | `permission.skill` + 工具级审批 |
| 市场 | 注册表的第二入口，订阅上游 |
| Roles | skill 的场景组合 |
| 团队权限 | 全员可发版；安装主体分成员/团队 agent |

两个很容易搞混的边界：**「skill 安装」和「skill 权限」不是一回事**——安装是把文件放到磁盘上，权限是允许它用哪些工具；**「agent 看到哪些 skill」与「团队有哪些 skill」不是一回事**——前者是本机磁盘上有什么，后者是注册表里有什么。一个成员没装的团队 skill，他的 agent 看不到，这就是按需安装的目的。

---

## 30. 实操：新增一个团队 skill

**第一步：本地写。** 在 `~/.agents/skills/my-skill/SKILL.md` 写好 frontmatter 与正文。

**第二步：发布。** 在资产浏览器里点发布，填六个必填字段，上传 zip。服务端跑相似度检查，建 v1。

**第三步：验证。** 在另一台机器（或清空本地后）找到它，点安装，看 agent 能不能用。

**第四步：迭代。** 改内容，发新版（带 changelog）。已装的人 10 分钟内自动对齐。

**第五步：退役。** 不想要了，标 deprecated 并指定 superseded_by。

如果要把它同时送到市场的目录，走发布 API 的 ①–⑤（①–④ 之后先拉下来验，再 ⑤ promote）。这条流程里最关键的是**第四步的 changelog**：自动跟随让更新变成无人值守的，所以 changelog 从一个好东西变成了一个必需的东西。

---

## 31. 改动检查清单

1. 本地安装目录改了吗？两个解析器（TS / Rust）都跟了吗？
2. frontmatter 回写还在吗？
3. 服务端记录与本地 lockfile 的权威关系还一致吗？
4. 自动跟随的对账还是全量还是改成了增量？
5. 卸载还会清 `permission.skill` 吗？
6. lockfile 的 `source` 还能区分 clawhub / team 吗？
7. 安装主体（成员 / 团队 agent）的权限门对吗？
8. 发布门的 6 个必填字段还在吗？
9. 市场的 `latest_version` 只往前滚吗？
10. 撤回端点还在吗？（自动跟随的上线硬门槛）

这份清单的价值在于：每个问题都对应一个曾经出过或极易出的问题。新增功能时容易为了「快」跳过其中某个，而它们的代价都不低。

---

## 32. 附录：Skill 与 MCP 的安全模型对比

两者都是「团队提供的、会在你机器上生效的东西」，但安全模型不同：

| | Skill | MCP server |
|---|---|---|
| 内容是什么 | 指令 + 资源（Markdown/脚本） | 一个要 spawn 的命令 |
| 谁能加入目录 | 全员 | 全员 |
| 谁能安装 | 自己；团队 agent 由管理员 | **只能自己，连管理员都不行** |
| 安装后做什么 | agent 读取，工具调用仍走权限 | 在成员机器上启动进程 |
| 单次安装的风险 | 增加 agent 的行为面 | 执行任意命令 |
| 更新 | 自动跟随 | 不自动（目录变了要重装） |

这张表的每一行都对应一个「为什么不一样」的理由，而不是拍脑袋：

- **为什么 MCP 不自动跟随？** 因为一个变化的 `command` 可能从「读数据库」变成「删数据库」。skill 的变化是内容变化，MCP 的变化是行为变化。
- **为什么 MCP 连管理员都不能替别人装？** 因为多一条「别人能替你决定装什么」的路径就多一分横向移动面。
- **为什么 skill 可以自动跟随而 MCP 不行？** 因为安装 skill 只是让 agent 多知道一件事，而安装 MCP 是让一个进程开始在你的机器上运行。

一个常见的误用是「把 skill 当成一个可以执行代码的包」。它的确可以带脚本，但脚本的执行仍然受工具权限门限制，不是无条件的。这与 MCP 的「安装即执行」是两回事。

---

## 33. 附录：变更记录

| 变动 | 影响章节 |
|---|---|
| 安装管线抽成共享 crate | 6.2、13 |
| 注册表新增字段 | 3、4 |
| 自动跟随改为可关闭 | 6.1 |
| 市场发布改回一步 | 16 |
| 新增第 N 种安装主体 | 3.2、7 |
| 两个解析器完成重构 | 5、13、26 |
| 个人市场接入团队 registry | 8.1 |

写本文最容易犯的错是把它写成「产品功能列表」。要按「数据形状 → 分发机制 → 更新机制 → 权限」的顺序写，因为几乎每个问题最后都回到这四件事。

---

## 34. 附录：六种常见误用

**一、把 skill 当作「提示词片段」发到群里。** 后果：没有版本、没有 owner、没有 when_not_to_use，三个月后没人知道哪个还有效。要用注册表。

**二、在 skill 里写绝对路径。** 后果：在一个成员机器上能用，在另一个上静默失败（因为目录不存在）。要用相对路径或环境变量。

**三、用 skill 传密钥。** 后果：明文进团队存储。团队密钥走 env（密文信封），不进 skill。

**四、发布时不写 when_not_to_use。** 后果：两个重叠 skill 无法比较，agent 会在错误时机用错的那个。这是六个必填字段里最重要的一个。

**五、把团队 skill 当个人工具改。** 后果：下次自动跟随会覆盖掉你的修改（或者产生冲突，取决于脏改保护是否生效）——但那是警告，不是保留。要定制就 detach，或发一个修正版。

**六、卸载后不清权限。** 后果：留下指向不存在 skill 的规则，行为模糊。

---

## 35. 附录：与第 4 篇的关系

本文与第 4 篇（团队协作与资产同步）是同一张图的两个视角：

- 第 4 篇回答「团队有哪几种资产、各自的传输/归属/权限是什么」；
- 本文展开其中一种（skills）以及它的组合（roles）与来源（market）。

两者共享一个结论：**需要被选择性地安装在你机器上的东西，不该用全量文件同步。** skills 与 MCP 都从同步前缀里搬走了，原因相同。

如果将来要给一个新的团队资产选分发机制，先判断：它是「内容」还是「会执行的东西」？前者可以同步，后者必须有安装制。这个判据在本仓库里从未错过。

还有一个与第 4 篇共享的教训：**对账比推送更可靠。** 团队同步的兜底是 300 秒定时器，skill 对账的兜底是 10 分钟周期，两者都把推送当加速器而不是主干。原因是同一件事：推送会丢、设备会离线、消息会乱序，而周期性全量对账天然幂等。任何一个「靠推送保证正确」的设计，最后都要补一条兜底路径；不如一开始就让它做主干。

---

## 36. 附录：五条不变量

如果只能记住五件事，是这些：

1. **frontmatter 回写不能省。** agent 读磁盘，不读 Postgres；不回写就等于没结构化。
2. **服务端是期望态，本地 lockfile 是投影。** 冲突时服务端赢；卸载会传导到其它机器。
3. **对账是主干，推送是加速器。** 周期 10 分钟，丢一条通知只晚 10 分钟。
4. **发布分两步，撤回一步。** 发版防手滑，撤回是止血。
5. **只有成员能给自己装，MCP 连管理员都不能替别人装。** 安装与改共享内容不是一回事。

再加上一条与第 4 篇共用的：**需要执行的东西不进同步。** skill 与 MCP 都因此搬离了同步前缀。

---

## 37. 一个总结：三个尺度

把整篇压缩成一页：

**单个能力的尺度是 skill。** 它的关键不是「能干什么」，而是「什么时候不该用」——所以 `when_not_to_use` 是六个必填字段里最重要的一个。

**场景组合的尺度是 role。** 它没有自己的分发机制，因为它是 skill 的命名组合。它解决的是「同一支 agent 在不同场景下的专长」。

**来源与更新的尺度是注册表与市场。** 注册表的投影在服务端，所以市场引入一条后，所有下游代码不用知道「市场」存在。

三者共同的一个判断：**这些东西是团队资产，不是提示词片段。** 一旦接受这个定位，版本、owner、发布门、自动跟随、撤回、权限清理就都是它的必然推论；一旦把它当提示词，就会退回到「两个字段 + 正则抠行 + 每人全量」的状态。

---

## 38. 附录：一个可以复用的判断

这篇里反复出现同一个问题：**「这个东西是内容还是会执行？」** 两个答案通向两套完全不同的机制。

| 判据 | 内容 | 会执行 |
|---|---|---|
| 分发 | 全量同步 | 安装制 |
| 权威 | 服务端行 | 服务端记录 + 本地投影 |
| 更新 | 自动跟随（内容） | 重装（行为） |
| 权限 | 目录（Path ACL） | 人（安装记录） |
| 风险 | 泄露 | 执行 |

一个具体的应用：新增一个「团队脚本」功能时，先问它会不会在别人机器上跑。会，那它就必须走安装制、必须有权限门、必须不自动跟随。不会，那它可以走同步、可以有目录权限、可以自动更新。

本仓库里 `.mcp/` 的搬家（第 4 篇）就是没问这个问题的代价：它曾经走同步，而 MCP server 的 command 会在全团队机器上 spawn。把「内容」当成「配置」存储，而配置里带着可执行命令，就是那一次的事故面。

---

## 39. 附录：一句话总结

如果把整篇压成一句话：**skill 是团队资产，不是提示词片段。**

这一个定位就足够推出全套设计：资产要版本（所以有 `team_skill_versions`）、要 owner（所以有 `owner_actor_id`）、要说清何时用与何时不用（所以有发布门）、要能被修正（所以全员可发版）、要能更新（所以有自动跟随）、要能止血（所以有 revert）、要能被卸载干净（所以清 `permission.skill`）。

反过来，如果把它当提示词，就会退回到「两个字段 + 正则抠行 + 每人全量」的状态——很多行的成本，很多人的上下文，却没有一个人能回答「这个 skill 现在还有效吗」。

---

## 40. 结语

这块的复杂度几乎全部来自一个决定：**skill 是团队资产，不是提示词片段。** 一旦接受这个定位，版本、owner、when_to_use、发布门、自动跟随、撤回、权限清理就都是它的必然推论。反过来，如果把它当提示词，就会退回到「两个字段 + 正则抠行 + 每人全量」的状态——那正是这套设计要离开的地方。
