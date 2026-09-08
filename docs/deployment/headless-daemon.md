# 无头 daemon 运维手册

**Audience:** 运维 / 在没有桌面端的机器上跑 agent 的人
**Status:** Living document — 以 `apps/daemon/` 源码为准
**设计背景:** [`docs/architecture/team-skills-registry.md`](../architecture/team-skills-registry.md)、[`docs/architecture/amuxd-home-layout-v2.md`](../architecture/amuxd-home-layout-v2.md)

## 这份文档针对的部署形态

一台只跑 `amuxd`、**没有人坐在前面用桌面 App** 的机器：办公室常开的 Mac mini、
专门跑定时任务的服务器。团队成员在会话里 @ 它，它干活。

和「成员自己的电脑上顺便跑着 daemon」的区别，是**身份**：

| | 成员机器 | 无头机器 |
|---|---|---|
| Cloud API 凭据代表谁 | 登录的**人**（member actor） | 这台机器的 **agent actor** |
| 技能装给谁 | 成员在桌面 UI 里点 | 运维在这台机器上指派，落到本机 |
| 技能装在哪 | `~/.agents/skills` | `~/.amuxd/teams/<团队id>/cloud/skills` |
| 本地改了技能文件 | 停下来问你（冲突 UI） | **无条件覆盖** |

CLI 里那句注释是这件事最准确的表述：*「无头 daemon 从不选择另一个 actor：它的
Cloud API 凭据就是那个托管 agent 的身份，所以所有安装都落在这台机器上。」*

## 1. 接入团队

```bash
amuxd init 'teamclu://invite?token=...'
```

邀请 URL 从 iOS 的 Actors 标签页或桌面端的邀请入口拿。不带参数运行会走交互引导。

接入后确认：

```bash
amuxd status          # 读 pidfile，看 daemon 活着没
amuxd install-pi      # 装（或修复）托管运行时：钉版 Node.js + pi + MCP SDK
amuxd doctor          # 确认 node / pi 两行 satisfied
```

> 运行时只有 pi（ADR-0014），没有 `agents.local_agent` 可配。Node 与 pi 都由 amuxd
> 装在 `~/.amuxd/cache/` 下（ADR-0015），不读机器上的 Node / npm / PATH；官方源不通
> 时自动走 npmmirror 或自建 OSS 镜像。要用自己的 Node 或 pi 检出，写
> `[agents.pi] node = "<path>"` / `package_root = "<dir>"`。

## 2. 补上无头机器拿不到的密钥

有些东西**服务端没有副本**，只能人工递给它：

```bash
amuxd team secrets set --help    # 看当前支持哪些字段
amuxd team secrets show          # 值是脱敏的，只看设没设
```

```bash
amuxd team secrets set --team-secret <64 位十六进制>   # --team-id 可选，默认取 daemon.toml 的 team_id
```

`--team-secret` 用来解密团队共享环境变量（`_secrets/`）并加密 OSS sync 上传的 blob。
它是用户持有的、**服务端没有副本**，所以无头安装只能在这里被人工递一次。

⚠️ **设置完要重启 daemon** —— 同步定时器在启动时对工作区列表拍了快照。

## 3. 给这台机器指派技能

```bash
amuxd manage      # daemon 保持运行，这是另开的交互进程
→ "Team skills"
```

会列出团队 registry 里所有已发布的技能和本机状态：

```
Team: 4b8e9df9-…
  Registry skills (for this daemon):
  - git-cleanup-branches (latest v4; installed v4)
  - deploy-check (latest v7; installed v5; update available v7)
  - pmux-screenshot (latest v3; not installed)
```

| 菜单项 | 作用 |
|---|---|
| Refresh registry | 重新拉列表 |
| Install a skill on this daemon | 把某个技能指派给本机 agent |
| Sync installed skills now | 立刻对账，不等定时 |
| Back | 返回 |

**写进部署脚本**的话直接打本机 HTTP（CLI 底下就是这个）：

```
GET  /v1/team/skills                  # 需要 workspace:read
PUT  /v1/team/skills/<slug>/install   # body {"version": 7}，需要 workspace:write
POST /v1/team/skills/reconcile        # 立刻对账一次
```

### 装完之后

包落在 `~/.amuxd/teams/<团队id>/cloud/skills/<slug>/`。agent 下次准备工作区时，
`prepare_workspace` 会把它软链进 `<workspace>/.claude/skills/`（Claude Agent SDK
只认这个位置），OpenCode 那边走 `skills.paths`。

**升级是自动的**：后台每 **10 分钟**对一次账，团队发新版就自己跟上，不用再管。
（比 MCP/env 缓存的 60 秒慢，是因为这个要下载并解包压缩包。）

### 别在这台机器上直接改技能文件

`cloud/skills` 下的内容**会被无条件覆盖**，改动活不过下一个对账周期。这是设计如此
——「本机上没有任何人有资格否决团队对共享 agent 的决定，而且也没有人可以问：做这个
变更的管理员在别处，daemon 也没有 UI」。要改就在团队 registry 里发新版本。

同名技能如果本机也有一份成员版本（这台机器上还登录着桌面端的情况），**托管 agent
那份优先** —— 解析顺序上它排在 `~/.agents/skills` 之前，免得某个人的私人改动决定
团队 agent 执行什么。

## 4. 排查

```bash
amuxd doctor      # JSON：amuxd / node（托管）/ pi（托管）/ git 各自装没装
amuxd status
amuxd config list # 所有标量配置，按点号 key
```

日志在 `~/.amuxd/logs/amuxd.log`（按**大小**轮转 —— daemon 可能空转数周也可能一分钟
里刷一堆，时间说明不了体量；默认 32MB × 3 份，`daemon.toml` 的 `[log]` 段可调）。
同目录下的 `amuxd.out.log` / `amuxd.err.log` 是 launchd/systemd 的重定向目标，只兜住
tracing 接管之前的输出、panic 和子进程输出 —— 别拿它们当主日志看。

### PATH：无头部署最容易踩的坑

`doctor` 说某个运行时「没装」，但你 ssh 上去手敲能跑 —— 十有八九是 PATH。

launchd/systemd 拉起的进程拿到的 PATH 比登录 shell 窄得多，而 `claude`、`pi` 这类
CLI 常装在 `~/.local/bin`（官方安装器）或 Homebrew 前缀下。daemon 现在会先在几个
常见目录里按绝对路径找（`~/.local/bin`、`~/.npm-global/bin`、`~/bin`、
`/opt/homebrew/bin`、`/usr/local/bin`），找不到才回落裸命令名；并且给子进程的 PATH
追加这些目录 —— npm 装的 CLI 是 `#!/usr/bin/env node` 的 shim，光找到文件还跑不起来。

如果你的运行时装在这几个目录之外，**在服务配置里显式设置 PATH**，或者用
`amuxd config set` 指定绝对路径。

### cursor 显示「未安装」不代表 Cursor 没装

cursor 运行时的就绪条件是四个的与：node 存在、TeamClu 自带的桥接脚本存在、
**`CURSOR_API_KEY` 存在**、SDK 包已安装。最常见的缺项是 API Key。`amuxd doctor`
的 `cursor` 节点会把四个子条件分别列出来，照着看即可。

## 相关

- 技能 registry 的设计与对账语义：[`team-skills-registry.md`](../architecture/team-skills-registry.md)
- `~/.amuxd` 目录布局：[`amuxd-home-layout-v2.md`](../architecture/amuxd-home-layout-v2.md)
- 多品牌 daemon：[`multi-brand-local-daemon.md`](../architecture/multi-brand-local-daemon.md)
