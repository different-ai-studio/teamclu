# amuxd 家目录布局 v2（规范）

> 状态：规范性文档。本文的目录树**就是验收标准**，与
> `teamclu_runtime_env::storage_namespace::ROOT_ALLOWLIST` 逐项对齐；两者不一致
> 时以本文为准，并在同一个 PR 里改回一致。
>
> 决策依据见 [ADR-0006](../adr/0006-daemon-state-is-team-scoped.md)。
> 面向用户的说明见 [`../amuxd-home-directory.md`](../amuxd-home-directory.md)。
>
> **落地进度**（本文描述的是目标态，不是当前态）：
>
> | 刀 | 内容 | 状态 |
> |---|---|---|
> | ① | 规范 + ADR + 字面量棘轮 | ✅ |
> | ② | 品牌判据收敛到只认 `teamclu` | ✅ |
> | ③ | 两个家目录各一个 helper 入口 | ✅ |
> | ④a | 根目录收敛 `run/` `logs/` `cache/` + 白名单测试 | ✅ |
> | ④b-1 | `teams/<id>/{shared,state,workspace}` 三层 | ✅ |
> | ④b-2 | `backend.toml` + `cloud-token` 下沉、`_unclaimed` + claim 时 rename | ✅ |
> | ④b-3 | `runtimes.toml` / `sessions/` / `history/` / `mcp-configs/` / `attachments/` / `apps/` / `members.toml` 下沉 | ✅ |
> | ④b-4 | 每团队一把 `secret.key` + `secrets.enc` 下沉、删掉反向搬运器 | ✅ |
> | ④c | 旧路径一次性清理 + 删除全部迁移代码 + `amuxd clear` 重写 | ✅ |
> | ⑤-C | 身份去重：`backend.toml` 独占 `actor_id`，`daemon.toml` 只剩 `active_team` 指针 | ✅ |
> | ⑤-D | 日志三合一 + 轮换（`logs/amuxd.log`，32 MiB × 3，`[log]` 可调） | ✅ |
> | ⑤-A | `team.toml` 拆分：`[channels]` / `[team_share]` / `local_agent` 下沉 + 凭证入 `secrets.enc` | ✅ |
> | ⑤-A′ | `agents.{cursor,claude}.api_key` 出 daemon.toml 入个人密钥库 | ✅ |
>
> ⑤ 里原列的"device-id 改名与边界"已作废，理由见 §3.2；`amuxd clear` 重写
> 提前并入 ④c，因为删掉 `legacy_config_dir` 时它是唯一的剩余调用方。
>
> ⑤-A 已落地，与 §4.3 的两点偏差：(1) 凭证按 §4.3 存进 `secrets.enc`
> （`TeamSecrets.channel_secrets`，键为 `channels.wecom.bots[<bot_id>].secret`
> 形式——按 bot_id 而非数组下标，删 bot 不会把别人的密钥错配过去）；保存时
> **空字符串凭证 = 保留已存值**，桌面表单因此不需要回显明文。(2)
> `config/edit.rs::is_secret_key` 的 channels 分支**保留**而非删除——合并视图
> 的 HTTP 列表仍靠它打码。编辑面按 key 在 `edit.rs` 内部路由（`channels.*` /
> `team_share.*` / `agents.local_agent` → team.toml），HTTP/CLI/前端契约零改动。
>
> **⑤-A 未经真实网关联测**：wecom 回调、多 bot 轮换等只有单测覆盖，发布前需要
> 一次真机验证。⑤-A′ 已落地：两个 `api_key` 字段从结构体删除，daemon 侧统一经
> `runtime::personal_api_key()` 读个人密钥库（`CURSOR_API_KEY` /
> `ANTHROPIC_API_KEY`，进程 env 仍最优先）；桌面 Cursor 设置写个人 env store，
> `default_model` 留在 daemon.toml。`amuxd manage` 无需改——它的 LLM 菜单写的是
> workspace 级 provider，从未碰过 agents.api_key。headless 场景用 env var 或由
> 桌面端预先写好个人库。

---

## 1. 两条不可违反的规则

**规则一：谁拥有目录，谁负责写。**

| 目录 | 拥有者 | 另一方 |
|---|---|---|
| `~/.amuxd*` | daemon | 桌面端只读（发现端口 / token / 诊断），**不写** |
| `~/.{brand}/` | 桌面端 | daemon 只读（个人密钥），**不写** |
| `<workspace>/` | 双方 | 各写各的文件，见 §5 |

**规则二：`~/.amuxd` 根目录只允许出现这七项。**

```text
daemon.toml  device-id  mcp.json  teams/  run/  logs/  cache/
```

新增任何东西之前，先回答一个问题：**换一个团队，这个值该不该跟着变？**
该变 → `teams/<id>/state/`；不该变且是缓存 → `cache/`；不该变且是进程运行时 →
`run/`；都不是 → 它多半不属于这里。

---

## 2. 目录树

```text
~/.amuxd/                              # 官方（shortName = teamclu）
                                       # 白标为 ~/.amuxd-<brand>
                                       # $AMUXD_HOME 覆盖两者
│
├── daemon.toml                        # 机器级配置 + 活跃团队指针（§3.1）
├── device-id                          # daemon 安装 id，仅用于版本上报（§3.2）
├── mcp.json                           # 设备级 MCP server（§3.4）
│
├── run/                               # 进程运行时，随进程生灭，可安全删除
│   ├── amuxd.pid
│   ├── amuxd.lock
│   ├── amuxd.sock                     # 仅 unix；Windows 用命名管道，不落盘
│   ├── amuxd.http.port
│   ├── amuxd.http.token               # 0600
│   └── opencode.serve.pgid
│
├── logs/
│   └── amuxd.log                      # 轮换：单文件上限 + 保留份数（§3.3）
│
├── cache/                             # 机器级缓存，删了只影响性能
│   ├── model-catalog.toml             # 键控：backend → worktree
│   ├── model-mru.toml                 # 键控：backend
│   └── pi/                            # pi runtime 扩展
│
└── teams/
    ├── _unclaimed/                    # 未 onboard 时的落盘位置（§4.1）
    └── <team_id>/
        │
        ├── shared/                    # ★ 同步引擎唯一扫描根
        │   └── teamclu-team/          # workspace 软链指向这里
        │       └── knowledge/
        │
        ├── workspace/                 # 无 workspace 时的默认可写 worktree
        │
        └── state/                     # daemon 私有，永不同步
            ├── backend.toml           # 云端凭证（§4.2）
            ├── team.toml              # 团队级配置（§4.3）
            ├── secret.key             # 本团队主密钥，0600
            ├── secrets.enc            # 团队密钥 + channels 凭证
            ├── cloud-token            # 0600，注入为 TC_ACCESS_TOKEN_FILE
            ├── opencode.json          # 当前团队的 OpenCode provider 配置，注入为 OPENCODE_CONFIG
            ├── members.toml           # 成员 / pending invite 缓存
            ├── runtimes.toml          # 本机 runtime 索引（§4.4）
            ├── cursor-permissions.json
            ├── sync.json              # 同步水位
            ├── history/<actor_id>.bin
            ├── mcp-configs/<hash>.json
            ├── attachments/<session_id>/
            ├── pi-sessions/<session_id>/
            ├── apps/<app_id>/
            └── sessions/
                ├── index.toml         # 会话元数据（§4.4）
                └── <session_id>/
                    └── messages.toml
```

`shared/` 是同步引擎**唯一**被授权扫描的路径。这条收紧之后，"往团队目录里加一个
文件会不会被推上云"的答案恒为"不会"——而不是旧布局里那句"取决于你加在哪一层"。

---

## 3. 根目录各项

### 3.1 `daemon.toml`

只装**机器级**配置，外加一个指针。它不再包含 `team_id`、`[actor].id`、
`[channels]`、`[team_share]`。

```toml
active_team = "<team_id>"          # 缺失 = 未 onboard，落盘走 teams/_unclaimed/

[actor]
name = "Mac-mini-8"                # 运维可改的显示名；id 在 backend.toml

[mqtt]
broker_url = ""                    # 空 = 从 /v1/config/bootstrap 解析

[http]
bind = "127.0.0.1:0"
allowed_origins = [...]
# …其余 HTTP 参数

[agents]
auto_discover = true               # 探测本机二进制并写回本文件

[agents.opencode]                  # 本机绝对路径 —— 机器级
binary = "/Users/x/.opencode/bin/opencode"
default_flags = []
```

`[agents]` 的另外两部分**不在这里**：`local_agent` 属于团队（`team.toml`），
`api_key` 属于个人（`~/.{brand}/secrets` 的个人 env store，键
`CURSOR_API_KEY` / `ANTHROPIC_API_KEY`；daemon 只读，桌面端负责写入）。

### 3.2 `device-id`

**这台机器的稳定身份，不只是遥测。** #895 之后它同时是 Cloud API 绑定 agent
actor 的键（`agents.device_id`，团队内唯一），并且改成了从硬件派生
（macOS `IOPlatformUUID` / Windows `MachineGuid` / Linux `/etc/machine-id`，经
UUIDv5 哈希），所以删掉文件会重新算出同一个值而不是换一个新身份。解析顺序：
`$AMUXD_DEVICE_ID` → 本文件 → 硬件派生 → 随机。

> 这一段推翻了本规范早先的写法。排查时它确实只是遥测 id，当时的结论是"前端那份
> `teamclu.client-version.device-id` 与它职责重合、应各自划清"。上游用另一种方式
> 收敛了：daemon 这份升格为路由身份，前端那份保持纯遥测。**两者仍然不可互换**，
> 但理由变了——不再是"重复"，而是"两个不同的东西"。

正因为它现在绑 actor，路径解析绝不能硬编码：白标 daemon 读到官方构建缓存的 id，
就会去认领官方机器的 agent。必须走
`teamclu_runtime_env::amuxd_home_from_env()`。

### 3.3 `logs/`

daemon 的 tracing 输出写进单文件 `amuxd.log`，按大小轮换（写满换名为
`amuxd.log.1`，逐级后移，最老的丢弃；上限与保留份数在 `daemon.toml` 的 `[log]`
段，默认 32 MiB × 3 个文件）。终端里跑时额外镜像到 stdout。

`amuxd.managed.log`（桌面 spawn 重定向）与 `amuxd.out.log` / `amuxd.err.log`
（launchd / systemd 重定向）仍然存在，但只接得到 tracing 覆盖不了的东西：
panic、init 前的 print、子进程输出。managed.log 由桌面端在每次 spawn 时超限
轮换。诊断打包优先取 `amuxd.log`，缺失时回退 managed / out / err。

旧布局三份日志并存且永不截断，实测单机 116 MB——这就是轮换是必修项的原因。

### 3.4 `mcp.json`

设备级 MCP server：`teamclu-introspect`（随 app 分发的 sidecar）、`playwright`、
`chrome-control`、`autoui`。形状是 opencode 自己的
`{ "mcp": { name: { type, enabled, command: [...] } } }`，**不是**团队那份用的
Cursor `mcpServers` 形状——Cursor 形状没地方放 `enabled`（playwright 默认关），
而这个形状每个消费者本来就已经在为工作区配置解析了。

消费者与团队 MCP 完全对称：`config::team_mcp::load_merged_mcp`（设置页的合并视图
与 MCP 面板的清单）、`runtime/sidecar/mcp.rs`（cursor）、
`runtime::team_cloud_config::sync_opencode_generated`（opencode，经 `OPENCODE_CONFIG`）、
`runtime/pi_rpc`（pi，经 `TEAMCLU_MCP_SERVERS`）。
合并顺序：设备 → 团队 → 工作区，后者覆盖前者。

放在根目录而不是 `teams/<id>/state/` 或 `cache/`：它描述的是**这台机器**的工具
（本机 socket、本机 npx 桥），换团队不该变，也不是缓存——里面有用户的开关状态。

这些 server 以前是被物化进**每一个** `<workspace>/opencode.json` 的，每份都带着
本机的绝对二进制路径：换台机器打开同一个仓库就会被重写，提交进 git 就永久冲突，
而且工作区那份的优先级高于设备那份，所以重装 app 之后它们会指向已经不存在的二进制。

`teamclu-introspect` 是最后一个搬进来的（2026-08-23）。它一直留在工作区，只因为
argv 里带 `--workspace <绝对路径>`——而这个参数它并不需要：默认值就是 `.`，各
runtime 生成 MCP 子进程时的 cwd 就是 worktree。留在工作区的代价不只是冗余，而是
**任意**：条目是某个 runtime 第一次准备该工作区时才写的，所以一个没跑过东西的
工作区干脆就没有 introspect，MCP 面板上也就看不到它。

`amuxd-send` 已退役（2026-08-23）。它是 daemon 的第二个 MCP server，只为一个
`send` 工具而存在，而模型面前因此同时摆着两个发送工具。它的能力现在是
`teamclu-introspect` 的 `send_channel_message` 的 `reply_token` 分支——由 daemon
经 `--sock` 路由（token 只有 daemon 解得开），所以无人值守的定时任务照样能回消息。
`RETIRED_DEVICE_MCP_NAMES` 负责把设备文件里的旧条目删掉，`LEGACY_MCP_NAMES` 负责
清工作区里的残留副本。

---

## 4. `teams/<team_id>/`

### 4.1 `_unclaimed`

未 onboard 的 daemon 是受支持的常驻状态（`DeferredBackend::unclaimed()`），
而嵌入式 `/v1/ui` chat 可以在没有 workspace 的情况下建会话。这些落盘写进
`teams/_unclaimed/`；claim 成功时**整目录 rename** 成 `teams/<team_id>/`。

于是代码里永远只有一条路径："当前团队目录"，不需要在每个写入点判空。
`_unclaimed` 是保留字，team_id 是 UUID，前缀下划线保证不撞。

### 4.2 `state/backend.toml`

```toml
kind = "cloud_api"

[cloud_api]
url = "https://api.teamclu-dev.ucar.cc"
refresh_token = "…"
team_id = "<team_id>"
actor_id = "<actor_id>"
```

`team_id` 和 `actor_id` **只此一份**。旧布局里它们同时存在于 `daemon.toml`，
onboarding 一次写两份、事后无人校验——那个问题是靠消灭副本解决的，不是靠加
一致性检查。

`actor.id` 即 `actor_id`：Cloud API 的 access-token hook 按
`amux/{team}/{actor}/…` 发 ACL，填错值会让 EMQX 直接拒绝 CONNECT。

单独成文件的理由是**写入频率**：token 轮换要频繁原子写回，不能和用户手改的配置
同处一文件——否则一次轮换失败会带走用户的 channel 配置。

### 4.3 `state/team.toml`

```toml
local_agent = "opencode"           # 团队规定用哪个 runtime

[team_share]
auto_sync = true

[channels.wecom]                   # 只有结构，没有凭证
enabled = true
[[channels.wecom.bots]]
bot_id = "…"
workspace_id = "…"
agent_type = "opencode"
system_prompt = "…"
```

**凭证字段一律不在这里**：`bot_token`、`secret`、`app_secret`、
`encoding_aes_key` 全部存进 `secrets.enc`。分界是"改 system_prompt 不该需要
解密，而任何凭证不该明文落盘"。

`secrets.enc` 由**同目录下的 `secret.key`** 封装，一团队一把。旧布局是家目录根
下一把主密钥封所有团队的密文——删掉一个团队的目录，别处还留着它的密文，而幸存的
那把钥匙照样能打开；轮换一个团队等于轮换全部。现在 `rm -rf teams/<id>` 把钥匙和
密文一起带走。

`config/edit.rs::is_secret_key` 的 `channels.*` 分支随之失效（`http/config.rs`
对这些键的打码不再有对象），但该函数本身要保留——`mqtt.password` 仍在
`daemon.toml` 里。

### 4.4 两个会话存储

它们是两样东西，不合并，但必须**不同名**：

| 文件 | 原名 | 装什么 | 写入特征 |
|---|---|---|---|
| `state/runtimes.toml` | `sessions.toml` | runtime_id ↔ acp_session_id ↔ 云端 session_id ↔ worktree | 热路径，高频 |
| `state/sessions/index.toml` | `teamclu/sessions.toml` | 会话标题、参与者 | 冷数据 |

改名不是审美：`config::SessionStore` 记的**是 runtime 不是 session**，而两个同名
的 `sessions.toml` 是旧布局里最容易认错的一组东西。

---

## 5. 不在 `~/.amuxd` 里的东西

| 路径 | 拥有者 | 内容 |
|---|---|---|
| `~/.{brand}/secrets/` | 桌面端 | `master.key`、`personal-secrets.json.enc`、`meta.json` |
| `~/.{brand}/local-cache.db` | 桌面端 | 会话 / 消息缓存 |
| `~/.{brand}/telemetry-consent.json` | 桌面端 | 遥测授权 |
| `~/.{brand}/git/` | 桌面端 | 个人 skills 等资源的 git 检出（`lib/git/manager.ts`） |
| `~/.{brand}/config.json` | 桌面端 | `lib/git/manager.ts` 的仓库配置 |
| `<workspace>/.{brand}/` | 双方 | `{brand}.json`、`knowledge.db`、`bm25_index/`、`stats.json`、`cron-jobs.json`、`allowlist.json` |
| `<workspace>/teamclu-team` | daemon | 软链 → `~/.amuxd/teams/<id>/shared/teamclu-team`，**链接名跨品牌固定** |
| `~/.opencode/bin/opencode` | opencode 安装器 | 官方二进制 |

`~/.{brand}` 的目录名由**唯一**的品牌判据推导（§6）。两个家目录各有唯一入口，
调用点不得自己 `home.join(...)` 拼：

| 想要 | 调用 | 桌面端封装 |
|---|---|---|
| `~/.{brand}/` | `teamclu_runtime_env::brand_home_dir(brand)` | `commands::brand_home_dir()` |
| `~/.amuxd*` | `amuxd_home_for_brand(brand)` / `amuxd_home_from_env()` | `commands::amuxd_home_dir()` |

旧代码里 `local-cache.db` 和 `cached-path.txt` 用工作区常量 `TEAMCLU_DIR` 拼家
目录名、`telemetry-consent.json` 直接硬编码 `.teamclu`、`apps_data_root()` 直接
拼 `$HOME/.amuxd`——都不再允许。

---

## 6. 品牌判据

**只有 `teamclu` 是官方**，其余一律白标。

```text
is_official(short_name) := short_name == "teamclu"

~/.amuxd            ← 官方          ~/.amuxd-<brand>   ← 白标
~/.teamclu/         ← 官方          ~/.{brand}/        ← 白标
<ws>/.teamclu/      ← 官方          <ws>/.{brand}/     ← 白标
teamclu.json        ← 官方          {brand}.json       ← 白标
```

解析顺序不变：`$AMUXD_HOME` → `$TEAMCLU_BRAND_SHORT_NAME` → 上表。

这个判据**只允许有一个实现**，在 `teamclu-runtime-env::storage_namespace`。
`apps/desktop/build.rs` 把它作为 build-dependency 直接调用；
`packages/app/src/lib/build-config.ts` 因为是另一条工具链，镜像那一个字符串，
由 `__tests__/brand-parity.test.ts` 读 Rust 源码守住镜像——为一个字符串搭 codegen
不划算，但一个"Rust 侧一动就红"的测试是值得的。旧代码三处实现两处互相矛盾，
betly 的家目录因此被劈成两半。

`LEGACY_BRAND_STORAGE_DIR` 一类常量保留，但降级为**清理清单的输入**（§7），不再
参与品牌解析。

> **需要在本仓库之外完成的一步：** betly 的 `shortName` 目前是 `teamclaw`，
> 它与 `LEGACY_BRAND_WORKSPACE_META_DIR`（`.teamclaw`）同名，而官方构建会主动
> 消费那个目录。必须在私有 branding 仓把 betly 的 `shortName` 改成 `betly`，
> 本仓库的改动无法代劳。在那一步完成之前，betly 构建的家目录会是
> `~/.teamclaw` / `~/.amuxd-teamclaw`，与官方的 legacy 清理清单重叠。

---

## 7. 硬切与清理

新版**不迁移任何旧数据**。首次启动时，daemon 在拿到单实例锁之后、
`DaemonConfig::load` 之前，按固定清单删除旧路径：

```text
~/.amuxd/{backend.toml, daemon.toml, members.toml, sessions.toml,
          workspaces.toml, secret.key, supabase.toml}
~/.amuxd/{team-secrets, history, mcp-configs, attachments, teamclu,
          pi-sessions, bin, apps}/
~/.amuxd/teams/<id>/{teamclu-team, cloud, sync}/        # 旧的团队内布局
~/.amuxd/*.log  ~/.amuxd/*.bak.*  ~/.amuxd/*.pid …      # 根目录残留
<config_dir>/amux/                                       # 旧家目录
```

删 `backend.toml` 和 `daemon.toml` 不是为了整洁：前者的 `refresh_token` 是一把
仍能换取 access token 的活钥匙，后者的 `[channels].bot_token` 与
`agents.cursor.api_key` 是明文凭证。硬切后没有代码会再读它们，留在盘上是纯风险。

用户侧的实际代价：**重新 onboard 一次**，外加丢掉本机 runtime 索引（云端
`agent_runtimes` 仍是主 resume 路径）。官方用户的 `~/.teamclu` 路径不变，个人
密钥原地存活。betly 用户因短名改为 `betly`，需重录个人 API key——发版说明须
明说。

同批删除的迁移代码：`DaemonConfig::migrate_legacy_file()` /
`legacy_config_dir()`、`provider_config` 的 `supabase.toml` 迁移、
`secret_store::legacy_secrets_path()` 与其自愈搬运器、
`workspace_link::migrate_legacy_dir`、桌面端 `commands/storage_migration.rs`、
前端 `lib/storage-migration.ts`。

---

## 8. 护栏

| 护栏 | 形式 | 抓什么 |
|---|---|---|
| 根目录白名单 | 单元测试：跑完 bootstrap + 清理后断言根目录条目 ⊆ `ROOT_ALLOWLIST` | 新功能往根目录偷加文件 |
| 字面量棘轮 | `storage_lint`：扫全仓 `.rs` / `.ts` / `.tsx`，禁止引号后紧跟 `.amuxd` / `.teamclu` / `.teamclaw` | 自己拼路径绕过解析器（`apps_data_root()` 连 `config_dir()` 都没调） |

棘轮**双向失败**：新增一个手写家目录会红，而清理干净后忘记把文件从 `DEBT` 里删掉
**同样会红**。没有人被迫修剪的 allow 列表很快就不再有意义。

> **它抓不到的一类：用常量拼错目录。** `local-cache.db` / `cached-path.txt` 曾用
> `TEAMCLU_DIR`（工作区元数据名）当家目录名——源码里没有任何字面量，棘轮全程沉默。
> 这一类只能靠"想要某个目录就调对应的 helper"来堵：
> [`brand_home_dir`] 与 [`amuxd_home_for_brand`] 各自是唯一入口，
> 不要在调用点自己 `home.join(...)` 拼。

首版 `DEBT` 含 **46 个文件**（PR ② 清掉 `build.rs` 后），此后只许缩短。`OWNERS`（2 个：
`storage_namespace.rs` 与棘轮自身）按设计豁免，不参与增减。

这两条测试跑在 `cargo test -p teamclu-runtime-env`——该 crate 的测试**此前从未
进过 CI**，本 PR 一并加进 `ci.yml` 的 `daemon-linux` job。

---

## 9. 相关代码入口

| 主题 | 位置 |
|---|---|
| 路径解析（唯一实现） | `crates/teamclu-runtime-env/src/storage_namespace.rs` |
| 根目录白名单常量 `ROOT_ALLOWLIST` | 同上 |
| 字面量棘轮 | `crates/teamclu-runtime-env/src/storage_lint.rs` |
| 启动清理 | `apps/daemon/src/config/layout.rs`（PR ④） |
| 团队目录布局 | `apps/daemon/src/config/global_team_store.rs` |
| 团队密钥 | `apps/daemon/src/sync/secret_store.rs` |
| workspace 软链 | `apps/daemon/src/config/workspace_link.rs` |
| 桌面端 amuxd 发现 | `apps/desktop/src/commands/mod.rs` |
