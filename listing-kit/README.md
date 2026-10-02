# Chrome Web Store listing kit — TeamClu 0.1.0

The Web Store API cannot write any of this. Paste it into the developer
dashboard by hand: https://chrome.google.com/webstore/devconsole

## Store listing → Product details

- **Title** (from package): `TeamClu`
- **Summary** (from package): `TeamClu 浏览器侧边栏：与 AI agent 多人协作聊天，并可将当前网页内容一键作为对话上下文发送`
- **Category**: Productivity
- **Language**: zh-CN

**Description**

```
TeamClu 是一款面向团队的 AI 协作平台。这个 Chrome 扩展把 TeamClu 聊天窗口嵌入浏览器侧边栏，让你在浏览任意网页时都能与 AI agent 对话、协作。

主要功能

• 侧边栏聊天 — 点击工具栏图标打开 Chrome Side Panel，登录 TeamClu 账号后即可与团队 AI agent 进行多人协作对话
• 抓取当前页 — 一键把正在浏览的页面标题、URL 与正文（或选中文本）作为上下文发给 agent，无需复制粘贴
• 链接悬停发送 — 在网页链接上悬停时出现「发给 agent」按钮，快速把链接交给 agent 分析
• 远程浏览器工具 — agent 可通过你已授权的操作读取当前页 DOM 或导航（仅在会话中、由 agent 发起时执行）

数据与隐私

扩展仅在您主动操作时读取页面内容；不会后台静默采集浏览历史。账号登录与聊天消息经 TeamClu Cloud API（HTTPS + MQTT over WSS）传输，凭证保存在扩展本地 storage，不上传至第三方。

适用对象

• 需要在浏览 admin portal、文档站、工单系统时随手向 AI 提问的团队
• 已部署 TeamClu Cloud API 的企业或自托管用户

安装后请点击扩展图标打开侧边栏，使用邮箱或 Google 登录 TeamClu 账号即可开始。
```

## Store listing → Graphic assets

- **screenshots**: 01-side-panel-chat.png, 02-page-capture.png, 03-link-hover.png (in `screenshots/`)
- **promo-small**: promo-small.png (in `promo-small/`)
- **promo-marquee**: none

## Privacy → Single purpose

```
TeamClu is a browser sidebar that lets a user chat with their AI agent and, on explicit user action, send the content of the currently active tab to that agent as context for the conversation.
```

## Privacy → Permission justifications

**activeTab**

```
Used to read the content of the tab the user is currently viewing only when the user explicitly invokes the extension (toolbar icon or in-page action), so that page content can be shared with their AI agent as conversation context.
```

**scripting**

```
Used to inject the content script that extracts the visible text/link context of the active page on user request, and to render an in-page link-hover affordance for sending a link to the agent.
```

**tabs**

```
Used to query the currently active tab (chrome.tabs.query) and to send messages to it (chrome.tabs.sendMessage) when relaying page content to the side panel chat, and when agent-initiated browser tools need to interact with the active tab.
```

**sidePanel**

```
Used to open the Chrome side panel that hosts the chat UI where the user talks to their AI agent.
```

**storage**

```
Used only for local ephemeral session state (chrome.storage.session) to pass a pending "open this link in the agent" action from the content script to the side panel, and a small local allowlist (chrome.storage.local) of domains the user has enabled the link-hover affordance on. Account session tokens and chat content are stored in the side panel's localStorage for the extension origin. No browsing history is persisted in chrome.storage.
```

**host_permissions**

```
The extension's core feature is letting the user send the page they are currently on to their AI agent from any website, so the content script and page-read capability must be available on all sites rather than an allowlist. No page content is read or transmitted unless the user takes an explicit action (opening the side panel / using the "send to agent" link affordance) or an agent tool call the user has already authorized through an active chat session — there is no passive/background collection.
```

## Privacy → Remote code & data usage

- **Remote code**: No, I am not using remote code
- **Data collected**: website_content, personally_identifiable_information
- **Privacy policy URL**: https://github.com/different-ai-studio/teamclu/blob/main/docs/chrome-extension-privacy.md

## Distribution

- **Visibility**: PUBLIC
- **Regions**: all

Note: Private/unlisted items are still fully reviewed. For internal-only
rollout, prefer Workspace admin force-install by extension ID.
