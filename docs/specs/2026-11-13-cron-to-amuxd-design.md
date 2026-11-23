# Cron → amuxd 设计（落地 ADR-0010）

日期：2026-11-13  
状态：已实现（feat/cron-to-amuxd）  
依据：[ADR-0010](../adr/0010-cron-belongs-to-the-daemon.md)、[layout-v2](../architecture/amuxd-home-layout-v2.md)、[功能详解 · 自动化](../features/08-automation-cron.md)  
代码注释仍指向的旧路径见文末 stub：`docs/superpowers/specs/2026-05-17-cron-to-amuxd-design.md`

---

## 0. 一句话

**调度器、任务存储、run 记录、投递编排进 amuxd；桌面只剩设置页 UI。**  
daemon 已有的 `prompt-await` / cron turn 执行路径保留，成为调度器的唯一执行器。

---

## 1. 现状（以代码为准）

| 能力 | 今日所在 | 路径 |
|---|---|---|
| 调度 / CRUD / 存储 / delivery 编排 | 桌面 | `apps/desktop/src/commands/cron/`（~4k LOC，11 IPC） |
| 一轮 ACP turn | daemon | `apps/daemon/src/daemon/server/cron.rs` + `prompt_await` |
| MCP 触发 | 桌面 introspect | `POST /cron-run`、`/cron-manage`（`:13144`） |
| 设置 UI | React | `stores/cron.ts`、`CronSection.tsx` → `invoke('cron_*')` |

三个入口并存 → 「这个 job 会不会跑」没有单一答案。关 app / 无头 gateway → 调度停。

---

## 2. 目标与非目标

### 目标

1. **关桌面 app 仍跑**；无头 amuxd 有完整 cron。
2. **单一调度权**：只有 amuxd 的 scheduler 决定何时 fire。
3. **存储 team-scoped**：`~/.amuxd/teams/<team_id>/cron/`（ADR-0006 / layout-v2）。
4. **无人值守默认 `full_access`** 写在 daemon 执行路径上（缺省 / 旧 JSON 同义），不依赖桌面权限 UI。
5. **收掉 introspect 的第三面**：MCP 改打 daemon HTTP（或经已鉴权的代理），不再直接拨桌面调度器。
6. **Run Now / session 跳转体验保持**：eager `cron-prepare-session` + run record 上尽早盖 `session_id`。

### 非目标（本设计明确不做）

- 云端多设备去重（ADR-0010 的方案 c）——本设计之后的可选层。
- 换调度语义（仍是 `at` / `every` / `cron`+可选 `tz`）。
- GPUI / 换壳。
- 重做 delivery 渠道实现（继续委托现有 gateway / amuxd channels）。
- 把 local_cache / mqtt UI bus 一并下沉。

---

## 3. 目标架构

```text
┌──────────── Desktop / Web UI ────────────┐
│  CronSection / cron store                │
│  HTTP(S) → amuxd /v1/cron/*  (或 control) │
└──────────────────┬───────────────────────┘
                   │
┌──────────────────▼───────────────────────┐
│  amuxd                                   │
│  ┌─────────────┐  ┌───────────────────┐  │
│  │ Scheduler   │→ │ prompt-await /    │  │
│  │ + Storage   │  │ cron turn exec    │  │
│  │ + Runs      │  │ (已有)             │  │
│  └──────┬──────┘  └───────────────────┘  │
│         │ delivery                       │
│         ▼                                │
│  channels / WeCom / SeaTalk / …          │
└──────────────────────────────────────────┘

MCP / introspect: 不再持有调度器；
  agent → daemon /v1/cron/*（带现有 introspect 调用方校验策略迁移过来）
```

桌面进程删除 `commands/cron/` 整树与专用 `amuxd_client`（cron 专用 socket 客户端）；通用 `amuxd_control` / daemon HTTP 客户端保留。

---

## 4. 存储（layout-v2）

```text
~/.amuxd/teams/<team_id>/cron/
  jobs.json          # 或 jobs/*.json（实现可选；须原子写）
  runs/<job_id>/…    # run records（保留现有字段语义）
  # 可选：scheduler-state.json（next_tick 缓存；可重建则不要持久化）
```

### 4.1 Scope 重映射

| 今日 | 迁后 |
|---|---|
| `global` → `config_dir/<brand>/cron-global` | **归属当前 active team** 的 `teams/<id>/cron/`（不再有「跨 team 全局」文件）。产品文案：全局 = 「本 team、不绑某个 workspace」。 |
| `workspace` → `<ws>/.teamclu/cron-jobs.json` | 仍按 workspace 路径区分 job，但**文件落在 team cron 树内**（例如 `jobs.json` 内带 `workspace_root`），**不再**写进用户仓库目录。避免 git 噪声与「clone 才有 cron」的诡异语义。 |

一次启动迁移（daemon）：

1. 若存在旧 `cron-global` → 导入 active team（或导入时要求显式 team id）。
2. 扫描已知 workspace 的 `.teamclu/cron-jobs.json` → 导入对应 team（workspace 已登记在该 team 下时）；无法归属的写入 `teams/<id>/cron/orphan-import/` 并打日志，不静默丢。
3. 迁移成功后旧文件改名为 `*.migrated`（或移到 desktop brand 下备份），避免双调度。

**双调度禁止：** 新版本桌面若仍编译到旧 `cron_*` IPC，必须 no-op 并提示「已迁至 daemon」；理想是直接删除命令。

---

## 5. Daemon API（建议）

挂在现有 daemon HTTP（与 team skills 等同一鉴权模型：本机 token / session）。路径示意：

| Method | Path | 作用 |
|---|---|---|
| GET | `/v1/cron/jobs?scope=&workspace=` | list |
| POST | `/v1/cron/jobs` | add |
| PATCH | `/v1/cron/jobs/:id` | update |
| DELETE | `/v1/cron/jobs/:id` | remove |
| POST | `/v1/cron/jobs/:id/enable` | toggle |
| POST | `/v1/cron/jobs/:id/run` | Run Now |
| GET | `/v1/cron/jobs/:id/runs` | history |
| POST | `/v1/cron/delivery/refresh` | 热读渠道配置（保持今日行为） |

Wire 类型与今日前端 `CronJob` / `CronRunRecord` / `CronPayload` **字段兼容**（serde rename 保持 camelCase），减少 UI 改动面：`stores/cron.ts` 从 `invoke` 换成 daemon HTTP client。

内部控制：scheduler 循环调用已有 `prompt-await` / prepare-session；**不要**再经桌面转一圈。

### 5.1 Payload / 权限（必须写死）

- `permission_mode` 缺省 / `null` / 旧 JSON → **`full_access`**。
- 墙钟 / 空闲超时常量与今日桌面一致（见 `08-automation-cron.md` §4.2），搬进 daemon 单一模块，避免两处漂移。
- `backend` 历史字段：执行侧只认 pi（ADR-0014）；存档可保留但忽略。

### 5.2 Run Now

保持 eager session：

1. `POST …/run` → 立刻写 run record（`running`）。
2. `cron-prepare-session`（已有）盖上 `session_id`。
3. UI 继续 1s 轮询 runs，拿到 `session_id` 即跳转（现 `stores/cron.ts` 逻辑可几乎不动）。

---

## 6. Delivery

- **编排**进 daemon（今日在 `delivery.rs`）。
- **发送**继续委托：WeCom / SeaTalk → amuxd-owned gateway；其余渠道读现有配置源（workspace / team 配置），「每次发送重读配置」保留。
- 桌面不再为 cron 持有 `DeliveryManager` 实例。

---

## 7. Introspect / MCP

| 今日 | 迁后 |
|---|---|
| `:13144` `/cron-run` `/cron-manage` 调桌面调度器 | **删除或 410**；MCP 改调 daemon `/v1/cron/*` |
| 调用方校验（runtime-context verify） | 迁到 daemon 侧等价门禁，或 MCP 经已有 daemon 工具面 |

一次性 MCP schedule（`at`，非 cron expr）语义保持（#1339 / #1337 的修复不回退）。

---

## 8. 多设备

本阶段：**每台机器的 amuxd 各自调度自己的 team cron 副本**（与今日「每台桌面各跑一份」同构，只是进程换了）。  
若两台同时在线 → 可能双跑——**已知限制**，文档写明；云端去重是 follow-up。

---

## 9. 前端

- `cron.ts`：IPC → daemon HTTP（与 skills / team sync 同一 client 风格）。
- `CronSection` / History / Run Now 导航：**行为不变**。
- 删除对 `cron_init`「按窗口起 scheduler」的依赖；改为「确保 daemon 可达 + list」。

---

## 10. 分阶段落地

| Phase | 交付 | 验收 |
|---|---|---|
| **A · Spec + 类型** | 本文 + 共享 job/run schema（daemon）+ 契约测试 | schema 与现前端类型对齐 |
| **B · Daemon 存储 + CRUD API** | 无调度，只读写 jobs/runs | HTTP 单测；手工 curl |
| **C · Scheduler + 接 prompt-await** | 无头 `amuxd`  alone 能到点跑 | 关桌面 app，job 仍 fire；run record + session |
| **D · Delivery** | announce 渠道 | 与现网渠道冒烟 |
| **E · 迁移旧存储** | 导入 cron-global / workspace json | 升级后旧任务仍在；无双跑 |
| **F · 前端切流** | UI 只用 daemon API | 设置页 CRUD / Run Now / 跳转 |
| **G · 拆除桌面 cron + introspect cron** | 删目录与路由 | `rg cron_` 桌面命令归零；MCP 走新 API |

建议 **A→C 可先合**（无头价值立刻兑现），再 E/F；G 最后以免回滚困难。

---

## 11. 风险

| 风险 | 缓解 |
|---|---|
| 迁移丢 job | 旧文件 rename 备份；orphan 目录；迁移前 dry-run 日志 |
| 双调度 | 桌面命令删除 / 硬 no-op；版本门控 |
| full_access 回退成要审批 | daemon 单测钉死缺省；旧 JSON 夹具 |
| Windows 控制通道 | 沿用已修复的 named pipe（#1049），调度与执行同进程后此面变小 |
| 多设备双跑 | 文档 + 后续云端去重；不在本设计范围假装已解 |

---

## 12. 实现时必读

- `apps/desktop/src/commands/cron/{mod,scheduler,storage,types,delivery,amuxd_client}.rs`
- `apps/daemon/src/daemon/server/cron.rs`、`daemon/prompt_await.rs`
- `packages/app/src/stores/cron.ts`
- `apps/desktop/src/commands/introspect_api.rs`（`/cron-*`）
- ADR-0006 / 0007 / 0010 / 0014；layout-v2 §「谁拥有目录谁写」

---

## 13. 开放问题（实现前拍板即可）

1. workspace-scoped job 是否**完全禁止**写入 `<ws>/.teamclu/`（推荐禁止，只迁出）。
2. daemon API 挂 HTTP `/v1` 还是仅 control socket（推荐 HTTP，与 skills 一致，便于无头与 MCP）。
3. 无 active team 时 global 导入落到哪里（拒绝启动 cron vs `_unclaimed`）。

---

## 14. 成功标准

- 无头 amuxd + 已登录 team：到点创建 cloud session 并完成 turn，桌面未打开。
- 升级用户：旧 global/workspace job 可见且不双跑。
- MCP 创建/触发只打 daemon；introspect 无 cron 调度逻辑。
- 设置页 Run Now 仍能在数秒内跳进带 `session_id` 的会话。
