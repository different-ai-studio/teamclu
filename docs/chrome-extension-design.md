# TeamClu Chrome 扩展设计方案

**日期**: 2026-06-23（2026-06-24 补 wss live-chat 验证）
**状态**: 子工程 1（浏览器运行时）已实现并端到端验证；子工程 2（扩展外壳 + 页面抓取）已实现，**已在真实 Chrome 加载并对 self-host 环境完成 live 聊天链路验证（登录 → 建队 → MQTT over wss 连接 → 订阅 wired）**
**分支**: `task/i-want-to-build-a-chrome-extentions-plugin-for-t`

---

## 1. 目标与场景

做一个 Chrome 扩展（Manifest V3），在浏览器**侧边栏（side panel）**里嵌入 TeamClu 的
多人聊天窗口，并能把**当前网页的内容**（选中文本或全页正文）作为上下文发送给远端
daemon 上的 agent。

**主要场景**：浏览自家 admin portal（或任意网页）时，随手就当前页内容向 agent 提问 /
下任务，复用 TeamClu 已有的多人协作聊天。

### 非目标（YAGNI）

- 不做 agent 反控页面（点击 / 填表 / 导航，browser-use 式）—— 后续阶段再议。
- 不做结构化字段抽取 —— 先只抓可读文本（`innerText` 兜底，不引入 Readability）。
- 扩展不直连 daemon HTTP，也不持有 daemon root token。
- 不在扩展里复刻全量桌面功能（workspace / terminal / git / MCP / 文件编辑全部排除）。

---

## 2. 连接架构（关键决策）

### 2.1 扩展不直连 daemon

amuxd daemon 的 HTTP API 只绑定 `127.0.0.1` + 文件 root token，浏览器跨机器**不可达**。
因此扩展沿用 web 前端 / expo 已有的通道：

> **Cloud API（HTTPS bearer token）+ MQTT over WebSocket（实时流）**，daemon 在后端被
> 间接驱动。**daemon 零改动。**

### 2.2 承载方式：把 app 直接打包进扩展

把 `@teamclu/app` 的**聊天子集**直接打包进扩展，作为 side panel 的
`chrome-extension://` 页面运行——**无 iframe、无公网托管、无跨域 CSP 问题**。

代价：app 目前是 Tauri 桌面应用，需要让它能在**纯浏览器**环境跑起来（见子工程 1）。

### 2.3 架构图

```
┌─ Chrome 扩展 (Manifest V3) ──────────────────────────────┐
│  Side Panel 页面 = 打包后的 @teamclu/app(embed 精简模式)  │
│     Cloud API(fetch) + MQTT over WebSocket(mqtt npm)      │
│                ▲   chrome.runtime 消息                    │
│  Service Worker (background)                              │
│   └─ 管理 side panel；调 content script 取页面；转发      │
│                ▲   chrome.runtime 消息                    │
│  Content Script (按需注入当前 tab)                        │
│   └─ 读取选中文本 / 全页 innerText + 标题/URL             │
└───────────────────────────────────────────────────────────┘
            │ HTTPS Cloud API + MQTT(wss)
            ▼
   Cloud API (api.teamclu-dev.ucar.cc) ──► 远端 amuxd daemon
```

### 2.4 实测环境拓扑

本节只记录扩展的 self-host 测试环境（一台 ECS，以下子域全部指向它）。Belayo 生产
环境由 Dokploy 承载，不是这组扩展测试构建的目标。

| 角色 | 地址 | 说明 |
|---|---|---|
| Cloud API | `https://api.teamclu-dev.ucar.cc` | bearer token；`/v1/config/bootstrap` 需登录态，下发 broker URL + 凭证 |
| MQTT broker | `wss://mqtt.teamclu-dev.ucar.cc/mqtt` | EMQX，经反代在 **443** 提供 wss（扩展 secure context 可用，见 6.5 实测）；另有明文 MQTT `47.112.210.217:1883` |

> **历史**：本文 6.3 / 6.5 之前的调试记录针对的是旧的 `ai.ucar.cc` broker（ws=8083、
> wss 8084 关闭），该主机**已下线**。相关段落保留为历史记录，其结论不适用于上表的
> self-host broker。

---

## 3. 子工程拆分

整个项目拆为两个可独立验证的子工程，顺序执行。

### 子工程 1：`@teamclu/app` 浏览器运行时（依赖项 — **已完成**）

让 app 的多人聊天子集在**纯浏览器**跑起来，只走 Cloud API + MQTT-ws。

**验收标准**：普通浏览器 tab 里能登录、选会话、收发多人消息、看到实时流式回复，全程
无 Tauri。✅ **已端到端验证**（见第 5 节）。

### 子工程 2：Chrome 扩展外壳（依赖子工程 1 — **已实现**）

把子工程 1 的浏览器 build 装进 MV3 扩展，加页面抓取。✅ 代码完成、`dist` 可重建加载、
抓取→注入链路闭合并单测覆盖；live 聊天链路已在真实 Chrome 验证（见 6.5），**页面抓取按钮的手动 e2e 待做**。

**验收标准**：装载未打包扩展，在真实 admin portal 里 抓取当前页 → 注入聊天框 → 发送 →
看到 agent 回复 的闭环。

---

## 4. 子工程 1 详细设计（已实现）

### 4.1 平台分流的 MQTT seam

`packages/app/src/lib/mqtt-bridge.ts` 是被 **16+ 文件共用的单一 seam**。改造为按
`isTauri()` 平台分流——导出签名**完全不变**，所有消费方零改动：

```
mqtt-bridge.ts                 # 分流器: isTauri() ? tauri : browser
 ├─ mqtt-bridge-tauri.ts       # 原 Tauri 实现(原样移入), invoke('mqtt_*')
 └─ mqtt-browser-bridge.ts     # 浏览器实现, ws url 映射 + envelope 转发
      └─ mqtt/browser-mqtt-adapter.ts  # mqtt npm(ws) 适配器(移植自 expo)
```

- 公共签名固定：`mqttConnect / mqttSubscribe / mqttUnsubscribe / mqttPublish /
  mqttStatus / listenForEnvelopes` + 类型 `IncomingEnvelope`。
- ws URL 映射：`useTls=false → ws://host:port/mqtt`，`useTls=true → wss://host:port/mqtt`。
- 浏览器适配器移植自 `apps/expo/src/lib/mqtt/expo-mqtt.ts` 的 JS-client 路径（`mqtt`
  npm v5，与 expo 同版本）。
- 连接状态 / 连接错误经 `subscribeBrowserMqttState` / `subscribeBrowserMqttError`
  桥接进 `mqtt-reconnect` store（单一来源），使浏览器下「未连接 / 错误」UI 真正生效。

### 4.2 embed 精简渲染模式

URL query `?embed=chat` → 启动时把 Zustand `useUIStore.embedMode` 置真 →
`App.tsx` 早返回一个只渲染「会话列表 + 多人聊天面板」的精简布局，跳过 setup 向导 /
桌面三列侧栏 / daemon 管理 UI。`embedMode=false` 时桌面行为字节级不变。

解析契约：`parseEmbedMode(search: string): 'chat' | null`（`packages/app/src/lib/embed-mode.ts`）。

### 4.3 非 Tauri 的 Web 构建 / Dev 模式

- env 文件提供 `VITE_APP_PLATFORM=web` + `VITE_CLOUD_API_URL` + `VITE_MQTT_WS_URL`
  （见 4.4）。当前仓库内只有 `packages/app/.env.web.test`（指向 self-host，见 6.6）；
  历史上的 `.env.web`（localhost http + `ws://`，指向已下线的 `ai.ucar.cc`）**已删除**。
  `dev:web` / `build:web`（`--mode web`）脚本仍在，但已无对应 env 文件，需自行提供。
- `vite.config.ts`：dev server 的端口 / `strictPort` 在 `VITE_APP_PLATFORM=web` 时放宽
  （非 web 即桌面路径，行为不变）。
- 脚本：`pnpm dev:web` / `pnpm build:web`。
- `main.tsx` 的 Tauri 调用全部 `isTauri()` 守卫或 try/catch（`initJwtBridge` 实为 no-op）。
- **打包出的扩展不读 env 文件里的后端地址**：`.env.web` 里的 `VITE_CLOUD_API_URL` /
  `VITE_MQTT_WS_URL` 只是 `pnpm dev:web` 的 dev fallback。`apps/extension/build.mjs`
  从 build config 取 `cloudApiUrl` / `mqttWsUrl`（`resolveExtensionBackend`），以真实
  env var 传给 vite——vite 的优先级里 process env 高于 `.env.*` 文件，所以 brand 的配置
  才是烘进包里的值。brand 没声明 `cloudApiUrl` 时构建**直接失败**，不再静默回退到
  TeamClu 后端。`EXT_ENV=test` 是唯一例外：那条路径就是为了指向 self-host 测试环境，
  仍由 `.env.web.test` 说了算。

### 4.4 浏览器 broker 覆盖（dev 专用）

bootstrap 下发的 broker URL 来自服务端、且**覆盖**本地 env（`saved.X ?? env.X`）。桌面是
TCP 客户端，服务端下发的是 TCP broker（`mqtt://...:1883` / `mqtts://...:8883`），浏览器
照搬会拼成 `ws(s)://...:1883or8883`，**连不上**。

为本地跑通，新增**仅 web 生效、覆盖 bootstrap** 的 `VITE_MQTT_WS_URL`：

```
# packages/app/.env.web.test —— 指向 self-host 的 wss 端点
VITE_MQTT_WS_URL=wss://mqtt.teamclu-dev.ucar.cc/mqtt
```

它硬覆盖 broker 的 host/port/tls，但 `mqttUsername/mqttPassword` 仍来自 bootstrap。

> **历史**：本节最初写的是 `ws://ai.ucar.cc:8083/mqtt`（明文 ws，仅在 `http://localhost`
> 这种非 secure context 下可用）。该 broker 已下线；self-host 直接提供 wss，扩展与本地
> web 均可统一用上面的 wss 端点。

### 4.5 团队 bootstrap 在浏览器运行（根因修复）

`AuthGate` 原本在 `!isTauri()` 时把团队 bootstrap 短路为 `ready` 而**从不采用团队** →
`currentTeamId` 恒 null → MQTT connect effect 的 guard 早退 → 不连 MQTT。

修复：浏览器运行时是真实云客户端，需跑同样的团队 bootstrap（路径是 Cloud API +
try/catch 守卫的本地缓存，浏览器安全）。去掉短路后，web 登录即解析 / 采用当前团队，MQTT
随之连接。

---

## 5. 端到端验证结果（子工程 1）

> **历史记录（2026-06-23）**：本节是当时针对**已下线**的 `ai.ucar.cc` broker（明文
> ws=8083）做的验证。结论（浏览器运行时可登录、连 MQTT、收发消息）仍然成立，但其中的
> 主机名与端口已不适用；对 self-host wss 的等价验证见 6.5。

`pnpm dev:web` → 浏览器开 `http://localhost:<port>/?embed=chat`：

- ✅ 真实账号登录成功，进入 embed 精简布局。
- ✅ Console：`[MQTT] connecting {brokerHost: 'ai.ucar.cc', brokerPort: 8083, useTls: false, teamId, actorId}`。
- ✅ Network → WS：`ws://ai.ucar.cc:8083/mqtt` → **101 Switching Protocols**。
- ✅ `[MQTT] receiver wired: subscribed to team session/live wildcard`。

> 注：web 模式下 `knowledge.ts` / `gitignore-manager.ts` / `channels-store.ts` / 文件
> watcher 等 desktop-only 初始化会刷无害的 `invoke undefined` 报错（功能不受影响），可在
> 子工程 2 前用 `isTauri()` 统一静音。

---

## 6. 子工程 2 设计（已实现）

落点 `apps/extension`（`@teamclu/extension`，纳入 `pnpm-workspace` 的 `apps/*`）。
**构建方式**：采用「app 静态 build + 手写 MV3 外壳 + esbuild」，**不用 crxjs/wxt**（规避对
Vite 8 的兼容不确定性）。`apps/extension/build.mjs` 组装：① `pnpm build:web`
（`VITE_APP_PLATFORM=web` + `VITE_FORCE_EMBED=chat`，相对 base）产出 app → 复制为
`dist/sidepanel/` ② esbuild 把 `background.ts`(ESM module worker) / `content-script.ts`
(IIFE) 打成 `dist/background.js` / `dist/content-script.js` ③ 复制 `manifest.json` + 图标。

### 6.1 组成（实际文件）

- `apps/extension/manifest.json`：MV3，`permissions: [sidePanel, scripting, activeTab]`，
  `side_panel.default_path: sidepanel/index.html`，`background: { service_worker:
  background.js, type: module }`。
- `apps/extension/src/background.ts`：`chrome.sidePanel.setPanelBehavior({
  openPanelOnActionClick: true })` 点图标开 side panel；监听 side panel 来的 `request-page`，
  经 `fetchActivePageContext`（`chrome.scripting.executeScript` 注入 content-script +
  `chrome.tabs.sendMessage`）取 active tab 页面，`sendResponse` 回 `page-context`。
- `apps/extension/src/content-script.ts` + `src/lib/content-handler.ts`：收到 `request-page`
  时用 `extractPage` 抽取 `document.title` / `location.href` / `getSelection()`，无选中取
  `body.innerText` 兜底，回 `page-context`。
- `apps/extension/src/lib/{page-extract,messages,page-fetch,content-handler}.ts`：纯函数 +
  类型守卫，全部 jsdom-free 单测覆盖（9 测试）。
- side panel = 打包后的 app（embed 模式）；app 侧的「抓取当前页」按钮 + 注入逻辑见 6.2。

### 6.2 页面抓取链路（chrome.runtime 请求/响应）

side panel 页面（app）与 background/content 同属扩展 origin，走 `chrome.runtime`：

```
[app 按钮]  requestPageCapture()
  app   → background:  sendMessage({ type:'request-page' })           // 请求
  background → tab:    executeScript(content-script) + tabs.sendMessage({type:'request-page'})
  content → background: { type:'page-context', payload:{title,url,text,selection} }
  background → app:    sendResponse(page-context)                     // 响应(同一通道)
  app:  isPageContextMessage(resp) → emitComposerInsert(formatPageContext(payload))
                                    → ActorChatInput 追加进输入框
```

关键点（最终评审修复）：抓取用**请求/响应**单通道（`sendMessage` 的 Promise 拿
`sendResponse` 的回值），**不是** `onMessage` 广播——二者不互通。app 侧由
`packages/app/src/lib/embed-page-context.ts` 的 `requestPageCapture()` 驱动，按钮在
`App.tsx` 的 embed 布局里。`startEmbedPageContextListener`（onMessage）保留为未来
background 主动 push 的次要通道，当前休眠。app 侧 chrome 用法对无 chrome 环境（web/桌面）
完全惰性。

app 侧消息形状（`embed-page-context.ts` 的 `PageContext`）与扩展侧（`messages.ts` 的
`ExtractedPage`）字段一致：`{ title, url, text, selection }`，经 chrome.runtime 传 JSON。

### 6.3 wss MQTT 端点 —— ✅ self-host 已提供

`chrome-extension://` 是 **secure context**，浏览器**禁止 `ws://`（非 TLS）**，故扩展 live
聊天必须有 wss MQTT 端点。

> **历史**：这一度是最高优先级的阻塞项 —— 当时 dev 用的 `ai.ucar.cc` broker 无可用 wss
> （8084 直连关闭、`/mqtt` 404）。该 broker 已下线，此阻塞随之消失。

**现状**：self-host 通过 Caddy 在 443 反代提供 `wss://mqtt.teamclu-dev.ucar.cc/mqtt`，
扩展 build 经 `.env.web.test` 指向它，已在真实 Chrome 中验证 wss 连接 + 订阅成功
（见 6.5）。即上述历史方案里的「域名 443 反代 → broker」形态已落地。

遗留的长期改进项：

- **bootstrap 给浏览器客户端下发 wss URL**：FC 的 `/v1/config/bootstrap` 按客户端类型
  返回 `wss://...` broker（而非桌面用的 TCP URL），这样浏览器/扩展无需本地
  `VITE_MQTT_WS_URL` 覆盖。**仍是推荐的最终形态**，可去掉客户端本地覆盖 hack。

### 6.4 错误处理

- side panel 页面未就绪前的抓取请求：background 缓存最近 1 条，页面 `ready` 后补发。
- content script 注入失败（`chrome://` / Web Store 等受限页）：side panel 显示「当前页
  不可抓取」。
- MQTT 连接失败：复用子工程 1 已桥接的「未连接 / 错误」UI。
- 非法 / 未知 `chrome.runtime` 消息：丢弃。

### 6.5 真实 Chrome live 验证（2026-06-24）+ 测试中发现并修复的两个 bug

把 `pnpm build:test` 产物（`apps/extension/dist`，指向 self-host）加载进真实
Chrome（用 Playwright + Chrome for Testing —— stable Chrome 149 已禁 `--load-extension`），
注入一个真实 GoTrue session 到 side panel 的 `localStorage["teamclu.session.v1"]`，观测到完整
链路：**扩展加载 → 登录 → 自动建队 → MQTT over wss 连接（`wss://mqtt.teamclu-dev.ucar.cc/mqtt`）
→ `receiver wired: subscribed to team session/live wildcard`，零错误**。side panel 渲染出 embed
精简布局 + 「抓取当前页」按钮。

验证过程中暴露并修复了两个浏览器/扩展路径的潜伏 bug（桌面 Tauri 路径不受影响）：

1. **无端口 wss URL 落到错误端口**（`packages/app/src/lib/server-config.ts`）：
   `VITE_MQTT_WS_URL=wss://host/mqtt`（无显式端口，反代在 443 后面）被解析成
   `port: undefined`，且 override 分支不回落 → 下游 bridge 默认到 **TCP 端口 1883** →
   拼成 `wss://host:1883/mqtt` → `ERR_CONNECTION_CLOSED`。修复：无端口时按 scheme 取
   **443（wss）/ 80（ws）**。

2. **connect 非幂等导致订阅丢失**（`packages/app/src/lib/mqtt-browser-bridge.ts`）：MQTT
   connect effect 会跑两次（依赖先后落定 team-id、actor-id）。桌面 `mqttConnect` 幂等，但
   浏览器 adapter 第二次会抛 `already connected`，使存活的那次 run 在**订阅 wiring 之前**
   就被打断 —— 连上了却没订阅（deaf）。修复：浏览器 `mqttConnect` 改为幂等（已连接即 no-op，
   并吞掉 `already connected` 抛错），与 Tauri 路径一致。

两处各补 2 条回归测试；`server-config` + `mqtt-browser-bridge` 套件 19/19 绿，两端 typecheck 净。

### 6.6 构建配置（`.env.web.test` / mode `web.test`）

指向 self-host 测试环境的独立 env：

- `packages/app/.env.web.test`：`VITE_CLOUD_API_URL=https://api.teamclu-dev.ucar.cc` +
  `VITE_MQTT_WS_URL=wss://mqtt.teamclu-dev.ucar.cc/mqtt`。
- `packages/app` 脚本：`dev:web:test` / `build:web:test`（`vite --mode web.test`）。
- 扩展：`apps/extension` 加 `build:test`（`EXT_ENV=test node build.mjs`），`build.mjs` 在
  `EXT_ENV=test` 时改跑 `build:web:test`。

```bash
cd apps/extension && pnpm build:test    # 产出指向 self-host 的 dist
```


---

## 7. 认证

app 完全复用现有 Cloud API 登录（bearer + bootstrap 取 MQTT 凭证）。扩展本身不持有
token，不碰 daemon root token。首登在 side panel 页面内完成；token / 团队上下文存
`localStorage`（扩展页面的持久 origin storage）。

---

## 8. 测试

- 子工程 1 单元：MQTT-ws adapter / browser-bridge（ws URL 映射、连接/发布/订阅、envelope
  分发、连接状态/错误桥接）、`parseEmbedMode`、`server-config` broker 覆盖优先级、平台分流。
  复用 web app 既有 vitest（jsdom）。**全部已实现并通过。**
- 子工程 1 端到端：`pnpm dev:web` 手动登录→多人聊天（已通过，见第 5 节）。
- 子工程 2 单元：`extractPage`（选中优先 / innerText 兜底）、`messages` 守卫、`page-fetch`
  路由、`content-handler`、app 侧 `requestPageCapture` / `embed-page-context`（mock
  `chrome`）。**已实现并通过**（扩展 9 测试 + app embed 相关 23 测试，两端 typecheck 净）。
- 子工程 2 端到端：装载未打包扩展（`apps/extension/dist`）在真实 admin portal 验证
  抓取→注入→发送→回复闭环。**待手动执行**（live 聊天链路本身已验证，见 6.5）。

---

## 9. 实现进度

| 项 | 状态 |
|---|---|
| MQTT-ws 浏览器适配器 | ✅ 完成 |
| 浏览器 mqtt-bridge + 平台分流（消费方零改动） | ✅ 完成 |
| 连接状态/错误桥接 store | ✅ 完成 |
| `?embed=chat` 精简渲染模式 | ✅ 完成 |
| 非 Tauri web build/dev 模式 | ✅ 完成 |
| dev 用 broker 覆盖 `VITE_MQTT_WS_URL` | ✅ 完成 |
| 团队 bootstrap 在浏览器运行（根因修复） | ✅ 完成 |
| 浏览器端到端聊天验证（WS 101） | ✅ 完成 |
| **子工程 2 · MV3 脚手架 + manifest + workspace** | ✅ 完成 |
| **子工程 2 · 页面抽取 / 消息协议 / content / background** | ✅ 完成 |
| **子工程 2 · 构建组装 build.mjs（dist 可加载）** | ✅ 完成 |
| **子工程 2 · 抓取触发按钮 + 请求/响应注入闭环** | ✅ 完成（最终评审修复） |
| **构建配置 `.env.web.test` + 扩展 `build:test`** | ✅ 完成 |
| **扩展真实 Chrome 加载 + live 聊天链路（登录/建队/wss 连接/订阅 wired）** | ✅ 已验证（6.5） |
| **wss MQTT 端点基建** | ✅ self-host 已提供（`wss://mqtt.teamclu-dev.ucar.cc/mqtt`） |
| 扩展手动加载 e2e（页面抓取按钮→注入，需第二个真实 tab 点击） | ⏳ 待手动验证 |
| desktop init 噪音静音（web 下 isTauri 守卫） | ⏳ 待办（可选） |
| bootstrap 按客户端类型下发 wss（去掉本地覆盖 hack） | ⏳ 待开发（最终形态） |

---

## 10. 关键风险与遗留项

1. ~~**wss 基建**（最高优先）~~ **✅ 已解决**：self-host 提供
   `wss://mqtt.teamclu-dev.ucar.cc/mqtt`，扩展已对其完成 live 聊天链路验证（见 6.5）。
   （原阻塞源于已下线的 `ai.ucar.cc` broker 无 wss。）
2. **bootstrap 客户端区分**（最终形态）：理想方案是 FC 按客户端类型下发 wss broker URL，
   去掉客户端本地 `VITE_MQTT_WS_URL` 覆盖的 hack。当前靠 `.env.web.test` 本地覆盖。
3. **desktop init 噪音**：web 下 Tauri-only 初始化空跑刷错，建议统一 `isTauri()` 守卫。
4. **build:web 跳过 `tsc -b`**：浏览器构建无 TS 类型门（仓库 `pnpm typecheck` 仍覆盖）。
5. **`host_permissions` 收紧**：manifest 仅 `activeTab`+`scripting`，抓取依赖用户在工具栏
   动作后的手势授权。若将来加「自动抓取」（无手势），需补 `host_permissions`，否则注入失败。
6. **正式图标**：当前从 `scripts/playwright-extension/icons/` 借用，待替换为 TeamClu 图标。

---

## 11. 构建与加载扩展

```bash
cd apps/extension
pnpm build:test            # 指向 self-host（.env.web.test，wss）→ dist
pnpm build                 # 默认 mode web —— 其 `.env.web` 已删除，需自备 env
```

Chrome → `chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」→ 选
`apps/extension/dist`。点工具栏 TeamClu 图标打开 side panel。

> **gotcha**：stable Chrome 137+ 已禁用 `--load-extension` 命令行加载（自动化场景）。
> 手动「加载已解压」不受影响；若用 Playwright 等自动化，需用 **Chrome for Testing** 构建
> （`npx playwright install chromium` 装的那份）而非系统 stable Chrome。


> dev 本地跑浏览器版（非扩展）：`cd packages/app && pnpm dev:web`，开
> `http://localhost:<port>/?embed=chat`（http 非 secure context，可用 `ws://` 调试 MQTT）。

---

## 12. 上架发布（copilot361 品牌 + CI）

流水线：`.github/workflows/release-extension.yml`。触发方式：
- push tag `ext-v*`（打包产物随 GitHub Release 附件发布，与桌面 `v*` tag 规则并行、互不影响）
- `workflow_dispatch`（手动跑，`publish` 输入项默认勾选自动发布，取消勾选则只产出 zip）

**品牌注入**：`.github/actions/brand-setup` 从私有 enterprise-branding 仓库取
`brands/<brand>/`，落地两部分：

- `brands/<brand>/build.config.json` → 仓库根的 `build.config.json`
- `brands/<brand>/extension/` → `branding/extension/`（**按品牌隔离**；共享的
  `branding/<palette>/` 是按调色板分的，两个品牌发的是两个不同的 Web Store 条目，
  扩展资产不能共用）

`branding/extension/` 的结构：

```
icons/icon-{16,48,128}.png    预先切好三种尺寸（不在 CI 里做图片转换）
listing.json                  商店文案：description / category / language / visibility
privacy.json                  Privacy 页答案：singlePurpose / permissionJustifications / ...
listing/screenshots/*.png     1280x800 或 640x400，24-bit PNG 无 alpha，最多 5 张
listing/promo-small/*.png     440x280
listing/promo-marquee/*.png   1400x560
```

`scripts/update-extension-manifest.js` 在 build 前把这些合并进 `apps/extension/manifest.json`
（逻辑与 `scripts/update-tauri-config.js` 对齐）：`app.name` → `name` + `action.default_title`，
`extension.description` → `description`（Chrome 上限 132 字符，超了直接报错而不是静默截断），
host 白名单 → `host_permissions` + `content_scripts.matches`。没有配置 branding 仓库时是纯
no-op，保持默认 TeamClu 品牌。

> **host 白名单的两种写法**。仓库自己的配置用 `extensions.domains`
> （见 `build.config.example.json`），而 branding 仓库里每个品牌用的都是
> `extension.hosts`。二者都必须能用 —— 在 `scripts/lib/extension-config.js`
> 的 `resolveExtensionPack` 里统一处理。这里曾经只读前者，导致品牌声明的域名收窄
> 全部失效，本该只跑在 10 个 Shopee 域名上的扩展带着 `<all_urls>` 去过审。

**Listing kit**：Chrome Web Store API v2 只有 `media.upload` 和
`publishers.items.{publish,fetchStatus,cancelSubmission,setPublishedDeployPercentage}`，
**没有任何接口能写 listing 元数据** —— 描述、截图、宣传图、分类、Privacy 答案全部只能在
开发者后台手填。所以 `scripts/build-extension-listing-kit.js` 把 branding 仓库里的这些内容
组装成 `listing-kit.zip`（校验过尺寸/alpha 的图片 + 一份可直接粘贴的 README），随 Release
一起产出，人工照着填一次。它同时会拿打包后的 manifest 反查：声明了却没写理由的权限、空的
商店描述、缺失的截图，都会以 `::warning::` 报出来。

**Chrome Web Store 自动发布**（可选，需要一次性手动准备）：

1. Chrome Web Store 开发者后台创建 copilot361 插件草稿监听，拿到 item ID。
2. Google Cloud Console 建一个 OAuth 2.0 Client（类型 Desktop app），启用 Chrome Web Store API。
3. 用该 client 走一次 OAuth 授权（scope `https://www.googleapis.com/auth/chromewebstore`）换
   refresh token（可用 `chrome-webstore-upload-cli` 官方文档的 `authorize` 流程）。
4. 在仓库 Settings → Secrets 里配置：`CHROME_EXTENSION_ID` / `CHROME_CLIENT_ID` /
   `CHROME_CLIENT_SECRET` / `CHROME_REFRESH_TOKEN`。

在这 4 个 secret 配好之前，"Publish to Chrome Web Store" step 会打印提示后直接跳过（exit 0，
不算失败），产物 zip 仍会作为 workflow artifact（`chrome-extension`）+ GitHub Release 附件产出，
可以手动上传到开发者后台。secret 配好后同一条流水线自动切换成全自动上传+发布，无需改 workflow。
