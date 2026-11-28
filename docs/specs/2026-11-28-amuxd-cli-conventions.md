# amuxd CLI 约定（动词、输出、选对象）

- **Date**: 2026-11-28
- **Status**: 已实现（`feat/amuxd-cli-surface`）
- **扩展自**：`2026-11-24-amuxd-app-cli-design.md` §1–§2（名词在前动词在后、JSON 契约、退出码），本文把它推广到 amuxd 所有面向 agent 的命令树。

## 1. 范围

面向 agent 的命令树：`app`、`cron`、`skill`、`role`、`session`、`member`、`workspace`、`knowledge`、`channel`、`config`、`team`。

生命周期和人工引导类命令（`start`、`stop`、`status`、`init`、`setup`、`manage`、`clear`、`doctor`、`install-*`、`update`）给人用，不在本约定内。

## 2. 动词

一个动词在所有树里只有一个意思。旧写法保留为**隐藏别名**：照样能解析，但 `--help` 里不列出。这样已有的脚本、skill 和老版本 desktop 发来的提示词都不会坏。

| 动词 | 含义 | 例子 |
|---|---|---|
| `ls` | 列出一组 | `app ls`、`session ls`、`channel ls` |
| `show` | 看一个 | `app show`、`member show 海港`、`config show <key>` |
| `create` | 新建一个有自己 id 的东西 | `app create`、`session create`、`cron create` |
| `update` | 改一个已有东西的字段 | `app update`、`session update --title`、`app cron update` |
| `set` | 按 key 写入（有则覆盖） | `config set`、`role set <slug>`、`channel set <platform>`、`app env set <KEY>`、`app gate rule set <path>` |
| `add` / `rm` | 把已有的东西放进 / 拿出一个集合 | `session participant add`、`session participant rm` |
| `rm` | 删除 | `app rm --yes`、`cron rm`、`channel rm`、`config rm` |
| `enable` / `disable` | 开 / 关 | `cron enable`、`app cron disable` |

`install`/`uninstall`、`deploy`/`undeploy`、`archive`/`unarchive`、`search`、`read`、`send`、`publish`、`propose`、`sync`、`reload`、`test`、`run`、`runs`、`wait` 是各自领域的专用动词，不强行套进上表。

### 2.1 改名对照（旧名仍可用）

| 旧 | 新 |
|---|---|
| `app list` / `app status` / `app delete` | `app ls` / `app show` / `app rm` |
| `app cron add` / `app cron edit` | `app cron create` / `app cron update` |
| `app gate rule add` | `app gate rule set`（这条本来就是「有则替换」） |
| `cron add` / `cron pause` / `cron resume` | `cron create` / `cron disable` / `cron enable` |
| `role put` | `role set` |
| `channel list` / `channel unbind` | `channel ls` / `channel rm` |
| `channel bind <platform> --flags` | `channel set <platform> --config-file -`（`bind` 隐藏保留，内部翻译成 `set`） |
| `config list` / `config get` / `config unset` | `config ls` / `config show` / `config rm` |
| `team secrets clear [--force]` | `team secrets rm --yes`（`--force` 是 `--yes` 的别名） |
| `team secrets set --team-secret X` | `team secrets set --team-secret-file -`（`--team-secret` 隐藏保留） |

## 3. 输出

和 `app` 一样（app spec §2.2–2.3）：

- 默认输出一行 JSON：`{"v":1,"ok":true,"data":…}`，或 `{"v":1,"ok":false,"error":{code,message,next,retryable,exit}}`。`-o table` 给人看，`-o file:<path>` 把完整结果写进文件。
- 退出码：0 成功，2 参数错误，3 没有身份或未 onboard，4 无权限，5 找不到或有歧义，6 冲突，7 daemon 或平台出错，8 结果未知。
- 列表一律放在 `data.items` 里，分页时附带 `data.nextCursor`。
- 参数写错时同样按 JSON 契约报错（退出码 2），`next` 给出该看的 `--help`。
- `-o` 是全局参数，写在子命令前后都可以。

这次统一前用纯文本输出、现在改成 JSON 的命令：`channel list/test/reload/bind/unbind`、`config *`、`team secrets *`。

## 4. 选对象

- **workspace**：`--workspace <dir>`，不写就用当前目录（pi worktree 会映射回它的 workspace）。适用于 `role`、`workspace`。
- **人或 agent**：id、名字，或 `me`。名字先精确匹配（不分大小写），没有再做包含匹配；匹配到多个时退出码 5，并在 `error.candidates` 里列出候选，绝不猜。适用于 `member show`、`session create --with/--agent`、`session participant add/rm`。
- **app**：见 app spec §2.1。

## 5. 密钥

密钥只从文件或 stdin 读（`--config-file -`、`--team-secret-file -`），不放在命令行上。旧的命令行参数为了兼容隐藏保留，帮助里不再推荐。`config ls` 里的凭证显示为 `"(set)"`，要读具体值用 `config show <key>`（能运行这条命令的人本来就能读 daemon.toml）。

## 6. 新命令树

| 树 | 子命令 | 走哪条路 |
|---|---|---|
| `session` | `ls` `show` `messages` `create` `send` `update` `archive` `unarchive` `participant add/rm` | daemon `/v1/team/sessions*` → Cloud API，以本 daemon 的 agent 账号身份调用 |
| `member` | `ls [--kind] [--name]` `show <who>` `whoami` | daemon `/v1/team/members*` → Cloud API |
| `workspace` | `ls` `show` `reload` `diagnose` `models` `mcp`（只读） | daemon `/v1/workspaces*` |
| `knowledge` | `search` `read` `inbox ls/show/propose/publish/rm` | daemon 控制 socket `cmd: knowledge`（和 MCP 工具共用同一个处理函数） |

`/v1/team/sessions*` 和 `/v1/team/members*` 的每条路由只调用一个 Cloud API 接口，路径由路由自己拼，调用方传不进任意路径，所以这不是开放代理。拒绝时原样保留状态码（403 仍是 403，404 仍是 404），CLI 才能给出对应的退出码。

`session create` 要求 FC 允许 agent 账号建会话：`createSession` 找不到 member actor 时，改用调用者在该团队的 actor。INSERT 策略校验的是 `current_actor_id_for_team`，不限 actor 类型，所以这么做和策略一致。

## 7. 没做的

- 本机运行时会话的 `cancel`、`restart`、`model` 没做。daemon 的 `/v1/sessions/*` 按 token 归属隔离，而 CLI 每次调用都会换一个新的会话 token，查不到上一次调用建的会话。
- workspace 的 MCP 配置只读，agent 不允许改（见 CLAUDE.md）。
- `skill` 没有个人 skill 的 `ls`。
