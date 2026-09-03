# 桌面端审计（2026-09-02）——待拍板的五个决定

配套 `2026-09-02-tauri-desktop-audit.md`「建议动手顺序」第 8 条。审计里有五条 P0/P1
不是改代码就能关的：它们各自要先定一个方向，代码才知道往哪改。本文把每条的现状、
可选项和建议写清楚，**只提建议，不替产品拍板**。每条末尾注明本分支（`fix/audit-2026-09-p0-p1`）
在不预设方向的前提下已经做了什么、什么在等这个决定。

定下来之后，每条各落一份 `docs/adr/00xx-*.md`（格式照 ADR-0007），本文即可删除。

---

## D1 · SEC-2 —— webview 到底需要多大的 fs / asset / 出网范围

**现状**：`capabilities/default.json` 每条 `fs:allow-*` 都带 `$HOME/**` 和 `/**`；
`tauri.conf.json` `assetProtocol.scope` 同样是 `["$HOME/**","/**"]`；CSP
`connect-src https: http: ws: wss:`；`withGlobalTauri: true`。前端 42 个非测试文件直接调
`@tauri-apps/plugin-fs`。渲染 LLM 输出、队友 markdown、agent 生成 UI 的是同一个 origin。
今天没有 XSS 落点（审计已核实），所以这是爆炸半径，不是漏洞。

**选项**

| | 方案 | 代价 | 收益 |
|---|---|---|---|
| a | 维持全盘 | 0 | 0 |
| b | 收敛到「已注册 workspace 根 + `~/.amuxd` + `~/.agents` + 下载目录」，用 `tauri-plugin-fs` 的运行时 scope（`FsExt::scope().allow_directory`）在用户新增 workspace 时动态放行；`dialog` 插件选中的路径 Tauri 会自动加进 scope，所以「打开任意文件」流程不受影响 | 要逐个过 42 个文件的路径来源；Obsidian vault、skill 目录等 workspace 外路径需要显式登记 | webview 被攻破时读不到 `~/.ssh`、不能改任意文件 |
| c | 所有 fs 访问下沉到 Rust 命令并按命令校验（`workspace_files.rs` 已是这个模式） | 42 个文件全改，工程量最大 | 权限判断集中在一处，前端零 fs 能力 |

**建议**：b 现在做，c 作为长期方向对新代码强制。另外两件不需要产品决定、可以直接做的：
`connect-src` 逐条列举（`build.config.*.json` 里的 API/MQTT/Supabase 域名 + `http://127.0.0.1:*`
给 daemon）；`withGlobalTauri` 改为 `isTauri()` 判断（需先确认没有依赖 `window.__TAURI__` 的
注入脚本，`webview.rs` 的身份注入脚本是一个）。

**本分支**：未动 capabilities / CSP / asset scope（等 D1）。已做的相邻项：SEC-5 agent 渲染的
本地图片限定到规范化后的会话目录（用户自己的附件仍走原来的宽松解析）、远程图片懒加载且不带
referrer、后台 SSO 注入只对显式入口 `openAdminConsoleTab()` 打开的登录路径生效（产品里目前
没有这样的入口，所以注入实际处于休眠）；SEC-11 外链只放行 http(s)/mailto。

---

## D2 · ARCH-6 —— 定时任务归谁

**现状**：调度器在桌面进程（`apps/desktop/src/commands/cron/`，3,535 行，6 个文件），daemon
只执行回合（`routes.rs:119-127` 里的两条路由注释明说是为桌面 cron 服务的）；无头运行的
daemon（gateway 场景）没有 cron；`cron/amuxd_client.rs:10` 引用的 spec 文件不存在；
`config_dir()/<brand>/cron-global` 不在任何 layout 文档里；`teamclu-introspect` 里还有第三个
cron 面（`/cron-run`）。团队记忆里另有一条：cron 触发的 agent 必须默认 full access，因为无人值守。

**选项**

| | 方案 | 后果 |
|---|---|---|
| a | 桌面端继续持有 | 关了 app 就不跑；三个 cron 面继续并存；无头 daemon 永远没有定时能力 |
| b | daemon 持有调度器（存储进 `~/.amuxd/teams/<id>/`，按 layout-v2 归 team），桌面端只做 UI + 调 daemon API | 要把 3,535 行搬家并写那份缺失的 spec；换来 gateway/无头场景也能跑、cron 存储进 layout、桌面端删掉一个子系统 |
| c | 云端调度（Cloud API 定时触发 daemon） | 依赖网络；离线场景丢掉；但多设备只跑一次的语义最自然 |

**建议**：b。理由是 cron 的用户价值恰恰在「人不在的时候跑」，而人不在的时候桌面 app 大概率
也不在。c 留作 b 之上的可选层（多设备去重）。

**本分支**：未动。等 D2 之前，只修了 ARCH-7 文档：把桌面 cron 的存在、存储位置、与 daemon
的边界写进架构文档，让它至少不再是没有文档的子系统。

---

## D3 · ARCH-2 —— agent 回复文本以谁为准

**现状**：CLAUDE.md 写「完成阶段禁止取最长」，但 `pickCanonicalAgentReplyText` 恰恰是
「等价则取较长」，且从三条完成路径被调：`v2-stream-parts.ts:392`（finalize）、
`agent-reply-transcript.ts:198-213`（`deriveAgentReplyContent`，同时喂持久化和实时气泡）、
`agent-reply-transcript.ts:272`。代码里的理由成立——MQTT QoS0 可能丢工具调用之后的 delta，
daemon 的最终内容有时带尾巴——但它住在三处、没有单一权威、类型层面拦不住第四处。

**选项**

| | 方案 | 前提 | 风险 |
|---|---|---|---|
| a | 拍板 `deriveAgentReplyContent` 为**唯一**对账点：finalize 改为调它，`pickCanonicalAgentReplyText` 只允许它 import（lint/测试守住），CLAUDE.md 把这条例外写明 | 无 | 行为不变，只是收口；「取最长」仍然存在，只是有了唯一出处和书面理由 |
| b | daemon 最终内容存在时**一律以它为准**，delta 拼接只在 daemon 内容缺席时兜底 | 先在 daemon 侧证实：最终内容是否完整覆盖工具调用后的文本、「尾巴」是什么、能否在 daemon 侧去掉 | 若 daemon 内容确有缺失，用户会看到回复被截断 |

**建议**：a 现在做（本分支已做），同时开一个 daemon 侧的核实任务；核实通过后切 b，
此时 `pickCanonicalAgentReplyText` 整个删除。

**本分支**：按 a 收口——`pickCanonicalAgentReplyText` 只剩 `agent-reply-transcript.ts` 一个
importer，它导出 `reconcileEquivalentAgentReplyText` 给 `v2-stream-parts.ts` 的 finalize 路径用，
一个守卫测试扫 `src` 防止第四处出现；v1 `streaming.ts` store 整个删除（`setStreaming` 零调用方，
所有读者看到的都是空值，已按它们实际走的分支简化）；CLAUDE.md 流式规则段补上这条例外的出处。
**没做**：`v2-streaming-store.ts` 里 delta 与最终内容共用 `outputText` 的物理分离——16 处调用点
散在 1,869 行的 store 里，不是一个可收口的改动，留给切 b 时一起做。

---

## D4 · ARCH-11 —— 多窗口时，哪些状态是「设备共享」的

**现状**：每个窗口一套 store 图和 `MqttLiveWiring`；跨窗口只有 Rust 广播 emit 和一个 auth
`BroadcastChannel`；6 个 `persist()` store（`automation-default-model`、
`offline-send-preference-store`、`agent-model-pick-store`、`header-preferences-store`、
`agent-default-workspace-store`、`client-model-mru`）和 33 处 `localStorage.setItem` 都是
后写者赢。今天没有用户报告，因为多窗口用得少。

**选项**

| | 方案 | 说明 |
|---|---|---|
| a | 明文规定：**除 auth 外一切状态窗口局部**，persist 的 6 个是「偏好」允许后写者赢；写进 AGENTS.md | 零代码；把隐含约定变成显式约定 |
| b | 把必须设备一致的状态（候选：当前团队、agent 默认 workspace、模型 MRU）挪到 Rust 持有、以 emit 广播变更 | 每挪一个都是一次小重构；换来多窗口一致 |
| c | 给每个 persist store 加 `BroadcastChannel` 同步 | 简单但只解决 6 个 store，33 处裸 localStorage 仍然各写各的 |

**建议**：a 立刻做（先把规则写下来），然后**逐个**评估 6 个 persist store 里哪几个真的需要
设备一致，只对那几个做 b。不做 c。

**本分支**：未动代码。

---

## D5 · STR-4 —— IPC 错误的稳定形状

**现状**：508 个 `Result<_, String>`，3 个 `thiserror` 枚举（`terminal/registry.rs`、
`oss_sync/error.rs`、`oss_sync/path_validator.rs`），0 个错误码。跨边界靠子串匹配的有五处，
含 Rust 匹配 daemon 文案（`team_sync_proxy.rs:426` `contains("no OSS team secret")`）和 JS 匹配
Rust 文案（`local-cache-error-report.ts:37`、`ensure-agent-runtime.ts:86`）。文案一改，分支就静默失效。

**选项**

| | 方案 | 说明 |
|---|---|---|
| a | 引入 `CommandError { code: &'static str, message: String, details?: Value }`，`impl Serialize` + `impl From<String>`（code = `"unknown"`）让 508 处可以**渐进**迁移；前端 `invoke` 封装统一解析 | 一次性引入，逐命令换码；先换五个被子串匹配的 |
| b | 维持字符串，约定稳定前缀（`E_NO_TEAM_SECRET: ...`） | 便宜，但前缀就是新的子串匹配，没有解决问题 |

**建议**：a。第一批：`local_cache/commands.rs:50` 及其 JS 消费方、`ensure-agent-runtime.ts:86`
对应的 Rust 端。`team_sync_proxy.rs:426` 匹配的是 daemon 文案，要 daemon 先给错误码，
属于 daemon 边界的后续任务。

**本分支**：未动（等 D5 定形状）。

---

## 本分支已关闭的条目

`2026-09-02-tauri-desktop-audit.md` 是那天的只读记录，不改；这里记这条分支实际关掉了哪些，
免得下次有人对着报告重查。带「部分」的是有意留了残余，残余写在下一节。

**安全**：SEC-1（13144 加 bearer + Origin/Host 门）、SEC-3、SEC-4、SEC-5、SEC-6、SEC-7、
SEC-8、SEC-10、SEC-11、SEC-13；
SEC-9（HTML 预览注入自己的 CSP，只封 connect-src / form-action / base-uri / object-src；
`img` 型信标是刻意留下的残余，收紧它会让所有带远程图片的预览失效）；
SEC-12（先核实：`VITE_APP_PLATFORM=web` 只有 MV3 侧边栏一个消费方，没有任何托管部署——
审计里那句「是否部署未核实」的答案是「不是网站」；非 Tauri 构建现在自带 CSP meta）。
**SEC-2 未动**（等 D1）。

**性能**：PERF-1、PERF-2、PERF-3、PERF-4、PERF-5、PERF-6、PERF-7、PERF-8、PERF-9、PERF-10、
PERF-11；
PERF-12（28 处整 store 订阅换 `useShallow`；`keepAliveCheck` 不再无条件 `set()`）；
PERF-13（流式尾巴不再做整文规范化与图片扫描；`splitStableBlocks` 的围栏计数从二次改成线性）；
PERF-14；PERF-15；
PERF-16（一份 `lib/base64.ts`；`read_workspace_binary_file` 与 `mqtt_publish` 两个 IPC 边界
改走 base64 而不是 JSON 数字数组）；
PERF-17（`diffAgentEdit` 先剪掉公共前后缀再 diff，dispatch 也只改动那一段，光标不再被扔到开头）；
PERF-18（登录 shell 探测挪到后台线程、与建窗口并行，在 `setup` 顶部收；预算刻意没缩——
缩了会让 profile 稍慢的用户整场跑在兜底 PATH 上，看起来就是「opencode 没装」）；
PERF-19（`shiki/core` 细粒度打包 + 按需装语法：924 → 559 个 chunk，24 MB → 15 MB）；
PERF-20（thin LTO；libsql 去默认 feature，`Cargo.lock` −360 行，tonic / tonic-web /
tower-http / hyper 0.14 / hyper-rustls 一起消失。两个 crate 都得写 `default-features = false`，
resolver 2 会把 feature 并起来）。

**架构**：ARCH-2（按 D3-a 收口）、ARCH-4、ARCH-7、ARCH-10；ARCH-1 与 ARCH-5 部分。
**ARCH-3 / ARCH-6 / ARCH-8 / ARCH-9 / ARCH-11 未动**（分别等 daemon 侧、D2、D4）。

**结构**：STR-1、STR-7；
STR-5（`introspect_api.rs` 与 `team_sync_proxy.rs` 补上第一批测试，CI 加了
`--all-targets --no-run`）；
STR-8（一份 `http_clients.rs`：两个 Cloud API client 合流，客户端只建一次而不是每次调用一个
连接池）；
STR-9（`println!`/`eprintln!` 全部换成 `log::`，只剩 `lib.rs` 里日志插件装好之前的 6 处——
那几处用 `log::` 会直接丢掉）；
STR-10（introspect API 从手搓 TCP + 手写 HTTP 解析换成 axum；网关中间件用 `layer` 而不是
`route_layer`，所以 fallback 也在门后，没带 bearer 的调用方无法用 404 与 401 的差别探路）；
STR-11（点名的三处）；STR-12（会进 toast 的两处）；STR-13（vendor 的 `src/packages/ai`
补来源说明）；STR-14（品牌显示名单一来源 `APP_DISPLAY_NAME`）。
**STR-2 / STR-3 / STR-6 未动**，STR-4 等 D5。

---

## 本分支刻意没碰的 P1

这些不是「等决定」，而是体量超出一个分支、或与上面某个决定强耦合：

- **STR-2 巨型文件**：已在 `refactor/split-giant-files` 上拆掉六个——`store.rs` 3,198 → 13 个
  文件、`team_skills.rs` 2,618 → 10 个、`env_vars.rs` 1,380 → 7 个、`SkillDetail.tsx` 2,245 →
  1,221 + 10 个、`App.tsx` 1,476 → 909 + 4 个、`FileTree.tsx` 1,738 → 1,320 + 3 个。**剩下的是
  真的要先设计**：`MqttLiveWiring.tsx`（1,705 行，其中一个 `useEffect` 1,100 行，闭包握着 12 个
  ref 和整条流式对账链）、`v2-streaming-store.ts`（1,869，等 D3 切 b 时一起做）、
  `team-share-browser.ts`（2,194，42 个 action 的 store 切片属于 ARCH-9）、
  `daemon-local-client.ts`（1,772，属于 ARCH-8）。这四个单独拆只会把环搬到别处。
- **STR-6 密钥/环境变量五模块四把锁**：和 D5 的错误形状、以及 `_secrets` 旧路径退役绑在一起。
- **ARCH-8 前端四层 client、ARCH-9 18 个 store 依赖环**：先要 D4 定「什么状态住哪」。
- **STR-3 import 时副作用**：一个统一重置注册表本身就要 import 35 个带副作用的模块，
  方向应是逐个消除副作用而不是集中重置。
- **ARCH-3 的中期部分**（daemon 把完整工具输出持久化进 parts）：是 daemon 侧改动。
- **ARCH-1 残余**：compat store 里仍被读的 `sessions`（列表行镜像）、`pendingPermissions` 与
  `messageQueue`（旧发送路径死后已无生产者，只剩旧审批/队列 UI 在渲染）、`sessionStatuses` 与
  `pendingQuestionIdsBySession`（无生产者）——都已换成真实类型，退役要连同旧审批 UI 一起。
- **ARCH-5 残余**：`gateway/mod.rs` 手工遍历 team.toml、`team.rs` 在 `~/.amuxd` 下 `create_dir_all`，
  daemon 侧缺少「不带凭证的渠道配置读取」和「物化并返回团队默认 worktree」两个端点；
  `read_daemon_actor_id` 的 backend.toml 解析降级为冷启动回退，彻底删除要 `window.rs` 的同步命令改 async。
- **STR-11 的整体分目录**：`lib/` 顶层 222 个文件按域搬进子目录是 600+ 个 import 点的重写，
  与并行改 main 的同事必然大面积冲突且 git 历史断链。本分支只做了点名的三处（命名撞车、
  `hooks/` 命名风格、`useAppInit.ts` 的多 hook 导出）；整体重排要和 ARCH-9 一起设计。
- **STR-12 余下的硬编码中文**：会进 toast 的两处（`apps-store.ts`、`team-share-browser.ts`）已走
  `i18n.t`。其余分布在 `lib/diagnostic-report.ts`（诊断包正文）、`lib/dynamic-ui/catalog.ts`
  （喂给 LLM 的 schema 描述）和一批设置页组件里——前两类不是 UI 文案，最后一类是逐个组件的
  搬运工作，不适合和这一批混在一起。
