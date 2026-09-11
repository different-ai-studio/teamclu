# TeamClu 功能详解 · 第 8 篇：自动化 / Cron

> 版本基线：当前 `main`（`package.json` v0.4.1-beta.51）。
> 读者：要接手定时任务这块的工程师。
> 关联：ADR-0010、`apps/desktop/src/commands/cron/`、`apps/daemon/src/daemon/server/cron.rs`、
> `packages/app/src/stores/cron.ts`、`packages/app/src/components/settings/CronSection.tsx`、
> `packages/app/src/lib/cron/`。

---

## 0. 一句话定位

自动化（cron）是**无人值守的 agent 回合**：到点把一个 prompt 发给某个 agent，让它自己跑完一轮，可选地把结果投递到某个渠道。

它与「用户手动发一条消息」的唯一区别是**触发者不是人**，而这个区别带来三个连锁后果：

1. **没人回答问题**：agent 执行工具时的权限审批没人应答，所以定时任务默认 full access；
2. **超时必须自己兜**：没有人看着，一轮跑飞了要有墙钟与空闲超时；
3. **结果要有去处**：没人坐在聊天窗口前，所以要有 delivery（发到某个渠道）。

理解这三条，就理解了 cron 这块几乎所有看起来多余的设计。

---

## 1. 现状：调度器在哪里

先说一个必须说清楚的事实，因为文档与代码在这里不一致。

**CLAUDE.md 描述的当前行为**：调度器跑在**桌面进程**里，一个 workspace 一个 `CronInstance`；全局任务存在 `dirs::config_dir()/<brand storage dir>/cron-global`，workspace 任务按 workspace 路径做键；**daemon 只执行 job 触发的 turn**，所以无头 daemon 没有 cron。

**ADR-0010（已接受）** 决定把 `apps/desktop/src/commands/cron/`（7 个文件、3,531 行）整体搬到 amuxd：调度器、任务存储、执行、投递都在 daemon 进程内，桌面端只保留设置页 UI。

**代码现状**：`apps/desktop/src/commands/cron/` 仍然存在且是活的（`CronScheduler`、`CronInstance`、`CronState`），daemon 侧的 `apps/daemon/src/daemon/server/cron.rs` 是**执行** cron turn 的逻辑（`CronSessionCache`、`handle_prompt_await`），不是调度器。

所以读这块时以代码为准：**调度在桌面，执行在 daemon。**

这个不一致本身是有价值的：它说明 ADR-0010 的目标（调度归 daemon，桌面只剩 UI）还没有落地，而它列出的三个问题今天仍然成立：

1. 关掉 app，定时任务就不跑；
2. 无头 daemon（gateway 场景、服务器上的 amuxd）永远没有定时能力；
3. 三个 cron 面并存（桌面调度器、daemon 执行、introspect 的 `/cron-run`）时，「一个任务现在到底会不会跑」没有单一答案。

---

## 2. 为什么调度绕不开「进程活着」

cron 的用户价值恰恰是「人不在的时候跑」，而人不在的时候桌面 app 大概率也不在。今天的形态把这个价值和「app 得开着」绑死了。

这不是一个可以靠「优化」解决的问题——它是**调度器所在进程的生命周期**问题。ADR-0010 的论证值得完整引用：

- 调度器跑在桌面进程里。关掉 app，定时任务就不跑。
- 无头运行的 daemon（gateway 场景、服务器上的 amuxd）永远没有定时能力，因为调度器根本不在那个进程里。
- daemon 只执行回合——它的两条相关路由的注释明说是为桌面 cron 服务的。也就是说，**daemon 已经承担了最难的部分（跑完一整个 agent turn），却拿不到触发权。**

第三点是最讽刺的：系统里最需要常驻的那个进程，只被允许做「执行」，而「何时执行」交给了那个可以随时关闭的进程。

### 2.1 考虑过的其它方案

**a. 桌面端继续持有。** 零成本，但上面三条问题一条都不解决，且三个 cron 面继续并存。

**c. 云端调度**（Cloud API 定时触发 daemon）。多设备只跑一次的语义最自然——这是 b 解决不了的：两台机器各跑一个 amuxd，同一个 team 的任务会跑两遍。但它依赖网络，离线场景直接丢掉，而「本机定时跑一件事」不该需要公网。

选 b（daemon 调度），把 c 留作 b 之上的可选层：**调度仍在 daemon，云端只做多设备去重。** 先 b 后 c 的顺序是对的，反过来（先做 c）会让离线用户从「app 开着就能跑」退化到「没网就不跑」。

---

## 3. 调度模型

### 3.1 三种 schedule

`apps/desktop/src/commands/cron/types.rs` 定义了 `ScheduleKind`：

| kind | 含义 | 字段 |
|---|---|---|
| `at` | 一次性，在某个时间点跑 | `at`（ISO 8601） |
| `every` | 固定间隔 | `every_ms`（毫秒） |
| `cron` | cron 表达式 | `expr`（5 字段）+ `tz` |

一个容易忽略的细节：**`tz` 是可选的，省略时用系统本地墙钟**（Unix crontab 语义），不是 UTC。这个选择与「用户写 `0 9 * * *` 期望早上 9 点」一致，但会让跨时区团队看到不同的执行时间——这是 crontab 一贯的语义，保持一致比「更正确」更重要。

### 3.2 两种 scope

| scope | 存储 | 说明 |
|---|---|---|
| `global` | `config_dir/<brand>/cron-global` | 不绑定 workspace |
| `workspace` | `<workspace>/.teamclu/cron-jobs.json` | 按 workspace 路径 |

`CronState` 里一个 workspace 一个 `CronInstance`：

```rust
pub struct CronInstance {
    pub storage: CronStorage,
    pub scheduler: CronScheduler,
}

pub struct CronState {
    pub instances: tokio::sync::Mutex<HashMap<String, CronInstance>>,
}
```

注释写明了「Multi-window-safe：启动 workspace B 的 cron 不再停掉 A 的调度器」。这是一个真实的修复——早期的实现可能只有一个全局调度器，切换 workspace 会停掉上一个。

### 3.3 全局任务的位置

全局任务在 `dirs::config_dir()/<brand storage dir>/cron-global`。这个路径**不在任何 layout 文档里**，与 ADR-0006（daemon 状态按 team 归属）对不上——这是 ADR-0010 提到的「存储位置也偏离了 layout-v2 的第一条」。搬去 daemon 时会改成 `~/.amuxd/teams/<id>/cron/`。

---

## 4. 任务内容（payload）

`CronPayload` 决定「跑什么、怎么跑」：

| 字段 | 说明 |
|---|---|
| `message` | 发给 agent 的 prompt |
| `model` | 可选模型覆盖（`provider/model`） |
| `backend` | 后端（历史字段，现在 runtime 只有 pi，见第 2 篇） |
| `timeout_seconds` | 单轮墙钟上限，默认 3600s |
| `permission_mode` | `full_access`（默认）或 `default` |

### 4.1 full access 是默认，且是有原因的

`DEFAULT_CRON_PERMISSION_MODE = "full_access"`。注释写得很直白：

> Cron runs unattended, so an approval prompt has nobody to answer it and the turn just burns its timeout — hence full access unless the job explicitly opts out.

这是第 0 节三条连锁后果的第一条。它有一个必须一起搬的约束（ADR-0010 特别点出）：**cron 触发的 agent 必须默认 full access。无人值守，等审批就等于不跑。搬到 daemon 之后这条要显式写进 daemon 侧的执行路径，不能指望桌面端的权限 UI 兜底——那时候没有 UI 在场。**

注意 `None`（旧 job JSON）也意味着 full access。这个向后兼容的选择是对的：如果一个旧任务在新版本里突然需要审批，它会从「能跑」变成「超时失败」。

### 4.2 超时预算

三组常量：

| 常量 | 值 | 含义 |
|---|---|---|
| `DEFAULT_CRON_WALL_TIMEOUT_SECS` | 3600 | 单轮墙钟上限（60 分钟） |
| `MAX_CRON_WALL_TIMEOUT_SECS` | 3600 | 任务可请求的上限 |
| `MIN_CRON_WALL_TIMEOUT_SECS` | 60 | 下限 |
| `DEFAULT_CRON_IDLE_TIMEOUT_SECS` | 300 | 无 ACP 进展的空闲超时 |
| `CRON_CLIENT_TIMEOUT_SLACK_SECS` | 60 | 桌面等 daemon 的额外宽容 |

两个超时的关系：**墙钟是硬上限，空闲是「看着没动静了」的软上限。** daemon 在每次事件（工具开始/结束、流式 delta）时重置空闲计时——所以一个长时间在跑工具的任务不会被误杀，而一个卡死的任务会。

`CRON_CLIENT_TIMEOUT_SLACK_SECS` 的存在是为了避免「慢的 persist/finalize 看起来像客户端卡住」——桌面等待的时间比任务的墙钟多 60 秒。

---

## 5. 执行：daemon 侧的 cron turn

`apps/daemon/src/daemon/server/cron.rs` 是执行逻辑。它的模型是：

> A "cron turn" is one ACP turn driven to completion for a logical `session_key` (e.g. `"cron/<job_id>/<run_id>"`). The first turn for a key creates a real cloud `sessions` row + spawns the ACP runtime; subsequent turns reuse the cached `(cloud_session_id, acp_session_id)` pair.

三个要点：

1. **一个 cron turn 就是一个正常 session 的 turn。** 它不是一条特殊路径，而是「用 session_key 驱动一次 turn」。这是「共享写入服务」的直接体现（第 7 篇第 19 节）——cron 与 gateway 最终都是「一个 agent 的消息写进一个 session 并广播」。
2. **首次创建真实云端 session。** 定时任务不是虚构的会话，它在云端有行，用户在会话列表里能看到（作为 scheduled session）。
3. **`CronSessionCache` 缓存 `(cloud_session_id, acp_session_id)`。** 同一个逻辑 key 的后续 turn 复用这对 id，所以一个任务的多次运行可以落在同一个 session 里（取决于 job 语义）。

`CronTurnOutcome` 带 `timed_out` 标记——超时也要产出一个结果（可能带被抢救出来的文本），而不是什么都没有。

---

## 6. Run Now 与 session 导航

「立刻运行」是一个体验要求，而实现它有一段值得注意的细节。

### 6.1 为什么要 eager 创建 session

**问题**：用户点 Run Now，然后想立刻跳进会话看结果。但 ACP runtime 冷启动要几秒，如果等 turn 结束才拿到 session id，用户要等整个 turn。

**解法**：`cron-prepare-session` 在 turn 开始前**先创建云端 session**，把 `session_id` 写进 run record。桌面端轮询 run records，拿到 session id 就跳过去。

前端 `stores/cron.ts` 的注释写得很好：

> "Run Now" watches for the cloud session id the daemon stamps onto this run's record, so the UI can jump straight to the session instead of blocking until the whole turn finishes. The scheduler creates the cloud session eagerly (via `cron-prepare-session`) and stamps `session_id` into the run record within a second or two of clicking — well before the ACP turn completes.

轮询参数：每 1 秒一次，最长 5 分钟。为什么最长是 5 分钟而不是更短？因为一个 run 的 prepare 可能排在另一个在跑的 cron turn 后面（daemon 串行化 turn），所以窗口要远高于最坏情况。

### 6.2 到达后的三件事

跳进会话后，前端做三件事（都在 `stores/cron.ts`）：

1. **`pinJobModelToSession`**：把任务的模型固定为该 session 的 pick，这样输入框的模型 pill 显示的是这次运行实际用的模型。注释解释了为什么必须现在做：transcript 是模型选择的另一个来源，而到达时它只有一条桌面还没拉到的消息，所以任何更便宜的做法都「too late」。
2. **`ensureCronSessionVisible`**：让 cron session 立刻出现在侧栏会话列表，不等下一次分页刷新。
3. **`watchRunOutcomeAndSeedFailureMessage`**：继续轮询这个 run，如果它以失败/超时结束，就往 session 里种一条 fallback 消息，解释为什么 agent 没回复，而不是留一个空白线程。

第 3 条是最有人情味的一条：**定时任务失败时，用户在聊天里应该看到原因，而不是一片空白。** 空白会被理解成「AI 没理我」，而实际是「任务超时了」。

### 6.3 一个曾经的 bug

`ensureCronSessionVisible` 的注释记着一个安全/隔离问题：

> A cron session belongs to the team you are in. This used to look the team up from the session id and then `enterTeam` into whatever came back, which meant a cron surface could yank you into another team's session; a run history should only ever show its own team's runs. Scoping to the current team makes a foreign session id simply "not found".

这是一个「便利功能变成跨团队入口」的例子。修法不是加校验，而是**把语义改对**：run history 只应显示自己团队的 run，所以用当前 team 查，外部 session id 自然「找不到」。这比「找到之后再判断有没有权限」更干净，因为它从一开始就不产生那个查询。

---

## 7. 运行记录与历史

每次运行产生一条 `CronRunRecord`：

- `runId`、`jobId`、时间、状态；
- `sessionId`（eager 创建后立刻有）；
- 错误/超时信息。

`CronHistoryDialog` 展示历史，`CronSection` 的 `JobCard` 有「查看历史」入口。`normalize_legacy_timeout_status` 处理旧版本写下的超时状态（`LEGACY_TIMEOUT_CUT_SHORT_MARKER`）。

一个细节：状态里区分「超时」与「失败」。用户看到「超时」时的下一步（调大预算、检查 prompt）与「失败」时（查错误、查网络）不同。

---

## 8. 结果投递（delivery）

`DeliveryMode`：`announce`（把摘要发到指定渠道）或 `none`（静默运行）。

`DeliveryChannel` 覆盖七个渠道：Discord、Feishu、Email、Kook、Wechat、Wecom、Seatalk。`DeliveryManager` 委托给 gateway 模块发送——**没有重新实现**。注释写明了原因与例外：

> Delegates to gateway modules for actual sending — no reimplementation. Most channels still read credentials from the workspace `.teamclu/teamclu.json`. WeCom and SeaTalk are routed through the amuxd-owned gateway; WeCom also reads ownerId from the daemon config dir when no explicit target is set.

一个实现选择：**每次发送重新读配置**，所以改了频道设置不需要重启。

WeCom / SeaTalk 不走 `read_teamclu_config`——它们是 amuxd 拥有的、携带自己的凭据，所以一个没有 `teamclu.json` 的 workspace 不会让它们的发送失败（与第 7 篇第 29 节是同一件事）。

---

## 9. 与会话系统的关系

cron 产生的会话在会话列表里以 **scheduled session** 出现：

- `isScheduledSession` 识别它们；
- `cronSessionIds`（来自 `useCronStore`）用于过滤；
- NavRail 的会话计数排除它们；
- `showCronSessions` 是一个开关，决定是否在列表里显示。

`lib/cron/cron-session-messages.ts` 负责把 cron session 的消息加载进 v2 message store——用户在 run history 里点一个 run 时，不应该等 libsql 同步。

一个设计判断：**定时任务不是「另一类会话」。** 它们有 session、有消息、有参与者，能用同一套聊天 UI 看。区别只在来源字段和列表过滤。这与第 3 篇「会话是一等对象」一致。

---

## 10. MCP 一次性调度

除了 cron 表达式，还有一条路径：**MCP 工具可以创建「一次性调度」**。历史上有两个修复与它相关：

- `fix(cron): treat MCP one-time schedules as at, not cron expr`（#1339）；
- `fix(cron): create MCP jobs in the desktop global store`（#1337）；
- `fix(cron): pin MCP announce delivery.to instead of treating empty as this chat`（#1361）。

这三次修复说明了一个常见问题：**「一次性」很容被实现成「一个不会再触发的 cron 表达式」**，而它的时间语义、存储 scope、投递 target 都和普通 cron 不同。设计上应当明确区分「at 类型的一次性」与「只跑一次的 cron」。

---

## 11. 前端与关键组件

- `components/settings/CronSection.tsx`：任务列表、卡片、开关、运行、历史。
- `components/settings/cron/CronJobDialog.tsx`：新建/编辑任务。
- `components/settings/cron/CronHistoryDialog.tsx`：运行历史。
- `components/settings/AutomationPanelDialog.tsx`：自动化面板。
- `stores/cron.ts`：状态、Run Now 轮询、模型 pin、失败消息种入。
- `lib/cron/cron-utils.ts`：日期转换与 delivery channel 注册表。
- `lib/cron/cron-session-messages.ts`：session 消息加载。
- `lib/cron/cron-workspace-models.ts`：workspace 模型目录解析。

一个细节：`cron-utils.ts` 从 `CronSection.tsx` 抽出来，是为了让多个 cron 组件复用日期与渠道工具，而不是把逻辑留在巨型组件里。

---

## 12. 测试与验收

- 调度触发准确性（at / every / cron + tz）；
- 墙钟与空闲超时；
- full access 默认值（含旧 JSON 的 `None`）；
- Run Now 的 session 导航；
- 失败时种入 fallback 消息；
- delivery 到七个渠道；
- 多 workspace 的 `CronInstance` 隔离；
- 存储的 IO 锁（见第 13 节）。

---

## 13. 关键文件索引

```
apps/desktop/src/commands/cron/
  mod.rs              CronState / CronInstance / IPC 命令
  scheduler.rs        CronScheduler（后台 tick、generation、heartbeat）
  storage.rs          CronStorage（cron-jobs.json、IO 锁）
  delivery.rs         DeliveryManager（委托 gateway 发送）
  types.rs            CronSchedule / CronPayload / CronRunRecord / 常量
  workspace_models.rs 模型目录解析
  amuxd_client.rs     与 daemon 的本地连接（为 cron 存在）
apps/daemon/src/daemon/server/cron.rs   cron turn 执行、CronSessionCache
packages/app/src/
  stores/cron.ts
  components/settings/CronSection.tsx
  components/settings/cron/CronJobDialog.tsx
  components/settings/cron/CronHistoryDialog.tsx
  lib/cron/cron-utils.ts
  lib/cron/cron-session-messages.ts
  lib/cron/cron-workspace-models.ts
```

---

## 14. 常见坑

1. **cron 默认 full access。** 无人值守，不要改成需要审批。
2. **墙钟与空闲是两个超时。** 不要合并。
3. **旧 job JSON 的 `None` 也意味着 full access。** 不要给 None 设更严的默认。
4. **Run Now 要 eager 创建 session。** 否则用户等整个 turn。
5. **失败时要种 fallback 消息。** 空白会被理解成「AI 不理我」。
6. **不要用 session id 反查 team。** 用当前 team 查，外部 id 自然找不到。
7. **`tz` 省略 = 系统本地墙钟。** 不是 UTC。
8. **WeCom/SeaTalk 不走 workspace 配置。**
9. **MCP 一次性调度不是 cron 表达式。**
10. **存储的 IO 锁不能去。** 并发 reload 会吞掉任务（见下）。

---

## 15. 存储的 IO 锁：一个真实的丢任务 bug

`CronStorage` 里有一把 `io_lock`，注释解释了它防的是什么：

> Serializes disk I/O against in-memory mutations so a concurrent `reload_jobs_from_disk` can never interleave between a mutation's in-memory write and its `persist_jobs` (which would clobber the fresh job back to a stale on-disk copy — the cause of jobs silently disappearing when a save coincides with a scheduler/UI reload).

这是一个典型的**内存状态 + 磁盘持久化**的竞态：修改先在内存生效，然后写盘；如果在这两步之间有人从盘里 reload，会把刚改的内容覆盖回旧值。用户看到的是「我建的任务自己消失了」。

修法是用一把锁把「内存写 + 写盘」变成一个原子操作。这条经验可以推广：**任何「内存是真相源、磁盘是持久化」的结构，都必须让「改内存 + 写盘」看起来是原子的**，否则 reload 路径就是一颗定时炸弹。

---

## 16. 附录 A：调度器的实现细节

`apps/desktop/src/commands/cron/scheduler.rs` 里的几个设计值得单独看：

### 16.1 generation counter

```rust
pub struct CronScheduler {
    storage: CronStorage,
    delivery: Arc<RwLock<Option<DeliveryManager>>>,
    generation: Arc<RwLock<u64>>,   // 每次 start/stop 递增
    app_handle: Arc<Mutex<Option<AppHandle>>>,
    execution_workspace: Arc<RwLock<Option<String>>>,
}
```

注释："Generation counter: incremented on each start/stop to uniquely identify scheduler instances. Prevents old tick loops from continuing after restart."

为什么需要它：调度器是一个循环任务，而重配置会重启它。旧循环可能还在跑（比如正在 await），重启后两个循环同时存在，同一个任务可能被触发两次。用 generation 标记「我是不是当前实例」，旧循环发现自己的 generation 不是当前值就退出。

这是一个常见的模式：**重启一个后台循环时，不能只启动新的，还要让旧的能发现自己已经过时。** 只靠取消令牌（cancellation token）也可以，但 generation 更简单，因为它不需要新循环去逐个通知旧循环。

### 16.2 心跳与 stale run

```rust
const CRON_RUN_HEARTBEAT_INTERVAL_SECS: u64 = 30;
const STALE_RUN_ERROR: &str =
    "Cron run was interrupted before completion; open the session to inspect the latest state.";
```

任务跑的时候每 30 秒写一次心跳。如果应用崩了，下一次启动会看到一条有开始但没有结束的 run，而它已经太久没心跳——那就是 stale，标成「被打断」。

为什么需要：不这样做的话，一条崩溃的 run 会永久处于「进行中」，而用户看到的是「它还在跑」——一个永远不会结束的谎言。把 stale 标出来，至少能说真话。

`STALE_RUN_ERROR` 的文案也值得学：它不假装知道发生了什么，只说「被打断，去会话看最新状态」。

### 16.3 execution_workspace

`execution_workspace` 是 workspace-scoped 任务的项目 cwd；global scope 是 `None`，由 amuxd 用默认 workspace。这解决了「全局任务在哪里跑」的问题：不是「没有目录」，而是「daemon 的默认目录」。

### 16.4 app_handle

`app_handle: Arc<Mutex<Option<AppHandle>>>` 从 `cron_init` 设置，用于 run-record 更新时刷新 UI 的 session filter。没有它，一个 Run Now 创建的 session 要等下一次列表刷新才出现。

---

## 17. 附录 B：多 workspace 隔离

多 workspace 的 cron 隔离不是免费的，它经历过一次修复。`mod.rs` 的注释写得很清楚：

> Cron state — one `CronInstance` per workspace, keyed by workspace_path.
> Multi-window-safe: starting cron for workspace B no longer stops workspace A's scheduler. Each workspace keeps its own jobs, scheduler, and delivery configuration.

「no longer stops」说明之前会停。具体形态很可能是：只有一个全局调度器，启动 B 时先停 A。后果是 A 的任务在切到 B 后不再跑，而用户不会发现——直到某天发现「昨天那个日报没发」。

修法是用 `HashMap<String, CronInstance>` 按 workspace 路径分区，每个实例有自己的 storage 与 scheduler。`instance_for` 返回 clone（Arc-backed，clone 很便宜），所以调用方不需要一直持锁。

这条修正的教训：**全局单例在「本来就是多实例」的场景下会静默丢失功能。** 与第 7 篇「两套并存」、第 4 篇「前缀白名单三处镜像」属于同一类：看起来能跑，但语义是错的。

---

## 18. 附录 C：一次 Run Now 的完整时序

把点击到看到回复的每一拍列出来：

```
1. 用户点 Run Now（CronSection 的 JobCard）
2. 前端记下 knownRunIds（当前历史里的 run id 集合）
3. invoke cron_run_job(jobId, scope, workspacePath)
4. 桌面调度器：
     a. 标记/heartbeat
     b. 调 daemon 的 cron-prepare-session（eager 创建云 session）
     c. 把 session_id 写进 run record
5. 前端每 1s 轮询 cron_get_runs，找 knownRunIds 里没有的
     且有 sessionId 的 run（通常 1–2 拍内命中）
6. 前端：pinJobModelToSession（把任务模型固定为该 session 的 pick）
7. 前端：ensureCronSessionVisible（立刻进侧栏列表）
8. 前端：跳到该 session，加载消息（cron-session-messages）
9. 后台：daemon 驱动 ACP turn，事件进 session/live
10. 前端：watchRunOutcomeAndSeedFailureMessage 持续轮询
11. 若失败/超时 → 在 session 里种一条 fallback 消息
12. 若 announce → DeliveryManager 把摘要发到指定渠道
```

关键拍是第 4b：**eager 创建 session 是「Run Now 不卡」的全部原因。** 没有它，第 5 步要等到第 9 步结束，也就是整个 turn。

第 6 步与第 7 步是「到达体验」的两个补丁，都是为了让用户在会话里看到的东西和任务实际的行为一致（模型 pill、列表可见）。

---

## 19. 附录 D：典型用例与它们暴露的设计需求

定时任务的用例看起来五花八门，但每一个都对应设计里的一个约束。

### 19.1 每日日报

每天早上九点，让 agent 汇总昨天的会话与数据，发一份日报到企业微信。

它暴露的约束：

- **时区**：`0 9 * * *` 必须是本地时间。如果按 UTC 解释，中国用户会在下午五点收到。
- **投递**：结果要发到一个没人盯着聊天窗口的地方，所以 delivery 必需。
- **无人值守**：agent 要读会话、可能还要调工具，所以 full access。
- **失败可见**：如果 agent 跑挂了，用户点进去应该看到原因，而不是空白。

### 19.2 定时巡检

每小时检查一次服务状态，异常时发告警。

它暴露的约束：

- **间隔类型**：用 `every` 而不是 cron 表达式更自然。
- **超时**：巡检可能卡在某个网络请求上，所以需要空闲超时（300 秒无进展就停），否则它会一直占着 agent。
- **静默运行**：正常时不想被通知，所以 `DeliveryMode::None` 是有用的。

### 19.3 周报与长任务

每周一生成一份周报，需要读很多数据。

它暴露的约束：

- **墙钟预算**：长任务需要更长的时间，所以 `timeout_seconds` 可配，默认 60 分钟。
- **模型固定**：长任务通常用更好的模型，所以 `model` 覆盖必需。
- **可观测**：跑得久意味着用户会去看，所以 Run Now 的 session 导航与历史很重要。

### 19.4 一次性提醒

「明天下午三点提醒我做某事」。

它暴露的约束：

- **`at` 类型**：这是最直接的一次性。
- **MCP 创建**：这个提醒可能是 agent 自己创建的，所以需要 MCP 路径——而那正是三次修复发生的地方（第 10 节）。

### 19.5 用例的共同点

四个用例都需要「无人值守」的四件套：**正确的时区、默认放开的权限、可靠的超时、能看到的结果。** 任何一件缺失，用例都会以「它没跑」「它卡住了」「我不知道它跑没跑」的形式失败。

---

## 20. 附录 E：迁移到 daemon 的计划与风险

ADR-0010 决定把调度器搬到 daemon。这件事的难点不在搬代码，而在几个行为差异：

### 20.1 存储位置变了

从 `dirs::config_dir()/<brand>/cron-global` 改成 `~/.amuxd/teams/<id>/cron/`。这意味着：

- **已有任务需要迁移**。一个写了很久的任务不能在升级后消失。迁移必须幂等且可回滚。
- **全局任务变成 team-scoped**。因为 daemon 状态按 team 归属（ADR-0006）。一个「全局」任务到底是「不绑 workspace」还是「不绑 team」，需要在迁移时说清楚。

### 20.2 无 UI 的执行路径

今天 cron 的权限默认 full access，但桌面端在的时候还有一层 UI 兜底（即使默认放开，至少有人在）。搬到 daemon 后，**没有 UI 在场**，所以 full access 必须显式写进 daemon 侧的执行路径。

这是 ADR-0010 特别强调的一条：不能指望桌面端兜底。

### 20.3 三个 cron 面要收敛成一个

桌面的调度器、daemon 的执行、introspect 的 `/cron-run`。搬完之后，前三者应该合并成「daemon 调度 + daemon 执行」，而 introspect 的入口变成「向 daemon 请求触发」。

### 20.4 桌面端退成什么

桌面端只保留：

- 设置页 UI（增删改查任务）；
- 运行历史展示；
- Run Now（一个 IPC 到 daemon）；
- 冲突/状态的展示。

它不再持有调度器，也不再决定什么时间跑。

---

## 21. 附录 F：安全与权限

定时任务的安全面比它看起来大，因为它是「一个 prompt 会在未来某个时刻自动执行」。

### 21.1 谁能创建任务

任务存储在当前 workspace（或 daemon 的全局目录），所以创建权限跟 workspace/团队权限走。没有单独的「cron 权限」。

### 21.2 full access 的边界

full access 意味着 agent 可以执行工具而不问。这在无人值守时是必需的，但它同时意味着：**任何能创建 cron 任务的人，都能安排一次未来的任意工具执行。**

这是一个真实的攻击面。当前设计的缓解是：任务的创建面就是 workspace/团队，与「能直接让 agent 干活」是同一批人。但如果将来 cron 能由外部输入创建（比如通道消息触发创建任务），这个面就会扩大。

### 21.3 投递目标的注入

`delivery.to` 是一个字符串，会被传给渠道发送。三次 MCP 相关的修复里有一次就是「空的 delivery.to 被当成当前聊天处理」——说明这个字段的默认值语义容易错。

原则：**一个用于寻址的字段，空值不应该有一个隐式的「这里」默认。** 空就是空，要么报错，要么显式选择目标。

---

## 22. 附录 G：常见问题

**Q：cron 需要开着 app 吗？**
A：按当前代码，需要（调度器在桌面进程）。ADR-0010 决定搬到 daemon，搬完后不需要。这是目前这块最值得知道的一条。

**Q：全局任务和 workspace 任务的区别？**
A：全局不绑 workspace（存在 config 目录），workspace 任务存在 workspace 的 `.teamclu/cron-jobs.json`。

**Q：任务为什么默认全权限？**
A：因为无人值守，等审批等于不跑。旧任务（没有 permission_mode）也是全权限。

**Q：任务超时了怎么办？**
A：有两个超时：墙钟（默认 60 分钟）与空闲（300 秒无进展）。失败会在会话里看到一条解释性消息。

**Q：时区怎么算？**
A：`tz` 省略时用系统本地墙钟（crontab 语义）。

**Q：能定时发到微信吗？**
A：能，delivery 支持七个渠道，包括 WeCom / 微信 / 邮件等。

**Q：Run Now 为什么能立刻跳到会话？**
A：因为 daemon 会 eager 创建 session 并把 id 写进 run record，前端轮询拿到就跳。

**Q：任务创建的会话和普通会话有什么不同？**
A：来源不同（scheduled），在列表里可过滤；其余一样，能用同一套聊天 UI 看。

**Q：能禁用某个任务而不删吗？**
A：能，JobCard 有开关。

**Q：多个 workspace 的任务会互相影响吗？**
A：不会，每个 workspace 一个 `CronInstance`，各自有 storage 与 scheduler。

---

## 23. 术语

| 术语 | 含义 |
|---|---|
| schedule | 何时跑（at / every / cron） |
| scope | global / workspace |
| payload | 跑什么（prompt / model / timeout / permission） |
| run | 一次执行，有记录 |
| delivery | 结果投递（announce / none） |
| eager session | turn 前先创建的云 session |
| wall timeout | 墙钟硬上限 |
| idle timeout | 无进展的软上限 |
| stale run | 应用崩溃后遗留的未结束 run |
| generation | 调度器实例版本号 |
| heartbeat | 运行中的 30 秒心跳 |

---

## 24. 维护约定

| 变动 | 影响章节 |
|---|---|
| ADR-0010 落地（搬到 daemon） | 1、2、20 |
| 超时常量调整 | 4.2、22 |
| 新增投递渠道 | 8 |
| 多设备去重（方案 c） | 2.1 |
| MCP 调度机制变动 | 10 |
| 权限默认值变动 | 4.1、21 |

写本文时最容易犯的错是把它写成「设定一个时间让它跑」的功能说明。它不是。它的重点是**无人值守带来的三个连锁后果**，以及调度器所在进程的生命周期。这两件事才是这块真正的设计内容。

---

## 25. 附录 H：任务的数据形状

一个 cron job 在磁盘上是一段 JSON。虽然用户不直接编辑它，但理解它有助于排查。

```jsonc
{
  "id": "job_...",
  "name": "每日日报",
  "enabled": true,
  "schedule": {
    "kind": "cron",
    "expr": "0 9 * * *",
    "tz": "Asia/Shanghai"
  },
  "payload": {
    "message": "汇总昨天的会话…",
    "model": "provider/model",
    "timeoutSeconds": 1800,
    "permissionMode": "full_access"
  },
  "delivery": {
    "mode": "announce",
    "channel": "wecom",
    "to": "..."
  }
}
```

几个观察：

- **`schedule` 是一个带 `kind` 的判别联合**，与前端 `coerceSchedule` 对应。三段式（at / every / cron）而不是一个统一的 cron 表达式，是因为「一次性」和「每隔 N 毫秒」用 cron 表达很别扭（尤其后者）。
- **`payload` 与 `schedule` 分开**：前者是「跑什么」，后者是「何时跑」。一个任务换了时间不该影响内容，反之亦然。
- **`delivery` 独立**：结果去哪与跑什么无关，一个巡检任务可以今天发 WeCom、明天发邮件。
- **`enabled` 而不是删除**：临时停掉一个任务很常见，删了要重建。

这段 JSON 还解释了为什么 `permission_mode` 的 `None` 要按 full access 处理——它是旧版本写下的任务，缺少这个字段并不代表用户选择「要审批」，只是字段还不存在。

---

## 26. 附录 I：cron、gateway、session 的三角关系

这三者共用一个写入服务（第 7 篇第 19 节），但它们的关系值得单独理一遍：

```
cron ──触发──┐
              ├──> 写入服务 ──> session（入库 + 广播）
 gateway ──入站──┘         │
                          └──> delivery / driver ──> 外部渠道
```

三个事实：

**一、cron 与 gateway 都是「触发源」。** 一个由时间触发，一个由外部消息触发。它们都不自己写消息，而是调写入服务。

**二、session 是唯一的消息归属。** 不管是定时任务还是通道消息，最终都是「某个 actor 在某个 session 里说了一句话」。

**三、delivery 是出站的一个消费者。** cron 的 announce 与 gateway 的回复都走渠道发送，区别只是「发到哪」。

这个三角关系的价值在于：**新加一个触发源时，只需接入写入服务，不需要理会消息如何持久化、如何广播、如何发到渠道。** 这正是抽象带来的收益。

一个反例：如果 cron 自己写消息、自己发渠道，那么它的消息就不在 session 里，用户在会话列表里看不到。这正是 gateway 的 introspect 旁路曾经犯的错（第 7 篇第 5 节）。

---

## 27. 附录 J：实操：创建一个日报任务

把流程走一遍，能看到前端、桌面、daemon 三边如何配合：

**第一步：填表。** 在 CronSection 点新建，打开 `CronJobDialog`。填名称、选 schedule（选「每天」+ 时间，或直接写 cron 表达式 + 时区）、写 prompt、选模型（可选）、设超时（可选）、选投递（可选）。

**第二步：保存。** `invoke` 到桌面的 cron 命令，`CronStorage` 写 `cron-jobs.json`，同时写进内存。

**第三步：调度。** `CronScheduler` 的 tick 发现到点了，走 Run Now 的那套流程（eager session → daemon turn）。

**第四步：到达。** 用户在会话列表里看到一个新的 scheduled session（可能被 `showCronSessions` 过滤），点进去能看到 agent 的运行过程。

**第五步：投递。** 如果配了 announce，`DeliveryManager` 把摘要发到指定渠道。

一个容易忽略的第四步细节：**定时任务产生的会话默认可能被列表过滤。** 这避免了每天早上多出一堆会话把真实对话顶下去，但也意味着「任务似乎没跑」时第一件事是检查 `showCronSessions`。

---

## 28. 附录 K：改动检查清单

1. 新 schedule 类型加了吗？三处（types / 前端 coerce / UI）都改了吗？
2. `tz` 的语义还是本地墙钟吗？
3. 新 payload 字段的默认值对旧任务是什么？
4. 权限默认还是 full access 吗？
5. 墙钟与空闲超时都还在吗？
6. Run Now 还是 eager 创建 session 吗？
7. 失败时还会种 fallback 消息吗？
8. 多 workspace 隔离还在吗？（不要变回全局单例）
9. 存储的 IO 锁还在吗？
10. delivery 的空 target 还会被隐式当成「这里」吗？
11. 新投递渠道委托给 gateway 还是重新实现了？

---

## 29. 附录 L：超时机制的深入

超时是无人值守任务最重要的一道保险，因为它是唯一能在「没人看着」时把资源收回来的机制。

### 29.1 为什么需要两种超时

**墙钟超时**回答「它最多能跑多久」。它防的是「任务本身就要很久」——但它太粗：一个任务可能在第 5 分钟就卡死了，而墙钟要等到 60 分钟。

**空闲超时**回答「它是不是没动静了」。daemon 在每次 ACP 事件（工具开始/结束、流式 delta）时重置计时。它防的是「卡死」——但一个真的在跑长工具的任务不应该被杀。

两者互补：墙钟保证有上限，空闲保证不浪费。

### 29.2 超时后的行为

超时不是「抛一个错误就算了」。`CronTurnOutcome` 带 `timed_out` 标记，并且可以带**被抢救出来的文本**——agent 可能已经生成了一部分有用的内容。保留它比丢掉好：用户看到的是「超时，但这是已经生成的部分」，而不是一个空结果。

`LEGACY_TIMEOUT_CUT_SHORT_MARKER = "AI response was cut short after"` 是旧版本写下的标记，`normalize_legacy_timeout_status` 处理它。这条保留是为了让历史 run 在升级后仍然可读。

### 29.3 超时与客户端等待

`CRON_CLIENT_TIMEOUT_SLACK_SECS = 60`：桌面等 daemon 的时间 = 任务墙钟 + 60 秒。这 60 秒是给 persist / finalize 的。没有它，一个刚好在墙钟附近完成的任务会看起来像「客户端卡住」，而实际上后端已经完成了。

这条的教训：**跨进程的超时不能只算「业务时间」，还要算「收尾时间」。** 收尾（写库、广播、清理）可能比业务本身还慢，尤其在数据多的时候。

---

## 30. 附录 M：桌面与 daemon 的连接

`apps/desktop/src/commands/cron/amuxd_client.rs` 是一个**只为 cron 存在的** Unix socket / 命名管道客户端。它说明了两件事：

1. 桌面与 daemon 之间有一条本地连接（不走网络）；
2. 这个连接在 cron 搬到 daemon 之后就不再需要——ADR-0010 把 `amuxd_client.rs` 列为「牵连删除」的一部分。

一条边界规则：**桌面不直接调 gateway crate 发消息**（那是 introspect 旁路的问题），而是经 daemon。`amuxd_client.rs` 是这个方向上的一个现有例子。

---

## 31. 附录 N：为什么这堆东西会存在

把 cron 的历史排一下，能看出每一步都是被一个真实需求逼出来的：

| 需求 | 产生的东西 |
|---|---|
| 到点跑一个 prompt | schedule + payload |
| 有的任务要跨 workspace | global / workspace scope |
| 跑完发给人看 | delivery |
| 用户想立刻看到结果 | eager session + Run Now 轮询 |
| 任务会卡死 | 墙钟 + 空闲超时 |
| 无人值守不能等审批 | full access 默认 |
| 崩溃后不能永远「进行中」 | heartbeat + stale 标记 |
| 多个 workspace | CronInstance 隔离 |
| 建任务与 reload 并发 | IO 锁 |
| agent 自己建提醒 | MCP 一次性调度 |
| 关闭 app 也要跑 | ADR-0010（未落地） |

这张表本身就是读代码的路径：每一行对应代码里的一组常量或一个结构。没有一行是提前设计出来的，都是问题出现后补上的。这也是为什么 cron 的代码看起来比「到点发个 prompt」重得多——**重的是那些失败模式。**

---

## 32. 附录 O：与其它模块的关系

| 模块 | 交界 |
|---|---|
| 会话 | 每次运行产生/复用一个 session |
| Agent runtime | daemon 执行 ACP turn |
| 通道网关 | delivery 复用渠道发送；共享写入服务 |
| 权限 | full access 默认；无人值守 |
| 团队 | 任务存储与团队/工作区绑定 |
| 模型 | 任务的 model 覆盖与 workspace 模型目录 |
| 前端 | 设置页、历史、Run Now |

一个与第 7 篇共同的结论：**cron 与 gateway 是同一件事的两个触发源。** 理解了这个，就不会在 cron 里重新发明消息持久化，也不会在 gateway 里重新发明 turn 驱动。

---

## 33. 附录 P：六条不变量

1. **无人值守 = full access 默认。** 旧任务缺字段也是 full access。
2. **墙钟与空闲是两个超时，别合并。** 一个管上限，一个管卡死。
3. **Run Now 必须 eager 创建 session。** 否则用户等整个 turn。
4. **失败必须可见。** 空白的会话比错误更难排查。
5. **多 workspace 必须各自一个实例。** 不要退回全局单例。
6. **调度器所在进程决定「关掉 app 还跑不跑」。** 今天不跑，ADR-0010 要改成跑。

加一条存储的：**「改内存 + 写盘」要像原子操作。** 否则 reload 会吞掉刚建的任务。

这七条对应了本文里七处看起来奇怪的代码。再读 `cron/` 目录时，可以把这七条当作目录：每个文件里至少有一处在守护其中一条。

---

## 34. 附录 Q：一页纸摘要

如果有人只读一段，应该是这段：

> 自动化是无人值守的 agent 回合。dispatch（调度）在当前代码里跑在桌面进程，执行跑在 daemon。这个分离带来三个后果：关掉 app 不跑、无头 daemon 永远没定时能力、三个 cron 面并存。ADR-0010 决定把调度也搬到 daemon，代码还没跟上。
>
> 无人值守的另外三个后果是：权限默认 full access（等审批等于不跑）、需要墙钟 + 空闲两个超时、结果需要有地方可去（delivery 七个渠道）。
>
> 用户体验上的关键设计是：Run Now 时 daemon eager 创建云端 session 并把 id 写进 run record，前端轮询拿到就跳；失败时往会话里种一条解释消息，而不是留一个空白线程。

这段话里每一句都对应至少一个常量或一个结构。把它记住，再读代码就有一个骨架。

---

## 35. 附录 R：变更记录

| 变动 | 影响章节 |
|---|---|
| 调度搬到 daemon（ADR-0010 落地） | 1、2、20 |
| 超时时长调整 | 4.2、29 |
| 新增 schedule 类型 | 3.1、28 |
| delivery 新增渠道 | 8 |
| 多设备去重（方案 c） | 2.1 |
| 权限默认值变动 | 4.1、21 |
| MCP 调度机制变动 | 10 |
| 前端组件重排 | 11 |

一条写作约定：cron 这块的文档最容易写成「怎么设一个定时任务」。那是帮助文档的活。这份要回答的是「它会在什么情况下不工作」——而事实证明，那个清单比功能说明长得多。

---

## 36. 附录 S：为什么「调度在桌面」是一个真问题

把这一点说透，因为它容易被当成「实现细节」。

定时任务的语义是「在我没空的时候替我做事」。而如果调度器在桌面进程，那么「我没空」和「电脑上的 app 没开」往往同时发生——你晚上八点离开公司，第二天九点的日报就不会发。用户的预期和系统的行为之间有一个稳定的偏差，而这个偏差不会被报成 bug，因为用户会以为自己「忘了开」。

这就是 ADR-0010 标题的意思：**定时任务归 daemon，桌面端只剩 UI。** 它的逻辑不是「daemon 更适合执行」，而是「一件事的价值不应该依赖于一个不相关的进程是否在运行」。

搬完之后有几个连带变化：

- 无头 daemon（服务器上）终于能有定时能力，而不只是执行别人的触发；
- gateway 场景（通道消息触发的 agent）可以与 cron 在同一个进程里协调；
- 「三个 cron 面」收敛成一个，这个问题才有答案：一个任务会不会跑。

代价是：daemon 必须持有调度状态（任务文件、run 历史），而它今天只持有执行状态。迁移时要处理已有任务从 config 目录搬到 team 目录，且不能丢。

---

## 37. 附录 T：一个容易搞错的边界

「定时任务」与「定时消息」是两件事。

- **定时任务**：到点让 agent 跑一轮。它是本节讲的 cron。
- **定时消息**：到点把一段固定文本发出去。它不需要 agent，只需要渠道。

前者需要 session、需要 runtime、需要超时、需要权限。后者的实现要简单得多（一个 scheduler + 一个 delivery），但它在当前系统里**与 cron 共用同一套结构**（因为 cron 的 delivery 已经在那里）。如果将来有人要加「定时发一条通知」，正确的做法是判断它是不是真的需要跑一轮——不需要的话，不要为了复用而把它做成一个空 prompt 的 cron 任务，那会白白引入一次模型调用。

这条判断与第 7 篇「能力还是传输」、第 4 篇「内容还是会执行的东西」是同一类问题：**先判断这件事的本质，再决定它用什么机制。** 本仓库里很多复杂度都来自在判断之前就开始实现。

---

## 38. 一个总结：无人值守的四件套

把整篇压缩成四条：

**一、权限默认放开。** full access 不是因为「方便」，而是因为无人值守时等审批等于不跑。旧任务缺字段也是 full access。

**二、超时双保险。** 墙钟管上限，空闲管卡死。二者互补，不能合并。

**三、结果要有去处。** 没人坐在聊天窗口前，所以 delivery 必需；而失败时要说真话，不能留空白。

**四、调度器必须常驻。** 这是 ADR-0010 要解决的问题，也是今天这块最大的已知缺口。

四条对应四个不同的失败模式：任务不跑、任务卡死、结果不知道去哪、关掉 app 就不跑。每一件背后都有一个真实场景——每日日报、定时巡检、周报、长任务。

最后一个与第 7 篇共享的结论：**cron 与通道不是两套东西，而是同一个写入服务的两个触发源。** 一个由时间触发，一个由外部消息触发。理解了这一点，就不会在 cron 里重新发明消息持久化，也不会在通道里重新发明 turn 驱动。

---

## 39. 附录：一个可以复用的判断

这篇里反复出现同一个问题：**「这件事依赖哪个进程活着？」**

- 定时任务的触发依赖调度器所在进程；
- 定时任务的执行依赖 daemon；
- 结果的投递依赖渠道凭据可达；
- 用户看结果依赖会话被保留。

四个依赖里，第一个（调度）是这块最大的缺口，因为用户对它的预期是「人不在也在跑」，而当时的实现是「app 开着才跑」。

这条判断可以推广：**当一个功能的价值陈述里包含「我不在的时候」时，它的核心依赖就不能是那个「我不在时会关掉」的东西。** 定时任务、通知、同步、后台巡检都属于这一类。

一个具体的子推论：这类功能的状态必须能被「没有人看」的时候正确维护。所以它们需要 heartbeat、需要超时、需要 stale 检测——不是因为这些是工程规范，而是因为「没人在看」意味着没有人类能发现异常。

---

## 40. 附录：一句话总结

如果把整篇压成一句话：**cron 是无人值守的 agent 回合，而「无人值守」这四个字带来了它全部的复杂度。**

没人回答问题 → 权限默认 full access；
没人看着 → 需要双超时与 heartbeat；
没人坐在聊天窗口前 → 结果必须主动投递；
人不在的时候电脑可能也不在 → 调度器必须常驻。

第四条是 ADR-0010 要解决的，也是今天最大的已知缺口。在此之前，请把「关掉 app 定时任务就不跑」当成这块的第一事实。

---

## 41. 附录：两条容易搞反的事

**一、cron 不是「定时消息」。** 定时消息只需一个 scheduler + delivery；定时任务需要 session、runtime、超时、权限。为「发一条通知」建一个空 prompt 的 cron 任务会白白引入一次模型调用。

**二、无头 daemon 现在没有定时能力。** daemon 能执行 cron turn，但调度器在桌面。所以「服务器上的 amuxd」今天不是「一个能自己安排任务的 agent」，而是一个「会执行被安排任务的 agent」。ADR-0010 就是要改这一点。

两条都很容易被反过来理解，而反过来之后设计会错。

---

## 42. 附录：三句话的速记

1. 无人值守 → full access、双超时、必投递。
2. 调度器所在进程决定「关掉 app 还跑不跑」。
3. cron 与通道共享同一个写入服务。

---

## 43. 附录：读完这篇应该能回答的问题

- cron 需要开着 app 吗？按当前代码需要，ADR-0010 要改成不需要。
- 为什么默认 full access？因为无人值守，等审批等于不跑。
- 为什么有两个超时？墙钟管上限，空闲管卡死。
- Run Now 为什么能立刻跳会话？因为 daemon eager 创建 session 并把 id 写进 run record。
- 失败会怎样？会在会话里种一条解释消息，不会留空白。
- 一个 app 的云端定时是同一件事吗？不是，那是站点的 HTTP 定时。

---

## 44. 附录：最后一点：这块最容易被低估

定时任务在功能列表里只占一行，但它是唯一一个「用户不在场」的功能。这意味着它没有人类能帮忙发现异常，所以它的每一道保险都要在代码里。

这也解释了为什么它的代码看起来比「到点发个 prompt」重得多：**重的是那些失败模式。** 权限、超时、心跳、stale、投递、多实例隔离、IO 锁——每一条都是一个曾经出错的地方。

---

## 45. 附录：三句话的速记（终）

**无人值守 → 权限放开、双超时、必投递；调度器所在进程决定关掉 app 还跑不跑；cron 与通道共享同一个写入服务。**

三句分别对应权限模型、生命周期、写入收敛。最后再加一条当前的硬事实：调度还在桌面，无头 daemon 只能执行不能安排。

---

## 46. 结语

cron 是一个很好的例子，说明一个看起来简单的功能为什么在真实系统里会变得复杂：**它的复杂度不在于「到点发个 prompt」，而在于「没人看着的时候，一切可能出错的地方都要有人管」。** 权限要放开，超时要双保险，失败要可见，调度器要活着，存储要防并发，多实例要隔离。每一项都是一个曾经出错的地方，也都是一行没人会主动去读的代码。

它与第 7 篇共享一个结论：**cron 和通道不是两套东西，而是同一个写入服务的两个触发源。** 理解了这一点，就不会在 cron 里重新发明消息持久化，也不会在通道里重新发明 turn 驱动。整个系统里，只有一处知道「消息怎么入库、怎么广播、怎么落回渠道」——这正是抽象的收益。

cron 看起来简单——到点发个 prompt——但它把「无人值守」这个前提的三条后果全部暴露了出来：权限默认放开、超时必须自己兜、结果必须主动投递。加上「调度器所在进程必须常驻」这条，就有了 ADR-0010 的搬迁理由。目前代码里调度还在桌面，执行在 daemon；读这块时以代码为准，但要知道 ADR 已经决定方向。

最后一句：**调度器所在进程决定了这个功能的价值能不能兌现。** 定时任务的承诺是「你不在的时候它也在跑」，而只要调度在桌面，这个承诺就只在「窗口开着」时成立。所以 ADR-0010 的标题不是「优化 cron」，而是「定时任务归 daemon」——它修的不是性能，是承诺。
