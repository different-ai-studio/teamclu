# TeamClu 功能详解 · 第 4 篇：团队协作与资产同步

> 版本基线：当前 `main`（`package.json` v0.4.1-beta.51）。
> 读者：要接手团队同步、团队资产、团队权限这块的工程师。
> 关联：ADR-0006、ADR-0008、`docs/specs/2026-09-01-team-sync-two-roots-design.md`、
> `docs/architecture/obsidian-compatible-knowledge.md`、
> `docs/architecture/knowledge-sync-push-notify.md`、
> `docs/architecture/team-mcp-and-env-cloud.md`、
> `docs/architecture/team-skills-registry.md`、
> `docs/architecture/multi-brand-local-daemon.md`、`CLAUDE.md` 的 Team Collaboration 一节。

---

## 0. 一句话定位

TeamClu 里的「团队」不是一堆人的集合，而是**一组共享资产的所有者**。加进一个团队，意味着你获得这个团队的：知识库、资料库、技能、角色、MCP 配置、环境变量、AI 网关、应用。这些资产各有各的分发机制，但它们共享同一个归属——团队。

理解这一点的关键是：**每种资产用的传输方式不一样，而且是有意不一样的。**

| 资产 | 分发方式 | 归属 | 权限粒度 |
|---|---|---|---|
| 知识库 `knowledge/` | daemon 的 OSS 同步 | 团队 | 目录级（Path ACL） |
| 资料库 `documents/` | daemon 的 OSS 同步 | 团队 | 目录级（Path ACL） |
| 技能 skills | 服务端注册表 | 团队 | 全员可发 |
| MCP 服务器 | Cloud API 目录 + 每人选装 | 团队 | 安装制 |
| 团队环境变量 | Cloud API（密文信封） | 团队 | 创建者/admin |
| 团队 LLM 网关 | Cloud API 配置 | 团队 | admin |
| 应用 apps | Gitea + FC 部署 | 团队 | member 三档 |
| 角色 roles | 工作区/团队文件 | 团队 | 全员 |

把这七种资产用同一种机制分发，是这块最深的一个反模式。历史上确实这么做过——`.mcp/`、`_secrets/`、`skills/` 都曾经在同步前缀里，后来全部搬走了。原因在下面第 3 节展开。

---

## 1. 团队是什么

### 1.1 数据模型

团队由 Cloud API 的 `teams` 表承载，成员关系在 `team_members`，角色是 `owner` / `admin` / `member`。团队下还有 `actors`——人和 agent 都是 actor。

几个与同步强相关的字段：

- `teams.share_mode` 及其 Postgres enum **仍然存在，但没有代码读写了**。它曾经是「团队共享开关」，但产品里没有任何地方会去设它，所以每个团队创建后都读成「off」，而所有分支它码（同步按钮、状态轮询、daemon 同步、链接清理）都因此静默失效。现在唯一的同步前置条件是「运行处的自动同步开关」：关掉且未强制 → `skipped`，否则同步。**不要重新引入对 `share_mode` 的分支。** 列和 enum 保留是因为「正在使用的 enum 值不能删，删列是生产数据上的单向门」。
- `amuxc_path_acl` / `amuxc_path_acl_grants`：目录级权限（第 5 篇详述）。
- `team_workspace_config.oss_change_seq`：同步水位（第 5 篇）。

### 1.2 团队与 daemon 的关系

ADR-0006：**daemon 的状态按 team 归属。** 也就是说，同一台机器上，团队 A 和团队 B 各有自己的内容根、自己的 cron、自己的 workspace 链接。这不是「一个 daemon 跑一个团队」，而是「一个 daemon 可以服务多个团队，但每个团队的状态是分开的」。

这个约束的直接体现是家目录布局：

```
~/.amuxd[-<brand>]/teams/<team_id>/
├── shared/
│   ├── team-sync/               同步内容根
│   │   ├── documents/           资料库
│   │   └── knowledge/           知识库
│   ├── teamclu-team/            遗留链接目录，不再创建
│   └── state/                   daemon 私有
└── ...
```

多品牌时根目录带 brand 后缀（`~/.amuxd-<brand>`），见 `docs/architecture/multi-brand-local-daemon.md`。

### 1.3 团队切换

切换团队会重定向内容根、workspace 链接、sync controller、conflicts store、team-share browser。`current-team.ts` 是团队状态的所有者。切换是**重之外的操作**：切换后 `globalTeamSyncShareRoot()` 返回不同的目录，所有按 sync key 寻址的功能（版本历史、冲突、ACL）都必须重新解析。

一个容易踩的坑：`team-conflicts.ts` 的 `syncRoot` 是**在 load 时解析**的，而不是启动时缓存一次。注释写明了原因：「切换团队会把它指向不同目录，而过期的目录会把每个冲突映射到一个不存在的文件。」

---

## 2. 七种资产的分发机制

### 2.1 知识库与资料库：同步

这两个是唯一走「文件同步」的资产，因为它们本质上是文件——Markdown、附件、文档。同步引擎的所有权在 daemon（ADR-0008 的后续决定），控制面在桌面端。详细机制见第 5 篇，本节只讲它们与「团队」的关系。

### 2.2 技能：注册表

技能曾经在 `skills/` 同步前缀里，后来搬到了服务端注册表。为什么？因为同步是「全量目录可见」的模型：`teamclu-team/skills/` 全量同步到每个成员机器，`collectTeamSkillPaths()` 把整个目录喂给加载器。团队里任何人加的 skill，所有人的 agent 上下文里都有——这就是 registry 文档里说的「每人全量，噪音大」。

注册表把 skill 变成「按包分发 + 按需安装」：团队里有目录，成员自己装。详见第 6 篇。

### 2.3 MCP：目录 + 每人选装

这是七种资产里安全模型最特别的一个。以前 `.mcp/` 整个目录同步给所有成员，并被 `materialize_team_mcp_for_runtime` 写进每个人的 `opencode.json`。而 **MCP server 的 `command` 是要在成员机器上 spawn 的**——等于任何能 push 团队仓库的人，都能在全团队的机器上执行任意命令，唯一的门槛是仓库写权限。

改成安装制后：

- **任意团队成员都能往目录里加** server（写目录不执行任何东西）；
- **只有本人能给自己安装**，安装才会 materialize 进自己的 `opencode.json`；
- 没有「替别人安装」这条路径——**连管理员也没有**。

之所以敢把「加」放得比 `team_skills`（任意成员可发布）还开，正是因为「加」不再等于「在别人机器上生效」。风险从「一个成员被盗号 → 全团队执行任意命令」降到「一个成员被盗号 → 目录里多一条没人装的脏数据」。

这条设计里有一个对比值得记住：`team_skill_installs` 允许管理员给 `visibility='team'` 的共享 agent 装技能，而 MCP 刻意**不开这个口子**——多一条「别人能替你决定装什么」的路径就多一分横向移动面。团队共享 agent 真需要 MCP 时再单独设计。

### 2.4 团队环境变量：加密模型不变，只换存储

客户端继续用团队密钥做 AES-256-GCM（HKDF-SHA256 派生），**只上传信封** `{v, nonce, ciphertext}`。服务端——包括 self-host 的 DB 运维方——拿不到明文。这与此前落在 OSS 上的模型完全一致：防的是存储方，不是同事（一个团队一把密钥，每个成员都持有）。

搬迁改变的是传输和存储位置，不是安全保证。但由此带来一个不直观但重要的约束：**`description` / `category` / `createdBy` / `updatedBy` / `updatedAt` 这些元数据全都在密文里面**（`SecretEntry`），服务端读不到。所以任何服务端要用来判权的字段，都必须是**独立的明文列**。表上的 `created_by` 不是与信封里那个字段冗余——它是服务端在决定「谁能删」时唯一能读到的那份。

### 2.5 团队 LLM 网关：配置

以前在 `_meta/provider.json` 里同步，后来改走 `GET /v1/teams/:id/workspace-config` + `PUT /v1/teams/:id/llm-config`。FC 不再 provision LiteLLM；网关是**被配置的，不是被铸造的**。

一个细节：一个没有存储 `llm_base_url` 的团队，只要 FC 有 `AI_GATEWAY_INTERNAL_URL` / `AI_GATEWAY_SERVICE_TOKEN`，就会被服务部署自己的网关（`<request origin>/ai/v1/teams/:id` + 三个档位）。存储的 baseUrl 永远优先，而「`enabled=false` 且有 baseUrl」是团队选择退出的方式。见 `services/fc/src/lib/team-llm-defaults.ts`。

### 2.6 应用：Gitea + FC

见第 9 篇。

### 2.7 角色：文件

角色是工作区/团队级的 Markdown + 技能组合，走 `lib/roles/`。它没有自己的分发机制，因为它本质上是「一组技能的命名组合」。见第 6 篇。

---

## 3. 为什么只有两个同步根

这是这块最重要的一个架构决定，值得单独一节。

同步引擎曾经承载六个前缀：

```
skills/  knowledge/  .mcp/  _meta/  _secrets/  _feedback/
```

现在只剩两个：

```
documents/  knowledge/
```

### 3.1 每一个搬走的理由

| 前缀 | 搬去哪 | 为什么 |
|---|---|---|
| `skills/` | 服务端注册表 | 全量同步 = 每人全量噪音；需要版本、owner、when_to_use |
| `.mcp/` | Cloud API 目录 | 同步目录 = 任何能 push 的人可在全团队执行命令 |
| `_secrets/` | Cloud API | 服务端需要明文列判权；且原设计没有任何强制脱敏 |
| `_meta/` | Cloud API workspace-config | LLM 配置属于 Cloud API |
| `_feedback/` | 无 | 从来没有写入方 |

`_meta/` 和 `_feedback/` 从来就没有写入端。`.mcp/` 更是「根本没有写入端」——桌面端只建了个空目录和一份 README，让人手写 `<server-name>.json`，UI 里团队 MCP 是只读的。内容全靠 git push 或 OSS 同步进来。这是一个典型的「设计了一个通道，但没人往里放东西」的例子。

### 3.2 剩下两个的区别：编辑方针

`documents/` 与 `knowledge/` 的区别是**内容性质**，不是技术约束：

- **documents（资料库）**：有归属的文件——合同、HR、财务。谁能看是业务问题。
- **knowledge（知识库）**：沉淀下来的共识。团队共有，不切分。

评审时明确否掉了「因为 agent 要保持一致所以 knowledge 不能分权」这个理由——那会导出一套硬规则。选定的是编辑方针，所以数据库的 CHECK 从 `LIKE 'knowledge/%'` 放宽到同时接受两个前缀，只在 UI 层不给 knowledge 设权限的入口。**编辑方针不该用数据库约束来执行。**

### 3.3 两个固定根的好处

内容根从 `shared/` 下移到 `shared/team-sync/` 之后，下面三个东西自动落在同步树外：

1. `teamclu-team/`（遗留链接目录）——不再需要「别放进去」的纪律；
2. `state/cloud`——它的注释说它「必须在 `shared/` 外面，否则扫描器会把它当内容推送，每次改动给所有人发墓碑」；
3. `team-knowledge` / `team-documents` 这两个 workspace 符号链接——`workspace_link.rs` 里有一段守卫专防「把 `shared/` 当 workspace 时，链接被种进同步内容根里」。

**把靠纪律维持的东西变成结构保证的**，这是下移内容根最大的收益。

### 3.4 三处镜像的白名单

前缀白名单在三个地方各有一份：

- `apps/daemon/src/sync/oss/path_validator.rs`（`ALLOWED_PREFIXES`）
- `apps/desktop/src/commands/oss_sync/path_validator.rs`
- `services/fc/src/lib/sync-path.ts`

三处必须一致。**加前缀是一次硬升级**：`engine::tick` 对 manifest 行用硬 `?` 调用 `validate()`，一个不认识新前缀的 daemon 会中止整个 apply，而 `InvalidPath` 被归类为非瞬时错误，永远不会自愈。也就是说，一个旧 build 会在别人创建新前缀文件的那一刻**静默停止同步**。

同文件里还有 `RETIRED_PREFIXES`（`skills/`、`.mcp/`、`_secrets/`、`_meta/`、`_feedback/`）。它们**仍然在 wire 上被接受**，这是刻意的：曾经同步过这些前缀的团队，manifest 里还有它们的行，而 `validate` 在 per-item pull 循环里是硬 `?`——拒绝它们会让整个 manifest apply 在第一行就中止，把 `knowledge/` 一起拖下水。它们被排除在 `ALLOWED_PREFIXES` 之外，这才是真正阻止它们的方式：扫描器不再推，pull 循环跳过。

---

## 4. 团队同步架构

### 4.1 所有权

**同步归 daemon（OSS 引擎），不归客户端。** 客户端提供触发器和展示器。所以关掉 app 后同步继续跑。

历史：iroh 的 P2P 模式已经删除，git share 也删除了——团队同步**从不调用 `git`**。产品里剩下的唯一 git 是 `apps/daemon/src/sync/app_git.rs` 里每个 app 的 Gitea checkout，与团队共享无关。

### 4.2 内容根与全局副本

每台设备上，每个团队一份全局副本：

```
~/.amuxd[-<brand>]/teams/<team_id>/shared/team-sync/{documents,knowledge}
```

然后每个 workspace 用两个符号链接把它露出来：

- `team-knowledge` → `.../team-sync/knowledge`
- `team-documents` → `.../team-sync/documents`

`ensure_workspace_link` 在 Unix/macOS 用 symlink，Windows 先试目录 junction，再退到「没有链接，直接读全局目录」——这样打开 workspace 永远不会因符号链接权限失败而报错。

一个重要的守卫：**绝不处理「workspace 本身就是团队 `shared/` 目录」的情况。** 这种假 workspace 曾经出现在 `workspaces.toml` 里（从云端同步过来），它的 `teamclu-team` 就是全局存储目录本身，把同步根链接进去会把 `shared/team-knowledge` 种进同步内容根——扫描器会走进去。代码里对这种情况直接 `Fallback` 并 warn。

`teamclu-team` 这个第三个链接**已经不再创建**，旧的 symlink 会在过程中被移除；但如果是同名真实目录，则原样保留——它先于全局存储存在，没有任何东西能证明它的内容曾经被同步过。

### 4.3 同步的触发

| 触发源 | 说明 |
|---|---|
| 定时器 | 300 秒，兜底 |
| 手动 Sync Now | 用户意图，直接 force |
| fs 监听 | knowledge/documents 根的文件变化，2 秒合并窗口，地板 5 秒 |
| MQTT hint | 队友推送后 FC 广播，2 秒合并窗口，地板 15 秒 |
| 启动 | app 启动时跑一次 |

调度器的细节（coalescing 而非 debounce、地板从上次 tick 结束算）见第 5 篇第 7 节。

---

## 5. 团队资产浏览器

第一列的 `TeamShareNavSection` 露出四个 section：skills、mcp、env、knowledge。第二列的 `TeamShareListColumn` 渲染内容，第三列/主列渲染详情。

### 5.1 四个 section

| section | 数据来源 | 说明 |
|---|---|---|
| `skills` | 技能注册表 | 见第 6 篇 |
| `mcp` | `team_mcp_servers` + installs | 目录 + 选装 |
| `env` | `team_env_secrets`（密文） | 团队环境变量 |
| `knowledge` | 本地同步目录 | 文件树 + 同步状态 + 冲突 |

### 5.2 counts loader

`useTeamShareCountsLoader()` 在 NavRail 里被调用一次，因为导航在两个地方渲染 team-share 行（默认组 + 高级组），而计数必须每个 team/workspace 只拉一次。

一段值得读的注释：它**不以 workspace 为门禁**。以前有 `!workspacePath` 的守卫，导致「没打开文件夹的客户端四个 section 全显示 0」，看起来像空的而不是未加载。现在 `workspacePath` 只在 deps 里——打开文件夹会增加本机的个人行，所以计数要重读。`loadCounts` 用 `allSettled`，所以一个需要 workspace 的 section（Env，它的目录读在没有 workspace 时会抛）不会把其它三个拖垮。

### 5.3 详情面

- skills：`SkillDetail.tsx`（1242 行）、`SkillFileTree.tsx`、`SkillFileEditor.tsx`；
- mcp：`McpDetail.tsx`；
- env：`EnvDetail.tsx`；
- knowledge：文件树 + `KnowledgeSyncFooter` + 冲突解析 + 版本历史 + 云版本；
- 市场：`MarketplacePane.tsx`、`SkillsMarketplace.tsx`。

---

## 6. 团队权限

### 6.1 角色

`team_members.role`：owner / admin / member。前端的门禁是 `useTeamPermissions()` 的 `canManageTeam`（owner 或 admin），用于环境变量、共享密钥删除、knowledge ACL 等管理面。

**服务端是权威。** 前端只是「要不要渲染这个页面」。每个管理 API 都在服务端重新判断。

### 6.2 邀请

`lib/team` + `invite/` 组件 + `/v1/invites` 端点。邀请有链接与定向两种。`pendingInvite` / `inviteLink` 在 locale 里。

### 6.3 资产的权限矩阵

| 资产 | 谁能读 | 谁能写 | 谁能删 |
|---|---|---|---|
| knowledge | 团队成员（除 ACL 限制） | 成员 | 成员 |
| documents | 团队成员（除 ACL 限制） | 成员 | 成员 |
| skills | 成员 | 成员（全员可发版） | 成员（同发布权） |
| mcp 目录 | 成员 | 成员（可加） | 创建者 / admin |
| mcp install | 本人 | 本人 | 本人 |
| env | 成员（读密文） | 成员（可加改） | 创建者 / admin |
| LLM 配置 | 成员 | admin | admin |
| apps | 见第 9 篇三档 | 见第 9 篇 | owner |

**skills 的「全员可写」是一个刻意决定**（2026-08-13 翻掉了「PATCH / 发版要求 owner」的写法）。理由：registry 是团队资产，不是发布者的私产。成员发现共享 skill 里有一步是错的却改不了，唯一的出口是换个 slug 发一个近似重复品——那正是注册表要消灭的重复。`owner_actor_id` 保留，含义是「谁负责」，用于展示和认领，不再是权限。落地在三处必须同时改：应用层、RLS、以及 `SkillDetail.tsx` 的 `canPublish`。

**`team_skill_installs` 刻意不变**：写安装记录是往某个人的机器上放文件，和改共享内容不是一回事。三条闸门保留：装给自己放行 / 团队 agent 要管理员 / 永不替别人装。

### 6.4 RLS

Supabase 后端的权限由 RLS 执行，postgres 后端没有 RLS 可依赖，所以**应用层要同时实现一遍**。仓库规则（`backend-kind.ts` 注释）要求两个分支都实现。

---

## 7. 冲突与同步状态

### 7.1 冲突

冲突由 daemon 的同步引擎产生：`knowledge/.conflicts/<镜像相对路径>/<stem>.conflict.<ts>.<hash>.md`。引擎把本地字节停放在 sidecar，让远端版本覆盖文档本身。

前端 `team-conflicts.ts` 聚合冲突，`KnowledgeConflictResolver.tsx` 做决策，`KnowledgeSyncFooter.tsx` 在底部栏提示「N 个冲突需要决策」。

### 7.2 同步状态

`team-sync-status.ts` 维护 `localBySyncKey` / `remoteBySyncKey` / `stuckBySyncKey`。底部栏按优先级呈现：冲突 > 大批新增被拦下 > 超大文件跳过 > 失败 > 进行中 > ↑N ↓M。

### 7.3 冲突与会话的类比

冲突的处理顺序（先把前缀加入本地 ignore、再删文件、再删 state）与第 3 篇线程「派生对象必须有独立身份」是同一个原则：**不要让一个对象的状态机去误伤另一个对象。** 冲突副本如果躺在原文件旁边，就会被扫描器当成本地删除广播；所以它必须在 `.conflicts/` 且被硬排除。

---

## 8. 团队模式与团队 Provider

`team-mode.ts` 管的是「团队共享的模型 provider」。有两个容易混淆的概念：

- **团队 LLM 网关**：团队配置的 baseUrl + models，所有成员可用；
- **团队 provider**：把一个 provider 作为共享资源（`TEAM_SHARED_PROVIDER_ID`）。

`team-mode.ts` 里的细节值得注意：team model 的存储键是 **workspace-scoped** 的（`workspaceScopedKey(TEAM_MODEL_BASE, workspacePath)`），并保留 legacy 无作用域键的读取回退。也就是说，「团队用哪个模型」实际上可以按 workspace 不同——这是一个有意为之的灵活性。

另一个细节是 `normalizeLlmBaseUrl`：远程 LLM host 强制 `http://` → `https://`。注释写了原因：Caddy/Nginx 后面的 LiteLLM 通常把 http 308 重定向到 https，而 fetch 与 AI SDK 会在重定向中丢掉 `Authorization` 头，表现为 `Authentication Error, No api key passed in.`。本地/内网 host 保留 http（它们不重定向，用户可能跑无 TLS 的开发 LiteLLM）。

---

## 9. 多品牌与 Onboarding

### 9.1 多品牌

`~/.amuxd-<brand>` 与 compile-time 品牌注入。`docs/architecture/multi-brand-local-daemon.md`。一个细节：`MQTT_FALLBACK_TEAM_ID` 是 `teamclaw`，品牌改名时**故意没改**——它是 rendezvous point，两端独立升级，没有迁移手段，改名会让所有混合版本的无团队设备对之间静默失联。

### 9.2 Onboarding

团队 onboarding 包括：登录 → daemon wizard（start-daemon → install-runtime → mint-invite → …）→ 选择/创建团队 → 选 workspace。`docs/specs/2026-06-02-unified-install-onboarding-design.md` 与 `2026-06-14-install-wizard-setup-engine-plan.md`。

一个原则：**runtime 在登录后、绑定后安装**，daemon 的 doctor 是唯一真相，没有 `setup-ok` 缓存（第 2 篇）。

---

## 10. 测试

- `stores/team-conflicts.ts`、`team-sync-status`、`team-share-browser` 的测试；
- `apps/daemon/src/sync/oss/` 的单元测试（scanner、ignore、tombstone、state）；
- `apps/daemon/src/config/global_team_store.rs` 的测试（布局迁移、team-sync 下移、幂等）；
- FC 侧 `services/fc/test/` 的 sync 与 ACL 测试；
- `deploy-env-parity.test.ts` 守着「新 env 必须在 compose 与 s.yaml 都声明」。

一个具体的测试值得单独提：`global_team_store.rs` 的迁移测试。它验证 pre-`team-sync` 布局能搬到新位置、幂等、且「legacy 与 team-sync 两份目录同时存在」时报错而不是猜。这种「迁移一次且只一次」的测试在团队同步里非常关键。

---

## 11. 关键文件索引

```
apps/daemon/src/
  config/global_team_store.rs      内容根、布局迁移
  config/workspace_link.rs         team-knowledge / team-documents 链接
  sync/oss/                        同步引擎
  sync/watch.rs                    fs 监听
  sync/scheduler                  per-team 调度
  runtime/team_cloud_config.rs     团队 MCP / env 的拉取与缓存
services/fc/src/
  lib/sync-handlers.ts             同步端点
  lib/sync-acl.ts                  目录级权限
  lib/sync-guards.ts               服务端拒绝与配额
  lib/pg-repo/team-mcp.ts          团队 MCP 仓库
  db/schema/                       表定义
services/supabase/migrations/      迁移（含 RLS）
packages/app/src/
  components/sidebar/TeamShareNavSection.tsx
  components/sidebar/TeamShareListColumn.tsx
  components/teamshare/            详情面（Skill/Mcp/Env/Knowledge）
  stores/team-share-browser.ts     资产浏览器
  stores/team-conflicts.ts
  stores/team-sync-status.ts
  stores/team-mode.ts
  stores/team-members.ts
  lib/team/                        团队、邀请、权限、skill 路径
  lib/backend/cloud-api/knowledge-acl.ts
```

---

## 12. 常见坑

1. **不要重新引入 `teams.share_mode` 分支。** 列还在，但没有读写方。
2. **不要把新资产塞进同步前缀。** 先问它是不是「有归属的文件」。
3. **三处白名单必须一致。** 改一处会让某端静默停止同步。
4. **`RETIRED_PREFIXES` 不能从 wire 上拒。** 会中止整个 manifest apply。
5. **不要替别人装 MCP / skill。** MCP 连管理员都没有这个口子。
6. **服务端判权字段必须是明文列。** env 的元数据在密文里。
7. **`team-knowledge` / `team-documents` 不要种进同步内容根。** 有守卫，别绕过。
8. **切换团队要重新解析内容根。** 不要缓存一次。
9. **不要用 `teamclu-team`。** 它已不再创建。
10. **新 env 要同时进 compose 与 s.yaml。** 有测试守着。

---

## 13. 一次同步 tick 的完整过程

把 daemon 的一次 tick 拆开，是理解整个同步链路最快的路径。

**步骤 1：准备。** 引擎拿到 team_id，解析内容根，读 `LocalSyncState`（记录每个文件上次同步的版本与哈希）。如果 `last_reconcile_at` 超过 30 分钟，这次 tick 标记为 reconciling。

**步骤 2：扫描。** `scanner.rs` 只遍历白名单目录，对每个文件产出 (path, mtime, size, hash)。忽略规则在这里生效——不 walk 进被忽略目录。这是「本地扫描性能」与「不把 node_modules 推上去」的第一道防线。

**步骤 3：规划 push。** `plan_push` 是纯函数，两个闸门：单文件 >25 MiB 跳过该文件（报进 `oversize`）；单 tick 新增 >2000 整次不发（报进 `blocked_new_files`，等人确认）。第二个闸门只数数、不读名字，所以在任何人写出规则之前就生效。

**步骤 4：批量 prepare。** 按 `MAX_BATCH=200` 切块，每块一次 `upload_complete_batch`。FC 返回 presigned PUT，客户端直传对象存储——字节不经过 FC。

**步骤 5：删除。** `locally_deleted_paths` 找「在 state 里、不在 scan 里」的路径，用 `is_ignored_with_ancestors` 过滤掉被忽略的，剩下的发 tombstone。这是最容易出事故的一步（下面单独讲）。

**步骤 6：拉 manifest。** 按 `afterSeq` 增量分页。如该 tick 是 reconciling，则从 0 全量 drain。

**步骤 7：应用 pull。** 对每个 manifest item：`needs_download = local.is_none() || item.version > local.synced_version`。需要则下载、写盘、更新 state。对 documents 前缀还有惰性分支（第 5 篇）。

**步骤 8：对账。** 如果是完整 drain（`nextCursor == null`），调 `apply_revocations`——state 里有、全量清单里没有的路径，就是被撤权的，要清理（三步顺序！）。

**步骤 9：状态。** 写回 `last_sync_at`、`last_error`、`oversize`、`blocked_new_files`、`stuck`，供 UI 读取。

**步骤 10：广播。** FC 在写入成功后往 `amux/<team>/sync/knowledge` 发一条 hint（不含路径），其它设备的 daemon 收到后进各自的调度器。

把这十步记住，再读 `engine.rs` 就不会迷路。每一处看起来奇怪的判断都对应上面某一步的一个陷阱。

---

## 14. 三个会删别人文件的陷阱

团队同步的事故几乎都指向同一件事：**把「不在本地」误判成「被删了」。** 有三个具体形态：

### 14.1 忽略规则迁移的 tombstone 广播

`locally_deleted_paths` 的判据是「在 `state.files` 里有（`synced_version > 0`），但不在本次 scan 结果里」。加 ignore 之后，一个历史上已经同步过的文件（比如某个团队之前真的同步了 `.obsidian/appearance.json`）会从 scan 结果里消失，于是引擎认为它被本地删除，**发出 tombstone，删掉全团队每台设备上的这份文件**。

解法：计算 tombstone 列表时用 `IgnoreRules::is_ignored_with_ancestors` 过滤一遍。被忽略的路径既不推、也不发删除。条目本来就留在 state 里，只是不再出现在 scan 结果中——规则将来放宽，文件重新被 scan 到，就会自己接着同步。少一个状态字段，少一处可能不同步的真相。

**上线前必须验证的一条**：拿一个历史上同步过 `.DS_Store` 的团队做回归，确认升级后云端那份没有被删。

### 14.2 惰性下载与 state.files

documents 的惰性下载（第 5 篇）引入第二种「不在磁盘上」的状态：文件在 manifest 里但从未下载。而这**正好是 `locally_deleted_paths` 的形状**。如果未下载的路径进了 `state.files`，第一次 push 就会把它们当本地删除广播出去。

解法：未下载的路径单独放一张 `known` 表，**不进 `state.files`**。评审时否掉了「给 `FileState` 加 `materialized: bool` 并在墓碑计算里跳过」——那会让 `state.files` 里同时住着两种语义完全不同的条目，而这张表被十几处代码读，**任何一处忘了检查那个标志，就是一次团队级删除**。分成两张表是用类型给出保证。

### 14.3 撤权的本地清理顺序

撤权后要删本地文件。engine 判断「文件被本地删除」的依据还是「在 state 里、不在扫描结果里」。所以**如果直接删文件而不先做别的，下一个 tick 就会把它当成本地删除，广播墓碑，删掉每个有权限的队友的磁盘副本。**

顺序因此必须是：

1. **先把前缀加入本地 ignore 判据**；
2. **再删本地文件**；
3. **再删 state 条目**。

顺序反了就是一次团队级数据丢失。这三步必须在同一个函数里，且带一条说明它为什么不能拆的注释。

### 14.4 三条教训的共同点

三个陷阱是同一个问题的三种外观：**一个路径从一个集合消失，到底是「本机没有」还是「已被删除」，必须由数据的形状而不是调用方的记忆来决定。** 所以解法都是「换一个容器」或「加一条硬排除」，而不是「在每个读取点记得判断」。

这条原则也解释了为什么 `apply_revocations` 必须只在完整 drain 之后调用：拿一页增量结果喂给它，等于把「不在这一页里」判成「不再有权限」，那会删掉整个知识库。函数的文档注释里写死了这条。

---

## 15. 团队邀请、成员与角色

### 15.1 邀请流程

`/v1/invites` 端点 + `invite/` 组件。两类邀请：

- **定向邀请**：指定邮箱/用户，对方收到通知后接受；
- **邀请链接**：一个可分享的链接，任何人可用一次。

邀请需要团队 actor 身份。接受后写入 `team_members`。

### 15.2 成员目录

`team-members.ts` 与 `actor-directory-store.ts`。成员的角色由 Cloud API 返回，前端 `useTeamPermissions()` 暴露 `canManageTeam`。

一个细节：成员列表里同时包含人和 agent。人和 agent 都是 actor，但展示上区分（agent 用圆角方形头像）。团队成员页在设置里的 team section（`components/settings/team/`）。

### 15.3 角色与权限的实际落点

| 动作 | 最低角色 | 服务端验证点 |
|---|---|---|
| 发版 skill | member | 无额外限制 |
| 改元数据 / 转交 owner | member | 无额外限制 |
| 删环境变量 | 创建者 或 admin/owner | `pg-repo` 应用层 + RLS |
| 建 knowledge ACL 规则 | owner/admin | `pg-repo` 应用层 + RLS |
| 改团队 LLM 配置 | owner/admin | 路由层 |
| 装技能给团队 agent | 团队 owner 或 agent 的 owner | `pg-repo/agents.ts` |
| 装 MCP | 本人 | RLS：actor_id 必须是调用者 |

这张表的价值在于：**它把「前端要不要显示按钮」和「服务端要不要放行」分开。** 前端只是体验，服务端才是权威。新增一个管理动作时，两处都要写。

---

## 16. 团队资产与工作区的关系

一个容易问的问题是：**资产是团队级的，还是工作区级的？**

答案混合：

| 资产 | 级别 | 备注 |
|---|---|---|
| knowledge / documents | 团队级（每团队一份全局副本） | workspace 通过符号链接看到 |
| skills | 团队级注册表 | 但可以装到 workspace 或 global |
| MCP | 团队目录 + 个人安装 | 安装的 scope 可选 |
| env | 团队级 | |
| LLM 配置 | 团队级 | 但 team model 存储键是 workspace-scoped |
| apps | 团队级 | 每个 app 一个 workspace |
| roles | 工作区/团队文件 | 可覆盖 |

这个混合不是混乱，而是「资产的性质决定了它的粒度」：

- 内容（knowledge/documents）按团队一份，因为团队要看到同一份东西；
- 能力（skills/mcp）有安装 scope，因为不同工作区可能需要不同能力；
- 配置（env/LLM）团队级，但允许 per-workspace 的偏好（模型选择）；
- 应用（apps）每个是一个工作区，因为每个 app 有自己的代码库。

skills 的安装 scope 在 `team_skill_installs` 表里是 `global | workspace`，workspace 时带 `workspace_id`。这也解释了为什么它表上的唯一索引是 `(actor_id, skill_id, scope, workspace_id)`。

---

## 17. 团队 AI 网关与预算

团队可以配置自己的 AI 网关（`services/ai-gateway/`），所有成员通过它调模型。这解决两件事：

1. **预算**：团队一份额度，而不是每人自己一个 key；
2. **模型分级**：管理员决定团队能用哪些模型。

配置走 `PUT /v1/teams/:id/llm-config`（`{ enabled, baseUrl, models }`）。FC 不再 provision LiteLLM；网关是被配置的。

一个容易混淆的细节：**「团队网关」和「团队 provider」不是一回事。** 前者是一组配置（baseUrl + models），后者是一个被登记为共享资源的 provider（`TEAM_SHARED_PROVIDER_ID`）。前端 `team-mode.ts` 管后者。

预算与用量：`TokenUsageSection`、`LeaderboardSection`、以及 `services/ai-gateway/` 的计量。用量数据对团队可见（谁用了多少），这是「共享额度」的必然要求。

---

## 18. 验收清单

改团队同步时，最少跑这几条：

1. 在 `knowledge/` 里 `git clone` 一个带 `node_modules/` 的仓库：同步状态显示被忽略/被拦截，`amuxc_files` 没有新增行，对象存储没有新对象。
2. 升级前同步过 `.DS_Store` 的团队，升级后云端那份仍在，本地不再推送它。
3. 一台故意不升级的旧客户端推 `node_modules/` → 服务端 422 拒绝，且不影响该团队其它文件。
4. 无 ACL 规则的团队，manifest SQL 与改动前逐字相同（比对 query plan）。
5. 被拒成员：manifest 不含受限路径；用已知 hash 打 download 被拒；versions 被拒；prepare/delete 被拒。
6. 撤权后被拒成员本地文件消失，**且有权限的成员本地文件完好**。
7. 未下载的 documents 全部释放后，下一次 tick 不产生任何墓碑。
8. 接受邀请后，成员能看到团队资产；退出后看不到。
9. 新 env 变量同时进了 compose 与 s.yaml。
10. 切换团队后，conflicts / 版本历史 / ACL 都指向新目录。

---

## 19. 常见问题

**Q：为什么知识库同步不是实时的？**
A：它有 fs 监听 + MQTT hint，安静时端到端 ≤10 秒。300 秒定时器是兜底。详见第 5 篇。

**Q：为什么不能选性地同步某个子目录？**
A：可以——用 `.amuxignore` 或 `.syncignore.local`。但那是自愿的、客户端的；要强制不可见用 Path ACL。两者不是一回事。

**Q：技能和知识库为什么不用同一种分发？**
A：因为技能需要版本、owner、when_to_use，而且不能全量推给所有人。同步是「文件模型」，注册表是「包模型」。

**Q：为什么 MCP 要装两次（目录 + 安装）？**
A：因为 MCP 的 command 会在你的机器上 spawn。目录只是「可选项」，安装才是「在你机器上生效」。

**Q：团队 env 服务端能读吗？**
A：不能。只上传密文信封，密钥在成员端。它防的是存储方，不是同事。

**Q：团队缓存和知识库的存储是同一个桶吗？**
A：线上是两个 bucket：`teamclu-app`（apps profile）与 `teamclu-self-host-storage`（默认 profile）。同一 bucket 内靠前缀分隔租户。

**Q：同名 skill 会怎样？**
A：市场引入时可以改 slug；团队内 slug 唯一。分辩公开时以 `(team_id, slug)` 为准。

---

## 20. 维护约定

本文与以下文档强耦合，变动时要同步：

- 同步引擎变了（新增前缀、改闸门）→ 第 3、14 节；
- 两种资产新增了分发方式 → 第 2 节表；
- 权限矩阵变了 → 第 6.3、15.3 节；
- `share_mode` 被真正删除 → 第 1.1 节；
- 新增了同步资产（比如 roles 上云）→ 第 2 节。

一条写作约定：团队这块最容易写成「我们支持 X」。要写成「X 的传输是 Y、归属是 Z、权限是 W」——因为当一个功能出问题时，第一个需要回答的就是这三件事。

---

## 21. 附录 A：相关数据表

与团队资产直接相关的表（都在 `amux` schema）：

| 表 | 作用 | 关键列 |
|---|---|---|
| `teams` | 团队 | id、name、share_mode（已无读写） |
| `team_members` | 成员关系 | team_id、actor_id、role |
| `actors` | 人和 agent | id、type、display_name |
| `team_workspace_config` | 团队工作区配置与水位 | oss_change_seq、llm_* |
| `amuxc_files` | 同步文件当前版本 | team_id、path、version、change_seq、content_hash |
| `amuxc_file_versions` | 同步文件历史版本 | file_id、version、content_hash |
| `amuxc_blobs` | 内容寻址 blob | content_hash、oss_key、size |
| `amuxc_path_acl` | 目录级规则 | team_id、path_prefix |
| `amuxc_path_acl_grants` | 规则的授权人 | acl_id、actor_id、permissions |
| `amuxc_access_log` | 受限内容访问审计 | team_id、actor_id、action、allowed |
| `team_skills` | 技能当前状态 | team_id、slug、owner_actor_id、latest_version |
| `team_skill_versions` | 技能版本 | skill_id、version、content_hash |
| `team_skill_installs` | 谁装了什么 | actor_id、skill_id、scope、workspace_id |
| `marketplace_skills` | 市场目录 | slug、publisher、latest_version |
| `marketplace_skill_versions` | 市场版本 | skill_id、version、object_path |
| `team_mcp_servers` | 团队 MCP 目录 | team_id、name |
| `team_mcp_installs` | MCP 安装记录 | actor_id、server_id |
| `team_env_secrets` | 团队 env（密文） | team_id、created_by、v、nonce、ciphertext |

几个值得注意的设计：

- **`amuxc_path_acl` 的 CHECK 约束**把两条机械规则钉在数据库层：`path_prefix LIKE 'knowledge/%'`（现在放宽到两个根）且 `path_prefix LIKE '%/'`。后半条防止 `knowledge/hr` 误匹配 `knowledge/hr-public/`。
- **`amuxc_path_acl_grants` 拆成两张表**是因为授权和撤权是审计对象（谁在什么时候把谁加进来的），数组存不下 `granted_by` / `granted_at`。
- **`amuxc_access_log` 的 `allowed` 列同时记拒绝**：一个成员反复尝试访问自己没权限的目录，本身就是需要被看见的信号。
- **`team_env_secrets` 的 `created_by` 是独立的明文列**，不是与信封里字段冗余——它是服务端判权时唯一能读到的。

---

## 22. 附录 B：workspace 链接的实现细节

`ensure_workspace_link` 的行为值得逐条列出，因为它是「本地文件树与会话团队资产相接」的唯一入口：

1. **先初始化全局目录。** `global_team_store::ensure_initialized(team_id)`。失败则 warn 并 `Fallback`。
2. **移除旧的 `teamclu-team` symlink**（如果是真实目录则不动）。注释：“一个同名的真实目录先于全局存储存在，没有任何东西能证明它的内容曾经被同步过。”
3. **守卫：workspace 就是团队自己的 `shared/`。** 直接 `Fallback` 并 warn。注释说明了后果：“它的 `teamclu-team` 就是全局存储目录本身，把同步根链接进去会把 `shared/team-knowledge` 种进同步内容根——扫描器会走进去。”
4. **Unix/macOS 用 symlink。** 失败则 `Fallback`。
5. **Windows 先试目录 junction。** 失败则 `Fallback`，读者直接用全局目录。
6. **幂等。** 重复调用不报错。

“永不返回错误”是一个刻意的设计：打开 workspace 不应该因为链接权限失败而报错。代价是调用方需要处理 `Fallback`，否则会以为链接一定存在。

---

## 23. 附录 C：与 Cloud API 的端点清单（团队相关）

| 类别 | 端点 |
|---|---|
| 团队 | `/v1/teams`、`/v1/teams/:id/workspace-config`、`/v1/teams/:id/workspace-defaults` |
| 成员 | `/v1/teams/:id/members` |
| 邀请 | `/v1/invites` |
| LLM | `PUT /v1/teams/:id/llm-config` |
| 同步 | `/v1/sync/manifest`、`/upload/prepare`、`/upload/complete`、`/download`、`/delete`、`/versions`、以及 batch 变体 |
| Skills | `/v1/teams/:id/skills`（列表/发布）、`/:slug/versions`、`/:slug/versions/:v/download`、`/:slug/install` |
| 市场 | `/v1/marketplace/skills`、`/v1/teams/:id/skills/adopt`、`/:slug/detach` |
| Knowledge ACL | `/v1/teams/:id/knowledge-acl`（GET/POST）、`/:aclId`（PATCH/DELETE）、`/preview` |
| MCP | `/v1/teams/:id/mcp-servers` 相关 |
| Env | `/v1/teams/:id/env` 相关 |

完整契约在 `docs/openapi/teamclu-api.v1.yaml`。新端点的实现顺序固定，见第 1 篇第 10 节。

---

## 24. 附录 D：术语

| 术语 | 含义 |
|---|---|
| 团队资产 | 团队拥有的七类共享资源 |
| 内容根 | `shared/team-sync/` |
| 同步根 | `documents/` 与 `knowledge/` |
| ALLOWED_PREFIXES | 三处镜像的白名单 |
| RETIRED_PREFIXES | 退役但仍被 wire 接受的前缀 |
| 全局副本 | 每团队一份的本地同步目录 |
| workspace 链接 | `team-knowledge` / `team-documents` |
| tombstone | 本地删除广播 |
| 水位 | `oss_change_seq` |
| 安装制 | MCP 的「目录 + 每人选装」模型 |
| 密文信封 | env 的 `{v,nonce,ciphertext}` |
| share_mode | 已废弃的共享开关 |

---

## 25. 附录 E：一次资产浏览的完整流程

点开第一列的「技能」，走的是什么：

1. **导航状态变更。** `sidebarFilter` 变成 `{ kind: 'teamShare', section: 'skills' }`。
2. **第二列渲染。** `TeamShareListColumn` 按 section 分发，渲染技能列表。
3. **数据加载。** `team-share-browser.ts` 的 `loadSection('skills')`。它的数据源有几路：团队注册表（Cloud API）、本机磁盘、当前 agent 的 RPC。
4. **计数。** `useTeamShareCountsLoader()` 在 NavRail 里已经拉过一次，列表页直接用。
5. **选中。** 点一行，`detailTarget` 更新，主列渲染 `SkillDetail`。
6. **详情。** 文件树 + 文件编辑器 + 版本列表 + 安装/更新/卸载按钮。
7. **动作。** 安装走 `team_skill_install`（桌面命令），下载 zip → 解压 → 回写 frontmatter → 写 origin/lockfile/permission → `PUT .../install`。
8. **落盘后。** `refresh_watch.rs` 监视 `~/.agents/skills`，归类成 `RefreshChangeKind::Skills`，当前会话记 pending，不 idle auto-apply；需显式 Apply/reload。同时该 workspace 的 host 会滚动替换 generation。

这八步里，第 3 步的「数据源有几路」是最容易出问题的地方：同列表里既有团队注册表的东西，也有本机磁盘的东西，还有 agent 侧的东西。区分它们的依据是 `source` 字段（`local` / `builtin` / `clawhub` / `team`）。**没有这个字段，对账就无法圈出自己该管的那部分。**

同样的逻辑适用于四个 section：每个都有「团队级」与「本机级」两层，而 UI 要把它们放在一起显示。这是团队资产浏览器最本质的复杂度。

---

## 26. 附录 F：同步的性能与成本

同步是免费的？不是。它的成本分布：

**FC / Postgres。** 每个文件一行 `amuxc_files` + 每版本一行，加 manifest 分页与 batch 请求数（一次最多 200 条）。`/v1/sync/*` 豁免 per-IP 限流，所以容量约束靠按 team 的配额。

**对象存储磁盘。** 字节是 presigned 直传，不经过 FC。self-host 的 MinIO 在根盘，余量个位数 GB。一个 `node_modules/` 就能吃掉它。所以客户端 ignore + 单文件 25 MiB + 单 tick 2000 新文件 + 服务端清单 + 每 team 5 万文件 / 2 GiB 字节配额，是六道防线。

**收端。** 反直觉但重要：真正贵的是每个 daemon 那次 manifest 查询加全树扫描。所以 MQTT hint 的限流加在订阅端（2 秒窗口 + 15 秒地板），不在发布端。

**本地磁盘。** 每个团队一份全局副本。documents 的惰性下载就是为了这块（第 5 篇）。

**配额不会误挡**是设计里的硬约束：它只在「无论这些文件叫什么都已经是问题」的量级上触发。`SYNC_MAX_FILES_PER_TEAM` 默认 50000，没被拖进过仓库的知识库够不到，而一个 `node_modules` 自己就能越过。字节配额默认 2 GiB。

**配额 ≠ 磁盘保护。** 物理占用还含历史版本 blob，回收靠 FC cron 的 `amux.oss_sync_gc_orphan_blobs()`，而 cron 是 compose 的独立 profile，self-host 没开。ticket 关闭前对外不说「磁盘安全」。

---

## 27. 附录 G：变更记录

| 变动 | 影响章节 |
|---|---|
| `share_mode` 列真正删除 | 1.1 |
| 新增同步根 | 3.4、20 |
| skills 上云完整落地 | 2.2 |
| MCP 开放替换安装 | 2.3 |
| 新增资产类别 | 2 |
| 权限矩阵变动 | 6.3、15.3 |
| cron profile 启用（GC） | 26 |
| 团队级预算/计费上线 | 17 |

写本文最需要避免的错是把它写成「团队功能说明」。它应该回答的是每个资产的三件事：传输、归属、权限。三件事说不清，就说明设计还没完成。

---

## 28. 附录 H：同步与 daemon 生命周期

团队同步完全跑在 daemon 里，所以它的行为与 daemon 的生命周期强绑定：

| daemon 状态 | 同步行为 |
|---|---|
| 未安装 | 无同步，客户端显示引导 |
| 未登录/未绑团队 | 无同步 |
| 已绑定、已登录 | 启动跑一次，之后定时 + fs + MQTT |
| 团队切换 | 重新解析内容根，重选 controller |
| 离线 | 本地改动累积在 state；联网后一 tick 全推 |
| 关闭 app | **继续同步**（daemon 独立） |
| daemon 被杀 | 重启后从 state 恢复，幂等 |

最后一条是整块设计的核心优势：**关掉 app 不停同步**。这也是为什么真正的同步逻辑不能在客户端——客户端会被关，daemon 不会。

一个与 ADR-0006 相关的细节：daemon 的状态按 team 归属，所以多团队时每个团队有自己的 state、自己的内容根、自己的定时器与调度器。切换团队不是「换一个配置」，而是「换一整套状态」。

---

## 29. 附录 I：为什么不用 git

一个常见的问题：既然是 Markdown、有历史、要合并，为什么不用 git？

理由有三层：

**第一层：产品定位。** 知识库的写入面是 Obsidian，不是命令行。用户不会为了同步一篇笔记去 commit。一个需要用户理解分支/合并的工具，失败率远高于一个自动同步的目录。

**第二层：冲突语义不同。** Git 的冲突是行级的，而我们明确不做行级 merge。冲突在知识库里是「两个人改了同一篇」这种文件级事件，解法是人工选择（保留我的/保留云的），而不是三路合并。用 git 反而会把「文件级冲突」映射成一个更复杂的模型。

**第三层：依赖与跨平台。** Git 意味着 Windows 上的 git 依赖、clone/pull 状态、浅克隆策略、认证方式。而 `CLAUDE.md` 写死了「`git` is not invoked anywhere in the product」——git share 是被刻意删掉的。

所以团队同步用的是 **OSS + 内容寻址 blob + 增量 manifest + tombstone**。它比 git 简单，但正好匹配需求：目录同步、单写者冲突、明文存储、秒级推送。

一个需要知道的例外：**apps 功能确实用 git**（每个 app 一个 Gitea checkout），但那与团队共享无关，是 app 自己的代码版本管理。两者不要混在一起。

---

## 30. 附录 J：安全叙事的统一口径

团队资产的敏感性不同，叙事必须分开：

| 资产 | 对服务端可见？ | 能不能说「加密」？ |
|---|---|---|
| knowledge | 是（明文） | 不能。说「TLS 保护传输，不是端到端加密」 |
| documents | 是（明文） | 同上 |
| skills | 是（明文 zip） | 不能 |
| mcp 目录 | 是 | 不能 |
| env | 否（密文信封） | 可以说「客户端加密，服务端只存密文」 |
| LLM 配置 | 是 | 不能 |

一条措辞纪律：**不要把「有权限管理」说成「敏感目录受保护」。** Path ACL 提供的是团队内的访问控制，不防运维、不防我们自己。一个主打防内部窥探的功能，如果承诺了做不到的撤回，第一次出事就是信任崩塌。我们真正能交付的是可追溯，不是不可能的收回。

这条口径在 ADR-0008、Path ACL 设计、`KnowledgeAclSection` 的 UI 文案里各落了一次，三处必须保持一致。

---

## 31. 附录 K：排障手册

看同步问题时，按这个顺序查：

**第一步：状态。** 底部栏说的是什么？已同步 / ↑N ↓M / 冲突 / 被拦下 / 失败。每种对应不同的下一层。

**第二步：谁的问题。** 是本地推不上去，还是拉不下来？`team-sync-status.ts` 的 `localBySyncKey` 是推、`remoteBySyncKey` 是拉、`stuckBySyncKey` 是两边的异常。

**第三步：daemon 在跑吗。** 关掉 app 后同步仍应继续。如果关了 app 就不同步，说明 daemon 没在跑。

**第四步：看具体原因。**

| 现象 | 可能原因 |
|---|---|
| 文件不推 | 被 ignore、超 25 MiB、超过 2000 新增闸门、被服务端拒绝（422） |
| 文件不拉 | 被 ACL 限制、拉取失败但已跳过、清单滞后 |
| 显示待删除但没删 | 被忽略的文件从前端看是“待删除”（已修：两边共用排除规则） |
| 冲突反复出现 | 两边持续修改同一篇 |
| 版本号不前进 | 上游/租户路径不匹配 |
| 全部不动 | 三处白名单不一致（旧客户端）| 或水位卡住 |

**第五步：不要猜。** 诊断 bundle（`lib/diagnostics/`）与 daemon 日志里有 manifest 响应、prepare 结果、错误码。一个具体的建议：报障时带上「sync key + 版本 + 错误码」，三者能把问题定位到具体一步。

---

## 32. 附录 L：六条不变量

如果只能记住本文六件事，是这些：

1. **只有两个同步根，且它们是两种内容性质（有归属的文件 vs 共识）。** 新资产先问它是不是「有归属的文件」，不是就不该进同步。
2. **三处白名单必须一致，加前缀是硬升级。** 旧 build 会静默停止同步，且永不自愈。
3. **「不在本地」不能等于「被删了」。** tombstone 判据、惰性下载、撤权清理，三处都是这个陷阱。
4. **冲突副本、未下载文件、被忽略文件都必须有独立的存储位置，不能靠标志位区分。** 因为总有人忘了检查标志。
5. **需要执行的东西（MCP、skills）不能靠全量同步。** 同步是文件模型，不表达「谁装了」。
6. **同步归 daemon。** 关掉 app 不停同步，这是它区别于「一个客户端功能」的根本。

把这六条记住，再读代码时会发现每一处看似旁枝的代码都在守护其中一条。

最后一个实用的判断方法：当你要新增一个「团队级」功能时，先写下它的三行答案——**传输是什么、归属是什么、权限是什么**。如果三行里有两行写不出来，那这个功能还不该开始写；写完三行后如果发现它与现有七种资产里的某一种完全同形，就直接复用那一种，不要因为「它叫别的名字」而新建一套机制。这七种机制加起来已经够多了，每多一种都要多一份对账、多一份迁移、多一份事故面。

---

## 33. 最后一条：团队资产的分类法

如果要把整篇压缩成一个可用的分类法，是这三个问题：

**一、它是内容还是会执行的东西？** 内容可以同步（knowledge/documents）；会执行的东西必须有安装制（skills/mcp）。

**二、它属于团队还是个人？** 团队级的有知识库、资料库、技能、MCP目录、env、LLM、app；个人级的是安装记录、模型偏好、本机覆盖。

**三、它的权限是按目录还是按人？** 内容按目录（Path ACL）；会执行的东西按人（安装记录）。

这三个问题的答案能把任何一个新资产放在正确的位置上。如果一个新资产让这三个问题都答不上来，那说明它还没有被想清楚——而不是需要一个新的机制。本仓库里七种资产的复杂度已经够多了，每多一种都要多一份对账、多一份迁移、多一份事故面。

---

## 34. 附录：一个可以复用的判断

写到这里可以发现，这一篇里几乎每一个设计决定都能归到一句话：**「一个值有几个来源？」**

- 路径只有一个来源（daemon），所以不做创建时选目录；
- 权威只有服务端（本地是投影），所以对账以服务端为准；
- 前缀只有两个来源（两个同步根），所以第三个就一定不该存在；
- 权限只有一张表（`app_member_access`），所以不新增 git 维度。

这条判断可以推广到任何新功能：**在写代码之前，先数一遍这个值有几个写入者。** 一个写入者最好；两个写入者就要定义谁是权威、另一个怎么跟随；三个以上几乎一定是设计问题。

本仓库里大部分架构性 bug 都是「两个写入者且没定义权威」的后果，而本仓库里大部分约束都是在把这个数字降回一。

---

## 35. 结语

团队这块的核心是**归属**：什么属于团队、以什么方式分发给成员、谁能改它。七种资产用七种传输方式不是历史包袱，而是「每种资产的性质不同」的正确反映。真正危险的是把它们统一成一种机制——同步简单，但它把「不执行任何东西的内容」和「会在你机器上 spawn 命令的配置」混为一谈，后者就是 `.mcp/` 搬家的原因。
