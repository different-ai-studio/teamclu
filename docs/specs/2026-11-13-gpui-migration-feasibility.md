# TeamClu → GPUI 可行性评估（对照 Discord Phoenix）

日期：2026-11-13  
范围：桌面主客户端（`apps/desktop` + `packages/app`）是否值得从 Tauri 2 + React 19 换成 GPUI  
结论先行：**现在不该换。** Discord 的故事证明「全量原生 Rust UI」在他们的规模与病根下成立；TeamClu 的病根、体量、多端矩阵和 GPUI 生态成熟度都不支持同等赌注。

---

## 1. Discord Phoenix 里哪些事实可信

| 主张 | 置信度 | 依据 |
|---|---|---|
| Discord 用 Rust 重写整客户端；Electron / React Native 退出 | 高 | CTO Stanislav Vishnevskiy 在 X 上的公开说明（多家一手转述，如 [The Verge](https://www.theverge.com/news/1027379/discord-ditching-electron-web-app)、[Windows Latest](https://www.windowslatest.com/2026/11/05/discord-is-killing-its-electron-app-that-can-eat-4gb-of-ram-on-windows-11-and-the-rust-rebuild-uses-just-290mb/)） |
| UI 框架是 **GPUI，不是 Tauri** | 高 | 同一线程里 CTO 明确否定 Tauri、点名 GPUI |
| 截图 290.2 MB | 中–高（数字真实，口径窄） | 早期 Windows 构建；CTO 后续说明当时是 **双账号同时在线**；不是对照实验、不是通话/直播负载 |
| 旧客户端常态 &lt;1 GB、最坏可到 4 GB，曾用超 4 GB 自动重启止血 | 高 | Discord 员工 2025-12 Reddit 确认（多家引用） |
| 病根是 Electron 多进程 + 每 guild/流当 tab、内存只增不减 | 中 | 与 Electron 架构一致；官方公开叙事强调内存，细节多为转述 |
| 移动端保留原生 UI，业务逻辑经 Rust 与桌面共享；浏览器端自写可渲 HTML 或 GPUI 的 UI 包装层 | 中 | CTO 帖文转述；无公开设计文档 |
| YouTube / Activities 等仍嵌系统 webview | 中 | CTO 回复转述（[Inven](https://www.invenglobal.com/articles/28182/discord-cto-confirms-the-desktop-and-mobile-apps-are-being-rebuilt-in-rust)）；与「完全去浏览器」不完全等同 |
| Discord 对 GPUI 有私有 patch，可能回馈上游 | 中 | 同上 CTO 回复转述 |
| 无私测日期 / 公开发布日 | 高 | 「soon™」；**无 Discord 官方博客公告** |
| 移动端 UI 也是 GPUI | **不成立** | CTO 说的是原生 UI + 共享 Rust 业务代码，不是移动像素层也 GPUI |

说明：原始 `@svishnevskiy` X 帖在本评估会话无法直接抓取（x.com 403）；上表「高」依赖多家 contemporaneous 引述交叉核对，不是 Discord 公司新闻稿。

**对 TeamClu 的直接含义：** Discord 不是「选了 Rust 后端」——他们是 **扔掉 DOM**。Tauri 仍是系统 webview + JS UI；换 Tauri ≠ 拿到 Phoenix 那类内存曲线。生产级采用还暗示 **愿意维护 GPUI fork/patch**。

---

## 2. GPUI 现状（2026-11）

一手文档：[gpui.rs](https://gpui.rs/)、[crates/gpui README](https://raw.githubusercontent.com/zed-industries/zed/main/crates/gpui/README.md)、[crates.io/crates/gpui](https://crates.io/crates/gpui)、Zed 仓库讨论。补充调研：[Research GPUI Discord Phoenix](0c01b122-eabf-43fb-8ecd-5d3d50c020ea)。

- **定位**：Zed Industries 的 GPU 加速 UI（Apache-2.0）；混合 immediate / retained；App → `Render` views → element 树（Tailwind **风格** builder，不是 CSS 运行时）→ GPU `Scene`。
- **成熟度**：明确 **pre-1.0**，版本间常有 breaking change；官方仍写「最好的文档是读 Zed 源码」。
- **crates.io**：`0.2.2`（2025-10）相对 HEAD 滞后；社区讨论指出完整发布链路未就绪（宏/内部 crate `publish = false`、依赖 git 分裂）。见 [zed discussion #55271](https://github.com/zed-industries/zed/discussions/55271)、[GPUI Distribution Problem](https://gpui-archipelago.github.io/news/gpui-distribution/)。应用侧常见应对：钉 Zed git、或跟 Longbridge 的 **`gpui-pre` / [gpui-kit](https://crates.io/crates/gpui-kit)** 快照。
- **平台**（上游 README，高于过时的 docs.rs 文案）：**macOS**（Metal）、**Linux/FreeBSD**（Wayland/X11）、**Windows**（Win32 + DirectWrite）。`gpui_platform` 另有 ios/wasm 臂。docs.rs 0.2.2 仍写「macOS or Linux」——以仓库 README 为准，但发版契约仍弱于 Tauri。
- **无障碍 / 文本**：AccessKit 已合入 GPUI（[PR #56065](https://github.com/zed-industries/zed/pull/56065)，2026-05）；IME 走各平台文本栈。公开文档 **没有独立的 CJK 认证矩阵**——可工作性靠 OS IME + 外部产品间接证明。
- **生产用户**：
  - **Zed** — 一等公民
  - **Longbridge Pro** — Electron → GPUI 的已上线券商桌面端；并维护组件库（因「gpui 本身不带控件」）——[Zed Community Champion: Jason Lee](https://zed.dev/blog/community-champion-jason-lee)
  - **Discord Phoenix** — 最大外部信号，尚未公开发布
  - 其余见 [awesome-gpui](https://github.com/zed-industries/awesome-gpui)（多为 indie/OSS）
- **webview / 富编辑替代**：核心无内嵌浏览器。[gpui-webview](https://crates.io/crates/gpui-webview)（Wry，实验性；Linux 限 X11/XWayland）。Markdown/代码编辑需 **GPUI Kit 控件或自建**（无 Tiptap/CodeMirror 等价物）。

**判断：** 技术上可行，且已有 Longbridge 级商业先例；仍适合「愿意跟 Zed/Kit 同仓节奏、用 Rust 写全部像素、必要时 patch」的团队。不适合作为 TeamClu 2026–27 默认主壳——供应链与重写面未变。

---

## 3. TeamClu 桌面栈现状（评估日计量）

来源：仓库计量 + `docs/audit/2026-09-02-tauri-desktop-audit.md` + `docs/features/01-multi-client-workspace.md`；补充盘点 [Map TeamClu desktop stack](75a990ac-d38a-48ff-8b59-b0fbb63ed6d3)。

| 面 | 规模 |
|---|---|
| `packages/app` 非测试 TS/TSX | ~184k LOC（全量含测试 ~276k） |
| Zustand store 模块（非测试） | ~80 文件 / ~66 `create(` |
| `components/` 非测试 `.tsx` | ~315 |
| `lib/` 非测试模块 | ~407 |
| `apps/desktop` Rust | ~45k LOC / ~120 `.rs` |
| `generate_handler!` 已注册 IPC | ~224（`#[tauri::command]` 注解 ~234） |
| 非测试文件依赖 `@tauri-apps*` / `tauri-plugin-*` | ~118 |
| FE `invoke('…')` 唯一命令名 | ~222 |

**已是「半 Rust」：** amuxd、cron、local cache、MQTT bus、gateway、introspect、fs/workspace、updater、tray 等在桌面进程或 daemon；前端是 React 工作台，不是 Electron 单体。

**桌面持有面（换壳时谁跟着走）：**

| 面 | 约略规模 | 与 webview/IPC | 能否下沉 daemon |
|---|---|---|---|
| Introspect API | ~6.3k LOC | 回环 HTTP + 本机确认 UI | 逻辑可；确认对话框仍要宿主 |
| Local cache (libsql) | ~4.6k / 39 cmds | 强 IPC | 可迁；今日在桌面 |
| Cron | ~4.3k / 11 cmds | UI 经 IPC | **是 — ADR-0010** |
| Embedded webviews | `webview.rs` ~2.0k / 17 cmds | **就是** webview | 否 |
| MQTT bus | ~1.3k / 6 cmds | emit → 前端 | 连接可迁；宿主仍要桥 |
| amuxd supervisor | ~1.3k | App 生命周期 | 宿主拉起 daemon |
| Updater / tray / window | 多文件 | 原生 OS | 留宿主 |
| OAuth loopback | ~0.5k / 3 cmds | 系统浏览器 + 回环页 | 监听可迁；浏览器必需 |
| Terminal (portable-pty) | 主 checkout 仍有；**本 worktree tip（#1872）已 sunset** | 强（xterm） | PTY 可讨论；UI 要控件 |

**DOM 重度依赖（换 GPUI 几乎全丢）：** CodeMirror 6（文档里的 Tiptap 已弃用，包内无 `@tiptap`）、Shiki、react-markdown、mermaid、pdfjs、Radix、TanStack Virtual、Tailwind 4、json-render、xterm（随 terminal sunset 可淡出）。

**仍需要 webview / 浏览器的产品面：** `WebViewContent` / Apps / Admin SSO、`FileEditor` HTML `srcDoc` sandbox、OAuth + `oauth_loopback`、remote-tools ↔ Chrome extension、深链落地。即便 GPUI 化，这些变成「壳原生 + 岛上仍是浏览器」。

**多端矩阵（刻意不共享 UI）：**

| 端 | 技术 | 与 `packages/app` | 约略自有规模 |
|---|---|---|---|
| Desktop | Tauri + React | 主消费者 | 上表 |
| Web | 同包 `platform: web` | 同 UI 代码 | 含在 `packages/app` |
| Extension | MV3 | 编译 `lib/extension/` 等切片 | `apps/extension/` |
| Expo | React Native | **仅 proto export** | ~75k TS |
| iOS | SwiftUI | **无 UI 共享** | ~59k first-party Swift |

换 GPUI = **重写 Desktop UI**，并逼 Web 要么另做 HTML 渲染层（Discord 路线），要么放弃 / 降级 Web。iOS / Expo 不受益于「同一套 GPUI 像素」。

**已有审计结论方向：** 2026-09 桌面审计的 P0/P1 是 introspect 鉴权、local-cache、主线程阻塞、session store 重复、JS 包体，**不是「必须离开 webview」**；审计选项里也没有「离开 Tauri」。后续 ADR（0009–0013）继续加固 Tauri 边界，而不是换壳。
---

## 4. 类比哪里成立、哪里不成立

| Discord | TeamClu |
|---|---|
| Electron 自带 Chromium，多进程 tab 内存膨胀到 GB | Tauri 用系统 WebView；无「每频道一个 Chromium 进程」同构病根 |
| 产品几乎是单一聊天 UI + 嵌网页活动 | 工作台：会话 + 知识库 + 编辑器 + Apps + daemon 宿主 |
| 2018 起大量客户端/语音已是 Rust；有专职客户端平台团队 | Rust 强在 daemon / 桌面命令；UI 资产在 React |
| 可接受多年并行双客户端 + 自研跨端 UI IR | SME 平台，并行双壳机会成本极高 |
| 290 MB 对标的是 1–4 GB Electron | 尚未建立 TeamClu 生产 RSS 基线；不能直接套用「降到 290」叙事 |

**一句话：** Discord 是在治 Electron 癌症；TeamClu 若跟风换 GPUI，是在换掉已经相对健康的骨架上那层还在高速迭代的产品皮肤。

---

## 5. 成本模型（粗估，人月）

假设目标：Desktop 功能对等（含中文 IME、无障碍基线、Apps webview、编辑器、设置、多窗口 ADR-0012 语义），Web 另议。

| 工作包 | 低 | 高 | 说明 |
|---|---|---|---|
| 壳 + 导航 + 会话列表 + 聊天只读 | 4 | 8 | 最像 Discord 的部分 |
| Composer / @提及 / 附件 / 权限流 | 2 | 4 | |
| Markdown / Code 编辑器（替代 CodeMirror） | 4 | 10 | GPUI 强项在编辑器，但仍是从零接产品需求 |
| 知识库树、diff、预览 | 3 | 6 | |
| Apps / OAuth / 系统 webview 岛 | 2 | 4 | 去不掉 |
| 把 ~220 IPC 从 Tauri command 迁到 GPUI 进程内 API | 2 | 4 | Rust 侧可大量保留 |
| 状态层（Zustand → GPUI Entity） | 3 | 6 | 业务规则可迁，UI 绑定全毁 |
| Web 客户端（HTML 后端或放弃） | 3 | 8 | Discord 自研双靶渲染；我们大概率先砍范围 |
| 设计系统 / Editorial Calm 像素重做 | 2 | 4 | Tailwind token → GPUI style |
| 测试、E2E、发布、回滚双轨 | 3 | 6 | |
| **合计（Desktop 对等）** | **~28** | **~60** | 约 **1.5–3 年 · 2 名全职**，或更大团队压缩日历 |

未计入：招聘/培养 Rust UI 产能、跟 GPUI breaking、无障碍与 CJK 细节、动态 UI（`@json-render`）重做。

**对比：不换壳、治真正痛点（示意）**

| 投资 | 人月 | 预期收益 |
|---|---|---|
| 继续下沉 cron / 重逻辑到 amuxd（ADR-0010 方向） | 1–3 | 桌面变薄、无头场景对齐 |
| local-cache / 启动包体 / 主线程（审计 P0/P1） | 1–3 | 体感与内存，保留 React 迭代速度 |
| 量产 RSS / 启动时间仪表盘 | 0.5 | 先证明「内存是不是问题」 |
| 收敛 webview 能力面（ADR-0009） | 1–2 | 安全，不换框架 |

---

## 6. 可选路径（若仍想押 GPUI）

按风险递增：

1. **不迁 UI，只测基线** — 记录 TeamClu 闲置 / 重会话 / 多窗口 RSS，再决定是否有「Discord 级」问题。
2. **逻辑继续 Rust 化** — UI 留 Tauri；扩大 amuxd 与桌面 Rust 命令深度（深模块、小 IPC）。与现架构同向。
3. **尖兵原型** — 已开工：`prototypes/gpui-kit-spike/`（throwaway，独立 `[workspace]`，`rust-toolchain` = stable ≥1.100；gpui-kit 0.9 编不过 TeamClu 的 1.97.1）。当前范围：假会话列表 → 原生 Markdown → composer IME smoke → 进程 RSS。下一步才接 Cloud API / amuxd；HTML 预览才上 `gpui-webview`。
4. **混合壳** — GPUI chrome + 中央仍 webview 跑现有 React。成本接近「两个壳」，内存收益有限；通常不值得。
5. **全量重写** — 仅当：GPUI ≥1.0 且 Windows 发版契约一等；TeamClu 有可证的内存/CPU 危机；愿意暂停 Desktop 功能半年以上；Web 策略已拍板；组织能接受维护 patch（Discord 先例）。

**推荐默认：1 → 2；3 仅作学习预算；拒绝 4/5 作为 2026–2027 主线。**

---

## 7. 决策标准（建议写成产品门禁）

同时满足再重新开题：

1. 生产 Desktop 在「正常重度使用」下 p95 RSS 持续高于可接受阈值（需先定义；例如相对同类 Tauri 应用异常）。
2. 审计级性能债已还完一轮，仍证明瓶颈在 **webview/JS 运行时本身**，而非本地缓存 / 同步 / 主线程命令。
3. GPUI 有可预测的发布通道（crates.io 跟上 HEAD，SemVer 承诺），Windows 为文档一等公民。
4. 组织上有 ≥2 名能以 GPUI 交付功能的工程师，且 Web/iOS 路线不依赖「桌面 React 继续当唯一完整客户端」。

否则：把 Discord 新闻当作 **激励「更多逻辑进 Rust」**，而不是 **激励「重写像素层」**。

---

## 8. 来源

- TeamClu：`docs/audit/2026-09-02-tauri-desktop-audit.md`、`docs/features/01-multi-client-workspace.md`、ADR-0009–0013；桌面面盘点 [Map TeamClu desktop stack](75a990ac-d38a-48ff-8b59-b0fbb63ed6d3)
- GPUI：https://gpui.rs/ 、https://crates.io/crates/gpui 、https://raw.githubusercontent.com/zed-industries/zed/main/crates/gpui/README.md 、https://github.com/zed-industries/zed/discussions/55271 、https://zed.dev/blog/community-champion-jason-lee 、https://crates.io/crates/gpui-kit 、https://crates.io/crates/gpui-webview ；一手整理 [Research GPUI Discord Phoenix](0c01b122-eabf-43fb-8ecd-5d3d50c020ea)
- Discord：The Verge / Windows Latest / Inven 等对 Vishnevskiy X 帖的报道（评估日；原始 X 未能直抓）；290 MB 口径含双账号；无官方博客公告
---

## 9. 一句话给决策者

**TeamClu 已经站在 Tauri（系统 webview）+ 厚 Rust daemon 这一侧；Discord 是从 Electron 深渊往 GPUI 跳。跟跳的成本是重写 ~18 万行产品 UI 并自养一套不成熟的 UI 运行时，换来的内存红利未证明、Web 端还要再付一次账。更划算的是继续加深 Rust 边界、瘦前端、先量内存。**
