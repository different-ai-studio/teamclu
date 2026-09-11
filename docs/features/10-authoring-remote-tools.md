# TeamClu 功能详解 · 第 10 篇：创作与本地操作能力（编辑器 / 终端 / 远程工具）

> 版本基线：当前 `main`（`package.json` v0.4.1-beta.51）。
> 读者：要接手编辑器、终端、远程工具、扩展这块的工程师。
> 关联：`docs/remote-tools.md`、`docs/chrome-extension-design.md`、
> `packages/app/src/components/editors/`、`packages/app/src/components/diff/`、
> `apps/desktop/src/terminal/`、`packages/app/src/lib/remote-tools/`、
> `packages/app/src/lib/dynamic-ui/`、`packages/app/src/lib/history/`。

---

## 0. 一句话定位

这一篇讲的是「人和 agent 一起改东西」的能力。TeamClu 不是 IDE，但它有编辑器、有终端、有 diff、有版本历史——这四件东西的存在不是为了让用户从零写代码，而是为了让 **agent 改完的东西可被人审查、可被人接手、可被人修正**。

所以这一篇的视角与「一个编辑器功能」不同。每个能力都要回答同一个问题：**它是为「人写」设计的，还是为「人看 agent 写的」设计的？** 答案是后者，这解释了很多看起来奇怪的选择：

- diff 是「agent-first」的，专门渲染 agent 的修改；
- 编辑器支持「agent 改了这里」的高亮，而不是全量重渲染；
- 终端有 8 MiB 回放缓冲，因为 agent 跑的命令你看的时候它可能已经跑完了；
- 远程工具让 agent 能读用户浏览器里的页面，而不是让用户复制粘贴。

---

## 1. 编辑器系统

TeamClu 有三种编辑器，按文件类型分发（`components/editors/utils.ts` 的 `getEditorType`）：

| 类型 | 技术 | 用途 |
|---|---|---|
| Markdown | Tiptap | 知识库、文档、笔记 |
| HTML | Tiptap + sandbox 预览 | 页面、模板 |
| Code | CodeMirror 6 + Shiki | 代码、配置 |

外加 Viewer：图片、PDF、不支持的二进制（`UnsupportedFileViewer`）。

四种编辑器都通过 `FileEditor.tsx` 分发，且都是 `React.lazy`——一个会话可能永远不打开编辑器，所以它不该进启动 chunk。

统一接口是 `EditorProps`（`editors/types.ts`）：

```ts
interface EditorProps {
  content: string
  filename: string
  filePath: string
  onChange?: (content: string) => void
  readOnly?: boolean
  isDark?: boolean
  originalContent?: string | null   // git HEAD，用于 git gutter
  targetLine?: number | null        // 滚动到行
  targetHeading?: string | null     // Markdown 滚动到标题
}
```

`originalContent` 与 `targetLine` / `targetHeading` 是三个「为审查而生」的字段：前者让编辑器画出「相对 git HEAD 改了什么」，后者让外部能定位到具体位置（比如从 diff 或搜索结果跳转）。

### 1.1 Markdown 编辑器

`MarkdownEditor.tsx` 除了常规编辑，还处理 wiki link（第 5 篇）：用 CodeMirror 的 `MatchDecorator` 给 `[[...]]` 加装饰，点击时在文档所属知识树内解析并跳转/新建。

### 1.2 Agent 编辑的高亮（PERF-17）

这是编辑器里最值得看的一段。agent 改文件时，编辑器不是全量替换，而是：

1. `diffAgentEdit(oldText, newText)` 找出真正变化的那一段；
2. 只 dispatch 那一段 changes；
3. 如果变化比例不大，给新增的字符加高亮。

`diffAgentEdit` 的注释解释了为什么不能直接 `diffChars(old, new)`：

> `diffChars(oldText, newText)` over a whole document is O(n·m) in the worst case, and an agent edit is almost always a small change to a large file... The unchanged head and tail are the overwhelming majority of both strings and are identical by construction, so they are stripped by two linear scans and only the differing middle reaches the diff. A one-line change in a 200 KB note goes from diffing 200 KB against 200 KB to diffing a few dozen characters.

还有一个细节：**不能把 surrogate pair 切开**。`isHighSurrogate` 检查确保 prefix 不会停在半个字符上，否则会把一个孤立代理项交给 diff。

以及为什么要 dispatch 那一段而不是整个文档：

> Replacing the whole document makes CodeMirror rebuild every line and drops the cursor, where replacing the changed span leaves the untouched lines — and the user's place in them — alone.

这条是「人看 agent 改」这个定位的直接体现：如果全量替换，用户正在编辑时光标会跳到顶部，而这在「agent 在后台改、我在前台看」的场景里是不可接受的。

### 1.3 其它编辑器能力

- **git gutter**：`git-gutter.ts` 画相对 HEAD 的增删行。
- **自动保存**：`useAutoSave.ts`。
- **图片粘贴**：`image-paste-handler.ts`。
- **HTML 预览 CSP**：`withHtmlPreviewCsp`（`lib/ui/html-preview-csp.ts`）——HTML 预览在 sandbox 里，CSP 要显式设置。

---

## 2. Diff 审阅器（agent-first）

`components/diff/` 不是一个通用的 diff 组件，而是一个**为 agent 修改设计的审阅器**：

| 文件 | 作用 |
|---|---|
| `DiffRenderer.tsx` | 主渲染 |
| `DiffHeader.tsx` | 头部（文件、统计） |
| `HunkView.tsx` / `HunkNavigator.tsx` | 按 hunk 浏览、跳转 |
| `parse-tool-patch.ts` | 解析 agent 的工具补丁 |
| `diff-ast.ts` | AST 级 diff |
| `agent-operations.ts` | agent 操作到展示的映射 |
| `shiki-renderer.ts` / `notion-shiki-themes.ts` | 语法高亮 |

关键设计：**它的输入是 agent 的工具补丁，不是两个文件。** 所以它能知道「这是 edit 工具的第几次调用」「这是 write 还是 patch」，并据此渲染。这也是 `parse-tool-patch.ts` 与 `agent-operations.ts` 存在的原因。

一个可用的判断：如果你想复用这个 diff 组件去展示两个任意文件，会发现它带着 agent 的语义——这说明它确实是为特定场景设计的，不是通用组件。这是有意为之：**通用 diff 组件会迫使它忽略那些让审查变容易的信息。**

---

## 3. 版本历史

`lib/history/` 提供版本历史，`components/version/`（`VersionList`、`VersionPreview`、`SimpleDiff`）展示。知识库文档的版本历史在第 5 篇展开。

Provider 是 `lib/history/oss-provider.ts`（`OssHistoryProvider`）——版本来自同步引擎记录的历史版本。

一个与编辑器的连接：`FileEditor.tsx` 里有 `LazyFileHistoryView`，所以任何文件都能看历史。恢复走 `restoreFileVersion`。

---

## 4. 终端

`apps/desktop/src/terminal/` 是一个完整的 PTY 实现：

| 文件 | 作用 |
|---|---|
| `pty.rs` | `portable-pty` 封装 |
| `registry.rs` | 终端注册表、状态、错误 |
| `ring.rs` | 8 MiB 固定容量环形缓冲 |
| `shell_integration.rs` | shell 集成脚本 |

### 4.1 8 MiB 环形缓冲

`RING_CAPACITY: usize = 8 * 1024 * 1024`。终端输出进环形缓冲，重新附着（re-attach）时回放。

为什么需要回放？因为终端是**异步**的：agent 或用户跑了命令，然后切走，过一会切回来。没有回放，你会看到一个空白终端，不知道刚才输出了什么。

为什么是 8 MiB？它是一个折中：足够回放大量输出，又不至于为每个终端吃掉不可接受的内存。`ring.rs` 的实现处理了「一个 chunk 大于整个容量」的情况（只保留尾部）、以及未填满与已环绕两种快照。

一个实现细节：`snapshot()` 在未环绕时返回 `buf[..head]`，已环绕时返回从 head 到末尾再接开头的两段。这是环形缓冲的标准做法，但很容易写错——`filled` 标志的处理是关键。

### 4.2 cwd 白名单

`TerminalError::CwdNotAllowed` / `CwdNotFound` 是两条错误。终端 cwd 必须落在前端传进来的 allowed roots 之下；**没有根就没有终端。**

这与第 2 篇的「PTY 的 allowed roots」是同一条：终端是一个可以在用户机器上跑任意命令的能力，所以它的工作目录必须受限。

### 4.3 状态与错误

`TerminalStatus`（running / exited）、`TerminalSummary`（id、shell、pid、status、exit code）、`TerminalError` 是一个判别枚举（shell not found / cwd not allowed / cwd not found / pty closed / not found / spawn failed / bad request）。

**错误是带 kind 的判别枚举**，不是字符串。这与 ADR-0013（IPC 错误带 code）一致：前端能按 kind 分支，而不是正则匹配文案。

### 4.4 UI

`TerminalToggleButton`（`app/chrome.tsx`）在 header 上切换终端面板，快捷键 `⌃`` `。`useTerminalStore` 按 workspace 记录面板开关状态（`panelOpenByWorkspace`）。

---

## 5. 远程工具（Remote Tools MCP）

`docs/remote-tools.md`：agent 侧的工具，在 TeamClu **客户端**（Chrome 扩展、未来的桌面/iOS）上通过 MQTT RPC 执行。

### 5.1 架构

```
Agent → amuxd remote-tools-mcp (stdio) → daemon.sock → remote_context_id lookup
  → MQTT amux/{team}/{memberActor}/rpc/req
  → all online clients for that member actor → capable client replies, others stay silent
```

- daemon 在 OpenCode/Codex host 启动前安装 `amuxd-remote-tools` 作为 host 级 MCP 基线；
- agent 收到一个 per-turn 的 `remote_context_id` 指令，必须在调用里带上；
- `packages/app` 监听 `amux/{team}/{myActorId}/rpc/req`；没有 executor 的客户端**不回复**；
- 扩展注册 `get_page_dom` executor。

### 5.2 路由

1. prompt 开始时为 `(runtime, ACP session, team, member actor)` 创建一个短命的 `remote_context_id`；
2. 下一条 prompt 注入指令，告诉模型要传这个确切的 id；
3. MCP invoke 把 `remote_context_id` 解析成当前的 member actor；
4. daemon 向 `amux/{team}/{memberActor}/rpc/req` 发一条 RPC。

**多成员会话**：Bob 发一个 turn，那个 turn 的 `remote_context_id` 路由到 Bob；Alice 之后在同一个 agent 会话里发 turn，她的 turn 拿到不同的 id，路由到 Alice。MCP server 仍是 host 级共享的——只有工具调用参数选择目标客户端。

这是一个很干净的设计：**「谁发的 turn」这个信息不需要在客户端之间协调，它已经在 daemon 的上下文里。**

### 5.3 安全

- **MQTT ACL**：member `SUB` 自己的 `rpc/req`；agent `PUB` 到 `amux/{team}/+/rpc/req`。**迁移要先于客户端部署。**
- **客户端校验 fail-closed**：`packages/app` 拒绝一个 `RemoteToolInvoke`，除非 `requester_actor_id` 是一个会话 agent **且** participants 已加载。desktop 用 libsql 缓存，extension/web 用 Cloud API 加载（`sessionMembers.listParticipants`）。
- handler 在验证前会调 `ensureParticipants`。

`validate-request.ts` 的注释解释了威胁：

> Reject forged member→member rpc/req injections. Legitimate remote-tool calls are published by the session's agent daemon (`requester_actor_id` = agent).

这是一个 RF 层面的防御：如果没有这个校验，一个成员可以向另一个成员的 RPC 主题发消息，冒充 agent 让它执行浏览器工具。

### 5.4 现有工具

- `get_page_dom`（`mode`: outline / text，`max_chars` 默认 8000）；
- `show_page_nav_links`（`links: string[]`，可选 `labels`）——**daemon-local**：立即返回，invoke 期间没有 MQTT/extension 往返；聊天 UI 从工具调用参数渲染按钮。

第二个工具的设计值得注意：它不需要真的访问浏览器，只是「让聊天界面显示几个按钮」。把它标成 daemon-local 避免了无谓的往返。

---

## 6. Chrome 扩展

`docs/chrome-extension-design.md`：MV3 扩展，在浏览器**侧边栏（side panel）**里嵌入 TeamClu 的聊天窗口，并能把当前网页内容作为上下文发给 agent。

### 6.1 关键决策

- **扩展不直连 daemon**：amuxd 的 HTTP API 只绑 `127.0.0.1` + 文件 root token，浏览器跨机器不可达。所以扩展用 **Cloud API（HTTPS bearer）+ MQTT over WebSocket**，daemon 被间接驱动，**零改动**。
- **把 app 打包进扩展**：把 `@teamclu/app` 的聊天子集打包进扩展，作为 side panel 页面运行——无 iframe、无公网托管、无跨域 CSP 问题。代价是要让 app 能在纯浏览器环境跑（`lib/embed/`）。
- **三个部分**：side panel（聊天）、service worker（管理 panel、转发）、content script（读选中文本/全文）。

### 6.2 非目标（YAGNI）

- 不做 agent 反控页面（点击/填表/导航）——这条后来被 remote-tools 部分实现了，但那是一个独立的机制，不是扩展的「反控」。
- 不做结构化字段抽取。
- 扩展不直连 daemon HTTP，也不持有 daemon root token。
- 不在扩展里复刻全量桌面功能。

### 6.3 一个共享代码的约束

`lib/extension/` 同时被 app 和 `apps/extension` 编译（含 link-hover / link-session）。所以有一个守卫测试确保两边行为一致。这条与知识库的「三处白名单镜像」是同一类：**同一份逻辑在两个地方编译时，最容易悄悄分叉。**

---

## 7. 动态 UI

`lib/dynamic-ui/` 允许 agent 编写 UI 描述并渲染成界面：

- `catalog.ts`：目录组件（基于 shadcn/ui），用 Zod schema 描述 props；
- `prompt.ts`：把目录转成给 agent 的提示；
- `registry.tsx`：渲染分发；
- `generator.ts` / `streaming.ts`：生成与流式；
- `DynamicUI.tsx`：组件。

安全边界：**动态 UI 只能使用目录里的组件，不能执行任意代码。** `catalog.ts` 用 `schema.createCatalog` 定义可用组件与它们的 props schema，agent 生成的是符合这个 schema 的描述。

这是它与「让 agent 写 React」的根本区别。前者是一个受限的表达空间，后者是任意代码执行。

一个用例：agent 把一组选项做成表单让用户填，而不是让用户打字。它属于第 3 篇的会话能力（产出在聊天里），但实现在这里。

---

## 8. 本地文件操作与权限

`lib/fs-scope.ts` 是前端的路径校验入口。ADR-0009 定义了 webview 的文件系统与网络作用域。

几个原则：

- 任何「让用户选一个目录」的功能都必须过 fs-scope；
- 终端 cwd 必须在 allowed roots 下；
- webview 的网络访问受 scope 限制；
- IPC 错误带 code（ADR-0013）。

一个与第 2 篇的关系：真正的强制在 daemon/Rust 侧，前端只是第一道。**前端不是安全边界**，但它是「用户以为自己能做什么」的边界，所以必须做对。

---

## 9. 与权限系统的关系

这一篇里的四个能力都需要权限：

| 能力 | 谁在执行 | 权限门 |
|---|---|---|
| 编辑器写文件 | 前端 + Tauri | 文件操作权限 |
| 终端 | 桌面进程 PTY | cwd allowed roots |
| 远程工具 | 客户端扩展 | requester 必须是 session agent + participants 已加载 |
| 动态 UI | 前端渲染 | catalog 白名单（不是权限，是能力边界） |

四者形态不同，但共同点是：**每一处都必须在真正执行的一侧强制。** 前端的校验是体验，不是安全。

---

## 10. 测试

- 编辑器：`editors/__tests__/`（含 agent-edit-diff 的 surrogate 测试）；
- diff：`diff/__tests__/`；
- 终端：Rust 侧单元测试（ring buffer 的环绕、cwd 校验）；
- remote-tools：`rpc-server.test.ts`、`validate-request.test.ts`、`link-utils.test.ts`；
- dynamic-ui：`__tests__/`；
- 扩展：`pnpm test:extension`。

---

## 11. 关键文件索引

```
packages/app/src/
  components/FileEditor.tsx              编辑器分发
  components/editors/
    MarkdownEditor.tsx / CodeEditor.tsx
    agent-edit-diff.ts                   PERF-17 的局部 diff
    git-gutter.ts / useAutoSave.ts
    image-paste-handler.ts / ConflictBanner.tsx
    types.ts / utils.ts
  components/diff/                       agent-first 审阅器
  components/history/                    FileHistoryView
  components/version/                    VersionList / VersionPreview / SimpleDiff
  components/viewers/UnsupportedFileViewer.tsx
  lib/history/                           oss-provider
  lib/remote-tools/
    registry.ts / platform.ts            executor 注册
    rpc-server.ts                        MQTT RPC 服务
    validate-request.ts                  fail-closed 校验
    types.ts / browser-navigate.ts
  lib/dynamic-ui/
    catalog.ts / prompt.ts / registry.tsx / generator.ts / streaming.ts
  lib/fs-scope.ts
  lib/extension/                         与 apps/extension 共享
apps/desktop/src/terminal/
  mod.rs / pty.rs / registry.rs / ring.rs / shell_integration.rs
apps/extension/                          MV3 扩展
```

---

## 12. 常见坑

1. **agent 编辑不要全量替换文档。** 会丢光标、重建所有行。
2. **surrogate pair 不能切开。** diffAgentEdit 里有专门检查。
3. **终端回放缓冲不能删。** 否则切回来是空白。
4. **终端 cwd 必须有白名单。** 没有根就没有终端。
5. **remote-tools 校验必须 fail-closed。** 且 participants 未加载时拒绝。
6. **MQTT ACL 迁移要先于客户端部署。**
7. **动态 UI 不能执行任意代码。** 只用 catalog 里的组件。
8. **前端校验不是安全边界。** 强制在 daemon/Rust 侧。
9. **`lib/extension/` 两边编译要保持一致。** 有守卫测试。
10. **编辑器要 lazy。** 大多数会话不会打开它。

---

## 13. 附录 A：编辑器的细节

### 13.1 为什么用三套编辑器而不是一套

Tiptap 与 CodeMirror 是两种不同的模型：前者是富文本（文档树、格式化、粘贴处理），后者是代码（行、语法、缩进）。

- Markdown 用 Tiptap：知识库的用户是写笔记的人，他们期望所见即所得。
- HTML 用 Tiptap + sandbox 预览：既要编辑结构，又要看效果。
- 代码用 CodeMirror：语法高亮、行号、gutter、indent 是必需的。

用一套统一编辑器会同时妥协两个场景：富文本编辑器写代码体验差，代码编辑器写笔记体验差。这是**产品选择**，不是技术债。

### 13.2 HTML 预览的 CSP

`withHtmlPreviewCsp`（`lib/ui/html-preview-csp.ts`）是一个看起来不起眼但很关键的工具。HTML 预览在 sandbox 里渲染，而 CSP 必须显式设置：一个渲染用户/agent 写的 HTML 的 iframe，如果不限制它的能力，就等于在 app 里开了一个任意脚本执行入口。

这条与第 7 篇的动态 UI 是同一类安全边界：**「渲染外部内容」与「执行外部代码」必须分开。**

### 13.3 Viewer 的分工

- 图片：缩放、旋转。
- PDF：内嵌预览。
- 不支持的二进制：`UnsupportedFileViewer` + `UNSUPPORTED_BINARY_EXTENSIONS` 列表。

最后一项是一个必要的“说不”：“这是一个二进制文件，我们不尝试渲染它”。没有它，尝试把二进制当文本读会产生乱码与卡顿。

### 13.4 三种进入编辑器的方式

1. **工作区文件树**点文件；
2. **知识库列**的文件树；
3. **tab**（从 diff、搜索、冲突等入口打开）。

三种方式最终都走 `selectFile`。一个细节：编辑器的 root 解析要看文档从哪来（真实知识目录还是 `team-knowledge` 链接），否则 wiki link 会在两个路径下各开一个 tab（第 5 篇）。

---

## 14. 附录 B：diff 审阅器的细节

### 14.1 输入为什么是工具补丁

一个 agent 改文件的路径是：调 edit/write 工具 → 工具产生一个补丁 → diff 审查器渲染它。所以审查器的输入不是「旧文件与新文件」，而是「agent 做了什么操作」。

这个区分的价值：审查器可以显示「这是第 3 次 edit，改的是第 42 行附近」，而不是只显示两段文本的差异。对审查者来说，前者更有用。

### 14.2 hunk 导航

`HunkNavigator.tsx` 让人沿着 hunk 跳。一个 agent 可能一次改几十处，逐处看比从头看完整文件快得多。

这是一个小功能，但它对应了「审查 agent 的修改」这个真实工作流——而不是「看两个版本有什么不同」。

### 14.3 AST diff

`diff-ast.ts` 做 AST 级 diff（针对代码），`shiki-renderer.ts` 做语法高亮。AST diff 的好处是它能把「一个函数被移了位置」与「函数内容变了」区分开，而纯文本 diff 看起来都是一大块变动。

### 14.4 与编辑器的关系

DiffRenderer 可以嵌在 tab 里，也可以用 `SimpleDiff`（版本预览用）。两个东西的差别在粒度：`SimpleDiff` 是行级、轻量；`DiffRenderer` 是审阅器、带 agent 语义。

一个建议：新增「展示差异」的需求时，先问它是「审阅 agent 的修改」还是「比较两个版本」。前者用 `DiffRenderer`，后者用 `SimpleDiff`。

---

## 15. 附录 C：终端的细节

### 15.1 portable-pty 与 shell 集成

`portable-pty` 提供跨平台 PTY。`shell_integration.rs` 是 shell 集成脚本，用于让 shell 报告 cwd、命令开始/结束等事件。

为什么需要 shell 集成？因为一个「原始的 PTY」只能看到字节流，它不知道「用户现在在哪个目录」或「一条命令什么时候结束」。shell 集成把这些语义补上，这也是很多终端功能的基础。

### 15.2 终端注册表

`Registry` 是 `RwLock<HashMap<TerminalId, Arc<PtyHandle>>>`。每个终端有 id、shell、pid、status、exit code。

一个细节：`TerminalError::ShellNotFound` 被标记 `#[allow(dead_code)]`——说明这条错误在当前平台上不可达（或者暂时没有调用方）。这类标记在文档里要诚实：“代码在，但现在是死的”。

### 15.3 与 agent 的关系

终端与 agent 是两个独立的东西：agent 跑命令是通过工具（bash），而不是通过终端。终端是给人看的，agent 不一定使用它。

但是它们共享同一个 workspace 的目录。所以一个常见的场景是：agent 改完代码，人在终端里跑测试。这也是为什么终端要有回放：agent 可能刚在终端里跑了什么（如果它用了终端），或者用户自己跑了然后切走。

### 15.4 多终端与持久化

`registry.rs` 支持多个终端（`HashMap`）。每个终端有独立的 ring buffer。

它们不跨应用重启保留——终止 app 后终端都没了。这是符合直觉的（终端是进程，进程随父进程结束），但值得知道：如果你想让它保留，那是一个独立的设计问题（比如 tmux 式的外部分离）。

---

## 16. 附录 D：远程工具的深入

### 16.1 为什么用 MQTT 而不是直连

客户端（浏览器、未来的 iOS）不一定能被 daemon 直接访问：扩展在浏览器里、手机上可能在移动网络后面。而每一个客户端已经有一条到 EMQX 的长连接（presence、session live 都在上面）。所以「让 agent 找到用户的客户端」这个问题，答案是用现有的广播通道。

这与知识库的同步 hint（第 5 篇第 7 节）是同一个思路：**不要为了一件事引入一条新通道，先用已经在跑的那条。**

### 16.2 为什么没有 executor 的客户端不回复

MQTT 是发布/订阅：一条 rpc/req 会被该 member actor 的所有在线客户端收到。问题是「哪一个来执行」。

答案是：**有能力执行的那个回复，其他保持沉默。** 这要求每个客户端知道自己有没有这个 executor（`listLocalCapabilities()`）。daemon 发一条 RPC，可能扩展和桌面都收到了，但只有扩展注册了 `get_page_dom`，所以只有它回复。

这个设计的优点是它不需要 daemon 知道「哪个客户端有什么能力」。缺点是如果有两个客户端都有同一个能力，两个都会回复，daemon 需要处理这个情况（取第一个、或者要求互斥）。

### 16.3 remote_context_id 的生命周期

`remote_context_id` 是短命的：它在 prompt 开始时创建，映射到 `(runtime, ACP session, team, member actor)`。为什么不用 session id 直接做键？因为「谁发的这个消息」在一个多人 agent 会话里是会变的——Bob 的 turn 和 Alice 的 turn 应该路由到不同的人。

这就是设计文档里「多成员会话」那一节的要点：

> When Bob sends a turn, that turn's `remote_context_id` routes to Bob. When Alice later sends a turn in the same agent session, her turn gets a different `remote_context_id` and routes to Alice. The MCP server stays shared at host level; only the tool-call argument selects the target client.

这是一个很干净的设计：**身份是由「这一轮」决定的，不是由「这个会话」决定的。** 如果按 session 记，多成员会话里就永远只能路由到第一个人。

### 16.4 ACP host 复用与 MCP 刷新

OpenCode/Codex 保持一个进程级的 MCP 注册表（第 2 篇的 host 模式），所以 remote-tools MCP **不能被 per-session ACP resume 刷新**。daemon 确保 host 在 workspace 里启动时就带上 inherent MCP 配置；`session/resume` 不重新附加 remote-tools MCP。host 复用按 workspace 路径键，避免跨 workspace 的注册表污染。

这条与第 2 篇的「进程池键」是同一个问题：**共享的进程不能承载 per-session 的配置。** 一旦把 per-session 的东西塞进进程级注册表，就会出现串味。

### 16.5 添加一个工具

设计文档列了四步：

1. `apps/daemon/src/remote_tools/registry.rs` —— 名字、描述（要写支持哪些客户端）、schema；
2. `packages/app/src/lib/remote-tools/` —— executor + `registerPlatformExecutors`；
3. （如果是浏览器 DOM）`apps/extension/src/lib/browser-tools/`；
4. 测试 + 扩展会话里的 smoke。

一个实践建议：描述里写清楚「支持哪些客户端」。因为一個工具在桌面上可能没有 executor，在扩展上有——如果描述不写清楚，agent 会在错误的客户端上调用它，然后得到一个「无人回复」的超时。

---

## 17. 附录 E：扩展的深入

### 17.1 为什么打包 app 而不是 iframe

把一个公网托管的聊天页 iframe 进 side panel 看起来更简单，但它有三个问题：跨域 CSP、需要一个公网地址（self-host 部署才有）、以及 iframe 里的 app 与扩展的 service worker 通信麻烦。

直接打包聊天子集进扩展解决了这三个：没有网络依赖、没有跨域、`chrome.runtime` 消息是同一进程内的。代价是 app 必须能在纯浏览器环境跑（不能依赖 Tauri），这就是 `lib/embed/` 模式的由来。

### 17.2 三个部分的职责

| 部分 | 职责 |
|---|---|
| side panel | 聊天 UI（打包的 app 精华模式） |
| service worker | 管理 side panel；调 content script；转发消息 |
| content script | 按需注入当前 tab，读取选中文本 / 全文 + 标题/URL |

content script 是「按需注入」的，不是所有页面都注入——这既是性能考虑，也是权限考虑（扩展不应该在所有页面上都跑代码）。

### 17.3 与 remote-tools 的关系

扩展同时是两个角色的宿主：

1. **被动的上下文提供者**：把当前页面发给 agent；
2. **主动的工具执行器**：注册 `get_page_dom` 等 remote-tool executor。

一个重要的区分：**「把页面发给 agent」（扩展自己的功能）与「agent 要求读页面」（remote-tools）是两条不同的路径。** 前者是用户主动的，后者是 agent 主动的。它们最终可能调用同一段 DOM 读取代码，但触发路径、权限语义、流控都不同。

### 17.4 共享代码的约束

`lib/extension/` 同时被 app 与扩展编译，且有守卫测试。改这里的代码时，要想着「两边都会用」：不能假设 Tauri 存在，也不能假设 chrome API 存在。`lib/extension/` 的模块通常是纯逻辑（link-hover 解析、link-session 规则），而不是平台相关的。

---

## 18. 附录 F：动态 UI 的深入

### 18.1 为什么不是「让 agent 写 React」

让 agent 直接生成 React 代码并执行，能力上更强，但后果不可控：它可以调用任意 API、读任意状态、发任意请求。一个受限的组件目录把「agent 能做什么」变成一个可枚举的集合。

这个选择与 MCP 的「目录 + 安装制」、动态 UI 的「catalog 白名单」、HTML 预览的「CSP sandbox」是同一个思路：**当输入来自不可完全信任的生成器时，限制表达空间比事后审查可靠。**

### 18.2 catalog 的形状

`catalog.ts` 用 `schema.createCatalog` 定义组件，每个组件有：

- `props`：Zod schema，带 `describe`（这些描述会进提示词，告诉 agent 怎么用）；
- `slots`：子元素位置（`hasChildren` 对应 `slots: ["default"]`）；
- `description`：给 agent 的人类可读说明。

注意 `describe` 与 `description` 的分工：字段级的 `describe` 进 schema 的类型描述，组件级的 `description` 是整体说明。两者都会变成 agent 的上下文。

一个细节：注释里写着「0.19 起 catalog 通过 `schema.createCatalog(...)` 创建」，说明这个 API 变过一次。改这块时要确认版本，因为提示词生成与渲染分发都依赖它。

### 18.3 数据绑定

Input 等组件有 `valuePath`（数据绑定路径），Form 有 `id`（提交用）。这意味着动态 UI 不只是展示，还能收集输入并回传。

数据流的方向：agent 生成描述 → 用户填表单 → 提交回 agent。所以它本质上是「agent 向用户提问的一种形式」，比让用户打一段自由文本更结构化。

### 18.4 流式渲染

`streaming.ts` 支持边生成边渲染。这意味着一个复杂的 UI 会逐步出现，而不是等全部生成完。

与第 3 篇的流式文本是同一个模式，但更难：文本可以从左到右追加，而 UI 描述是一棵树，部分生成意味着部分树。实现上要么是「逐步补全树」，要么是「等结构完整再渲染，但提前展示骨架」。

### 18.5 与权限的关系

动态 UI 的 catalog 不是权限系统，而是**能力边界**。它保证「agent 生成的 UI 只能做这几个组件能做的事」，但它不判断「这个用户能不能看到这个 UI」。后者是会话权限的事。

这个区分很重要：不要把一个能力边界当成一个权限控制。同理，权限控制也不应该用「组件白名单」来实现。

---

## 19. 附录 G：版本历史的深入

### 19.1 版本从哪来

版本来自同步引擎记录的历史版本（`lib/history/oss-provider.ts` 的 `OssHistoryProvider`）。每次一个文件被推送，它产生一个新版本；`amuxc_file_versions` 保存历史。

所以版本历史的粒度是「一次同步」，不是「一次保存」。一个用户连续保存十次然后同步一次，只产生一个版本。这是合理的：版本的价值是「回到之前的状态」，而不是「记录每一次敲击」。

### 19.2 恢复的语义

`restoreFileVersion` 把某个历史版本恢复成当前内容。这是一次本地写入，然后由同步推送。

一个细节：恢复不是「回滚到那个版本」的元数据操作，而是「把那份字节重新写一遍」。所以它会产生一个新的当前版本，而历史仍然保留。这与其他「版本控制」系统的 revert 语义一致，也是安全的（不会丢失中间历史）。

### 19.3 UI 的分工

- `VersionList`：版本列表；
- `VersionPreview`：选中版本的预览 + 恢复按钮；
- `KnowledgeVersionHistory`（第 5 篇）：知识库文档的专门视图，去掉了文件列表（因为用户已经右键了具体文档，再让他选一次是重复提问）。

后面那条是一句很好的设计原则：**不要让用户回答他已经回答过的问题。**

---

## 20. 附录 H：与其它模块的关系

| 模块 | 交界 |
|---|---|
| 会话 | 编辑器可以「把选中的内容发给 agent」；动态 UI 在聊天里 |
| 知识库 | Markdown 编辑器 + wiki link + 版本历史 + 冲突 |
| 文件同步 | 版本历史的来源；冲突横幅 |
| Skills | 技能文件用同一套编辑器 |
| Apps | 代码用 CodeMirror + diff 审阅 |
| 权限 | fs-scope、终端 cwd、remote-tools 校验 |
| 扩展 | 共享 `lib/extension/`；提供 remote-tool executor |

一个总结：**这一篇的能力都是「工作面」**，而会话是「协作面」。工作面服务于「我把东西做好」，协作面服务于「我们一起把事情做好」。两者不可以相互代替：一个只有会话的系统不能改文件，一个只有工作面的系统不能协作。TeamClu 的价值恰恰在于它把两者放在同一个壳里。

---

## 21. 附录 I：常见问题

**Q：TeamClu 是 IDE 吗？**
A：不是。它有编辑器、终端、diff，但目的是审查与接手 agent 的产物，而不是从零写项目。没有调试器、没有项目管理、没有构建配置 UI。

**Q：为什么有专门的 diff 组件而不是用现成的？**
A：因为现有库都是「比较两个文件」，而我们需要的是「展示 agent 做了什么」。后者需要工具调用语义（第几次 edit、哪个工具）。

**Q：agent 改了文件，我的光标会跳吗？**
A：不会。只 dispatch 变化的那一段，不是全量替换。

**Q：终端关了还会保留输出吗？**
A：切走再切回会回放（8 MiB 环形缓冲），但关闭 app 后终端进程会结束，不跨重启保留。

**Q：远程工具需要装扩展吗？**
A：需要。`get_page_dom` 的 executor 在扩展里注册。没有 executor 的客户端不回复。

**Q：agent 能直接控制我的浏览器吗？**
A：目前只能读页面（`get_page_dom`）与显示导航链接（`show_page_nav_links`）。点击/填表是明确的非目标（YAGNI）。

**Q：动态 UI 安全吗？**
A：它只能使用 catalog 里的组件，不能执行任意代码。但它不判断权限，那是会话权限的事。

**Q：HTML 预览会执行脚本吗？**
A：在 sandbox 里，CSP 显式设置。

**Q：为什么版本粒度是「一次同步」？**
A：因为版本来自同步引擎的历史记录。它的价值是回到之前的状态，不是记录每一次敲击。

**Q：能不能在扩展里用完整桌面功能？**
A：不能。扩展只嵌入聊天子集；workspace / terminal / git / MCP / 文件编辑都明确排除。

**Q：前端校验能当安全边界吗？**
A：不能。真正的强制在 daemon/Rust 侧。前端的校验只是体验。

---

## 22. 附录 J：术语

| 术语 | 含义 |
|---|---|
| EditorProps | 三种编辑器的统一接口 |
| agent-edit-diff | 局部 diff（PERF-17） |
| git gutter | 相对 HEAD 的增删行 |
| CSP sandbox | HTML 预览的隔离 |
| hunk | diff 里的一个连续改动块 |
| AST diff | 语法树级差异 |
| PTY | 伪终端 |
| ring buffer | 终端回放缓冲 |
| allowed roots | 终端 cwd 的白名单 |
| remote-tools | agent 侧、客户端执行的 MCP 工具 |
| remote_context_id | 一轮 turn 的目标客户端销 |
| executor | 客户端的工具实现 |
| side panel | Chrome 侧边栏 |
| catalog | 动态 UI 的组件目录 |
| valuePath | 动态 UI 的数据绑定 |

---

## 23. 附录 K：五条不变量

1. **agent 编辑只 dispatch 变化段。** 全量替换会丢光标、重建所有行。
2. **终端 cwd 必须在白名单下。** 没有根就没有终端。
3. **远程工具校验 fail-closed。** requester 必须是 session agent 且 participants 已加载。
4. **动态 UI 只能用在 catalog 里的组件。** 不是权限，是能力边界。
5. **前端校验不是安全边界。** 强制在真正执行的一侧。

这五条对应了本文里五处看起来保守的设计。它们共同回答一个问题：**当 agent 能驱动你的机器时，什么不能让它做？**

---

## 24. 附录 L：改动检查清单

1. 新编辑器能力需要每个编辑器都实现吗？还是可以放共享层？
2. agent 修改时的 dispatch 还是局部的吗？
3. surrogate pair 还会被切开吗？
4. 新终端能力会不会绕过 cwd 校验？
5. 新 remote tool 的 executor 在哪些客户端注册？描述里写了吗？
6. 新 remote tool 会跨会话调用吗？校验还 fail-closed 吗？
7. 动态 UI 新组件是否进了 catalog（含 describe）？
8. 渲染外部内容是否在 sandbox + CSP 里？
9. `lib/extension/` 改动是否两边都能编译？
10. 新编辑器/视图是否 lazy？

---

## 25. 附录 M：变更记录

| 变动 | 影响章节 |
|---|---|
| 新增 remote tool | 5、16 |
| 新增动态 UI 组件 | 7、18 |
| 扩展支持新客户端 | 6、17 |
| 编辑器换库 | 1、13 |
| 终端持久化（tmux 式） | 15.4 |
| 版本历史粒度改变 | 19 |
| 新安全边界（如 webview 作用域） | 8 |

一条写作约定：这篇容易写成「编辑器功能列表」。它不是。它的重点是**「人在回路里」这个前提**——每个能力都是为了让 agent 的产出可被人审查、接手、修正。丢了这个前提，这些功能就退化成「一个简陋的 IDE」。

---

## 26. 附录 N：本地操作能力的边界

把这一篇里的四个能力放在一起，会看到一个共同点：**它们都能在用户的机器上产生副作用。** 编辑器写文件、终端跑命令、远程工具读页面、动态 UI 渲染界面。四个里面有三个需要真正的安全边界。

### 26.1 谁能触发

| 能力 | 触发者 | 权限判断在哪 |
|---|---|---|
| 编辑器写文件 | 人直接编辑 / agent 改 | 文件操作权限（前端 + Rust） |
| 终端 | 人（快捷键） | 桌面进程 cwd 白名单 |
| 远程工具 | agent（经 MQTT） | 客户端 fail-closed 校验 |
| 动态 UI | agent（在聊天里） | catalog 能力边界 |

注意「触发者」这一列：**终端是人触发的，远程工具是 agent 触发的。** 这是它们安全模型截然不同的原因。一个人自己开终端跑命令不需要额外校验（他已经有 shell 了）；agent 让客户端跑东西就必须证明「这个 agent 属于这个会话」。

### 26.2 为什么远程工具的校验这么严

因为 MQTT 是一个**广播**通道。daemon 发一条 rpc/req，该 member actor 的所有在线客户端都收到。如果没有校验，一个成员就可以向另一个成员的 RPC 主题发消息，冒充 agent 让它执行浏览器工具。

`validate-request.ts` 的两道检查：

1. requester 必须是 actor directory 里的 agent（不是 member、不是 external）；
2. requester 必须是该 session 的 participant。

第二道是关键的：一个 agent 属于某个会话，不代表它属于你正在参与的会话。这就是为什么 `ensureParticipants` 是必需的。

### 26.3 「fail-closed」的具体含义

`isAllowedRemoteToolRequest` 在两个地方返回 false：

- 找不到 participants；
- participants 为空。

这不是「加载失败」的处理，而是「未知即拒绝」。它与知识库 ACL 的「默认关闭」是同一个选择：**在黑名单下，「忘加规则」的后果是泄露；在白名单下，「忘加规则」的后果是有人用不了。前者不可接受，后者可修。**

### 26.4 一个容易忽略的边界

编辑器的一个能力是「把选中的内容发给 agent」（`sendAgentPromptInActiveSession`）。这是一个**从人到 agent** 的方向，与远程工具的**从 agent 到人**方向相反。

两个方向的安全考虑不同：

- 人到 agent：内容是你自己选的，风险在于你可能无意中把敏感内容发给了一个错误的会话；
- agent 到人：内容不是你选的，风险在于 agent 可能不是你以为的那个。

本文的四个能力里，只有终端与远程工具需要真正的强制；编辑器与动态 UI 的危险性来自「内容来源」而不是「执行」。分清这一点，就不会在不需要的地方加校验（体验变差），也不会在需要的地方漏掉（安全面）。

---

## 27. 附录 O：这块的演进史

把四个能力的来历排一下：

| 能力 | 先长出来的是 | 后来补的 |
|---|---|---|
| 编辑器 | Markdown / Code 两种 | agent 编辑的局部 diff（PERF-17） |
| diff | 通用差异 | agent 工具补丁语义 |
| 终端 | PTY + 基本交互 | 8 MiB 回放 + cwd 白名单 |
| 远程工具 | `get_page_dom` | `show_page_nav_links`（daemon-local） |
| 动态 UI | 组件目录 | 流式 + 数据绑定 |

一个规律：**每一项的「后来补的」都是为了回答「agent 在用的时候怎么办」。** 这不是巧合，而是因为这块的定位就是「人如何与 agent 一起工作」。最初的功能都是「人能做的事」，后来补的都是「agent 也能做，且人能看见」的部分。

这也解释了为什么这块的文档需要单独写一篇：它的演化方向与其它模块不同。其它模块是「从无到有」，这块是「从人用扩到人机共用」。

---

## 28. 附录 P：为什么「审查」比「编辑」难

这一篇里最重的两个组件是 diff 审阅器和 agent-edit-diff。它们都在解决「审查」问题，而不是「编辑」问题。为什么审查更难？

**编辑是一个本地的、同步的动作。** 你敲一个字符，文档变一下，你立刻知道结果。

**审查是一个跨时间的、异步的动作。** agent 改了十处，你看的时候可能已经过了十分钟，而且你不知道它为什么这么改。所以审查需要：

- **定位**：改在哪里（hunk 导航）；
- **意图**：为什么改（agent 的操作与说明）；
- **对比**：与什么相比（git HEAD、上一个版本）；
- **动手**：发现问题能直接改（同一个编辑器）。

这四件事里，只有第三件是传统 diff 工具能提供的。前两件需要 agent 语义，第四件需要编辑器与 diff 在同一个壳里。

这就是为什么 TeamClu 的 diff 不能直接用一个现成库，也是为什么编辑器与 diff 在同一个三栏里而不是两个应用。

---

## 29. 附录 Q：一个具体的协作场景

把四个能力串起来，看一个真实的工作流：

1. **人在会话里说需求。**
2. **agent 用 bash 工具改代码**（在 app 的 workdir 里）。
3. **人在编辑器里看文件**，看到「agent 改了这里」的高亮；光标不会跳。
4. **人打开 diff 审阅器**，沿着 hunk 跳，发现一处改得不对。
5. **人直接在编辑器里改掉**，保存。
6. **人在终端里跑测试**（上一轮 agent 跑的命令还能回放看）。
7. **agent 需要看线上页面长什么样** → 调 `get_page_dom` → 请求路由到当前用户的扩展 → 扩展读当前 tab 的 DOM 回传。
8. **agent 想让人选一个方案** → 生成一个动态 UI 表单 → 人在聊天里点选。

八步里，第 3、4、6、7 步都是「人机共用」的：它们是本文四个能力的核心场景，而 1、2、5、8 是普通的编辑与会话。

一个观察：**这八步里没有一步需要人「切换到另一个工具」。** 编辑器、终端、diff、浏览器上下文都在同一个窗口里。这是 TeamClu 「三栏工作区」这个形态的价值：它不是把已有工具包在一起，而是让「agent 干活 + 人审查」不需要上下文切换。

---

## 30. 一个总结：人在回路里

把整篇压缩成一句话：**这一篇的每个能力，都是为了让 agent 的产出可被人审查、接手、修正。**

展开是四个动作：

- **改**：编辑器，且 agent 的修改在局部 dispatch 与高亮里可见；
- **审**：diff 审阅器，输入是 agent 的工具补丁而不是两个文件；
- **接**：终端，带回放，让人接着 agent 跑的东西继续；
- **供**：远程工具与动态 UI，让人把上下文给 agent、让 agent 向人提问。

四个动作都是「人机共用」，而不是「人的工具」或「agent 的工具」。这解释了那些看起来奇怪的取舍：diff 是 agent-first 的、终端要能回放、动态 UI 是受限的、远程工具要 fail-closed。

最后一个与第 1 篇共享的结论：**三栏壳的价值不是把工具包在一起，而是让「agent 干活 + 人审查」不需要上下文切换。** 如果四个能力各自是一个应用，即使每个都做得更好，这个工作流也不成立。

---

## 31. 附录：渲染外部内容的统一纪律

本文里有两个地方在渲染外部来源的内容：HTML 预览与动态 UI。再加上一个相近的：知识库的 Markdown 渲染。三者面对的是同一类问题，但处理不同。

| 内容 | 来源 | 隔离方式 |
|---|---|---|
| HTML 预览 | 用户/agent 写的 HTML | sandbox + 显式 CSP |
| 动态 UI | agent 生成的 JSON 描述 | catalog 白名单 |
| Markdown | 用户/agent 写的 Markdown | 渲染器不执行脚本 |

三个共同点：

**一、都不执行任意代码。** HTML 在 sandbox 里，动态 UI 只能拼已有组件，Markdown 只是文本格式。

**二、隔离方式不同，因为表达能力不同。** HTML 能力最大（所以要 sandbox），动态 UI 能力受限（所以 catalog 就够），Markdown 能力最小（所以不需要额外隔离）。

**三、都不判断权限。** 它们保证「内容不能干什么」，但不判断「这个人能不能看」。后者是会话/团队权限的事。

这条纪律可以推广到任何「渲染来自不可完全信任的生成器的内容」的场景：**先确定它能表达什么，再选一个刚好够用的隔离方式。** 用 sandbox 去装一个只需要白名单的场景是浪费；用白名单去装一个需要表达 HTML 的场景是漏洞。

---

## 32. 附录：一个可以复用的判断

这篇的核心判断可以压缩成一句：**「这个能力是谁触发的？」**

- 人触发的（编辑器、终端）：危险来自内容，不来自执行；
- agent 触发的（远程工具、动态 UI）：危险来自执行，需要证明「这个 agent 属于这个会话」。

这条判断解释了四个能力安全模型为何截然不同：终端不需要额外校验（人已经有 shell），远程工具必须 fail-closed（MQTT 是广播的），动态 UI 用 catalog 限制表达能力，编辑器只需注意内容来源。

一个实用的方法：新增一个「能在用户机器上做事」的能力时，先问它由谁触发。人触发就问「他知不知道自己选了什么」；agent 触发就问「怎么证明这是它该做的」。两个问题导向不同的实现，而把它们搞反会造成要么体验变差（在不需校验的地方加校验），要么安全面变薄（在需要的地方漏掉）。

---

## 33. 附录：一句话总结

如果把整篇压成一句话：**这一篇的每个能力都是为了让人能审查、接手、修正 agent 的产物。**

编辑器让人改、diff 让人审、终端让人接、远程工具与动态 UI 让人把上下文给 agent。四个动作都是「人机共用」，这就是为什么它们在同一窗口里，而不是四个独立工具。

理解了这一点，就不会把这块做成「一个简化的 IDE」——那会把重心放到「怎么写」而丢掉「怎么看」。而 TeamClu 里 agent 负责写，人负责看。

---

## 34. 附录：最后三条提醒

**一、agent 编辑不要全量替换。** 会丢光标、重建所有行。

**二、终端要有回放。** 因为它是异步的，切回来不该是空白。

**三、agent 触发的能力要 fail-closed。** 「未知即拒绝」在这里比「加载失败就放行」安全得多。

三条都是这块历史付过代价的教训。

---

## 35. 附录：三句话的速记

1. 每个能力都是为了让人审查、接手、修正 agent 的产物。
2. agent 编辑只 dispatch 变化的那一段。
3. agent 触发的能力要 fail-closed。

---

## 36. 附录：读完这篇应该能回答的问题

- 为什么 agent 改文件光标不跳？因为只 dispatch 变化的那一段。
- 为什么有专门的 diff 组件？因为它要展示「agent 做了什么」，不是「两个文件的差异」。
- 终端关掉还有输出吗？切走再切回会回放；关 app 不保留。
- 远程工具需要装扩展吗？需要，executor 在扩展里。
- agent 能控制我的浏览器吗？目前只能读页面与显示导航链接。
- 动态 UI 安全吗？它只能用 catalog 里的组件，不执行任意代码。

---

## 37. 附录：最后一点：这块的判断标准

评价一个编辑器/终端/远程工具的新功能时，只问一个问题：**它让「人审查 agent 的产物」变容易了，还是仅仅让「人自己做事」变容易了？**

前者是这块存在的理由，后者应该去别的产品。这不是说后者没有价值，而是说它不属于 TeamClu 的定位——TeamClu 里 agent 负责写，人负责看。

---

## 38. 附录：三句话的速记（终）

**每个能力都为「人审查 agent 的产物」服务；agent 编辑只 dispatch 变化段；agent 触发的能力要 fail-closed。**

三句分别对应定位、性能与安全。再加一条：渲染外部内容一律不执行任意代码，隔离方式按表达能力选。

---

## 39. 结语

这一篇的四个能力（编辑器、终端、diff、远程工具）看起来是四件不同的事，但它们共同回答一个问题：**agent 干活的时候，人怎么参与？**

编辑器让人改 agent 的产物，diff 让人审 agent 的修改，终端让人接手 agent 跑的东西，远程工具让人把自己的上下文给 agent。每一个都是在为「人在回路里」提供一条路径。这也解释了那些看起来奇怪的取舍：diff 是 agent-first 的、终端要能回放、动态 UI 是受限的、远程工具要 fail-closed。它们不是为了功能更多，而是为了在「agent 主动、人审查」这个模式下不出错。

这一篇的四个能力（编辑器、终端、diff、远程工具）看起来是四件不同的事，但它们共同回答一个问题：**agent 干活的时候，人怎么参与？** 编辑器让人改 agent 的产物，diff 让人审 agent 的修改，终端让人接手 agent 跑的东西，远程工具让人把自己的上下文给 agent。每一个的设计都围绕「人在回路里」这个前提，而不是「人从零创作」。理解了这一点，就会明白为什么 diff 是 agent-first 的、为什么终端要能回放、为什么动态 UI 是受限的。

如果只从本文带走一句话，就带这句：**TeamClu 里 agent 负责写，人负责看。** 这一篇的四个能力都是在把前半句的产物变成后半句能看懂的东西。这一句话，也就是这一整篇存在的理由。
