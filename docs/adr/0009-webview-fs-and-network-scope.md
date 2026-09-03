---
status: accepted
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
