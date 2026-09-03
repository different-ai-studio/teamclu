---
status: proposed
---

# webview 只拿它实际要用的目录，不拿整块磁盘

`apps/desktop/capabilities/default.json` 的 11 条 `fs:allow-*`（读、写、删、
改名、建目录、复制）每一条都带 `{"path": "$HOME/**"}` 和 `{"path": "/**"}`，
`tauri.conf.json` 的 `assetProtocol.scope` 同样是 `["$HOME/**", "/**"]`。
本 ADR 把它们收敛到**运行时按需放行的一组根**：

- 用户已注册的 workspace 根（新增 workspace 时通过 `tauri-plugin-fs` 的
  `FsExt::scope().allow_directory` 动态放行）
- `~/.amuxd`（daemon 的家）与 `~/.agents`（skills）
- 系统下载目录
- 用户经 `dialog` 插件亲手选中的路径 —— 这条不需要我们做任何事，Tauri 会自动把
  选中项加进 scope，所以「打开任意文件」的流程不受影响

另外两件不依赖本决定、可以立刻做的：`connect-src` 从 `https: http: ws: wss:`
改成逐条列举（`build.config.*.json` 里的 API / MQTT / Supabase 域名，加
`http://127.0.0.1:*` 给本机 daemon）；`withGlobalTauri: true` 换成
`isTauri()` 判断——**前提是先确认没有依赖 `window.__TAURI__` 的注入脚本**，
`commands/webview.rs` 的身份注入脚本就是一个候选。

## 为什么

`capabilities/default.json` 自己的 description 写着 "The fs grants below are
whole-disk."，所以这不是疏忽，是当时的取舍。今天重新算这笔账，代价的一侧变了。

**同一个 origin 渲染的东西**：`packages/app/src/packages/ai/message.tsx` 渲染队友
和 agent 的 markdown，`lib/dynamic-ui/` 渲染 agent 生成的 UI 描述，编辑器渲染
workspace 里的任意文件。同一个 origin 持有的能力是：全盘 fs（27 个非测试文件直接
`import '@tauri-apps/plugin-fs'`）、`connect-src https: http: ws: wss:` 的任意
出网，以及 `lib/daemon/daemon-local-client.ts:104` 用 daemon 根 token 换来的、
带 `admin` scope 的会话 token。

**今天没有漏洞**：2026-09-02 的审计逐条查过 XSS 落点——三处
`dangerouslySetInnerHTML` 吃的是 Shiki 输出或 `securityLevel: 'strict'` 的
Mermaid SVG；react-markdown 没开 `rehype-raw`，原始 HTML 被丢弃，
`javascript:` / `file:` / `asset:` 被中和；生产构建没有 `eval` / `new Function`；
没有 `postMessage` 处理器。所以这是**爆炸半径，不是漏洞**。

正因为它是爆炸半径，它的价值不在「修掉一个已知 bug」，而在把未来任何一次 XSS 的
后果从「读 `~/.ssh/id_rsa`、改任意文件」降到「读写用户本来就在这个 app 里操作的
目录」。SEC-5 已经先按这个方向做了一半：agent 渲染的本地图片被限定到规范化后的
会话目录（`message.tsx` 的 `img` 组件），但那是逐个落点的补丁，补一个漏一个——
`readFile` 本身仍然是全盘的。

## 考虑过的其它方案

**a. 维持全盘。** 代价 0、收益 0。在没有 XSS 落点的今天可以自洽，但它把「有没有
漏洞」和「漏了会怎样」绑成了同一个赌注。

**c. 所有 fs 访问下沉到 Rust 命令、按命令校验路径**（`commands/workspace_files.rs`
已经是这个模式：规范化后限定 workspace 内、25 MiB 上限、不在主线程）。这是终局
形态——前端零 fs 能力，权限判断集中在一处——但要改 27 个文件的全部路径来源，
工程量最大。

选 b 是因为它拿到 c 的绝大部分收益，而不需要一次性重写 27 个文件：scope 一收，
webview 就已经读不到 `~/.ssh` 了。**c 仍然是长期方向**，对新代码应当直接要求：
新的 fs 访问走 Rust 命令，不要新增 `@tauri-apps/plugin-fs` 的导入点。

## 代价与已知的坑

- 要逐个过那 27 个文件的路径来源，把 workspace 外的合法路径显式登记。已知的至少
  有：Obsidian vault（`lib/knowledge/obsidian.ts`）、skill 目录、诊断包写出的位置。
- 动态放行必须在**用户新增 workspace 的那一刻**发生，而不是在第一次读文件时，
  否则会出现"第一次点开报错、第二次就好了"的时序 bug。
- `assetProtocol.scope` 是编译期静态的，不能像 fs 那样运行时追加。图片预览这类
  走 `asset:` 的路径要么改走已经存在的 `read_workspace_binary_file`（PERF-16 之后
  它返回 base64），要么给 asset 单独留一组更宽的根。这一条要在动手前定，
  否则收 scope 会直接打断文件预览。

## 实现记录（第一批已落地）

动手之后有四件事和本文写的不一样，记在这里，因为它们改变了剩下的工作量。

**1. `assetProtocol` 不是取舍，是死配置。** 上面「代价与已知的坑」担心收 scope 会打断
图片预览，要在「改走 `read_workspace_binary_file`」和「给 asset 留一组更宽的根」之间选。
实际核查：客户端里**一个 `convertFileSrc` 调用都没有，一个 `asset:` URL 都没有**，图片
早就走 `read_workspace_binary_file`（返回 base64）。所以直接 `enable: false`，scope 清空，
CSP 里的 `asset:` / `asset.localhost` 一并删掉。**没有取舍要做。**

顺带一个坑：`tauri-build` 会交叉校验 `tauri.conf.json` 和 Cargo feature，关掉
`assetProtocol` 必须同时把 `tauri` 依赖的 `protocol-asset` feature 去掉，否则构建脚本
直接失败。

**2. 系统下载目录不需要授权。** 本文把它列进了「需要的根」。实际上产品里三个写下载的
地方（诊断包导出、附件下载、图片另存）**全都先弹 `save()` 再写它返回的路径**，而
`tauri-plugin-dialog` 的 `save` 命令自己会 `allow_file`（`commands.rs:222` 起）。静态授权
下载目录是白给。

**3. 拖拽进来的文件也不需要授权** —— 这条本文完全没提，但它本来会是最大的破坏面。
Tauri 的 `DragDropEvent::Drop` 处理里，**在把事件发给前端之前**就对每个路径调了
`allow_file` / `allow_directory`（`tauri::manager::window`）。所以「从 Finder 拖一个文件
进聊天框」在收窄之后照常工作。

**4. 时序问题的真身不是「第一次读文件时才放行」，是 `register_window_workspace` 根本
没被 await。** 它挂在 `setWorkspace` 末尾一个 fire-and-forget 的 `.then()` 里，而
`ensureWorkspaceDirectory` 的 `mkdir` 在它前面几十行就跑了。所以授权点放在
`setWorkspace` 开头并 await，`register_window_workspace` 里那次只作为兜底。

**还有一条要记住**：运行时授权（dialog / 拖拽 / 我们自己调的）**活不过重启**。所以任何
冷启动就要用的路径必须落在静态 capability 或 `fs_scope::fixed_roots` 里；用户自己配的
额外 skill 扫描路径因此要在每次读之前重新授权，而不是等失败了再补。

### 这批没做的

- **`connect-src` 逐条列举**仍是 `https: http: ws: wss:`。
- **`withGlobalTauri`**：本文说前提是「确认没有依赖 `window.__TAURI__` 的注入脚本」。实际
  拦路的不是注入脚本，是 **E2E 测试**——`tests/regression/` 和 `tests/functional/` 有 12 处
  直接 `window.__TAURI__.core.invoke(...)` 驱动应用。产品代码只把它当探测标志用（3 处，
  都能换成 `isTauri()`）。要关这个开关，得先把 E2E 换成别的驱动方式，这是一件独立的事。
- 前端 27 个 `@tauri-apps/plugin-fs` 导入点一个没减。c 仍是长期方向。
