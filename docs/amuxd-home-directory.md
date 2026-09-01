# `~/.amuxd` 目录说明

本机 Agent Daemon（`amuxd`）的家目录。

> 规范与决策依据见
> [`architecture/amuxd-home-layout-v2.md`](./architecture/amuxd-home-layout-v2.md)
> 与 [ADR-0006](./adr/0006-daemon-state-is-team-scoped.md)。本文是面向使用者的
> 说明；两者冲突时以规范文档为准。

路径：官方版 `$HOME/.amuxd`，白标版 `$HOME/.amuxd-<brand>`，`$AMUXD_HOME` 可覆盖。

> **一句话**：这里是「本机小助手」的身份证、工具箱和仓库，不是云端聊天记录的
> 主库。聊天列表和消息主要在 Cloud API；这里是本机身份、进程控制和团队同步副本。

---

## 根目录只有六项

```text
~/.amuxd/
├── daemon.toml     # 这台机器的配置 + 当前属于哪个团队
├── device-id       # 这台机器的身份（见下）
├── run/            # 进程运行时：pid / 锁 / socket / HTTP 端口与令牌
├── logs/           # 日志
├── cache/          # 机器级缓存，删了只影响性能
└── teams/          # 每个团队一个目录，团队相关的一切都在里面
```

新增东西之前先问一句：**换一个团队，这个值该不该跟着变？** 该变就放
`teams/<id>/state/`，不该变且是缓存就放 `cache/`，随进程生灭就放 `run/`。
有一条单元测试守着这个列表，往根目录多放一个文件就会红。

---

## 各项在干什么

### `daemon.toml` —— 户口本

这台机器上小助手的名字、属于哪个团队、本机 HTTP 控制面参数、探测到的 agent
二进制路径。

### `device-id` —— 机器身份证

这台机器的稳定 id。**不只是遥测**：Cloud API 用它把一个 agent actor 绑到这台
机器上（`agents.device_id`，团队内唯一）。

它优先从 `AMUXD_DEVICE_ID` 读，其次读这个文件，都没有就**从硬件推导**
（macOS 的 `IOPlatformUUID` / Windows 的 `MachineGuid` / Linux 的
`/etc/machine-id`，哈希成 UUID）。所以删掉这个文件不会换身份——会算回同一个值。

⚠️ 容器和克隆的虚拟机要注意：镜像里烘死的 `/etc/machine-id` 会让每个容器算出
**同一个 id**，它们会抢同一个 agent。这种部署必须给每个实例设 `AMUXD_DEVICE_ID`。

与前端 localStorage 里的 `teamclu.client-version.device-id` 是两回事，不可互换。

### `run/` —— 进程运行时

| 文件 | 作用 |
|---|---|
| `amuxd.pid` | 当前进程号；桌面端用它判断是否在跑 |
| `amuxd.lock` | 单实例锁 |
| `amuxd.sock` | 本机控制通道（Windows 用命名管道，不落盘） |
| `amuxd.http.port` | 本机 HTTP 控制面的实际端口 |
| `amuxd.http.token` | 桌面端敲本机 API 的通行证（`0600`） |
| `opencode.serve.pgid` | 受管 `opencode serve` 的进程组，供 `amuxd stop` 收尾 |

daemon 停着的时候整个目录都可以安全删除，下次启动会重建。

### `logs/`

`amuxd.managed.log` 是桌面托管启动时重定向的 stdout/stderr，**排障首选**。
`amuxd.out.log` / `amuxd.err.log` 是旧 LaunchAgent / systemd 的重定向。

### `cache/`

`model-catalog.toml`（模型探测缓存，按 backend → worktree 键控）和
`model-mru.toml`（各 backend 最近用过的模型）。删掉只会多做一次冷探测。

### `teams/<team_id>/` —— 团队的一切

```text
teams/<team_id>/
├── shared/team-sync/      # 唯一会被同步引擎扫描并推上云的目录
│                          # 两个固定根：documents/ 和 knowledge/
├── shared/teamclu-team/   # workspace 软链的落点；daemon 自己用，在同步树外
├── workspace/             # 没指定项目路径时，小助手默认干活的地方
└── state/                 # daemon 私有，永不同步
```

`state/` 里有：云端凭证（`backend.toml`）、团队级配置（`team.toml`——
channels / team_share / local_agent，**凭证字段不落这里**，bot token 等存在
`secrets.enc` 里）、本团队的加密主密钥与密文（`secret.key` / `secrets.enc`）、
成员缓存、runtime 索引（`runtimes.toml`）、会话（`sessions/`）、事件历史、
MCP 配置、附件、app 检出。

**只有 `shared/team-sync/` 会被同步。** 往团队目录里加文件会不会被推上云？
只要不在 `shared/team-sync/` 下面，答案恒为不会——包括紧挨着它的
`shared/teamclu-team/`：那是 daemon 自己的目录，被刻意放在同步树**外面**
（`global_team_store::SYNC_ROOT_DIR`）。

`teams/_unclaimed/` 是还没 onboard 时的落脚点，onboard 成功时整个目录会被
重命名成真正的 team id，之前攒下的会话不会丢。

---

## 切团队 / clear（易混点）

`amuxd clear` 现在只删两样：**当前团队的整个目录**，和 `daemon.toml`。
因为团队相关的一切都在那一个目录里，不再需要维护一份"要删哪些文件"的清单——
旧清单已经两头都不准了：它列着早就没人写的 `workspaces.toml`，却把云端 token、
`secret.key`、`team-secrets/` 全留在原地。

保留不删的是 `device-id`（机器身份，删了也会算回来）、`cache/` 和 `logs/`——
它们都不把这台机器绑到某个团队。

| 你以为丢了什么 | 实际 |
|---|---|
| 聊天列表、消息正文 | **一般在云端**，切回原团队还能从 Cloud API 拉回来 |
| `runtimes.toml` | 丢的是本机 runtime ↔ opencode session 的通讯录；主 resume 路径仍走云端 `agent_runtimes` |
| 别的团队的目录 | `clear` 只动当前团队，其它 `teams/<id>/` 不受影响 |

若 daemon 仍在跑（占着 `run/amuxd.lock`），`clear` 会拒绝执行，避免旧进程把
凭证又写回去。

---

## 从 v1 升上来会发生什么

新版**不迁移旧数据**。首次启动时按固定清单删掉 v1 留下的东西（根目录那堆散
文件、`history/`、`mcp-configs/`、`team-secrets/`、`bin/`、以及旧的
`<config_dir>/amux/` 目录），然后**需要重新 onboard 一次**。

这么做是因为旧的 `backend.toml` 里的 `refresh_token` 仍然能换到 access token，
`daemon.toml` 里的 channel bot token 和 `agents.cursor.api_key` 是明文——留在
盘上是风险而不只是杂乱。桌面端家目录（`~/.teamclu`）不受影响，个人密钥原地存活。

---

## 不在 `~/.amuxd` 里、但常一起出现

| 路径 | 说明 |
|---|---|
| `~/.teamclu/`（白标为 `~/.<brand>/`） | 桌面端自己的家目录：个人密钥、`local-cache.db`、遥测授权 |
| `~/.opencode/bin/opencode` | 官方 OpenCode 二进制，跑大模型对话的引擎 |
| `<workspace>/teamclu-team` | 软链，指向 `~/.amuxd/teams/<id>/shared/teamclu-team` |
| `<workspace>/.teamclu/` | 工作区元数据：`teamclu.json`、`knowledge.db`、cron 等 |

---

## 相关代码入口

| 主题 | 位置 |
|---|---|
| 路径构造（唯一入口） | `apps/daemon/src/config/layout.rs` |
| 品牌 / 家目录解析 | `crates/teamclu-runtime-env/src/storage_namespace.rs` |
| v1 清理 | `layout::purge_v1_layout` |
| `clear` 删除清单 | `apps/daemon/src/cli/clear.rs` |
| 团队密钥 | `apps/daemon/src/sync/secret_store.rs` |
| 桌面托管 amuxd 生命周期 | `apps/desktop/src/commands/amuxd_supervisor.rs` |
