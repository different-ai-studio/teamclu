# TeamClu 功能详解 · 第 1 篇：多端工作区客户端（三栏 Shell）

> 版本基线：当前 `main`（`package.json` v0.4.1-beta.51）。
> 读者：要接手这块的工程师。文中所有事实尽量带路径；与文档冲突时以代码为准。
> 关联：根 `AGENTS.md`（Web/Desktop 视觉规范）、`apps/ios/DESIGN.md`（iOS 视觉规范）、
> `docs/architecture/v2.md`、`CLAUDE.md`、ADR-0012。

---

## 0. 一句话定位与它不是什么

TeamClu 的客户端不是一个「聊天窗口」。它是以团队为单位、以**会话 / 应用 / 知识库 / 技能**为主对象的三栏工作台。这个判断决定了后面所有的 UI 决策：如果一个功能只是「把消息显示出来」，那它属于聊天；如果它有独立身份、独立权限、独立生命周期，那它就应该在第一列占一行、在第二列有列表、在第三列有工作面。

先把「不是什么」说清楚，事情会简单很多：

- **不是第二个 Slack。** 频道、表情回应、线程都是围绕「人在聊天」设计的。TeamClu 的一等对象是会话（人 + agent 的协作单元），线程只是 agent 回复的分叉。
- **不是第二个 Notion。** 知识库是团队 Markdown vault，不做行级协作，冲突走人工决策（详见第 5 篇）。
- **不是 IDE。** 有编辑器、有终端、有 diff，但它们的目的是「让 agent 改完的东西可被人审查」，不是「让人从零写代码」。
- **不是单机工具。** 没有团队就没有知识库、没有通道网关、没有共享模型——本地 agent 是唯一的离线能力。

这四条边界在代码里都能找到痕迹：编辑器没有项目管理、没有调试器；终端必须传 allowed roots；应用要有团队才能部署。

---

## 1. 客户端矩阵：一个协议，四种表达

| 端 | 路径 | 技术 | 状态 | 角色 |
|---|---|---|---|---|
| Desktop | `apps/desktop/` + `packages/app/` | Tauri 2（Rust）+ React 19 | 主客户端 | 完整工作台：本地文件、终端、编辑器、daemon |
| iOS | `apps/ios/` | SwiftUI + SwiftPM（`AMUXCore`） | TestFlight | 原生移动端，Outbox / dedup / libsql 同步 |
| Mobile | `apps/expo/` | React Native / Expo | onboarding + sessions | 跨平台移动形态 |
| Extension | `apps/extension/` | MV3 | 在售 | 浏览器侧，remote-tools 执行器 |

四端共享的只有**协议层**——`proto/`、`crates/teamclu-proto`、`crates/teamclu-types`、`crates/teamclu-transport`——和**同一个 Cloud API 契约**（`docs/openapi/teamclu-api.v1.yaml`）。UI 组件**不共享**，这是刻意的：桌面用 Tailwind、iOS 用 SwiftUI，抽一套跨端组件库会把两边的表达力都压到最小值。共享协议而不是共享 UI，是「多端」这件事唯一划算的做法。

**安装关系决定拓扑。** 装 TeamClu Desktop 会同时装 `amuxd` daemon，因此「本机即 agent host」开箱成立。移动端不带 daemon，它只是接入 agent network 的人类参与者——这解释了为什么桌面端是主客户端：它是唯一能承载 agent 的形态。

有一个容易被忽视的约束写在 `docs/architecture/v2.md`：同一个 user、同一个 team **只能有一台 Desktop 在线**（= 一个 daemon = 一个 agent 身份）。新的 Desktop 登录会强制踢掉旧的。多设备并存只对被动客户端（Mobile / Web）开放，因为它们不承载 daemon。这条约束的根源在 ADR-0002「actor 只运行一种 agent 类型」和 ADR-0006「daemon 状态按 team 归属」。

---

## 2. 三栏结构：一张图与三个落点

```
┌──────────────┬───────────────────┬──────────────────────────────────────────┐
│  NavRail     │  Second column    │  MainContent                              │
│  (第一列)     │  (第二列)          │  (第三列：ChatPanel + tab overlay)         │
│              │                   │                                          │
│  新会话按钮   │  会话列表 /        │  ┌────────────────────────┬────────────┐ │
│  会话         │  应用列表 /        │  │ 聊天 / 编辑器 / 应用数据 │ RightPanel │ │
│  联系人       │  团队资产列表      │  │ / 日志 / webview       │            │ │
│  知识库/技能   │                   │  └────────────────────────┴────────────┘ │
│  ─── 更多 ─── │                   │                                          │
│  想法/快捷方式 │                   │                                          │
│  MCP/环境变量  │                   │                                          │
│  Apps         │                   │                                          │
└──────────────┴───────────────────┴──────────────────────────────────────────┘
```

组件落点：

- 第一列：`packages/app/src/components/sidebar/NavRail.tsx`
- 第二列：`packages/app/src/components/sidebar/SidebarSecondColumn.tsx`
- 第三列：`packages/app/src/app/MainContent.tsx`，右面板 `components/panel/RightPanel.tsx`
- 窗口 chrome 与拖拽把手：`packages/app/src/app/chrome.tsx`

### 2.1 第一列是导航的唯一真相源

第一列**不渲染列表内容**（会话列表在第二列），它只回答「去哪」。导航状态收敛在 `useUIStore.sidebarFilter`，形状是一个判别联合：

```ts
{ kind: 'all' } | { kind: 'ideas' } | { kind: 'apps' }
| { kind: 'shortcuts' } | { kind: 'actors' }
| { kind: 'teamShare'; section: 'skills' | 'knowledge' | 'mcp' | 'env' }
```

用判别联合而不是「多个 boolean」是这里最关键的技术选择。多个 boolean 会允许非法状态（`showIdeas && showApps` 同时为真时该显示什么？），而判别联合让这种状态在类型层面就不存在。第二列的分发因此是一个必然穷尽的 `switch`，不需要任何优先级规则。

`NavRail` 把 filter 映射成若干 `TopEntry`：

- **常驻行**：会话（`Inbox`）、联系人（`ContactsNavEntry`）、团队共享的 skills 与 knowledge（`TeamShareNavSection`）；
- **折叠区「更多」**：想法（`Lightbulb`）、快捷方式（`Keyboard`）、MCP、环境变量、Apps（受 `features.apps` 远程开关控制）。

「更多」是一个**折叠交互**而不是又一个列表。它的视觉是一条带标签的横线，点击时 `moreExpanded` 翻转、`▾` 原地旋转。为什么是折叠而不是常驻？因为第一列的行数直接决定第二列能拿到多少空间，而常驻行必须永远可见。折叠把「每天用」和「偶尔用」分开，这是一个信息架构决策，不是省地方。

一个必须处理的边界：**别的东西也可能选中折叠区里的目的地**——默认 tab 设置、深链接、聊天里点过来的链接。所以有一个 `useEffect` 监听 `moreFilterActive`，一旦命中就自动展开，保证活动行永远不会藏在折叠的规则后面。这个 bug 的形态是「用户点了链接，界面看起来什么都没发生，其实第二列已经换了」，非常难排查，所以它值得一段专门的代码。

### 2.2 第二列是第一列的函数

`SidebarSecondColumn` 按 `sidebarFilter.kind` 分发渲染：

- `all` → `SessionListColumn`（会话列表，含分页、搜索、日期分组、置顶、活动徽标）；
- `apps` → 当前 app 的 session 列表（`AppSessionsColumn`）；
- `teamShare` → `TeamShareListColumn`（skills / knowledge / mcp / env 四个 section）；
- `ideas` → `IdeasView`；
- `shortcuts` → `ShortcutsListColumn`。

**第二列不允许有「两个形态、两套空状态」。** Apps 曾经有独立的 `AppsListColumn`，后来被删除：第一列已经完整呈现了应用列表，同一份数据在两列里各画一遍是冗余，而且会给出两个不同的空状态。这条规则值得记住，因为新增模块时很容易想「再开一个列表列」——判据是：它的子项是否有独立身份？Apps 有（每个 app 是一个 workspace + 一个部署目标），所以它在第一列内联展开；会话/知识库/技能没有（它们的子项就是第二列本身），所以不展开。

### 2.3 第三列：聊天常驻 + tab 覆盖

`MainContent` 的核心设计是：**`ChatPanel` 永远挂载，tab 激活时把它隐藏而不是卸载**。原因是聊天里持有大量本地状态（草稿、滚动位置、流式内容、正在跑的 turn），卸载会丢。

所以第三列实际是「聊天在底层，tab 覆盖在上层」。tab 有三种类型（`stores/tabs.ts`）：

| type | 内容 | 例子 |
|---|---|---|
| `file` | 文件编辑器 | Markdown / Code / 图片 / PDF |
| `webview` | 内嵌浏览器 | 已部署 app 的预览、外部链接 |
| `native` | 原生 React 视图 | 应用数据表、日志、冲突决策、版本历史 |

`TabContentRenderer` 按 target 字符串前缀分发 native tab。`lib/tabs/` 下每个域一个 opener（`app-tabs.ts`、`knowledge-tabs.ts`、`teamshare-target.ts`），这样文件树和侧栏都能打开 tab 而不用 import 视图本身——这一点在 `knowledge-tabs.ts` 的注释里写明了：「它们住在这里而不是视图旁边，是为了让文件树和侧栏能够到它们，而不必 import 视图本身」。

还有一个「direct section owns main column」的分支：当 sidebar 是 `teamShare`（非 knowledge）、`ideas`、`actors` 时，主列直接由该 section 拥有，不经过 tab 系统。原因是这些 section 的主内容本来就是「选中项的详情」，用 tab 反而多一层，而且会产生「同一个详情在 tab 和面板里各有一份」的重复。

---

## 3. 视觉语言：Editorial Calm

桌面端的视觉规范全部在根 `AGENTS.md`，token 在 `packages/app/src/styles/globals.css`，通过 Tailwind 4 的 `@theme inline` 暴露。核心是四条：

**第一，paper-feel 中性色。** `--background #fbfaf7`（应用背景）、`--paper #ffffff`（卡片/消息面）、`--panel #efece4`（侧栏）、`--selected #e7e2d6`（选中行）。这四个值构成整个界面的「纸感」层次。新增一个 surface 时必须能回答「它读作 paper、panel、background 还是 selected」——答不出来，通常说明需要一个新 token，而不是随手写个颜色。

**第二，品牌珊瑚色只做小面积强调。** `--coral #e85a4a`，一帧内最多两处，且只允许出现在：会话左条（2px）、未读徽标背景、发送按钮、AI pill 边框、AI 头像环 + 指示点。如果发现自己在别的地方（成功态、焦点环、链接、hover）伸手去拿珊瑚色，应该改回 ink/muted/border。

**第三，中文优先排版。** `--font-sans` 以 `PingFang SC` / `Noto Sans SC` / `Source Han Sans SC` 开头，拉丁字形回落到系统字体；`--font-mono` 用于时间戳、工具调用参数字符串、模型标识、版本号、键盘提示 pill。

**第四，信息密度高于典型聊天应用**，但每张卡片内部留白。字号刻度从 `text-[9.5px]`（mono 品牌 AI pill）到 `text-[15px]`（section 标题），并刻意保留原型里的非整数值（`13.5px`、`12.5px`、`10.5px`）——**不要四舍五入到 Tailwind 最近的档位**，那会破坏原型的密度。密度技巧是「先收紧行内边距和字号，再考虑缩写」。

### 3.1 actor 头像的稳定颜色

Actor 数据模型里没有头像颜色，所以字母回退盘从 `actorAvatarColor(actorId)`（`lib/actor/actor-color.ts`）取色：同一 actor 在全 app 内颜色稳定。palette 是饱和但克制的十色（coral、violet、green、amber、blue、plum、teal、olive、terracotta、slate）。**不要回落到 `bg-muted` 灰色**——那会让 actor 条看起来像死的。`display_name` 为空时回落到 Sparkles/User 图标，仍在彩色圆盘上。

agent（AI）actor 用圆角方形（`rounded`，不是 `rounded-full`），人类用圆形 + 右下角绿色在线点。这个形状差异在 20px 下就能分辨类型，不需要额外文字徽标。

### 3.2 窗口 chrome 的纪律

侧栏顶部条携带 macOS 红黄绿交通灯（真实原生，不是假的），右侧右对齐品牌标签。**这条里永远不放任何 logo 字形**——lobster 标记是隐式的。这条纪律的动机是：窗口 chrome 是所有窗口共享的，放一个品牌 glyph 会让每个窗口都变成「营销位」。

### 3.3 AI presence：适度区分

用户可见的规则是「适度区分——清晰但不抢眼」。具体：

- **不要**在窗口 chrome 放任何字形；
- **要**给 AI actor 头像加 1.5px 珊瑚色环 + 右下角珊瑚小点；人类头像同位置放绿色在线点；
- **要**给 AI 行加一个小的「AI」pill——侧栏列表里用描边珊瑚变体，线程里首次出现用实心珊瑚；
- **不要**把珊瑚色用在任何 AI 文本内容上。文本读起来是普通 ink，只有 meta strip 拿到珊瑚。

---

## 4. 状态管理：window-local 是默认

前端有 50+ 个 Zustand store（`packages/app/src/stores/`）。ADR-0012 定下的规则值得整段引用，因为它决定了很多后续决策：

> **默认 window-local。** 每个工作区窗口和本地 agent 面板有自己的 store graph 和自己的 `MqttLiveWiring`。一个 store 的状态不承诺跨窗口一致，也不需要一致。

**唯一例外是认证。** `lib/auth/session-store.ts` 通过 `BroadcastChannel` 在窗口间同步 session——因为「一个窗口登出、另一个还持有 token」是安全问题，不是观感问题。

**持久化默认是「偏好」。** 五个 store 用 zustand `persist()`（agent 默认工作区、agent 模型选择、自动化默认模型、client 模型 MRU、离线发送偏好），另有一些手写 `localStorage`（`header-preferences-store`、`git-settings`）。规则是：**新加一个 `localStorage.setItem` 默认就是偏好，last-writer-wins 可以接受**。如果一个值不能容忍 last-writer-wins，它就不该待在 `localStorage` 里——此时应该提出来，而不是顺手加 `BroadcastChannel`。

这条规则的价值在于：它把「跨窗口一致性」从默认变成需要论证的例外，避免每加一个值就决定一个没人问过的问题。ADR-0012 还记了哪些值值得提升为「设备共享状态」（当前团队、agent 默认工作区），但要求一个一个来、各自论证。

另一个重要约定：`lib/store-utils.ts` 是七个真正无域的原语之一，专门放 store 的通用工具。store 的测试与实现同目录（`stores/xxx.test.ts`），跨域的测试放在 `lib/__tests__/`。

---

## 5. 布局与响应式

- 面板宽度调整走 `useResizablePanels`（`hooks/use-file-editor-state.ts`），把手是 `ResizeHandle`（`app/chrome.tsx`）。主列的左右分割有最小/最大约束（右侧控制面至少 280px）。
- 窄窗口有专门的 `components/responsive/NarrowChatHeader.tsx`。
- 会话切换性能是一等约束：见 `docs/plans/2026-08-09-session-switch-perf-requirements.md`。会话列表的每一行都涉及 actor 头像、参与者缓存、同步状态，切换时的渲染成本不小，所以 `useSessionListStore` 的分页（50/页）和 `participantsBySession` 的懒加载都是性能设计的一部分。

`SessionListColumn` 还保留了一个右边缘槽位给「未读徽标」，但本地 schema 目前不追踪已读状态（没有 `last_viewed_at` / `read_marker`），Supabase 也没有。这是一个已知的未完成项：要真正做需要（a）在 `sessions` 加列或加 `session_read_marker` 侧表，（b）session-activate 时的写入 hook，（c）同步接线，（d）UI 渲染。卡片已经预留了位置。

---

## 6. 设置面板：code-split 的 26 个 section

`components/settings/Settings.tsx` + `section-registry.tsx`。每个 section 用 `React.lazy` 单独切 chunk：

```ts
const lazySection = (load, name) => React.lazy(async () => ({ default: (await load())[name] }))
const SETTINGS_SECTION_COMPONENTS: Record<SettingsSection, React.ComponentType> = {
  llm: lazySection(() => import('./LLMSectionRouter'), 'LLMSection'),
  knowledgeAcl: lazySection(() => import('./KnowledgeAclSection'), 'KnowledgeAclSection'),
  channels: lazySection(() => import('./ChannelsSection'), 'ChannelsSection'),
  automation: lazySection(() => import('./CronSection'), 'CronSection'),
  // …共 26 个
}
```

注释写明了原因：`Settings` 只在少数会话里被打开，静态 import 全部 26 个 section 会把 channels/cron/skills/LLM 整棵子树拖进启动 chunk。

设置页里还有一个反复踩过的坑：**设置页是模态 dialog，弹层必须传 `container`**，否则默认 portal 到 body 的弹层永远打不开。这条在 `KnowledgeAclSection` 的注释里被记着。

`section-registry.tsx` 的 ScrollArea 还有一段值得一读的注释：Radix 的 Viewport 会把 children 包进一个 `display:table; min-width:100%` 的 div，它会 shrink-to-fit 到内容的 max-content 宽度。任何不换行的后代（比如 `truncate` 的 URL）都会把那个 table 撑得比面板宽，然后被外层 `overflow-hidden` 裁掉。修法是强制 viewport 内层 `display:block`。这是一个典型的「第三方组件默认样式与宿主布局冲突」问题，改动时要小心不要把它改回去。

---

## 7. 快捷键

`components/shortcuts/ShortcutsSection.tsx` 是设置页里的快捷键表；`components/panel/ShortcutsPanel.tsx` 是主界面里的快捷面板。几个关键绑定：

- `⌘N`：快速新会话（`NavRail` 里监听，走 `createQuickSession`，目标由 `resolve-quick-chat-target` 解析为「本地 agent，否则有效默认 agent」）。失败时会弹 toast 并给出 `no_agent` 情况下的「设置默认 agent」动作，直接打开 `daemonGeneral` 设置页。
- `⌘↵`：发送。
- `⌃`` `：切换终端（`chrome.tsx` 的 `TerminalToggleButton`）。

键盘提示 pill 用 mono 字体、`text-[11px]`、faint 色——见 `AGENTS.md` 的类型刻度。

`NavRail` 的「会话」行还有一个隐藏功能：点击它兼作「看起来过期了」的兜底刷新，节流到 5 秒一次，重新拉会话列表第一页（云端 + 本地 hydrate）。这个设计的动机是：后台 daemon 可能在窗口未聚焦时同步过，而前端的 store 没有别的途径知道，所以「回到这个 tab」是最可能发现它过期的时刻。

---

## 8. 多端横向对比

| 维度 | Desktop | iOS | Expo | Extension |
|---|---|---|---|---|
| UI 框架 | React 19 + Tailwind | SwiftUI | RN | DOM |
| 承载 daemon | ✅ | ❌ | ❌ | ❌ |
| 本地 agent | 由 daemon 驱动 | ❌ | ❌ | ❌ |
| 本地文件/终端 | ✅ | 部分 | 部分 | ❌ |
| 编辑器 | Tiptap/CodeMirror | 原生 | 部分 | ❌ |
| 离线 | libsql 缓存 + outbox | SwiftData/libsql | 部分 | ❌ |
| 视觉规范 | `AGENTS.md` | `apps/ios/DESIGN.md` | — | `docs/chrome-extension-design.md` |

**两端视觉规范不可互相套用**：`apps/ios/DESIGN.md` 是 Hai 灰 / wabi-sabi 体系，与 Web 的 Editorial Calm 是两套语言。这是一个容易犯的错误——改 iOS 时去翻 `AGENTS.md`。

iOS 还有自己的一套同步语义（Outbox、dedup key、SwiftData/libsql 同步），见 `CONTEXT-MAP.md` 的 ios context 与 `apps/ios/Packages/AMUXCore`。它的 Cloud API 客户端是 `CloudAPIClient` / `CloudAPIRepositories`。`apps/ios/Packages/AMUXCore/Sources/AMUXCore/CloudAPI/`。

Expo 客户端的 Cloud API provider 是 `createCloudSessionsApi`（`apps/expo/src/features/sessions/cloud-api.ts`）。

---

## 9. `lib/` 分层约定

`packages/app/src/lib/` 是「一域一目录」。真正无域的原语只有七个：`utils`、`store-utils`、`base64`、`lazy-component`、`shared-module-lease`、`i18n`、`locale`。其余都归域：

```
actor/        谁在说话——身份、颜色、在线、提及
agent/        agent 身份、模型选择、运行时可达性与状态
apps/         Apps 功能（部署、数据浏览器、app 会话）
attachments/  上传、下载、图片处理
auth/         登录、token 存储、OAuth
backend/      Cloud API 客户端
cache/        Cloud API 行的本地 libsql 镜像
clawhub/      技能注册表类型
config/       构建配置、服务端配置、功能开关、平台、版本
cron/         桌面调度任务
daemon/       所有对 amuxd 的调用：发现、RPC、工作区、admin
diagnostics/  脱敏、探针、诊断 bundle、调试日志
dynamic-ui/   agent 编写的 UI 描述
e2e/          tauri-mcp harness 面
embed/        嵌入/侧栏聊天模式
extension/    浏览器扩展（含 link-hover / link-session，apps/extension 也编译它）
history/      版本历史 provider
knowledge/    知识树、wiki link、Obsidian 兼容
messages/     消息行、收件箱、发件箱展示、发送路径选择
mqtt/         broker 桥（Tauri / browser / worker）与诊断
opencode/     opencode 配置与模板
proto/        生成的 protobuf
remote-tools/ agent 可在用户浏览器里驱动的工具
roles/        role markdown 与 role skills
session/      会话：创建、列表、解析、fork、权限、工作区
session-export/  转录导出
skills/       skill 发现、frontmatter、自动跟随
stream/       流式管线——delta、持久化、恢复
sync/         Cloud API ⇄ 本地缓存行同步
tabs/         tab 模型
team/         团队、邀请、权限、skill 路径
teamclu/      agent runtime 协议（ACP 权限、runtime 命令）
telemetry/    Sentry、打分、用量、启动计时
terminal/     PTY 客户端
ui/           没有自己领域的展示助手
workspace/    工作区路径、gitignore、桌面文件读取
workspace-seed/  首启工作区说明
```

（完整列表见 `AGENTS.md`。）如果一个新文件看起来「没有域」，那通常说明它在做两件事。

`lib/<domain>/__tests__/` 放域内测试；`lib/__tests__/` 只放跨域测试或测试 root 模块的测试。

---

## 10. 后端边界

**`cloud_api` 是客户端唯一后端。** `supabase` 和 `pocketbase` 后端种类已从 `packages/app/` 移除，客户端代码里直接使用 `@supabase/supabase-js` 是禁止的，由守卫测试 `packages/app/src/lib/backend/__tests__/no-supabase-import.test.ts` 强制执行。

契约在 `docs/openapi/teamclu-api.v1.yaml`。新增业务端点的顺序固定：先定义契约 → repository contract（`services/fc/lib/repository-contract.mjs`）→ business-api 路由（`services/fc/lib/business-api.mjs`）→ supabase-repo passthrough（`services/fc/lib/supabase-repo.mjs`）→ FC 测试 → 接客户端 provider。

客户端的 provider 是 `CloudApiProvider`（`packages/app/src/lib/backend/provider.ts`），按模块拆成 `cloud-api/*.ts`（会话、消息、团队、knowledge-acl 等）。`getBackend()` 返回的接口是 UI 唯一能碰的。

这条边界的意义是：未来替换后端（MySQL、其它存储）发生在 FC 内部，客户端不需要重写。所以任何「先直连一下」的捷径都是在拆这条边界。

---

## 11. 构建、品牌与配置

- `build.config.*.json` 合并顺序：`build.config.json` → `build.config.${BUILD_ENV}.json` → `build.config.local.json`（git-ignored）。关键项是 `cloudApiUrl`。本地开发还可以用 `packages/app/.env.local` 的 `VITE_CLOUD_API_URL` 覆盖，但需要 rebuild。
- 多品牌/白标是 compile-time 的：品牌名与 logo 通过构建注入；主题调色板按品牌（`docs/specs/2026-06-12-*`）。`apps/daemon` 的 cache 目录也因此带 brand 后缀。
- 远程功能开关（`useFeatures` / `lib/config/remote-features`）控制 `features.apps` 这类能力的显隐——不是本地 flag，所以服务端可以按团队/环境灰度。

---

## 12. 测试

- 单元：`pnpm test:unit`（Vitest），`packages/app/src/**/__tests__/` 与 `lib/<domain>/__tests__/`。
- E2E：`pnpm test:e2e`（tauri-mcp harness），`tests/v2-e2e/pr` 是 PR 子集，`nightly` 是夜间子集；旧的 `tests/e2e|functional|regression` 仍可用 `test:e2e:legacy` 跑。
- 性能与压力：`vitest.config.stress.ts`。
- iOS：`pnpm ios:test:core`（SwiftPM）、`pnpm ios:test`（UI）。
- 扩展：`pnpm test:extension`。

`tests/v2-e2e/` 是当前的 E2E 主路径。它依赖已构建的 app + tauri-mcp，所以本地跑之前要先 build。

---

## 13. 关键文件索引

```
packages/app/src/
  App.tsx                          应用根
  app/MainContent.tsx              第三列 + tab 分发
  app/chrome.tsx                   窗口 chrome、拖拽把手、终端按钮
  app/shell-hooks.ts               外壳级 hook
  app/webview-ui-store.ts          webview 的 UI 状态
  components/sidebar/NavRail.tsx   第一列
  components/sidebar/SidebarSecondColumn.tsx
  components/sidebar/SessionListColumn.tsx
  components/sidebar/AppsNavSection.tsx
  components/sidebar/TeamShareNavSection.tsx
  components/sidebar/ContactsNavEntry.tsx
  components/sidebar/NewChatSplitButton.tsx
  components/panel/RightPanel.tsx  右面板
  components/tab-bar/TabBar.tsx
  components/tab-bar/TabContentRenderer.tsx
  components/settings/section-registry.tsx
  stores/ui.ts                     导航/布局状态
  stores/tabs.ts                   tab 状态
  lib/tabs/*.ts                    各域 tab opener
  lib/backend/provider.ts          CloudApiProvider
  lib/actor/actor-color.ts         actor 颜色
  styles/globals.css               design tokens
apps/desktop/src/                  Rust/Tauri 侧
  commands/                        IPC 命令（oss_sync/、terminal、cron/…）
  terminal/                        PTY
  local_cache/                     libsql 镜像
  commands/introspect_api.rs       loopback HTTP（给 MCP sidecar）
```

---

## 14. 常见坑

1. **改 iOS 不要照搬 `AGENTS.md`。** 两端是两套视觉语言。
2. **`ChatPanel` 不能卸载。** 它是第三列的常驻底层，tab 只覆盖。
3. **折叠区里的目的地要自动展开。** 默认 tab / 深链接 / 聊天内链接都可能指向它。
4. **设置页弹层要传 `container`。** 模态 dialog 里默认 portal 到 body 的弹层打不开。
5. **不要给同一份数据开第二个列表列。** Apps 的 `AppsListColumn` 就是这么被删的。
6. **新持久化默认是偏好，可以 last-writer-wins。** 不能容忍时才需要论证。
7. **不要直接 import `@supabase/supabase-js`。** 守卫测试会挂。
8. **新字号不要四舍五入。** 原型里的 13.5/12.5/10.5 是有意的。
9. **新 surface 先问它读作哪个 token。** 答不出来就提新 token，别写死颜色。
10. **珊瑚色一帧最多两处。** 多了品牌感就变成廉价感。

---

## 15. 会话列表：第二列里最重的组件

`SessionListColumn.tsx` 是整个 shell 里逻辑最密的组件，值得单独看。它的职责有六层：

**第一层，分页。** `useSessionListStore` 按 cursor 分页（`loadFirstPage` / `loadMore`，每页 50），按 list kind 分别追踪 `hasMore` / `nextCursor`。底部渲染 Load-more 按钮（`sidebar.loadMoreSessions`）。这条是明确从「未做」变成「已做」的能力，不要再重新规划。

**第二层，分组。** 卡片按日期分隔：今天、昨天、本周、更早。分隔本身是小号大写 faint 文本加一个 mono 计数（`今天 · 4`）。用 mono 显示计数是为了让数字对齐，视觉上不跳。

**第三层，卡片结构。** 每张卡片是「标题（单行截断）+ 两行预览 + 头像簇 + 未读槽位」。活跃卡片是 paper 白底 + 2px 珊瑚左条；非活跃是透明底、无左条；hover 是极轻微的加深，**不引入阴影**。这条「hover 不加阴影」是有意的——阴影会让列表看起来像一堆浮起来的按钮，而这里的目标是「纸上的行」。

**第四层，头像簇。** 参与者头像以 -5px 重叠排列，后面跟「N 位」。`participantsBySession` 是懒加载的。已知缺口：这个缓存**永远不会失效**——realtime envelope handler 在 `App.tsx` 看到 `session_participant` 变化时应该去戳这个缓存，今天没有，所以用户会看到过期的头像直到列重新挂载。

**第五层，活动徽标。** `useSessionStore.sessions` 仍然喂 `pinnedSessionIds`、`highlightedSessionIds`、`activeSessionId` 和活动徽标。这是双 store 遗留层：列表的真相源已经是 `useSessionListStore.rows`，但上面这些字段还在旧 store 上。要彻底去掉冗余，得先把它们迁到 v2 store。

**第六层，过滤。** 定时任务产生的 session 被 `isScheduledSession` 识别并可以从计数里排除。这个判断需要 `cronSessionIds`，而它来自 `useCronStore`，所以 NavRail 的会话计数天然依赖 cron store 已经加载。

把这六层分开看，就能理解为什么会话切换性能是一个独立课题：一次切换可能同时触发文件加载、参与者加载、消息加载、stream store 切换。`docs/plans/2026-08-09-session-switch-perf-requirements.md` 记录的就是这条链路的预算。

---

## 16. 启动、冷启动与首启向导

桌面端的启动路径分两段：Tauri 进程启动（Rust），和前端挂载（React）。

**Rust 侧**要做的事包括：解析 brand、确定 daemon 是否在跑、必要时拉起 daemon、注册窗口、装 IPC 命令。`apps/desktop/src/commands/` 是命令的集合，按域分目录。一个容易忽略的点：`apps/desktop/tauri.conf.json` 的 bundle resources 会 glob `binaries/{cursor,claude}-bridge/**/*`，而 `binaries/` 完全 gitignored——所以 fresh checkout 上这个 glob 匹配不到任何东西，`tauri-build` 会在任何 crate 编译之前就失败。仓库用 `scripts/tauri-cli.js` 包装器解决了这个问题：真构建时先 stage bridge 树，纯分析运行时去掉 glob。**永远走 `pnpm rust:check` / `pnpm rust:build` / `pnpm tauri:*` 包装器，不要直接用裸 `cargo`。**

**前端侧**的启动成本主要在两个地方：settings 子树（已用 code-split 解决）和图标库。这也是为什么 `lazy-component.ts` 是七个 root 原语之一——它把「按需加载」变成一个有统一封装的机制，而不是每个组件自己写 `React.lazy`。

**首启向导**（onboarding）在产品上是「Language → 登录 → daemon wizard（start-daemon → install-runtime → mint-invite → …）」。关键设计是：**runtime 在登录后、绑定后安装**，daemon 的 doctor 是唯一真相，没有 `setup-ok` 缓存；老版本升级上来的机器在第一次 refresh 时补装。这条来自 ADR-0015：因为 pi 需要 Node，而「每个 pi 装了但起不来」最后都是「哪个 Node」，所以 amuxd 自己托管 Node 与 pi，路径是常量，不用用户机器上的任何一个。

开发时可以用 `pnpm tauri:dev -- --skip-setup --skip-daemon-onboarding` 跳过首启向导。

---

## 17. 多窗口与嵌入模式

桌面端支持多窗口。每个窗口是一个独立的工作区视图，有自己的一份 window-local store（见第 4 节）。`MainContent`、`NavRail`、`MqttLiveWiring` 都会在每个窗口各挂一份。

**嵌入模式（embed）** 是另一回事：它在侧栏/面板里嵌一个聊天实例，而不是完整三栏。判据在 `useUIStore.embedMode`。嵌入模式下，`NavRail` 会隐藏「想法」和「快捷方式」这两个依赖完整主列的目的地，因为嵌入面板没有足够的空间承载它们。`lib/embed/` 是这个模式的域目录。

多窗口 + 多 store 的一个直接后果是：**同一份 UI 在两个窗口里可能显示不同的时间戳**，因为各自的 store 刷新节奏不同。这是被接受的——ADR-0012 明确说「一个 store 的状态不承诺跨窗口一致，也不需要一致」。唯一不能容忍不一致的是 auth。

---

## 18. 国际化

`lib/i18n.ts` 与 `lib/locale.ts` 是两个 root 原语，locale 资源在 `packages/app/src/locales/{en,zh-CN}.json`。

几条约定：

1. **中文优先。** 默认与首要语言是 `zh-CN`，`en` 是补充。
2. **中文专用标签保留原型措辞。** 例如「会话」「想法」「团队」「等待我」——不要为了「统一」把它们改成英文再翻回来。
3. **混合语境的字符串用现有 `t()` key。** 不要凭空发明 en-US 占位。
4. **`docs/i18n-audit.md` 是审计记录**，改文案前值得扫一眼。

一个具体的注意点：`NavRail` 里的 `t('sidebar.more', 'More')` 这种「第二个参数是 fallback」的写法在仓库里很常见。它的好处是即使 key 缺失也不会显示成 key 本身；坏处是缺失的 key 不会报错。所以新增文案时最好同时补 `zh-CN.json` 和 `en.json`。

---

## 19. 可观测性与错误处理

三件事：

**Sentry。** `lib/telemetry/` 负责 Sentry 初始化、打分、用量、启动计时。脱敏逻辑在 `lib/diagnostics/`。

**错误边界。** `components/ErrorBoundary.tsx` 包住主内容，避免一个组件崩掉整个窗口。

**诊断 bundle。** `lib/diagnostics/` 里有一个「症状驱动诊断」的设计（`docs/specs/2026-09-03-symptom-driven-diagnostics-design.md`）：不是让用户描述问题，而是给一组症状（比如「agent 不回话」「同步不动」），每个症状对应一组探针。桌面端还有 `DiagnoseSessionButton`（聊天里）和 `DiagnosticSymptomPanel`（设置里）。

日志方面有一条纪律：**脱敏发生在写入日志之前，而不是展示时。** 所以 `lib/diagnostics/redaction` 的调用点是数据出口，不是 UI 层。

---

## 20. 本地缓存与离线

桌面端有一份 libsql（SQLite）文件，在 `<brand home>/local-cache.db`，镜像 Cloud API 的行：actors、sessions、participants、messages、ideas、claims、submissions、outbox、watermarks。命令前缀是 `local_cache_*`，全部按当前 team 做门禁。

它的目的有两个：**离线可读**，以及**降低 Cloud API 压力**。UI 读到的是缓存 + 云端增量合并后的结果，所以「哪些是缓存、哪些是实时」在 store 层是合并过的，调用方不需要知道。

发消息走 **outbox**：离线时写入 outbox，联网后由同步器发出。相关的偏好（离线是否自动发送）存在 `offline-send-preference-store`。

一个容易混淆的点：**本地缓存不是真相源。** Cloud API 才是。缓存的价值是「在云端不可达时仍能读」，不是「替代云端」。所以任何依赖缓存做权威判断的逻辑都是错的。

---

## 21. 版本、升级与发布

桌面端版本号必须**五处一致**：`package.json`、`apps/desktop/Cargo.toml`、`apps/desktop/tauri.conf.json`、`apps/daemon/Cargo.toml`（bundled amuxd sidecar）、以及 `Cargo.lock` 里的 `teamclu` 与 `amuxd` 条目。`Cargo.lock` 不是可选的：CI 用 `--locked` 构建 daemon，lockfile 与 manifest 不一致会直接失败。验证方式是 `cargo metadata --locked`。

发布流程、iOS TestFlight 流程、以及自动部署的触发条件都在 `CLAUDE.md`。自动更新由 `components/updater/` 与 `components/version/` 承载，`lib/config/version` 提供版本信息。

一个产品层面的细节：macOS 用户下载未签名包会遇到「damaged」提示，解决办法是 `xattr -cr /Applications/TeamClu.app`。这个提示来自 Gatekeeper 的 quarantine 属性，不是真损坏。

---

## 22. 无障碍与键盘导航

仓库没有专门的 a11y 规范文档，但代码里有几个稳定约定：

- 图标按钮一律带 `title` 或 `aria-label`；
- 可点区域用真实 `<button>`，不是绑 `onClick` 的 `<div>`；
- 侧栏可交互区域有 `sidebar-interactive-cursor.ts` 统一光标；
- 键盘快捷键集中注册，避免散落在组件里；
- 焦点环不要用珊瑚色（见珊瑚色白名单）。

这些约定不完整，但新增 UI 时按这几条走，至少不会让键盘用户被完全卡住。

---

## 23. 走查：新增一个「发布面板」需要动哪些地方

用一个假想功能收尾，把上面所有规则串起来。假设要新增「发布面板」，列出哪些文件必须改：

1. **导航状态**：在 `stores/ui.ts` 的 `sidebarFilter` 判别联合里加一个 `{ kind: 'releases' }`。这一步会让 TypeScript 把所有需要处理它的地方暴露出来。
2. **第一列**：在 `NavRail.tsx` 加一个 `TopEntry`（放「更多」折叠区，除非它是每天用的）。
3. **第二列**：在 `SidebarSecondColumn.tsx` 加分支，渲染一个新的 `ReleasesListColumn`。**不要**另开一个「列表列 + 详情列」的双列结构——详情属于第三列。
4. **tab opener**：新建 `lib/tabs/release-tabs.ts`，导出 `openRelease(id)`，target 用 `<kind>:<id>` 形状。
5. **主列分发**：在 `TabContentRenderer.tsx`（或 `MainContent.tsx` 的 native 前缀分发）注册新前缀。
6. **数据**：在 `lib/backend/cloud-api/` 加一个模块 + 在 `lib/backend/types.ts` 加类型；**不要**直接 fetch `cloudApiUrl`。
7. **契约**：如果它需要新端点，先改 `docs/openapi/teamclu-api.v1.yaml`，再按第 10 节的六步走。
8. **文案**：`zh-CN.json` 与 `en.json` 各加一组 key。
9. **测试**：store 测试与组件测试；如果是跨域的就放 `lib/__tests__/`。
10. **视觉**：用现有 token；如果确实需要一个新 surface 语义，先提 token 再加。

这份清单的价值在于：它把「加一个功能」变成一个可枚举的改动面。如果发现某一项无处可放，那通常说明当前架构缺了一个抽象，而不是「就地在组件里写一下」。

---

## 24. 组件实现约定

组件目录按域分（`components/chat/`、`components/apps/`、`components/settings/`…），而不是按类型分（`buttons/`、`cards/`）。这条和 `lib/` 的分层是同一个思路：一个组件属于它的域，而不是「它长什么样」。

几条具体约定：

1. **className 用 `cn()` 合并**（`lib/utils.ts`），不要手写字符串拼接。条件类名的可读性和去重都靠它。
2. **不要写内联 `style`**，除非是为了匹配原型里的紧密数值（5px、9.5px 等）。原型里那些非整数值被刻意保留，写进 `style` 是允许的，但其它的尺寸/颜色一律走 token。
3. **颜色绝不硬编码**。用 `bg-paper`、`bg-panel`、`text-faint`、`text-ink-2`、`bg-coral` 这类由 `@theme inline` 暴露的类。
4. **图标用 `lucide-react`**，尺寸通过 `className`（`h-4 w-4`）而不是 props。
5. **测试钩子用 `data-testid`**，不要用文案匹配——文案会随 i18n 变。
6. **可点区域用真实 `<button>`**，并用 `type="button"` 避免意外提交。
7. **大组件拆分的判据不是行数，而是「它是否同时拥有数据和展示」**。拥有数据的部分应该进 store 或 hook，组件只做展示。

`KnowledgeSyncFooter` 是一个正面例子：它把「同步状态 → 一行文案」的优先级映射集中在一个 `useMemo` 里，渲染层只负责画。这样文案优先级可以被单独测试，而不是埋在 JSX 里。

---

## 25. 性能预算与瓶颈

仓库里没有一份统一的性能 spec，但有几个明确的约束点：

**会话切换。** `docs/plans/2026-08-09-session-switch-perf-requirements.md` 记录了预算。一次切换会触发：文件加载、参与者加载、消息加载、stream store 切换、流式订阅重连。任何一项慢都会让切换看起来卡。所以参与者是懒加载的，消息是分页的，stream 有独立的 store。

**消息列表渲染。** 消息行带着头像、状态点、token 用量、工具调用卡片。长会话必须避免全量重渲染。这也是为什么工具调用卡片的解析被拆到了 `components/chat/tool-calls/`。

**流式渲染。** 流式内容来自 `useV2StreamingStore`，built from the delta buffer。**不要**在流式期间写 `msg.content`，也不要用「最长内容」策略在完成时合并。唯一的 reconcile 点是 `deriveAgentReplyContent`（`lib/agent/agent-reply-transcript.ts`），且 `pickCanonicalAgentReplyText` 只能被它 import（有守卫测试）。这条纪律的存在是因为历史上多源内容合并导致过消息内容跳变。

**上下文用量。** `ContextUsageBadge` 与 `MessageTokenUsage` 的更新频率如果跟着每个 delta 走会非常贵，所以它们按消息完成事件更新。

---

## 26. 安全与权限边界（前端侧）

前端不是安全边界，但它是「用户以为自己能做什么」的边界，所以有几处必须做对：

**webview 的文件系统与网络作用域。** ADR-0009 定了范围。`lib/fs-scope.ts` 是前端的路径校验入口。任何一个「让用户选一个目录」的功能都必须过它。

**remote-tools 的 fail-closed 校验。** `lib/remote-tools/validate-request.ts` 会拒绝一个 `RemoteToolInvoke`，除非 `requester_actor_id` 是一个 session agent **且** participants 已加载。多成员会话里，谁发出的 turn 就路由到谁的设备，所以这个校验不能省。`rpc-server.ts` 的 handler 会先 `ensureParticipants`。

**扩展的 link-session。** `lib/extension/` 同时被 app 和 `apps/extension` 编译，所以有一个守卫测试确保两边行为一致。

**IPC 错误带 code。** ADR-0013：IPC 错误必须携带一个 code，而不是只有 message。这样前端能按 code 做分支（比如 `PathForbidden`），而不是正则匹配文案。

---

## 27. 数据流：前端 ↔ daemon ↔ Cloud

把三条链路画在一起，能避免很多「这个操作应该走哪」的困惑：

```
用户动作
  ├─ 业务数据（会话/消息/团队）──> Cloud API /v1 ──> Supabase
  ├─ 实时（消息/在线/RPC）──────> MQTT amux/… ──> EMQX
  ├─ 本地能力（文件/终端/PTY）───> Tauri IPC ──> Rust
  ├─ agent 能力（起 runtime/发 prompt）─> daemon HTTP/RPC ──> pi
  └─ 同步（knowledge/documents）──> daemon（不是前端）──> FC /v1/sync/* ──> OSS
```

两个容易搞混的边界：

- **同步不由前端发起。** 前端的「Sync now」只是给 daemon 一个信号，真正的扫描/上传/下载在 daemon 里。所以关掉 app 后 daemon 仍会按定时器同步。
- **agent 不由前端 spawn。** 前端只发 `RuntimeStartRequest`，daemon 决定怎么起、起在哪。这也是为什么「本地 agent」在别端不存在——那不是一个前端开关，而是 daemon 的能力。

---

## 28. 一次真实故障的复盘（抽象化）

仓库里很多设计约束都来自具体事故。这里抽象一个反复出现的模式：**两个组件各自维护一份「同一个东西」的状态，然后靠「谁最后写」决定正确性**。

同一个模式在三个地方出现过，三种修法：

| 现象 | 根因 | 修法 |
|---|---|---|
| 消息内容在流式结束时跳变 | stream 与 message.content 两个源 | 单一 reconcile 点 + 守卫测试 |
| 会话头像过期 | participants 缓存从不失效 | 应该由 realtime handler 戳缓存（未修） |
| 同步显示「待删除」但删除永不发生 | 前后端各一份 ignored 判定 | 服务端与客户端共用同一条排除规则 |

共同结论是：**当同一事实有两个持有者时，要么让其中一个成为唯一真相源，要么让另一个变成它的纯函数。** 折中的「两边都存、写的时候小心一点」在长期一定会漂移。这条结论直接支撑了 ADR-0011（agent 回复文本的唯一 reconcile 点）、ADR-0012（window-local 是默认）和知识库同步里「只数数不读名字」的闸门设计。

---

## 29. 附录 A：开发命令速查

日常开发最常用的几条（完整列表见 `CLAUDE.md` 与 `package.json`）：

```bash
pnpm install                # 装依赖
pnpm dev                    # 只跑前端（Vite）
pnpm tauri:dev              # 完整桌面端
pnpm tauri:dev -- --skip-setup --skip-daemon-onboarding   # 跳过首启向导
pnpm rust:check             # 快速 Rust 编译检查（一定要走包装器）
pnpm lint                   # ESLint
pnpm typecheck              # TypeScript strict
pnpm test:unit              # Vitest 单元测试
pnpm test:e2e               # E2E（需要已构建的 app + tauri-mcp）
```

一条最容易踩的坑已经在前面说过，这里再强调一次：**不要用裸 `cargo`。** `binaries/` 是 gitignored 的，而 `tauri.conf.json` 会 glob 它下面的 bridge 资源，fresh checkout 上裸 cargo 会在任何 crate 编译之前就失败。`scripts/rust-cli.js` 与 `scripts/tauri-cli.js` 就是为此存在的。

---

## 30. 附录 B：术语表

这份表是读其它模块文档时的对照，按字母/拼音混排：

| 术语 | 含义 | 在哪里实现 |
|---|---|---|
| **actor** | 会话参与者的抽象，人（member）或 AI（agent） | `lib/actor/`、`crates/teamclu-types` |
| **agent** | 一种 actor，由 daemon 驱动 | `apps/daemon/` |
| **amuxd / daemon** | 本地 agent host 进程 | `apps/daemon/` |
| **ACP** | agent 通信协议，daemon 与 pi 之间的语义层 | `lib/teamclu/`、`docs/architecture/pi-agent-backend.md` |
| **pi** | 唯一的本地 agent runtime（ADR-0014） | `apps/daemon/src/runtime/pi_rpc/` |
| **session 会话** | 人与 agent 的协作单元，云端有行 | `lib/session/` |
| **thread 线程** | 由某条 agent 回复分叉出的新 session（`source=thread`） | `docs/architecture/session-threads.md` |
| **runtime** | daemon 为一个 agent 起的运行实例 | `lib/teamclu/ensure-agent-runtime.ts` |
| **skill** | agent 可调用的能力包（`SKILL.md`） | `lib/skills/` |
| **role** | 可组合的角色库，给 agent 加专长 | `lib/roles/` |
| **knowledge 知识库** | 团队 Markdown vault，全员一致 | 第 5 篇 |
| **documents 资料库** | 有归属的文件，可设权限 | 第 5 篇 |
| **team-sync** | 同步内容根 `shared/team-sync/` | `apps/daemon/src/sync/` |
| **apps** | 可部署的一等对象 | 第 9 篇 |
| **channel 通道** | 外部 IM 网关（企微/飞书/邮件…） | 第 7 篇 |
| **cron** | 桌面调度任务 | 第 8 篇 |
| **remote-tools** | agent 驱动用户浏览器的工具 | 第 10 篇 |
| **outbox** | 离线发送队列 | `stores/`、iOS 同步 |
| **dynamic-ui** | agent 编写的 UI 描述 | `lib/dynamic-ui/` |

一个容易混淆的词是「runtime」：在 `lib/teamclu/` 里它指 daemon 起的一个 agent 实例，在 `apps/daemon/src/runtime/` 里它是一个模块，在 `useCronStore` 里它可能指 daemon 的可用运行时列表。读代码时靠上下文区分。

---

## 31. 附录 C：与其它模块的关系

第一篇只讲「壳」，但壳与所有模块相接。一张关系表：

| 模块 | 与壳的接口 | 更多 |
|---|---|---|
| 会话与实时 | 第二列会话列表、第三列聊天、MQTT 订阅 | 第 3 篇 |
| 本地 agent | 「新会话」按钮、agent 选择器、权限卡片 | 第 2 篇 |
| 知识库 | 第一列 knowledge 行、文件树、第三列编辑器 | 第 5 篇 |
| 技能与角色 | 第一列 skills 行、`/` 弹窗、设置页 | 第 6 篇 |
| 通道 | 设置页 channels、会话来源徽标 | 第 7 篇 |
| 自动化 | 设置页 automation、定时会话 | 第 8 篇 |
| Apps | 第一列 Apps、控制面、主列 tab | 第 9 篇 |
| 编辑器/终端/远程工具 | 第三列 tab、终端面板、扩展 | 第 10 篇 |
| 团队同步 | 第二列团队资产、同步角标、冲突视图 | 第 4 篇 |

把这张表倒过来读也成立：**每个模块都必须能在三栏里找到自己的位置**。一个找不到位置的功能，通常是产品还没想清楚它的身份，而不是 UI 缺一个入口。

---

## 32. 附录 D：常见设计问答

**Q：为什么不用路由（router）？**
A：三栏状态是一个判别联合，不是一个 URL 树。仓库确实有深链接（`session-deeplink.ts`、`open-session-deeplink.ts`），但它们是对状态的一种输入，而不是状态的来源。引入 router 会把「哪栏显示什么」拆成两套真相，而这两套很快会不同步。

**Q：为什么不把第二列做成可折叠的？**
A：它已经是一次导航选择的结果。再叠加一层折叠，就变成「先选目的地再决定要不要看列表」，多一次决策。Apps 的内联展开是例外，因为它的子项有独立身份。

**Q：为什么设置页有 26 个 section 却不分组更细？**
A：它们已经是按「一个用户心智模型」分的（LLM、通道、自动化…）。真正的问题是启动成本，而那个已经用 code-split 解决了。分组更细只会让搜索变成两层。

**Q：新功能应该放设置页还是主界面？**
A：判据是「它是配置还是工作」。配置进设置，工作进主界面。一个反例是 cron：它的「列表与历史」在设置页，但它产生的会话出现在第二列——因为它同时是配置和工作。

**Q：能不能直接用 electron？**
A：Tauri 是既定选择，理由是包体积、原生能力（PTY、文件监听、系统集成）和安全边界（capabilities）。换壳不是一个小决定，不在讨论范围。

**Q：为什么很多组件用 `React.lazy`？**
A：因为桌面的启动预算很紧，而很多面板（设置、编辑器、应用控制面）大部分会话永远不会打开。`lazy-component.ts` 把这个模式统一封装，避免每处各写一套 loading 与错误处理。

**Q：UI 里的英文可以硬编码吗？**
A：可以，但只能作为 `t(key, fallback)` 的 fallback。纯硬编码的字符串在切语言时不会变，且不会进入 locale 文件，会让 i18n 审计出现盲区。

**Q：一个组件多大算大？**
A：仓库里有 784 行的 `AppControlPanel`、1295 行的 `SkillsMarketplace`。行数不是判据，判据是「它是否同时拥有数据和展示」。如果一个大组件里有一半代码在算数据，那部分应该被抽出去。

---

## 33. 附录 E：一次完整的新会话点击

把一次「点新会话」的链路完整展开，作为阅读代码的入口：

1. **用户点 `NewChatSplitButton`**（`components/sidebar/NewChatSplitButton.tsx`）。主按钮走快速新建，下拉给出更多选项。
2. **解析目标。** `useQuickChatReadiness()` 告诉你现在能不能建，`resolve-quick-chat-target` 给出目标：优先本地 agent，否则有效默认 agent。
3. **创建会话。** `createQuickSession(target)`（`lib/session/create-quick-session.ts`）。失败时 `describeQuickSessionFailure` 把 reason 转成标题与描述；`no_agent` 会带一个「设置默认 agent」动作，点开 `daemonGeneral` 设置页。
4. **写云端。** 会话行由 Cloud API 创建（`lib/session/session-create.ts`）。本地缓存随后由同步器补上。
5. **选中。** `useSessionStore.activeSessionId` 更新，列表高亮，第三列切到该会话。
6. **起 runtime。** 聊天面板发 `RuntimeStartRequest` 给 daemon；daemon 按 (isolation domain, env revision, worktree) 找到或新建 pi host 进程。
7. **订阅。** `MqttLiveWiring` 订阅 `amux/&lt;team&gt;/session/&lt;id&gt;/live`，同时补拉历史消息。
8. **提示。** 如果 runtime 还在冷启动，界面显示相应状态（`SessionContinueBanner`、`EngagedAgentOfflineBanner` 这类）；agent 不可达时不是静默失败。
9. **第一条消息。** 用户输入后 `⌘↵` 发送，走 `use-chat-send.ts`；流式内容进 `useV2StreamingStore`，完成后由单一 reconcile 点写入 `message.parts[]`。

这九步里，任何一步失败都应该有可见的反馈。仓库里那些看起来多余的 banner、toast、notice 列表，都是这条链路上某个失败模式曾经是静默的。

一个具体的例子：`SessionContinueBanner` 存在的原因是新会话创建后 runtime 还没有就绪，用户发第一条消息前需要知道「可以发了」还是「再等等」。另一个例子是 `EngagedAgentOfflineBanner`：当绑定的 agent 离线时，用户不应该看到一个「发送成功了」的假象。

---

## 34. 附录 F：阅读代码的建议顺序

第一次接这块时，推荐按下面顺序读，每一步都能独立跑起来验证：

1. `stores/ui.ts` 的 `sidebarFilter` —— 先看导航有多少种状态，后面一切都从这里长出来。
2. `components/sidebar/NavRail.tsx` —— 看状态如何变成行。
3. `components/sidebar/SidebarSecondColumn.tsx` —— 看行如何决定第二列。
4. `app/MainContent.tsx` + `stores/tabs.ts` —— 看第三列与 tab。
5. `styles/globals.css` —— 看 token。
6. `lib/tabs/` 里选一个域（建议 `app-tabs.ts`，它注释最全）—— 看 tab 的注册方式。
7. `lib/backend/provider.ts` —— 看数据从哪里来。

不建议一开始就读 `App.tsx`。它是接线层，包含实时订阅、认证、遥测、主题、多窗口等很多互不相关的初始化，在没有上面六步的上下文时读它会以为整个应用是一团乱麻。

同理，不建议一开始就读 `SessionListColumn`。它是这个 shell 里最复杂的组件，先读懂「第二列是第一列的函数」这个框架，再进它。

---

## 35. 变更记录与维护约定

本文描述的是当前 `main` 的行为。维护时注意：

- **导航状态变了**（`sidebarFilter` 加/删了一种子类），本文第 2.1 与第 23 节要同批更新。
- **新增了一个端**（比如将来支持 Android 原生），第 1 节的客户端矩阵要改。
- **视觉规范变了**（`AGENTS.md` 的 token 或珊瑚色白名单），第 3 节要改。
- **某个未完成项被做了**（比如未读徽标、参与者缓存失效），文里标注的「未完成」段落要删。

一条写作约定：本文不陈述「应该是怎样」，只陈述「现在是什么、为什么」。如果发现某段写的是意图而不是现实，应该把它移到设计文档，而不是留在功能介绍里——两者混在一起会让后来者分不清哪些是能依赖的事实。

---

## 36. 一个总结：三层边界

最后把整个 shell 的三层边界总结成三句话：

**第一层，导航与内容分开。** 第一列回答「去哪」，第二列是它的函数。这个分开让新增一个模块只需要动三处（入口、分支、opener），而不需要动整个布局。

**第二层，聊天与工作分开。** 聊天常驻底层，工作（编辑器、数据、日志）在上层的 tab 里。这个分开让「边聊边改」不需要两个窗口，也让聊天里的状态不会因为切走而丢。

**第三层，窗口与进程分开。** 每个窗口有自己的 store graph，只有认证跨窗口同步。这个分开让多窗口不会因为一个共享状态而互相干扰，代价是两个窗口的列表可能不同步——而那是一个可接受的代价。

三层边界都指向同一个判断：**哪里有独立身份，哪里就应该独立。** 导航、工作、窗口都有独立的身份，所以它们分开；而会话里的消息没有独立身份，所以它在同一个列表里。想不清楚一个东西该放哪时，先问它的身份是什么。

---

## 37. 结语

三栏 shell 看起来是「布局」，实际上是**一套导航状态的收敛模型**：第一列用判别联合表达「去哪」，第二列是它的函数，第三列是「聊天常驻 + tab 覆盖」。把这层想清楚，新增一个模块要动的地方就只有三处：一个 `NavRail` 入口、一个 `SidebarSecondColumn` 分支、一个 `lib/tabs` opener。想不清楚，就会不断冒出第二个列表列和第二个详情面板，然后整个 shell 退化成「每个功能自己一摊」。

多端并存不是要「共享 UI」，而是要**共享协议、分开表达**——这决定了 iOS 有自己的设计规范、Expo 有自己的 UI 库存、扩展只做它那件事。桌面端作为主客户端，承担的正是「本地 agent + 本地文件 + 本地终端」这三件别的端做不到的事。

最后给一个判断标准。当你不确定一个新需求该不该动这个 shell 时，问自己三个问题：它的子项有独立身份吗（决定它入不入第一列）？它的主内容是一次性的还是一直在的（决定它用不用 tab）？它是配置还是工作（决定它进设置还是进主界面）？三个答案就能定位它，不需要担心创意。
