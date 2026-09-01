# 团队 MCP 与团队 env 走 Cloud API

状态：已落地。`.mcp/` 与 `_secrets/` 都已退出同步前缀——三处镜像常量
（daemon / desktop 的 `ALLOWED_PREFIXES`、FC 的 `sync-path.ts`）现在都只有
`documents/` 和 `knowledge/`，客户端读的是 Cloud API。
相关：`docs/architecture/team-skills-registry.md`、`docs/architecture/personal-env-and-runtime-env.md`

## 1. 背景

团队共享此前通过 amuxd 的 git/OSS 引擎同步六个前缀：

```
skills/  knowledge/  .mcp/  _meta/  _secrets/  _feedback/
```

`skills/` 已经改成服务端注册表。本次把 `.mcp/`（团队 MCP 配置）和
`_secrets/`（团队 env，客户端加密）也搬到 Cloud API，**同步引擎退化成只管内容**。
`_meta/` 与 `_feedback/` 从此没有写入方。git 模式后来整个删掉了，只剩 OSS；内容
根之后又从一个 `knowledge/` 扩成 `documents/` + `knowledge/` 两个
（见 `docs/specs/2026-09-01-team-sync-two-roots-design.md`）。

搬迁同时修掉两个现状问题：

**其一，`.mcp/` 根本没有写入端。** 没有任何代码创建这些文件——桌面端只建了个空
目录和一份 README，让人手写 `<server-name>.json`，UI 里团队 MCP 是只读的。内容
全靠 git push 或 OSS 同步进来。

**其二，MCP 的 `env`/`headers` 明文同步，没有任何脱敏。** 设计上应当写 `${KEY}`
占位符、运行时由 `crates/teamclu-runtime-env/src/mcp_resolve.rs` 从加密库解出，
但没有任何东西强制这一点，直接粘 token 就会明文进团队仓库。

先例：团队 LLM 配置已经从磁盘同步搬到云上（`_meta/provider.json` 已删除，改走
`GET /v1/teams/:id/workspace-config` + `PUT /v1/teams/:id/llm-config`）。本次是
同一套模式的下半场。

## 2. 两条核心设计

### 2.1 MCP：从「自动下发」改为「目录 + 每人选装」

这是本设计的骨架。

此前 `.mcp/` 整个目录同步给所有成员，并被 `materialize_team_mcp_for_runtime`
写进每个人的 `opencode.json`。而 MCP server 的 `command` 是要在成员机器上
**spawn** 的——等于任何能 push 团队仓库的人，都能在全团队的机器上执行任意命令，
唯一的门槛是仓库写权限。

改成安装制后：

- **任意团队成员都能往目录里加** server（写目录不执行任何东西）
- **只有本人能给自己安装**，安装才会 materialize 进自己的 `opencode.json`
- 没有「替别人安装」这条路径——连管理员也没有

之所以敢把「加」放得比 `team_skills`（任意成员可发布）还开，正是因为「加」不再
等于「在别人机器上生效」。风险从「一个成员被盗号 → 全团队执行任意命令」降到
「一个成员被盗号 → 目录里多一条没人装的脏数据」。

对比 `team_skill_installs`：那里管理员还能装给 `visibility='team'` 的共享 agent。
这里**不放这个口子**——多一条「别人能替你决定装什么」的路径就多一分横向移动面。
团队共享 agent 真需要 MCP 时再单独设计。

### 2.2 团队 env：加密模型完全不变，只换存储介质

客户端继续用团队密钥做 AES-256-GCM（HKDF-SHA256 派生，见
`crates/teamclu-runtime-env/src/team_crypto.rs`），**只上传信封**
`{v, nonce, ciphertext}`。服务端——包括 self-host 的 DB 运维方——拿不到明文。

这与此前落在 OSS 上的模型完全一致：防的是存储方，不是同事（一个团队一把密钥，
每个成员都持有）。换句话说，搬迁改变的是传输和存储位置，不是安全保证。

**由此带来一个不直观但重要的约束**：`description` / `category` / `createdBy` /
`updatedBy` / `updatedAt` 这些元数据**全都在密文里面**（`SecretEntry`），服务端
读不到。所以任何服务端要用来判权的字段，都必须是**独立的明文列**。表上的
`created_by` 不是与信封里那个字段冗余——它是服务端在决定「谁能删」时唯一能读到
的那份。

## 3. 数据模型

迁移：`services/supabase/migrations/20260806020000_team_mcp_and_env.sql`

| 表 | 用途 |
|---|---|
| `amux.team_mcp_servers` | 团队 MCP 目录，每个 server 一行 |
| `amux.team_mcp_installs` | 谁装了哪个 server |
| `amux.team_env_secrets` | 团队 env，只存密文信封 |

RLS 要点：

- `team_mcp_servers`：成员可读可增；改/删限创建者本人或 admin/owner
- `team_mcp_installs`：**写入只有一条闸门——`actor_id` 必须是调用者自己**
- `team_env_secrets`：成员可读、可增、可改；**删**限创建者本人或 admin/owner
  （改一个值是协作，删掉一个 key 会让所有人的 runtime 少一个环境变量，
  破坏性不对等）

## 4. API

契约见 `docs/openapi/teamclu-api.v1.yaml`。

```
GET    /v1/teams/:teamId/mcp-servers                  目录 + 调用者的 installed 标记
POST   /v1/teams/:teamId/mcp-servers                  任意成员可加
PATCH  /v1/teams/:teamId/mcp-servers/:name            创建者或 admin
DELETE /v1/teams/:teamId/mcp-servers/:name            创建者或 admin
PUT    /v1/teams/:teamId/mcp-servers/:name/install    只能装给自己
DELETE /v1/teams/:teamId/mcp-servers/:name/install
GET    /v1/teams/:teamId/mcp-servers/config           daemon 用（见下）

GET    /v1/teams/:teamId/env-secrets                  密文列表
PUT    /v1/teams/:teamId/env-secrets/:keyId           upsert 信封
DELETE /v1/teams/:teamId/env-secrets/:keyId           创建者或 admin
```

**`/mcp-servers/config` 的形状是刻意设计的**：它返回的恰好是一个 Cursor
`mcpServers` map，且**只含调用者已安装的** server——也就是 daemon 此前从
`.mcp/*.json` 读到的那个字节形状。daemon 把响应体原样写进本地缓存，
`scan_team_mcp` 零改动地解析。这是让 daemon 侧改动保持极小的关键。

路由注册顺序上 `/mcp-servers/config` 必须在 `/mcp-servers/:name` **之前**，
否则 `config` 会被当成 server 名吞掉（有测试守着）。

### 4.1 密钥硬校验

`env`/`headers` 里 key 名匹配 `/(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)/i`
的项，值必须是 `${KEY}` 或 `$KEY` 形式，否则 **422 `literal_secret_rejected`**。

三点说明：

1. **匹配 key 名而不是嗅探值。** 对值做启发式要么漏掉短 token，要么误伤正常
   配置；key 名是作者能理解、能控制的东西。
2. **拒绝而不是警告。** 落进共享服务器的警告，等到有人读到时秘密已经泄露了。
3. **时机。** 这条约定此前之所以能一直「只是约定」，是因为数据搭的是加密的 OSS
   blob；现在它要落进服务端可读的列，正是把约定升级成契约的时候。

`tc_api_key` 和 `_team_secret*` 是保留 keyId，直接 422——后者本身就是解开其余
一切的那把钥匙。

## 5. 客户端接入（分阶段）

| 阶段 | 内容 |
|---|---|
| PR1 ✅ | OpenAPI + 迁移 + drizzle + pg-repo + **supabase-repo** + routes + 测试 |
| PR2 ✅ | daemon：backend trait + `team_cloud_config.rs` reconciler + 落盘缓存 + 双源读取 |
| PR3 ✅ | 桌面端团队 env 读写切云；store 层 `team-mcp.ts` |
| PR4 ✅ | 三栏 UI：`McpDetail` 安装/编辑/删除、`EnvDetail` 就地编辑、列表新增入口 |
| PR5 ✅ | 摘掉 `.mcp/`、`_secrets/` 前缀；拉取循环改跳过 |

**「摘前缀」摘的是同步，不是读取。** `ALLOWED_PREFIXES` 里去掉这两个前缀，扫描器
就不再推、拉取循环也不再落盘；但**旧目录仍然读**。理由：既然不同步了，这些文件
只可能存在于「迁移前就有」的机器上，读它们的成本为零，却能让老 checkout 继续工作；
而云缓存在候选列表的最后，所以它们永远盖不过云端的值。

**关键：`validate()` 必须继续接受这两个前缀。** 拉取循环里是
`validate(&item.path).map_err(SyncError::from)?`——硬 `?`，而 `SyncError::InvalidPath`
被归类为非瞬时错误、永不自愈。迁移前同步过的团队，manifest 里还有这些行；一旦
`validate` 拒绝，第一条遗留记录就会中止整个 manifest apply，把**本该继续同步的
`knowledge/` 一起带走**。所以拆成两个常量：`ALLOWED_PREFIXES`（还推还拉）和
`RETIRED_PREFIXES`（线上仍合法，但扫描器不推、拉取循环 `continue` 跳过）。

服务端 `services/fc/src/lib/sync-path.ts` **不动**——保持宽松，避免旧 daemon 的推送
拿到永久性 422 把它们的同步循环刷爆。

**两个后端实现都要写。** `BACKEND_KIND` 在 docker-compose 里默认 `supabase`，
只写 `pg-repo` 的功能在真实部署上是 500。单测发现不了——它注入 fake repository，
从来看不到容器实际加载的是哪个后端。这是本地起完整 self-host 栈做端到端测试才发现的。

**端点必须跟着渲染层走，不能用编译进二进制的那个。** token 是渲染层当前指向的那台
服务器签发的，而 `get_fc_endpoint()` 返回的是 build-config 里的地址——两者一旦不一致，
就是必然 401。所以团队 env 的读写都从前端接收
`getEffectiveServerConfigSync().cloudApiUrl`，走 `resolve_runtime_fc_endpoint()`，
和 `team_share/join.rs` 等既有命令同一套契约（那个函数的文档原话就是「运行时选服务器
这件事发生在渲染层，原生命令必须用这个值而不是二进制里烘的那个」）。

注意这跟 `get_fc_endpoint` 注释里**故意删掉**的那个 override 不是一回事：被删的是
`teamclu.json` 里的**每工作区持久化 pin**——陈旧、不可见、会悄悄盖过 build config。
这里传的是渲染层**当前生效**的值，和 token 同源同批次，正是那段注释想要的「两边锁步」。
URL 格式非法时返回 `None` 而不是回退到 build config——回退会把要避免的错配又请回来。

**桌面端写入不再需要本地 `team_dir`。** `set_secret_for_workspace` 改成只解出
密钥（`ensure_derived_key`）就加密上传，不再走 `try_lazy_init_from_workspace`——
后者还要求已同步的共享目录，会让「加入了团队但没拉过共享文件夹」的成员写不了
团队 env，而那恰恰是最需要它的场景。删除的本地 role 预检保留，但只为了给出一句
人能看懂的错误；真正的权限边界是 RLS，它看到的是真实 actor 而不是本机 node id。

### 5.1 daemon 侧的硬约束（PR2 必须处理）

`scan_team_mcp()` 和 `load_team_env_from_secrets_dir_detailed()` **都是同步
函数**，且从同步调用点进入（`assemble_spawn_runtime_env` 等）——**云请求不能内联
进去**。且 agent 必须能离线跑。

解法是 **daemon 自有的落盘缓存 + 异步 reconciler**：缓存放
`~/.amuxd/teams/<team_id>/state/cloud/`（`layout::team_state_dir` 下，**在同步树
`shared/team-sync/` 外面**，否则会被同步引擎当成本地文件、给每个队友产生
tombstone）。同步读取端只需在候选目录列表里加一项。

三个必须处理的陷阱：

- **离线时团队 MCP 会被永久私有化。** `classify_source` 在团队 map 为空时判为
  `Workspace`，用户一改再 PUT 回来，`filter_put_body` 就把它固化成本地配置，
  网络恢复也回不去。→ 团队层必须是三态 `Known(map) | Unknown`，`Unknown` 时
  保持上次分类、拒绝提升（照抄 `ManagedLlmState::Unknown` 的语义）。
- **离线启动会把字面量 `${KEY}` 灌进运行时。** `resolve_config_secret_refs` 在
  secrets 为空时短路不写 overlay。→ 必须区分「团队确实没有 env」和「拉取失败」，
  后者用缓存兜底，缓存也没有时 fail closed。
- **`managed_llm` 的内存 TTL 缓存不足以照抄**：它是进程内的，daemon 重启即空；
  它没事是因为真正的持久产物是磁盘上的 `opencode.json`，而团队 env 每次 spawn
  现解现注。→ 缓存必须落盘。

另外 `refresh_watch.rs` 对 `.mcp/` 和 `_secrets/` 的监听是 `RefreshChangeKind::Mcp`
/ `EnvVars` 的唯一产生者，要把缓存目录纳入分类，否则云端改了配置永远不弹「需要
重启 runtime」。`materialize_team_mcp_for_runtime` 目前只插入不移除，改成安装制
后需要补 reconcile。

## 6. 已知取舍

- **旧客户端不兼容。** 不做双写、不加版本门槛。旧版本会静默看到陈旧数据（不报错、
  不丢数据），升级后恢复。切换时生产环境无存量数据，故无导入逻辑。
- **团队 env 编辑需要联网。** 此前是本地写文件、离线可用；改成云写入后离线编辑
  会失败且没有排队重试。读取有缓存兜底，不受影响。
- **MCP 的 `env`/`headers` 在 Postgres 里是服务端可读的明文列**（此前随加密 OSS
  blob 走）。靠 §4.1 的硬校验把真密钥挡在外面，但非密钥类的配置值确实变成服务端
  可见。
