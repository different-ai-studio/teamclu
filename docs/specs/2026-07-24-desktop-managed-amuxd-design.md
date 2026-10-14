# 设计：amuxd 仅跟随桌面生命周期

> 状态：**已确认**（2026-07-24）  
> 日期：2026-07-24  
> 范围：桌面端托管 sidecar；**不**拷贝 amuxd / introspect 到 `~/.amuxd/bin`；**不**注册开机自启；App 开则起、关则停。  
> 非目标：多团队 profile、常驻后台双模式（可后续加）。
>
> ### 已拍板
>
> 1. 关 App 后 agent / 渠道 / cron **离线** — 接受，v1 唯一行为。  
> 2. `teamclu-introspect` **也不拷贝**，由桌面 sidecar 管理（启动 amuxd 时注入绝对路径）。  
> 3. macOS 关窗口但 App 仍在 Dock — amuxd **继续跑**；仅真正退出 App 时 stop。

---

## 1. 背景与决策

当前路径：

1. Setup 把 sidecar 拷到 `~/.amuxd/bin/amuxd`
2. Onboard 后 `install-service`（LaunchAgent / systemd-user / 计划任务）
3. App 关掉后 daemon 仍跑（渠道 / MQTT / cron）
4. App 升级后再拷贝 + stop/restart 对齐版本

问题：拷贝锁冲突、自启与升级编排复杂、切团队依赖 `clear` + 服务重启。

**产品决策（本设计）：** 本机 agent **只在桌面打开时可用**。接受关 App 后：

- 企微 / 飞书等 channel 不收消息
- 手机端看本机 agent = offline
- cron 不跑
- 团队文件后台 sync 停

身份与数据仍落在 `~/.amuxd/`（`daemon.toml`、`backend.toml`、`teams/` 等）；变的是 **谁启动进程、二进制从哪来**。

---

## 2. 目标与非目标

### 目标

| ID | 目标 |
|----|------|
| G1 | 桌面启动后拉起包内 `amuxd` sidecar；健康后再进主 UI / agent 能力 |
| G2 | 桌面退出（含 Cmd+Q / 关最后窗口退出）时停止该子进程 |
| G3 | **永不**把 amuxd 拷到 `~/.amuxd/bin`（本模式） |
| G4 | **永不**注册 / 依赖 `install-service`（本模式） |
| G5 | 升级 = 装新 App；下次启动直接用新 sidecar，无需 `ensureBundledAmuxdCurrent` 覆盖拷贝 |
| G6 | 已安装旧 LaunchAgent 的用户，首次进新模式时 **卸载旧服务**，避免双实例抢锁 |

### 非目标（本阶段不做）

- 设置里「保持后台运行」开关（双模式）
- 多 team profile 热切换（仍可 mismatch → clear → re-init，但 stop/start 由桌面编排）
- 无 GUI 纯 CLI 常驻部署（仍可用自行编译的 `amuxd start`，与桌面模式正交）
- 改 opencode 安装位置（仍 `~/.opencode`）

---

## 3. 方案对比

| | A. 桌面托管 sidecar（推荐） | B. 仍拷贝 bin，但不注册服务 | C. 保持现状常驻服务 |
|--|---------------------------|---------------------------|-------------------|
| 二进制来源 | App 包内 sidecar | `~/.amuxd/bin` | 同左 |
| 生命周期 | 跟 App | 跟 App（detached start） | 跟 OS 服务 |
| 升级 | 自然跟随 App | 仍要覆盖拷贝 | 同左 + 服务重启 |
| 实现复杂度 | 中（进程管理） | 低但保留拷贝痛点 | 已有 |
| 关 App 后 agent | 离线 | 离线 | 在线 |

**推荐 A：** 同时消掉拷贝与自启两类复杂度。

---

## 4. 目标架构

```text
┌─────────────────────────────────────────┐
│  TeamClu Desktop (Tauri)               │
│                                         │
│  AmuxdSupervisor (Rust, AppState)       │
│    start: shell.sidecar("amuxd") start  │
│    stop:  SIGTERM / amuxd stop + wait   │
│    child handle held in process         │
│                                         │
│  Frontend                               │
│    AuthGate / onboard 只等 HTTP healthy │
│    不再 invoke daemon_install_service   │
└─────────────────┬───────────────────────┘
                  │ spawn（不拷贝）
                  ▼
         [bundled] amuxd start
                  │
                  ▼ 读写（不变）
         ~/.amuxd/{daemon,backend}.toml
         ~/.amuxd/amuxd.http.{port,token}
         ~/.amuxd/teams/...
```

进程模型：

- **Parent：** 桌面主进程持有 `CommandChild`（或等价），`lifecycle` 互斥 + `app_exiting` 门闩串行化 ensure/shutdown
- **Child：** sidecar `amuxd start`（独立 process group；`kill_on_drop(false)`；Exit 只发 `amuxd stop`，失败再强杀 **amuxd 自身**）
- **单实例：** 仍靠 `~/.amuxd/amuxd.lock`；启动前若发现旧服务/旧进程，先卸载/停止并 **验证** 已 unloaded
- **平台：** v1 以 macOS 为主；Windows 用 `taskkill /T` + pid 文件身份校验收尸（非 Job Object）

---

## 5. 生命周期详细设计

### 5.1 启动顺序

```text
App setup / 首屏前
  1. migrate_legacy_service_if_needed()
       - 若检测到 LaunchAgent/systemd unit/计划任务 amuxd → uninstall-service
       - 若 amuxd.pid 仍存活 → sidecar 或 installed path 执行 stop，wait lock
  2. AmuxdSupervisor::ensure_started()
       - 已有本 supervisor 子进程且 HTTP probe ok → noop
       - 否则 spawn: sidecar("amuxd").args(["start"])
       - 轮询 ~/.amuxd/amuxd.http.port + /v1/healthz（超时 ~20s）
  3. 前端 setup / auth / onboard 照旧；ensureHealthy 改为「等 supervisor」而非 install-service
```

**何时 start：**

- **推荐：** Tauri `setup` 末尾异步拉起（与现 prewarm 类似，不挡窗口），AuthGate 用 `probeDaemonHttp` / 新命令 `daemon_supervisor_status` 等待。
- Onboard（`daemon_init`）成功后：若进程已在跑，需 **重启一次** 以加载新 `backend.toml`（今日靠 install-service kickstart；新模式改为 `supervisor.restart()`）。

### 5.2 停止顺序

挂在现有 `RunEvent::ExitRequested` / `Exit`（与 `terminal::Registry::kill_all` 并列）：

```text
ExitRequested
  → AmuxdSupervisor::shutdown()
       1. 对持有的 child 发 stop：优先 `amuxd stop`（经 sidecar 一次性命令）或 SIGTERM
       2. wait_for_amuxd_stopped(timeout ≤ 5s)（复用 setup.rs 的 pid 轮询）
       3. 仍存活则 kill child handle
```

注意：

- macOS「关窗口最小化到 Dock、进程仍在」：**不**停 amuxd（与今日 App 仍活着一致）。
- 仅真正退出 App 时停。

### 5.3 崩溃与孤儿

| 场景 | 处理 |
|------|------|
| amuxd 子进程意外退出 | supervisor 标记 down；前端 probe 失败；`ensureHealthy` → `supervisor.restart()` |
| 桌面被 force kill | 子进程可能残留；**下次**启动 `migrate`/`ensure_started` 前先 stop 旧 pid |
| 开发热重载 | supervisor 用单例；重载前 stop，避免多实例 |

---

## 6. 对现有流程的改写

### 6.1 SetupWizard

| 现在 | 改后 |
|------|------|
| 自动 `setup_install('amuxd')` 拷贝二进制 | **删除 amuxd 安装行**；doctor 改为「bundled sidecar 可执行 +（可选）已能 start」 |
| 装 opencode / 检测 git | **保留** |

`setup_list_requirements`：`amuxd.present` = sidecar 存在且 `amuxd doctor` 对 **bundled** 二进制 satisfied（版本 = 包内版本），不再看 `~/.amuxd/bin`。

### 6.2 Onboarding

```text
现在: createInvite → daemon_init → daemon_install_service
改后: createInvite → daemon_init → daemon_restart_managed  （或 supervisor.restart）
```

- 去掉对 `daemon_install_service` 的依赖（命令可留 stub：转调 restart，或删除并改前端）。
- `ensureHealthy`：改为 `invoke('daemon_ensure_running')`（supervisor ensure + probe）。

### 6.3 升级

- 删除 / 空实现 `ensureBundledAmuxdCurrent()`（不再拷贝）。
- 用户装新 `.dmg` / 安装包后打开即新 sidecar。

### 6.4 切团队 / clear

仍：mismatch → `daemon_clear` → 再 init。  
增强（本设计范围内的小改进）：

```text
forceReset:
  supervisor.stop()     // 先停，避免 clear 撞 lock
  daemon_clear
  refresh → needs-onboard
bind/create:
  daemon_init
  supervisor.restart()
```

（不解决多 profile；只让 clear 更可靠。）

### 6.5 设置页

- 文案：「后台服务 / 开机启动」→「随 TeamClu 运行」。
- 去掉「安装/修复 LaunchAgent」类按钮；改为「重新启动本机 Agent」。

---

## 7. `~/.amuxd` 在本模式下的角色

| 仍使用 | 不再依赖 |
|--------|----------|
| `daemon.toml` / `backend.toml` | `bin/amuxd`（可忽略；迁移期可删旧文件可选） |
| `amuxd.pid` / `lock` / `sock` / `http.*` | LaunchAgent / systemd unit / 计划任务 |
| `teams/`、`team-secrets/`、`sessions.toml`… | `ensureBundledAmuxdCurrent` 拷贝 |

可选清理（迁移一次）：若 `bin/amuxd` 或 `bin/teamclu-introspect` 存在，可删除（不再是真相源）。

**Introspect（已拍板）：** 与 amuxd 一样 **不拷贝**。桌面 `spawn amuxd start` 时设置环境变量，例如：

```text
TEAMCLU_INTROSPECT_BIN=/…/TeamClu.app/Contents/MacOS/teamclu-introspect-<triple>
```

daemon `resolve_introspect_binary()` **优先读该 env**，再回退 PATH / 旧 `~/.amuxd/bin` / App bundle 搜索（兼容过渡）。

---

## 8. 新增 / 调整的桌面 API

| 命令 | 职责 |
|------|------|
| `daemon_ensure_running` | supervisor ensure + 等到 healthy |
| `daemon_restart_managed` | stop + start（init / heal 后用） |
| `daemon_supervisor_status` | `{ running, healthy, pid?, error? }` |
| `daemon_install_service` | **废弃**：实现改为 `daemon_restart_managed` 或返回 ok no-op（兼容旧前端一轮） |
| `setup_install(id=amuxd)` | **废弃/拒绝**：或仅做「确保 supervisor 在跑」 |

Rust：`AmuxdSupervisor` 进 `AppState`，在 `lib.rs` Exit 钩子 shutdown。

---

## 9. 迁移（已有用户）

首次新版本启动：

1. 检测服务已注册 → 跑 sidecar `uninstall-service`（失败只打日志）
2. `amuxd stop`（sidecar）+ wait pid
3. 再 `ensure_started` 托管进程
4. （可选）日志提示「本机 Agent 现已随 App 启停」

不自动 `clear` 身份；用户团队绑定保留。

---

## 10. 风险与缓解

| 风险 | 缓解 |
|------|------|
| 关 App 后渠道/cron 不可用 | 产品文案明确；后续可做「可选常驻」 |
| force kill 留孤儿 amuxd | 下次启动先 stop |
| `amuxd start` 若自身 daemonize | 需确认当前 `start` **前台占住**还是立即退出；若已 daemonize，改为 `start --foreground` 或桌面用管 fd 的模式（**实现前必验**） |
| 开发态多实例 | supervisor 单例 + lock |
| doctor/CI 仍假设 `~/.amuxd/bin` | 更新 doctor 与桌面 probe |

### 10.1 `amuxd start` 前台语义（已验证）

`Commands::Start` 的 `daemonize` 参数被忽略（`daemonize: _`）；`start` **前台**跑 `server.run` 直到退出。桌面可直接持有子进程，无需额外 `--foreground`。

---

## 11. 成功标准

1. 新装用户：无 `~/Library/LaunchAgents/cc.ucar.amuxd.plist`（mac），无 `~/.amuxd/bin/amuxd` 拷贝步骤。
2. 打开 App → `/v1/healthz` 通；退出 App → pid 消失、lock 释放。
3. 升级 App 后无需拷贝即可跑到新版本 daemon（`--version` 与包内一致）。
4. Onboard / heal / 切团队 clear 在「先 stop」后稳定成功。
5. 关 App 期间 MQTT presence = offline（预期行为）。

---

## 12. 实现分期（预告，非本设计正文）

| 阶段 | 内容 |
|------|------|
| P0 | 验证 `start` 前台语义；`AmuxdSupervisor`；Exit stop；迁移卸服务 |
| P1 | 前端去掉 install-service；Setup 去掉 amuxd 拷贝；ensureHealthy 改 ensure_running |
| P2 | 删升级拷贝；文案；可选清 `bin/amuxd`；文档更新 `amuxd-home-directory.md` |

---

## 13. 已拍板（2026-07-24）

1. 关 App = agent / 渠道 / cron 离线 — **接受，v1 唯一行为**。  
2. introspect **不拷贝**，sidecar + `TEAMCLU_INTROSPECT_BIN` 注入。  
3. macOS 关窗口、App 仍在 Dock — amuxd **保持运行**；仅 Exit 时 stop。

下一步：实现计划 → 改代码。
