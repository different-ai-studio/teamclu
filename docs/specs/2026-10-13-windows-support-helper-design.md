# Windows 支持助手（独立程序 + 支持会话）

- **Date**: 2026-10-13
- **Status**: IMPLEMENTED — Windows 安装器与 Win32 窗口还需要在 Windows 上编译验证；macOS 助手已在本机通过编译
- **Scope**: 独立程序 `teamclu-support`（Windows 为 `.exe`）、NSIS 安装记录与失败拉起、Windows 与 macOS 白屏时最多重启一次后拉起助手、Cloud API 支持会话、支持端兑码并把一次性诊断包交给现有 agent
- **Non-scope**: 操作员名单、短码哈希、日志脱敏、限流、按工具来回查询、远程桌面、把 introspect 暴露到机器之外、在用户机器上跑 agent、Linux 助手、白标品牌的目录和安装器
- **Related**: `apps/desktop/windows/installer-hooks.nsh`、`apps/desktop/src/webview_recovery.rs`、`apps/desktop/src/commands/diagnostics.rs`、`docs/specs/2026-09-03-symptom-driven-diagnostics-design.md`

---

## 0. 一句话

Windows 上安装失败或主界面白屏时，用户打开一个不依赖 TeamClu 界面的小程序。支持人员在自己正常的 TeamClu 里输入短码，用户点允许后，小程序一次性上传诊断包，支持端的 agent 读这包并给出结论。

---

## 1. 目标

| # | 要求 | 落点 |
|---|------|------|
| 1 | 主程序没装完、白屏、或进程已退出时，用户仍能发起一次支持 | 独立的 `teamclu-support.exe` |
| 2 | 助手不加载 TeamClu 界面，不启动 amuxd，不用 WebView2 | 单独 crate，Win32 窗口 |
| 3 | 安装器自身打不开时，支持可以把助手单独发给用户 | 与安装包放在同一发布目录的独立下载 |
| 4 | 支持人员用短码接到这场会话，并看到一个明确结论 | Cloud API 支持会话 + 支持端现有 agent |
| 5 | 用户点允许之前，诊断包不上传 | 会话状态 `redeemed` → 用户允许 → `allowed` 之后才接受 bundle |

验收时必须能区分这四类情况：

1. 没有 WebView2
2. 安装文件被占用，主程序写不进去
3. `amuxd.exe` 或主程序仍在运行
4. 某份日志里有明确错误；文件不存在时报告「没有这份文件」，不当成采集失败

---

## 2. 今天长什么样

| 资产 | 事实 | 缺口 |
|------|------|------|
| 设置里的症状诊断 | 应用打开后可导出 cause code、trace 和日志尾部 | 白屏和安装失败时界面进不去 |
| `webview_recovery` | 主 webview 缺失或无响应就 `request_restart()`，并向 Sentry 打一条警告 | 会反复重启；没有给人看的下一步 |
| `installer-hooks.nsh` | 安装前结束 sidecar，并等待主程序可写 | 步骤结果只进 NSIS 自己的日志，失败后没有可打开的程序 |
| 桌面 Sentry | 崩溃上报，且不带用户名和机器名 | 安装器失败、白屏但进程还活着时，支持对不上是哪一台 |
| daemon 日志 | `$HOME/.amuxd/logs/amuxd.log` 与 `amuxd.managed.log` | 人不在机器旁边就读不到 |
| Cloud API | 客户端业务数据的唯一入口 | 没有支持会话 |

---

## 3. 决策

### D1 — 助手是独立程序

新 crate `apps/support-helper`。Windows 产出 `teamclu-support.exe`，窗口用 Win32。macOS 产出同名无后缀二进制，窗口用 AppKit。不依赖 Tauri、wry、WebView2、amuxd。Linux 没有窗口。

它和 TeamClu 的约定只有两处：只读下面第 6 节的固定路径；会话走 Cloud API。找不到那些文件时，对应字段为「没有」，助手自己仍可连上支持。

### D2 — 分发

1. **随安装器。** `NSIS_HOOK_PREINSTALL` 一开始就把助手释放到 `$PLUGINSDIR\teamclu-support.exe`，早于主程序拷贝。安装失败时启动这份已经释放的程序。安装成功后复制到 `$INSTDIR\teamclu-support.exe`，并在主程序同一个开始菜单目录放快捷方式「TeamClu 支持助手」，参数 `--phase manual`。
2. **单独下载。** Windows 发布产物增加 `teamclu-support.exe`，和 NSIS 安装包放在同一目录（GitHub Release 与每日 Beta 的 OSS 目录）。安装包打不开、或主程序退出前来不及拉起助手时，支持把这个文件发给用户。
3. **macOS。** 没有 NSIS。`bundle.macOS.files` 把 `binaries/teamclu-support` 放进 `Contents/MacOS/teamclu-support`，和主程序并列。应用打不开时，发布产物里的独立二进制 `teamclu-support-<target>` 就是入口（GitHub Release 与每日 Beta 的 OSS 目录，不进网站下载按钮）。没有开始菜单快捷方式。`beforeBundleCommand` 在非 Darwin 上直接退出；Darwin 上若二进制还不在，就编译它，并在 `APPLE_SIGNING_IDENTITY` 已设置时自己签名（这一步晚于现有的 sidecar 签名脚本）。

构建安装器时，助手 exe 必须已经存在。缺失则 Windows 安装包构建失败。

hooks 文件不能再定义 `.onInit`（Tauri 模板已经占用）。失败拉起写在 hooks 里的 `.onInstFailed`：执行 `$PLUGINSDIR\teamclu-support.exe --phase install`。若当前 Tauri 模板已经定义 `.onInstFailed`，实现时改到模板实际提供的失败插入点，行为不变。

### D3 — 白屏最多自动重启一次

`webview_recovery` 的探测结果不变（`Healthy` / `MissingWindow` / `Unresponsive`）。决策改成纯函数：

| 探测 | 已记录的重启次数 | 动作 |
|------|------------------|------|
| `Healthy` | 任意 | 把计数清零，不重启 |
| 非 `Healthy` | 0 | 计数加一，`request_restart()` |
| 非 `Healthy` | ≥ 1 | 不重启，启动 `$INSTDIR\teamclu-support.exe --phase webview` |

计数放在 `%USERPROFILE%\.teamclu\support\webview-restart-count`。助手 exe 不在安装目录时，用 `MessageBox` 显示单独下载的说明，不再重启。

macOS 用同一张表、同一份计数文件。助手文件名是 `teamclu-support`，放在主程序旁边。找不到时用 `osascript` 提示，不再重启。健康时 Dock 点击仍然显示窗口。拉起助手之后，Dock 处理不再把空白窗口提到前面。

### D4 — 会话四步，都在 Cloud API

不另做后台，不直连 Supabase。客户端只调 `/v1`。

1. 助手 `POST /v1/support-sessions`，无需登录，得到短码。
2. 支持人员在自己已登录的桌面应用里兑码。任何已登录账号都可以兑，先兑到的人绑定这场会话。
3. 助手轮询到支持人员的显示名。用户点「允许」后，助手一次性上传诊断包。
4. 支持端把诊断包交给现有本地 agent。agent 的回复写回会话，助手显示这句结论。

短码就是助手后续请求的凭据（查询参数 `code`）。这一版不把短码做成哈希，也不做操作员名单、脱敏和限流。

### D5 — 支持端复用现有 agent

兑码和查看会话放在桌面设置的诊断区：一个短码输入框和「接入」。bundle 到达后，支持端新建一条本地会话，把 bundle 作为第一条用户消息交给现有 agent，请它回答三件事：卡在哪一步、证据在哪、用户下一步做什么。agent 的回复截断到 4000 字，`POST` 为结论。

支持端的 agent 起不来时，诊断区仍展示原始 bundle。支持人员可以自己写结论并提交。用户机器上不跑 agent。

---

## 4. 支持会话

### 4.1 短码

8 位，字符集 `ABCDEFGHJKLMNPQRSTUVWXYZ23456789`，界面显示为 `XXXX-XXXX`。比较时忽略大小写和连字符。插入时若撞上已有短码，换一个再插入。

有效期 15 分钟，从创建时间起算。过期在读取时判断，不依赖定时任务。过期后的兑码、允许、上传、写结论都拒绝。

### 4.2 状态

`waiting` → `redeemed` → `allowed` → `concluded`

旁路：`rejected`（用户拒绝）、`closed`（任意一方结束）、`expired`（超过 15 分钟）。

进入 `rejected`、`closed`、`expired` 之后，不再接受允许、上传和结论。

### 4.3 表 `support_sessions`

迁移放在 `services/supabase/`。只有 Cloud API 使用服务端写入，客户端不直接插入。

| 列 | 类型 | 说明 |
|----|------|------|
| `id` | uuid | 主键 |
| `code` | text | 短码明文，唯一 |
| `status` | text | 上一节的状态 |
| `phase` | text | `install`、`webview`、`manual` |
| `support_user_id` | uuid，可空 | 兑码人 |
| `support_display_name` | text，可空 | 兑码时记下的展示名 |
| `bundle` | jsonb，可空 | 一次性诊断包 |
| `conclusion` | text，可空 | 给用户看的结论 |
| `created_at` | timestamptz | |
| `expires_at` | timestamptz | `created_at + 15 min` |

### 4.4 接口

错误体沿用现有 Cloud API 的错误响应，并带下列 `code`：`not_found`、`expired`、`already_redeemed`、`not_redeemed`、`not_allowed`、`already_uploaded`、`closed`。

| 方法与路径 | 谁调用 | 行为 |
|------------|--------|------|
| `POST /v1/support-sessions` | 助手，无登录 | Body：`{ "phase": "install" \| "webview" \| "manual" }`。返回 `{ sessionId, code, expiresAt }`，状态 `waiting` |
| `GET /v1/support-sessions/{id}?code=` | 助手 | 返回 `{ status, supportDisplayName, conclusion, expiresAt }`。短码不匹配为 `not_found` |
| `POST /v1/support-sessions/redeem` | 支持端，要登录 | Body：`{ "code" }`。`waiting` 且未过期则绑定当前用户，状态改为 `redeemed`，写下展示名。已被别人兑过返回 `already_redeemed` |
| `POST /v1/support-sessions/{id}/allow?code=` | 助手 | 仅 `redeemed` 时可调用，状态改为 `allowed` |
| `POST /v1/support-sessions/{id}/bundle?code=` | 助手 | 仅 `allowed` 且 `bundle` 仍为空时写入。第二次上传拒绝 |
| `GET /v1/support-sessions/{id}` | 支持端，要登录 | 仅兑码人可读，返回状态、phase、bundle、conclusion |
| `POST /v1/support-sessions/{id}/conclusion` | 支持端，要登录 | 仅兑码人，且状态为 `allowed`。Body：`{ "text" }`。写入后状态为 `concluded` |
| `POST /v1/support-sessions/{id}/close` | 双方 | 助手带 `code`，支持端带登录。Body：`{ "reason": "user_rejected" \| "user_closed" \| "support_closed" }`。`user_rejected` 把状态写成 `rejected`，其余写成 `closed` |

展示名取兑码用户的 `nickname`。`nickname` 为空时用 `email`。仍为空则存「支持人员」，助手也显示这四个字。

`GET` 发现已过期时把状态写成 `expired` 并照常返回，不报错，这样窗口可以提供「重新生成」。兑码人的 `GET /v1/support-sessions/{id}` 在 `concluded`、`closed`、`rejected`、`expired` 时仍返回已经写下的 bundle 和 conclusion。

助手每 2 秒轮询一次带 `code` 的 `GET`，直到 `concluded`、`rejected`、`closed` 或 `expired`。

`conclusion.text` 最长 4000 个字符，超出由支持端截断后再提交；API 拒绝更长的正文。`concluded` 之后可以 close 成 `closed`。已经是 `rejected`、`closed` 或 `expired` 时，close 返回当前状态，不报错。bundle 已存在时再次上传返回 `already_uploaded`。

### 4.5 诊断包

允许之后上传一次，形状如下。日志按原文上传，这一版不做脱敏。

```json
{
  "snapshot": {
    "os": "windows",
    "osVersion": "10.0.22631",
    "arch": "x86_64",
    "helperVersion": "0.4.1-beta.91",
    "phase": "install",
    "webview2": { "present": false, "version": null },
    "installDir": "C:\\Users\\a\\AppData\\Local\\TeamClu",
    "installDirWritable": false,
    "processes": { "teamclu": false, "amuxd": true, "installer": true },
    "webviewProbe": null
  },
  "journal": [
    { "ts": "2026-10-13T07:00:00Z", "step": "wait_writable", "ok": false, "detail": "ticks=75" }
  ],
  "logs": [
    { "name": "amuxd.log", "present": true, "tail": "..." },
    { "name": "amuxd.managed.log", "present": false },
    { "name": "desktop", "present": true, "tail": "..." }
  ]
}
```

`webview2.present` 读注册表项 `Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}` 的 `pv`（先 HKLM 的 `WOW6432Node`，再 HKCU）。读到非空版本则为 `true` 并带上版本。键不存在为 `false`。读取失败为 `null`，版本 `null`。

`processes` 只回答三个映像在不在：`TeamClu.exe`、`amuxd.exe`、安装器。安装器映像名由 PREINSTALL 写进 journal（`step` 为 `installer_image`）。没有这条记录时，`installer` 为 `false`。

`installDir` 来自 journal 的 `step` `install_dir`。没有这条记录时，`installDir` 和 `installDirWritable` 都是 `null`。有目录时，助手尝试在该目录创建并删除一个临时文件，以此填写 `installDirWritable`。

每份日志尾部最多 500 行，且不超过 256 KiB。桌面日志把该目录下每个 `*.log` 的尾部按文件名拼在一起，和 `diagnostics.rs` 的尾部采集方式一致。

---

## 5. 助手窗口

阶段由启动参数决定：`--phase install`、`--phase webview`、`--phase manual`。缺省为 `manual`。

每一屏都写两件事：这个窗口是给 TeamClu 打不开的人用的，以及下一步做什么。

| 窗口状态 | 用户看到的 |
|----------|------------|
| 正在连接 | 说明是给打不开 TeamClu 的人用的，连上后会有短码 |
| 创建会话失败（网络或 HTTP 错误） | 同上，并说明短码出不来。助手把诊断包写成该文件夹里的 `诊断记录.json`。下一步是打开文件夹，把这个文件发给支持人员。不显示短码。技术详情放在最后一行 |
| `waiting` | 短码。下一步是把短码告诉支持人员，并留在窗口里。点允许之前不上传 |
| `redeemed` | 支持人员显示名，说明对方想查看日志。按钮「允许」和「拒绝」，并写明允许才上传 |
| 上传中 | 正在把日志发给支持人员。下一步是留在窗口里等结论 |
| `concluded` | 结论文本，并说明这是看完日志后的结论。按钮「结束」 |
| `expired` | 短码已过期。下一步是点「重新生成」，把新短码再告诉支持人员 |
| `rejected` / `closed` | 这次支持已结束。下一步是重新打开窗口再要一个短码 |

拒绝调用 close，`reason` 为 `user_rejected`。关掉窗口调用 close，`reason` 为 `user_closed`。

---

## 6. 本地记录

官方构建只认下面这些路径。助手、安装器、桌面进程写同一份 journal。

| 用途 | 路径 |
|------|------|
| 安装与恢复记录 | `%USERPROFILE%\.teamclu\support\journal.jsonl` |
| 白屏重启次数 | `%USERPROFILE%\.teamclu\support\webview-restart-count` |
| daemon 日志 | `%USERPROFILE%\.amuxd\logs\amuxd.log`、`amuxd.managed.log` |
| 桌面日志 | `%APPDATA%\com.teamclu.app\logs\*.log` |

journal 是 UTF-8 JSONL，一行一个对象：`ts`（RFC3339）、`step`、`ok`、`detail`。目录不存在就创建。

安装器在 PREINSTALL 写入的 step：

| step | 何时 |
|------|------|
| `installer_image` | 记下安装器自己的映像名，`ok` 为 true |
| `install_dir` | 记下 `$INSTDIR`，`ok` 为 true |
| `stop_sidecars` | 现有 `taskkill` / `schtasks` 结束后，`detail` 带每条命令的退出码 |
| `wait_writable` | 现有等待主程序可写的循环结束。等到则为 `ok: true`；走到 75 次仍失败则为 `ok: false`，`detail` 为 `ticks=<次数>` |
| `helper_extracted` | 助手已释放到 `$PLUGINSDIR` |

`.onInstFailed` 再写一行 `step` `install_failed`，然后启动助手。

桌面进程在决定重启或拉起助手时各写一行：`webview_restart` 或 `webview_launch_helper`。`detail` 为探测结果（`MissingWindow` 或 `Unresponsive`）。助手读取最后一条此类记录，填进 `snapshot.webviewProbe`。没有记录则为 `null`。

### 6.1 macOS 路径

journal、重启计数、daemon 日志和 Windows 相同（家目录下的 `.teamclu` 与 `.amuxd`）。桌面日志是 `~/Library/Logs/com.teamclu.app/*.log`。

`snapshot.os` 为 `macos`。`osVersion` 来自 `sw_vers -productVersion`。进程名是 `TeamClu` 和 `amuxd`。`webview2` 为系统 WebKit：`present: true`，`version: null`。没有安装器钩子；应用打不开时走单独下载的二进制。

---

## 7. 没有网络时

助手不创建会话，窗口走「创建会话失败」。journal 已经由安装器或桌面进程写在第 6 节的路径。用户把该文件另行发给支持。支持端没有可兑的短码。

---

## 8. 测试

**Cloud API**（`services/fc/test/`）：创建返回短码和 `waiting`；兑码后为 `redeemed` 并带显示名；第二个人兑同一短码得到 `already_redeemed`；`waiting` 时允许被拒绝（`not_redeemed`）；`redeemed` 时上传被拒绝（`not_allowed`）；允许后第一次上传成功，第二次返回 `already_uploaded`；兑码人能读到 bundle；结论写入后助手的轮询能看到文本；`user_rejected` 之后上传被拒绝；创建 15 分钟后，兑码、允许、上传得到 `expired`，助手的 `GET` 得到状态 `expired`。

**助手 crate**：journal 缺 `install_dir` 时目录字段为 `null`；WebView2 键不存在时 `present` 为 `false`；日志文件不存在时 `present` 为 `false`；尾部超过 500 行或 256 KiB 时被截断；短码比较忽略连字符和大小写。macOS 的进程名不带 `.exe`，桌面日志目录是 `~/Library/Logs/com.teamclu.app`。

**桌面**：`recovery_action` 单测覆盖第 3 节的表。`Healthy` 清零计数。macOS 与 Windows 共用这张表。

**Windows 手工**：

1. 主程序拷贝完成前让安装失败，`$PLUGINSDIR` 里的助手能打开，journal 里有失败前的 step。
2. 去掉 WebView2 后启动主程序，自动重启一次，第二次出现助手窗口，不再重启。
3. 开始菜单的「TeamClu 支持助手」能打开（`--phase manual`）。
4. 单独下载的 exe 在未安装 TeamClu 的机器上能打开；缺日志时 bundle 里对应项为 `present: false`。
5. 断网时窗口给出 journal 路径，不出现短码。

---

## 9. 实现顺序

1. OpenAPI、迁移、Cloud API 与 FC 测试。
2. `apps/support-helper`：采集、窗口、上传。
3. NSIS：释放、journal、失败拉起、开始菜单快捷方式。
4. `webview_recovery` 改为最多重启一次并拉起助手。
5. 诊断区兑码、把 bundle 交给现有 agent、提交结论。
6. Windows 发布产物带上 `teamclu-support.exe`。
