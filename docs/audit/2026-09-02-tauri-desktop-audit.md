# Tauri 桌面端全面排查报告（2026-09-02）

只读审计。范围：**Tauri 桌面端**——Rust 后端 `apps/desktop`（32,218 行 / 84 个文件，
含 `tauri.conf.json`、`capabilities/`）与 React 前端 `packages/app`（153,605 行非测试
TS/TSX / 735 个文件，81 个 store 文件共 22,301 行）。按要求不含 iOS、Expo、`services/`
和 amuxd 内部实现；daemon 只在桌面端调用它的边界处出现。

基线 `8de8288d`。方法：五路并行审查（Rust 安全 / Rust 架构与结构 / Rust 性能 /
前端架构与结构 / 前端性能与安全），统一证据规则——没有真实读到的 file:line 不许写成
发现，每路必须交"已核实的非问题"；本文每条头部结论随后都由人工在源码里重读过一遍。
包体数字来自在临时目录跑的两次真实生产构建。

上一次审计是 `2026-08-16-rust-tauri-audit.md`，只审了 Rust；**前端此前从未审过**。
体量基线：8/16 以来本范围 266 次提交，+40.6k / −21.8k 行，17 天。

在线版（含英文版）：
- 中文 https://claude.ai/code/artifact/2ac70f6a-9c33-4d32-9b3d-f81466d74e02
- 英文 https://claude.ai/code/artifact/25d96b55-6cf4-4ba3-bd42-2fab3be9ff1d

---

## 一句话总览

| # | 级别 | 维度 | 结论 |
|---|---|---|---|
| 1 | P0 | 安全 | 13144 回环 API 至今无鉴权，`/mcp-put` = 本地代码执行；8/16 的 S4 原样未动 |
| 2 | P0 | 性能 | 本地缓存逐行自动提交、无 WAL、一把全局锁；打开会话全量回放历史 |
| 3 | P0 | 性能+架构 | 每回合对 opencode 私有库 `LIKE '%id%'` 全表扫；桌面端伸手进 runtime 内部文件 |
| 4 | P0 | 性能 | 50 条同步命令占主线程，依赖检查/skill hash/Spotlight 查询都在上面 |
| 5 | P0 | 架构 | 前端兼容 session store 是 `any` + 索引签名，38 个文件在读，列表存了三份 |
| 6 | P0 | 架构 | CLAUDE.md 流式完成规则"禁止取最长"在三条路径上被违反 |
| 7 | P1 | 安全 | 渲染 LLM 输出的 origin 握有全盘 fs、任意出网、daemon admin；邀请深链无确认；两端 Sentry PII |
| 8 | P1 | 性能 | 启动预加载 97 个文件 3.8 MB JS；364 KB 无用 bridge；聊天栏空闲 1 Hz 重渲染 |
| 9 | P1 | 架构 | 没有 daemon client（12× 发现、12× 交换、4 份 wire 类型）；读 daemon 私有文件；cron 无归属；文档说单 runtime 代码发四个 |
| 10 | P1 | 结构 | ~1,000 行死 Rust + 13 条死命令被 crate 级 allow 压着；494 个死 TS 导出；import 时副作用导致测试顺序敏感；CI 无任何安全扫描 |

**8/16 以来变好的**：内嵌浏览器碰不到 IPC 了（S1 的 IPC 一半）、`webview_eval_js`
已删（S2）、CSP 有了（S3，仍宽松）、introspect 测试目标能编译（H1）、HomeGuard 改成
恢复原值、`amuxd doctor` 加了 3 秒缓存和并发合并、团队记忆里"会话列表永久转圈"的 bug
已用 try/catch 修好。四条安全 P0 关了三条，第四条是上表第 1 行。

---

## 上次审计对账（桌面端条目）

4 已修 · 6 部分 · 7 未修。daemon 条目（D1–D4、A1–A4、A6–A7、H2–H3）不在本次范围，未复查。

| 条目 | 状态 | 今天的证据 |
|---|---|---|
| S1 内嵌浏览器拿全量 IPC + 全盘 fs | 部分 | IPC 半边已修：`capabilities/default.json:6-7` 只列 main/ws-*/local-agent-panel，无 `remote` 块。fs 授权仍是 `/**` + `$HOME/**`；`tauri.conf.json:34` asset scope `/**` |
| S2 `webview_eval_js` 编进 release | 已修 | `apps/desktop` 无任何 `eval_js` 符号 |
| S3 CSP 为空 | 部分 | 已设置，但 `connect-src https: http: ws: wss:`、`img-src http: https:`、`frame-src https:` |
| S4 introspect API :13144 零鉴权 | **未修** | `introspect_api.rs:23-119` 不校验就分发；`lib.rs:576-580` 无 cfg 门控启动。见 SEC-1 |
| A5 错误字符串当 wire 契约 | 未修 | `local_cache/commands.rs:50` 被 `lib/telemetry/local-cache-error-report.ts:37` `includes()`；`ensure-agent-runtime.ts:86` 正则匹配 daemon 文案；**新增** `team_sync_proxy.rs:426` Rust 侧也在 `contains("no OSS team secret")`。0 个错误码，2 个 `thiserror` 枚举 |
| A8 本地缓存单 `Mutex<Connection>`、无 WAL | 未修 | `store.rs:426`；`local_cache/` 零处 `PRAGMA`/`BEGIN`。见 PERF-1 |
| A8 sidecar 生命周期 4 处、无父进程看门狗 | 部分 | `AmuxdSupervisor` 已是唯一 owner；仍无父 PID 看门狗（`kill_on_drop(false)`，daemon 无 `getppid`），孤儿要等下次启动 |
| A8 ~20 条零调用命令 | 部分 | 13 条已注册无调用 + 死文件 `mcp.rs` 里 8 条未注册 |
| A8 `#![allow(dead_code, unused_imports)]` | 未修 | `lib.rs:4` 原样 + `lib.rs:8-38` 30 条 clippy allow；force-warn 30 条告警，且因 `pub mod commands` 导出一切而低估 |
| A8 四套 install/doctor | 部分 | `setup.rs` 已收拢 doctor 和安装器；`deps::check_dependencies` 仍自己探测 |
| H1 introspect 测试目标编不过 | 已修 | 无 `fetch_credential` 残留 |
| H4 `pty.rs` `lock().unwrap()` | 未修 | 13 处 |
| H4 HomeGuard 删 HOME | 已修 | `src/test_home.rs:20-59` 一把锁下恢复原值 |
| H4 `Result<_, String>` | 未修 | 508 个签名 |
| H5 release profile / 重复依赖 / workspace deps | 未修 | `lto = false` 仍归咎 `email.rs`；228 个重复版本（原 262）；桌面 crate 0 处 `workspace = true` |
| H5 doctor 反复 spawn | 已修 | `setup.rs:91-139` 3 秒缓存 + 并发合并；`diagnostics.rs` 不再起进程 |
| H6 文档过期 | 部分 | `teamclu-stt` 已删；`CLAUDE.md:103` 仍写已删的 `team_git.rs`；runtime 段落与代码矛盾（ARCH-7） |

---

## 安全

### SEC-1（P0）127.0.0.1:13144 回环 API 无鉴权，且以用户 bearer 行事

- `apps/desktop/src/commands/introspect_api.rs:23-119`：裸 TCP、手工解析 HTTP、按
  `(method, path)` 分发，不读 `Authorization` 也不读 `Origin`。路由：`/send-wecom`
  `/cron-run` `/team-sync-all` `/env-var-set` `/env-var-delete` `/session-export`
  `/channel-set` `/mcp-get` `/mcp-put` `/session-archive` `/session-participants`。
- `introspect_api.rs:630-660`：`/session-archive`、`/session-participants` 在请求体没带
  token 时退回 `IntrospectAuthState`——当前登录用户 Cloud API token 的内存副本。
  `introspect_auth.rs:1-9` 写明它是出站凭证桥，不是门禁。
- `lib.rs:576-580` 无条件启动，无 `cfg(debug_assertions)`。sidecar 发请求不带凭证
  （`crates/teamclu-introspect/src/mcp.rs:392-394`）。

**场景**：本机任意进程（包括 agent runtime 执行的任何东西）POST `/mcp-put`，写入一条
workspace MCP server 命令，agent 随后拉起它——本地代码执行。`/session-participants`
能以受害者身份把攻击者加进会话。Origin/Content-Type 都不看，网页用 `no-cors` 的
text/plain fetch 同样触发副作用。

**修法**：启动时生成随机 bearer，0600 写到 `amuxd.http.token` 旁边（daemon 已这么做），
sidecar 带上；没带、带 `Origin` 头、`Host` 非回环的一律拒绝。

### SEC-2（P1）渲染 LLM 输出的 origin 同时握有全盘 fs、任意出网和 daemon admin

- `capabilities/default.json`：每条 `fs:allow-*`（读写删改名建目录复制）都带
  `{"path":"/**"}` 和 `$HOME/**`；`shell:allow-open`。文件自己的 description 写着
  "The fs grants below are whole-disk."
- `tauri.conf.json:12,34-35`：`withGlobalTauri: true`，`assetProtocol.scope
  ["$HOME/**","/**"]`，CSP `connect-src https: http: ws: wss:` / `img-src http: https:`。
- `packages/app/src/lib/daemon-local-client.ts:94-105`：JS 读 daemon 根 token 换成含
  `admin` 的会话 token。
- 同一 origin 渲染队友和 agent 的 markdown（`packages/ai/message.tsx`）、agent 生成的
  UI 描述（`lib/dynamic-ui`）、编辑器里的任意文件。

今天没找到 XSS 落点（见非问题），所以是爆炸半径不是漏洞。修法：fs 和 asset 收敛到
workspace 根 + `~/.amuxd` + `~/.agents` + 下载目录；`connect-src` 逐条列举；
`isTauri()` 替代 `withGlobalTauri`；daemon token 交换挪到 Rust 按命令给权限。

### SEC-3（P1）邀请深链无需确认即入队、切换活跃 org、重新 onboard daemon

`App.tsx:1303-1345`：`claimInviteToken(token)` → `enterTeam(claim.teamId)` →
`useDaemonOnboardingStore.getState().refresh()`，无弹窗、不查焦点；未登录时暂存 token
登录后自动认领（`components/auth/AuthGate.tsx:225-251`）；旧 `teamclaw://`、`amux://`
仍接受（`lib/invite-deeplink.ts:6-8`）；随后 `TeamSkillAutoFollow` 每 10 分钟把已装团队
skill 对齐到团队版本。一条链接点一下 = 进攻击者团队 + org 被切 + daemon 被重新 onboard +
团队可推 skill 进受害者 agent 上下文。修法：确认页 + `document.hasFocus()` + 下掉旧 scheme。

### SEC-4（P1）两个进程的 Sentry 都在发默认 PII，console 面包屑未脱敏

`apps/desktop/src/main.rs:9` `send_default_pii: true`（生产），无 `before_send`；
`packages/app/src/main.tsx:44-49` `sendDefaultPii: true`；`lib/console-capture.ts:44,62`
只对本地环形缓冲脱敏，原始参数照样进 Sentry console 面包屑；46 处生产 `console.log`
含本地文件路径。修法：两边 false + `beforeBreadcrumb` 套现成的 `redactLogString`。

### SEC-5（P1）内容可控的链接和图片能到特权落点

- 后台 SSO 注入：`lib/admin-sso-inject.ts:37-64` 对任何 host 等于后台域名的 URL（不看
  路径）把 `access_token`+`refresh_token` 交给子 webview；`hooks/useAppInit.ts:563-585`
  捕获文档里每次 https 链接点击（含 LLM markdown 里的）并以这种 tab 打开。后台域名将来
  出一次 XSS/开放重定向 = 从聊天链接到账号接管。
- 渲染即读本地文件：`packages/ai/message.tsx:194-212` `resolveImagePath` 绝对路径原样
  返回、相对路径不规范化就拼接，然后走全盘授权 `readFile(src)`；远程图片在
  `img-src https: http:` 下立即加载。`![](/Users/me/.ssh/id_rsa)` 渲染即读进 data URL；
  远程图片探针泄露查看者 IP 和阅读时间。

修法：SSO 注入只对明确后台入口打开的 tab、只限登录路径；本地图片限定规范化后的
会话/workspace 目录；远程图片懒加载或经 daemon 代理。

### P2 安全

| 编号 | 发现 | 位置 |
|---|---|---|
| SEC-6 | Windows `cmd /C start {path}` 接受调用方路径；目录名 `x & calc` 点一下就执行 | `commands/mod.rs:276-278,309-311`，`obsidian.rs:322-325` |
| SEC-7 | `window.teamclu` 身份（设备号、显示名/主机名）注入内嵌浏览器每个页面，不限可信域 | `webview.rs build_teamclu_identity_script`，`WebViewContent.tsx:150-168` |
| SEC-8 | `env_var_get` 把解密后的密钥明文返回 webview（渠道配置已经在抹凭证，模式现成） | `env_vars.rs:461-475` |
| SEC-9 | HTML 预览 iframe 正确用了不透明 origin，但继承父 CSP，预览脚本仍可向任意主机发文档 | `FileEditor.tsx:1006-1010` |
| SEC-10 | 终端 cwd 限制根由 webview 自己传，而非 Rust 从已注册 workspace 推导 | `ChatPanel.tsx:1441`，`lib/terminal/client.ts:36-45` |
| SEC-11 | `shell.open` 前无 JS 侧 scheme 白名单；`openExternalUrl` 报错就退回 `window.open` | `lib/utils.ts:36-43` |
| SEC-12 | Web 构建把 access/refresh token 放真实 origin 的 `localStorage`，无 CSP meta；是否部署未核实 | `lib/auth/session-store.ts:17,199-207` |
| SEC-13 | 所有 workflow 无 `cargo audit`/`pnpm audit`/CodeQL；无 `rust-toolchain` 锁定 | `.github/workflows/*` |

---

## 性能

### PERF-1（P0）批量 upsert 是 N 个自动提交事务，跑在 rollback-journal 库和一把全局锁下

- `local_cache/store.rs:820-823` 及另外七个同构函数（session / session_workspace /
  participant / message / idea / claim / submission）：`lock().await` 后逐行
  `conn.execute`，无 `BEGIN`，语句每行重新 prepare。
- `local_cache/` 零处 `PRAGMA`/`journal_mode`/`busy_timeout`/事务。libsql 只在未启用的
  `sync` feature 下开 WAL，于是走 SQLite 默认：rollback journal + `synchronous=FULL`，
  每行两次 fsync。
- libsql 本地连接在等待它的 tokio worker 上同步执行（`libsql-0.9.30/src/local/impls.rs:22-24`），
  同时握着 40 条缓存命令共用的 store 互斥锁。
- 打开会话：`lib/load-session-message-history.ts:96-113` 拉全量历史、全部 upsert、再
  重新加载。同步分页 100 行（会话）/ 500 行（actor）。

500 条消息的会话 ≈ 1000 次 fsync 之后才能开始回读，其间新消息 upsert 和会话列表都在等
同一把锁。**修法**：每批一个事务（`BEGIN IMMEDIATE`…`COMMIT`），prepare 一次逐行
execute，`LocalCacheStore::new` 里跑一次 `PRAGMA journal_mode=WAL; synchronous=NORMAL`；
再改成只 upsert 比本地 `MAX(updated_at)` 新的行。

### PERF-2（P0）每回合结束、每次打开会话，对 opencode `part` 表做无上界 `LIKE '%id%'` 扫描

`store.rs:139-196` 每次调用都打开每个候选 opencode 库，对每个 tool-call id 跑
`SELECT data FROM part WHERE data LIKE '%id%' ORDER BY … LIMIT 8`。调用方：
`message_set_parts`（`store.rs:1360-1368`，每回合结束由 `streaming-persist.ts` 调）、
`message_load_session`（`store.rs:1425-1428`，每次打开会话）、
`local_cache_message_enrich_parts`。门控（`store.rs:68-75`）对任何没抓到输出的 tool call
放行——对 pi / cursor / claude-code 是常态。代价 = tool call 数 × 本机全部 opencode
会话量，随历史无上限增长；对非 opencode runtime 100% 白扫。

**修法**：短期按库文件是否存在、消息 runtime 是否 opencode 门控，`LIKE` 换
`json_extract(data,'$.callID') = ?`；中期 daemon 把完整工具输出持久化进 parts（ARCH-3），
桌面端不再打开 opencode 的库。

### PERF-3（P0）起进程、hash 目录的同步命令跑在主线程

Tauri 把非 `async` 命令直接在 IPC handler 内联执行（macOS 主线程）。桌面端 50 条同步命令，
代价大的几条：

- `deps.rs:345` `check_dependencies` 串行 spawn 六个 `--version`（brew/gh/node/python3/
  opencode/pi），依赖页挂载时调；窗口冻 1–3 秒。
- `team_skills.rs:1116` `team_skill_inspect` 对包内每个文件算 SHA-256；切团队时和每
  10 分钟对所有 slug 循环调用（`stores/team-share-browser.ts:1785-1795`，
  `lib/skills/auto-follow.ts:71`）。
- `obsidian.rs:63` `obsidian_status` 在 Obsidian 不在 `/Applications` 时每次窗口聚焦
  spawn `mdfind`（`hooks/use-obsidian.ts:31-36`）。
- 同类：`read_workspace_directory`、`tail_log_files`、`acp_debug_append_log`。

**修法**：改 `async` + `spawn_blocking`（或 `#[tauri::command(async)]`）；Obsidian 路径
进程级缓存；六个探测并发并按设置页会话缓存。

### P1 性能

| 编号 | 发现 | 位置 |
|---|---|---|
| PERF-4 | **启动 JS**：97 个 modulepreload 共 3.77 MB，主 chunk 1.84 MB（gzip 490 KB）；仅 14 处懒加载边界；设置/teamshare/onboarding/apps/SkillDetail 都在主 chunk；`ChatMessage` 静态引入 `lib/dynamic-ui`，后者 import 时构建 zod schema | `vite.config.ts:219-250`，`ChatMessage.tsx:13-18` |
| PERF-5 | **364 KB 无用 bridge**：两个 MQTT bridge 都静态 import，桌面端永远选不到浏览器版却每次解析（gzip 104 KB） | `lib/mqtt-bridge.ts:2-8` |
| PERF-6 | **空闲 1 Hz + 0.5 Hz 重渲染** `ChatPanel`/`SessionChatColumn`：两个 `useReducer` 计时器喂给返回的 `useMemo` | `hooks/use-engaged-agent-ui-states.ts:366-421` |
| PERF-7 | **文件监听**：递归监听 workspace 根、无忽略规则（`ignore` crate 声明未用），每个变更路径向每个窗口各 emit 一次、5 个 JS 监听者各醒一次；JS 侧任何变更都重新列出根 + 所有已展开目录 | `filewatcher.rs:73-109`，`FileBrowser.tsx:200`，`stores/workspace.ts:876-895` |
| PERF-8 | **PTY 输出**每 4 KiB 一次 emit，载荷是 JSON 数字数组（3–4 倍体积，各一次主线程 eval）；8 MiB 快照重新 attach 时同样这么发；按键已走 raw-body | `terminal/pty.rs:13,128-131`，`commands/terminal.rs:78-86` |
| PERF-9 | `message_load_session` 无 LIMIT、每行内联 `parts_json`；`session_load_team`/`actor_load_team`/`idea_load_team` 同 | `store.rs:1377-1394` |
| PERF-10 | 每次调 daemon 新建 `reqwest::Client`（24 处）；每条团队同步命令重新 `/v1/auth/exchange`（14 条，300 秒 token 从不缓存） | `daemon_http.rs:359-372`，`team_sync_proxy.rs:88-98` |
| PERF-11 | 批量 upsert 前的 N+1 门控查询，每次取放一次全局锁 | `local_cache/commands.rs:243-256,452-466,502-516` |

### P2 性能

| 编号 | 发现 | 位置 |
|---|---|---|
| PERF-12 | 30 处整 store 订阅，`useShallow` 0 次；`keepAliveCheck` 总是 `set()` 所以 `App` 每 30 秒重渲染；未发现返回新对象的 selector，今天没有渲染风暴 | `hooks/useAppInit.ts:376-381`，`stores/channels-store.ts:334-345` |
| PERF-13 | 流式每帧对全文做正则解析和规范化，随回复长度平方增长 | `packages/ai/message.tsx:930-949` |
| PERF-14 | `MessageStatusDot` 让 80 行可见消息各自订阅逐帧 revision 计数器 | `MessageStatusDot.tsx:29-50` |
| PERF-15 | 两套语言包都打包预加载（277 KB，gzip 92 KB） | `lib/i18n.ts:6-25` |
| PERF-16 | 二进制走 JSON `number[]` + 逐字节 `String.fromCharCode` 做 base64（二进制文件、聊天图片、诊断 zip、MQTT publish） | `stores/workspace.ts:215,1005-1011`，`message.tsx:365-367`，`mqtt_bus.rs:98-103` |
| PERF-17 | markdown 编辑器每次 agent 编辑对整篇 `diffChars` | `editors/MarkdownEditor.tsx:215` |
| PERF-18 | 缓存未命中时登录 shell PATH 探测在窗口出现前同步执行（≤4 秒）；daemon 冷启动 `start` 前先 spawn `launchctl` 和 `amuxd stop`，健康检查每 200 ms 新建 HTTP client | `lib.rs:266-274`，`amuxd_supervisor.rs:717-757` |
| PERF-19 | 整包 `shiki` import + 显式 16 语言列表，构建仍吐约 450 个语法 chunk（~10 MB 包体） | `diff/shiki-renderer.ts:28-43` |
| PERF-20 | `lto = false`、`codegen-units = 16`、`opt-level = "s"`；libsql 默认 feature 链进 tonic/hyper 0.14/tower 0.4；两套 TLS、两个 hyper 大版本 | `Cargo.toml:14-21`，`Cargo.lock` |

---

## 架构

### ARCH-1（P0）聊天界面读的是 `any` 类型的兼容 store；会话列表活在三个 store 里

`stores/session-store.ts:28` `type Compat = any`；`:60`
`SessionState = V2Native & CompatExplicit & { [key: string]: Compat }`，任何不认识的属性都能
编译。三个模块级 `subscribe()`（`:260-327`）把 v2 的列表/选中项/消息镜像进去。38 个非测试
文件在读；`ChatPanel.tsx:121-130` 选了 12 个兼容字段。`sessionDiff`、`todos` 的每处写入都是
`[]`，所以 `App.tsx:641` 和 RightPanel 的 Diff 页签永远为空。`AGENTS.md:381` 已列为欠账；
`tsconfig.json:22-25` 因它关着 `noUnusedLocals`。

**修法**：删索引签名让 `tsc` 列出真消费方；ChatPanel 12 个 selector 迁到 v2 store；删永远
为空的字段和 Diff 页签；重开 `noUnusedLocals`。

### ARCH-2（P0）流式完成规则在三条路径上被违反，v1 store 仍接着线

CLAUDE.md："Never use longest content strategy on completion."
`lib/agent-reply-text.ts:7-12` `pickCanonicalAgentReplyText` 返回较长者。完成路径调用方：
`stores/v2-stream-parts.ts:392`（finalize）、`lib/agent-reply-transcript.ts:198-213,272`
（`deriveAgentReplyContent`，同时生成 `streaming-persist.ts` 的持久化 content 和
`live-agent-stream.ts` 的实时气泡）。`v2-streaming-store.ts:65` 用同一个 `outputText` 装
delta 和最终内容；`docs/architecture/v2.md:848` 说"必须做"的物理分离从未落地。
`ChatMessage.tsx:157-181` 仍订阅 v1 store，但 `setStreaming` 零调用方，分支已死。

代码里的理由（QoS0 可能丢工具调用后的 delta，daemon 最终内容带尾巴）成立，但它住在三处、
没有单一权威、类型层面拦不住第四处。**修法**：拍板一次——要么把 `deriveAgentReplyContent`
定为唯一对账点并让 finalize 调它并写进 CLAUDE.md，要么 daemon 最终内容存在时以它为准；
删 v1 分支和 v1 store。

### P1 架构

| 编号 | 发现 | 位置 |
|---|---|---|
| ARCH-3 | **桌面端打开 opencode 私有库**；`opencode_paths.rs` 只为此存在；另三个 runtime 从不写它；与 PERF-2 同根 | `store.rs:18-228`，`opencode_paths.rs` |
| ARCH-4 | **没有 daemon client**：端口/token 发现 12 处、`/v1/auth/exchange` 12 处、`daemon_http.rs` 一个文件 10 个 `reqwest::Client`，自己的 helper 在五个函数里没用；wire 类型手写四份（桌面 Rust / daemon Rust / `daemon-local-client.ts` / 无人引用的 OpenAPI）；`teamclu-types` 只导出 `mqtt` 和 `skill_frontmatter`；解码失败变 `Ok(vec![])` | `daemon_http.rs:146-204,404,624-630`，`apps/daemon/src/http/workspaces.rs:1460` |
| ARCH-5 | **读 daemon 私有状态、往 `~/.amuxd` 写**，违反 layout-v2 第一条：为 `/v1/setup/status` 已返回的 `actor_id` 去解析含 refresh token 的 `backend.toml`；手工遍历 `team.toml`；`create_dir_all` 团队 workspace 目录 | `daemon_http.rs:114-133`，`gateway/mod.rs:108-176`，`team.rs:42-53` |
| ARCH-6 | **cron 无归属**：3,535 行调度器跑在桌面进程；daemon 只执行回合，无头 daemon 没有 cron；引用的 spec 不存在；`config_dir()/<brand>/cron-global` 不在任何 layout 文档；introspect crate 还有第三个 cron 面 | `commands/cron/`，`cron/amuxd_client.rs:10` |
| ARCH-7 | **文档与代码矛盾**：CLAUDE.md 说单 opencode、ACP 已移除；`setup.rs` 发四个 runtime，`tauri.conf.json` 打包 daemon 会用的 cursor/claude bridge；`CLAUDE.md:103` 写已删的 `team_git.rs`；AGENTS.md 仍称 supabase 后端"已弃用"、说列表无 `loadMore`；两处引用不存在的 `lib/supabase-client.ts`；桌面 cron/终端/local_cache/introspect API 无任何文档 | `setup.rs:258-263`，`tauri.conf.json:88-91`，`AGENTS.md:325,371` |
| ARCH-8 | **前端四层 client**（Cloud API provider、1,776 行 43 个自有类型的 `daemon-local-client.ts`、MQTT RPC、local-cache 封装）+ 44 条命令直接从组件调用 + 16 条命令两处封装两套签名；`zod` 只校验一个文件 | `lib/daemon-local-client.ts`，`lib/backend/cloud-api/http.ts:66` |
| ARCH-9 | **18 个 store 依赖环**靠 `getState()` 和 19 个文件 85 个动态 `import('@/stores/…')` 撑着；`ui.ts` 嵌套三层动态 import 重置 `lib/reset-client-chat-state.ts` 已会重置的状态；81 个 store 32 个做 IPC/网络；`team-share-browser.ts` 2,192 行 42 个 action | `stores/ui.ts:271-277`，`stores/workspace.ts` |
| ARCH-10 | **旧聊天管线仍编译且部分可达**：outbox 之前的发送路径（无重试无幂等）从文件编辑器"问 agent"可达；`SessionList.tsx` 只在类型里已不存在的页签值后渲染；`session-internals.ts` 的死调用方跑起来会抛 | `FileEditor.tsx:960`，`stores/session-messages.ts:207-262`，`panel/RightPanel.tsx:51` |
| ARCH-11 | **多窗口无同步层**：每窗口自己的 store 图和 `MqttLiveWiring`；跨窗口只有 Rust 广播 emit 和一个 auth `BroadcastChannel`；33 处 `localStorage.setItem` 和 6 个 `persist()` store 后写者赢 | `window.rs:99,177`，`App.tsx:1002` |

---

## 代码结构

### P1 结构

| 编号 | 发现 | 位置 |
|---|---|---|
| STR-1 | **死代码被 allow 压着**。Rust：`mcp.rs`（755 行，自注释"Deprecated"）、`team_unified.rs`+`team_types.rs`、`trash.rs`；13 条已注册无调用命令（`create_workspace_window` `unwatch_all` `get_watched_directories` `daemon_stop_managed` `daemon_supervisor_status` `clawhub_check_updates` `team_skill_pack` `workspace_read_team_meta` `personal_env_diagnostics` `env_var_resolve` `session_export` `local_cache_get_current_team` `webview_focus`）；force-warn 16 个死项 + 14 个未用 import。前端：494 个导出无活引用（261 个哪里都没引用，233 个仅测试），含 `tool-call-utils.ts` 17 个 helper 和三个无生产订阅者的 store hook | `lib.rs:4-38`，`commands/mcp.rs:72` |
| STR-2 | **巨型文件**：`MqttLiveWiring.tsx` 1,707 行、一个 `useEffect` 从 522 到 1624 行；`App.tsx` 1,447 行 25 个 effect、7/15 以来 71 次提交；`ChatPanel.tsx` 1,454；`FileTree.tsx` 1,730 行 34 个 `useCallback`；`SkillDetail.tsx` 2,245 行内含八个私有组件。Rust：`store.rs` 2,683、`team_skills.rs` 2,516、`env_vars.rs` 1,516 | `MqttLiveWiring.tsx:522-1624` |
| STR-3 | **import 时副作用是测试顺序敏感的根子**：5 个 store 模块级 `subscribe()`、6 个 `persist()`、8 个 lib 模块 import 时执行 `window` 块、187 个模块级 `let`、113 个模块级 Map/Set、生产导出 35 个 `*ForTests` 重置函数，`vitest-setup.ts` 一个都不重置 | `stores/session-store.ts:260-327`，`src/test/vitest-setup.ts` |
| STR-4 | **错误是字符串，字符串就是契约**：508 个 `Result<_, String>`、2 个 `thiserror`、0 个错误码；跨边界子串匹配五处，含 Rust 匹配 daemon 文案、JS 匹配 Rust 文案 | `local_cache/commands.rs:50`，`team_sync_proxy.rs:426` |
| STR-5 | **daemon 边界零测试**：`introspect_api.rs`（943）、`team_sync_proxy.rs`（751）、`daemon_http.rs`（711）、`local_cache/commands.rs`（611）、`skillssh.rs`（478）一个测试没有；`updater.rs` 4、`clawhub.rs` 1；`wiremock` 声明未用。CI 只 `cargo test --lib`，Windows 只 `cargo check` | `.github/workflows/ci.yml:141-154` |
| STR-6 | **密钥/环境变量五个模块、3,208 行、四把互斥锁管一份状态**，三层调用链 + 字符串前缀式错误协议；旧 `_secrets` 路径还在读 | `shared_secrets.rs:46-54`，`team_secret_store.rs:26-51` |

### P2 结构

| 编号 | 发现 | 位置 |
|---|---|---|
| STR-7 | Cargo 卫生：`unused_crate_dependencies` 报 16 个未用 crate（`tokio-tungstenite`+native-tls、`jsonwebtoken`、`arboard`、`ignore`、`hkdf`、`hmac`、`futures`、`futures-lite`、`filetime`、`getrandom`、`hex`、`prost`、`prost-types`、`rustls`（可能是刻意的 ring 锁定，删前核实）、`tokio-util`、`tower-http`）；`axum` 和 8,131 行 vendor 的 `tauri-plugin-mcp` 为 debug 用途编进 release；两套 ObjC 桥；228 个重复版本 | `apps/desktop/Cargo.toml` |
| STR-8 | 两个 Cloud API client（异步 `oss_sync/fc_client.rs` vs `team_skills.rs:35-45` 阻塞镜像）；26 处临时 `reqwest::Client` 各写各的超时 | `team_skills.rs:35-45` |
| STR-9 | 日志绕过管线：72 `eprintln!` + 45 `println!` vs 36 `log`/`tracing`；supervisor 失败到不了日志文件和诊断包 | `amuxd_supervisor.rs:534-847` |
| STR-10 | `introspect_api.rs` 手搓裸 TCP HTTP server 重新实现命令逻辑（`handle_env_var_set` 与 `env_catalog_set` 平行）；sidecar 里第三个控制 socket client | `introspect_api.rs:306-386` |
| STR-11 | 扁平 `lib/` 顶层 201 个文件；命名撞车（`session-messages.ts`/`session-message-store.ts`，`session.ts`/`session-store.ts`，`channels.ts`/`channels-store.ts`）；`hooks/` 混 kebab/camel；`useAppInit.ts` 导出 10 个不相干 hook | `packages/app/src/lib` |
| STR-12 | 19 个文件 350 行硬编码中文在 `t()` 之外；会进 toast 的在 `apps-store.ts`、`team-share-browser.ts`；parity 测试本身是真守卫 | `stores/apps-store.ts:116` |
| STR-13 | vendor 的 AI-elements 组件包（`src/packages/ai` 3,524 行）大改却无来源说明；六个 `MessageBranch*` 导出无人用 | `packages/ai/` |
| STR-14 | 品牌显示名两个来源（`build.rs` `APP_DISPLAY_NAME` vs `branding::brand_name(product_name)`）；存储命名空间倒是正确单一来源 | `build.rs:151-167` |

---

## 建议动手顺序

1. **安全 PR（小，无需设计）**：13144 加 bearer + Origin 校验（SEC-1）；`main.rs` 与
   `main.tsx` 的 `send_default_pii` 改 false + 脱敏 `beforeBreadcrumb`（SEC-4）；邀请深链
   确认页 + 下掉旧 scheme（SEC-3）。随后修 `cmd /C`，SSO 注入限定明确入口。
2. **本地缓存 PR**：每批一个事务、prepare 复用、WAL + `synchronous=NORMAL`（PERF-1）；
   opencode enrichment 按 runtime/库文件门控，`LIKE` 换 `json_extract`（PERF-2）；增量 upsert
   + `message_load_session` 加 LIMIT（PERF-9）。顺手给 `local_cache/commands.rs` 写第一批测试。
3. **主线程 PR**：IO 同步命令改 async + `spawn_blocking`，Obsidian 路径缓存，依赖探测并发
   （PERF-3）；去掉空闲 1 Hz 计时器（PERF-6）；只重列变更目录、监听路径过 `ignore`（PERF-7）。
4. **启动 PR**：浏览器 MQTT bridge 动态 import，设置/teamshare/onboarding/apps 子树和
   dynamic-ui catalog 懒加载，第二套语言包懒加载（PERF-4/5/15）；CI 加包体预算。
5. **死代码 PR**：删 `mcp.rs`、`team_unified.rs`、`team_types.rs`、`trash.rs` 和 13 条死命令；
   `lib.rs:4` 收窄到条目级 allow；去掉未用 crate，`libsql default-features = false`
   （STR-1/7）；前端 `knip` 报告模式进 CI，先删 261 个无引用导出。
6. **退役兼容 shim**：删 `any` 索引签名，迁 ChatPanel selector，去掉空 Diff 页签，文件编辑器
   "问 agent"改走 outbox，然后删 `SessionList.tsx`、`session-messages.ts`、
   `session-loader.ts`、`session-internals.ts`、`streaming.ts`（ARCH-1/2/10）；重开 `noUnusedLocals`。
7. **一个 daemon client**：Rust 侧一个 `DaemonClient`、共用 `reqwest::Client`、缓存带 scope
   的 token、请求/响应结构体进两边共编的 `teamclu-types`；`/v1/setup/status` 替换
   `read_daemon_actor_id`（ARCH-4/5，PERF-10）。TS 侧 lint 把 `@tauri-apps/api/core`
   限制在 `lib/`，收拢 16 条双重封装命令（ARCH-8）。
8. **要落成 ADR 的决定**：cron 归谁（ARCH-6）；agent 回复文本唯一对账点（ARCH-2）；产品真正
   需要的 fs/asset 范围（SEC-2）；窗口局部 vs 设备共享状态（ARCH-11）；稳定 IPC 错误码形状
   （STR-4）。然后对照代码修 CLAUDE.md / AGENTS.md（ARCH-7）。
9. **CI 守卫**：`cargo audit` + `pnpm audit`、`rust-toolchain.toml`、
   `cargo test --all-targets --no-run`、`vitest-setup.ts` 统一测试重置注册表（STR-3/5，SEC-13）。

---

## 审计中顺手核实的非问题（避免后人重查）

**安全**

- 更新器：每个平台路径都在安装前做 minisign 校验，无未签名回退，公钥编译期固定，端点只有
  GitHub HTTPS 或构建期注入；Windows `ShellExecuteW` 参数是固定 NSIS 标志。
- zip 解压：`crates/teamclu-skillpack/src/zip_path.rs:22-29` `sanitize_zip_path` 拒绝绝对
  路径/`..`/目录项/反斜杠，`skillssh.rs:20-28` 同；符号链接条目按普通文件写出；只 OR 可执行位。
- debug 专用面：axum E2E server（:13199）和 tauri-mcp 插件都在 `cfg(debug_assertions)`
  后面（`lib.rs:322-334,761`）；release 插件是空操作。
- 本地密钥库：32 字节随机主密钥 `O_EXCL` 0600 创建，AES-256-GCM 每次写新随机 nonce，原子
  写入，解不开的 blob 隔离不删。
- OAuth 回环：127.0.0.1:0，静态页不反射查询参数，300 秒超时，并发启动中止前一个。
- workspace 文件读取规范化后限定 workspace 内、25 MiB 上限、不在主线程；`terminal_open`
  把 cwd 限定给定根内、不接受命令字符串。
- Entitlements 只有 audio-input。`jsonwebtoken` 未使用，token 只转发服务端校验；`daemon_rpc`
  换 `sessions:write` token，daemon 授权。
- 今天没有 XSS 落点：三处 `dangerouslySetInnerHTML` 吃 Shiki 输出或 `securityLevel: 'strict'`
  的 Mermaid SVG；react-markdown 未开 `rehype-raw`，原始 HTML 丢弃，`javascript:`/`file:`/
  `asset:` 被中和；生产无 `eval`/`new Function`；无 `postMessage` 处理器。
- 动态 UI 注册表只暴露有类型组件，无 `href`/处理器字符串/原始 HTML，只接 `submit`、`setData`。
- 源码无硬编码凭证（只有公开 Sentry DSN 和更新器公钥）；token 不进日志；诊断包脱敏
  bearer/JWT。

**性能**

- 流式传输已合批：delta buffer 按 rAF 合并，revision flush 合并，流式中跳过 Shiki/Mermaid，
  `ChatMessage` 已 memo，MQTT 入站 8 ms 窗口 base64 合批，Tauri `emit` 跳过无监听者的 webview。
- 虚拟化是真的：消息列表 >80 行、会话列表 >40、文件树 >200。
- 重依赖懒加载：mermaid、shiki、CodeMirror 语言包、xterm、pdfjs、Sentry、按图标切分的 lucide。
  23 处 Tauri `listen` 清理时都 unlisten。
- Rust 并发：无跨 `.await` 持有 std 互斥锁（CI `await_holding_lock` 过），`reqwest::blocking`
  只在 `spawn_blocking` 里，PTY 环形缓冲有上限且关闭释放，最后订阅者离开时 watcher drop，
  supervisor 无周期健康轮询。

**结构**

- `SessionListColumn` 与 `TeamShareListColumn` 只共享 3 个标识符，不是复制粘贴。
- MQTT bridge 三件套是刻意的平台分叉；`v2-` 前缀是历史遗留，无运行时开关选到 v1。
- `acp_debug_log.rs` 仍有前端调用方；cursor/claude bridge 是 daemon 在用的（过期的是
  CLAUDE.md 不是代码）；存储命名空间单一来源（`build.rs:160-167`）。
- 团队记忆里"loadFirstPage 两个 await 没 try/catch 永久转圈"已修
  （`session-list-store.ts:396-425`）。

---

## 指标与方法

| 指标 | 值 | 方法 |
|---|---|---|
| 同步 Tauri 命令 | 50 / 218 | `grep -A1 '#[tauri::command' \| grep 'pub fn'` |
| 死的已注册命令 | 13 | 逐名搜 app/tests/mcp 插件；已考虑 `${name}_versions` 动态拼接 |
| `Result<_, String>` / thiserror | 508 / 2 | grep `apps/desktop/src` |
| 端口读取处 / token 交换处 | 12 / 12 | `grep 'amuxd.http.port'`，`grep '/v1/auth/exchange'` |
| force-warn dead_code + unused_imports | 30 | `node scripts/rust-cli.js clippy --manifest-path apps/desktop/Cargo.toml -- --force-warn dead_code --force-warn unused_imports` |
| 未用 extern crate | 16 | 同上 `--force-warn unused_crate_dependencies` |
| 启动预加载 / 主 chunk | 97 个文件 3,774 KB / 1,884 KB（gzip 490 KB） | `npx vite build --outDir <scratch>`，从 `index.html` 取 modulepreload 列表 |
| 懒加载边界 / useShallow / 整 store 订阅 | 14 / 0 / 30 | grep `packages/app/src`，排除测试 |
| store 数 / 同一 getState 环 / 动态 store import | 81 / 18 / 85 | store 依赖图脚本（import ∪ getState 边，SCC） |
| 无引用导出（从未 / 仅测试） | 494（261 / 233） | 全词搜索 app/tests/expo/scripts/desktop |
| 兼容 session store 消费文件 | 38 | `grep -rl useSessionStore`，排除测试 |
| 模块级 subscribe / persist / `*ForTests` | 5 / 6 / 35 | grep `stores`、`lib` |
| `cargo tree -d` 重复 | 228 | `cargo tree -p teamclu --manifest-path apps/desktop/Cargo.toml -d` |
| 8/16 以来变更 | 266 提交，+40,636 / −21,763 | `git diff --shortstat <8/16 main> HEAD -- apps/desktop/src packages/app/src` |
