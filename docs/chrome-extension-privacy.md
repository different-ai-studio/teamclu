<!-- Source of truth for the TeamClu extension privacy policy. The hosted copy
     (https://www.teamclu.ai/privacy-extension, teamclaw-website repo
     public/privacy-extension.html) and docs/chrome-extension-privacy.html carry
     the same text — update all of them together. -->

# TeamClu Browser Extension — Privacy Policy

*Last updated: October 21, 2026*

This policy explains how the TeamClu team ("TeamClu", "we", "us") collects, uses, stores, shares and protects information when you use the TeamClu Chrome extension (Chrome Web Store ID `nlmkpmokfbboonocdnngddbfpdedkfee`, the "Extension") and the TeamClu service it connects to (the "Service").

## 1. Single purpose

TeamClu adds a Chrome side panel in which you chat with your team and your team's AI agents and, when you choose, share the web page you are viewing as context for that conversation.

## 2. Information we collect

- **Account information** — your email address and display name. If you use “Sign in with Google”, we receive your Google account name, email address and profile picture (OpenID scopes `email` and `profile` only). If you use password sign-in, your password is sent over TLS to our authentication server and stored there only as a salted hash. Authentication tokens are stored on our server and in the side panel's local storage in your browser so you stay signed in.
- **Conversation content** — messages, attachments and files you send in the side panel, session titles, and the replies produced by AI agents and teammates.
- **Web page content you choose to share** — the URL, title, visible text, selected text, links and a simplified outline of the page in your active tab. It is collected **only** when (a) an AI agent in your conversation asks to read the current page **and you approve that request** in the side panel, or (b) you click the TeamClu link button that appears on websites you added to the allow-list in Settings (this shares that link, its text and the surrounding page). The Extension does not read pages in the background, does not request the `tabs` permission and does not collect your browsing history.
- **Local settings** — your link-button allow-list, page-access and diagnostics choices and UI preferences, stored only in your browser (`chrome.storage` / local web storage).
- **Diagnostics (opt-in, off by default)** — only if you turn on “Send anonymous error reports” in Settings, error reports (stack traces, Extension and browser version, a random installation ID, and redacted console/network breadcrumbs) are sent to our error-monitoring provider. No account identity or IP address is attached.
- **Server logs** — like most online services, our servers record IP addresses, timestamps and request metadata for security, abuse prevention and troubleshooting.
- We do **not** collect payment or financial information, health information, precise location, keystrokes or mouse movements, or the content of pages you have not chosen to share.

## 3. How we use information

We use information only to: sign you in and keep your account secure; deliver and sync messages within your team; send the content you share to your team's AI agent and the AI model it uses so it can answer you; operate, secure and troubleshoot the Service; and, if you opted in, fix crashes. We do not use your information for advertising, do not sell it, do not use it to determine creditworthiness or for lending purposes, and do not use it for any purpose unrelated to the Extension's single purpose.

## 4. How we share information

- **Your team** — messages and shared page content in a team conversation are visible to members of that team.
- **Agent hosts** — your team's AI agents run on computers connected to your team (the TeamClu agent daemon), which may be operated by TeamClu or by members of your team. Conversation content, including page content you shared, is delivered to the agent host that serves the conversation.
- **AI model providers** — to generate replies, the relevant conversation content, including shared page content, is sent to the large-language-model provider configured for your team. On our hosted Service the default provider is DeepSeek; team administrators may configure other providers (for example OpenAI) or their own model endpoint. These providers process the data under their own API terms.
- **Service providers** — Alibaba Cloud (servers, database, file storage and e-mail delivery, in mainland China); Google (only when you use Google sign-in); Sentry, United States (only if you opted in to error reports). They process data on our behalf to provide the Service.
- **Legal reasons** — when required by law, or to protect the rights, property or safety of our users, the public or TeamClu.
- We never sell or rent personal data, and we do not share it with data brokers or advertisers.

## 5. Storage, retention and security

The Service is hosted on Alibaba Cloud servers in Shenzhen, mainland China. Data is encrypted in transit with TLS, access to production systems is restricted, and passwords are stored only as salted hashes.

- Account data is kept until you delete your account.
- Conversations and shared page content are kept until you or your team administrator delete the conversation or the team, or your account is deleted.
- Server logs and error reports are kept for a limited period (no longer than 90 days) unless needed to investigate a security incident.
- Local settings stay in your browser until you clear them or uninstall the Extension.
- When you ask us to delete your account, we delete your account data within 30 days, except where we are required by law to keep it.

## 6. International transfers

Your information is stored and processed in mainland China. If you use the Extension from another country, your information will be transferred to China, and to the countries where the providers listed above operate (for example the United States for Google and Sentry). We take the measures required by applicable law for such transfers.

## 7. Your choices and rights

- Turn agent page access off entirely, or decline any individual request, in the side panel (Settings → General → Privacy).
- Turn error reports on or off at any time in the same place.
- Remove site access you granted at `chrome://extensions` → TeamClu → Site access, or uninstall the Extension at any time.
- Revoke Google sign-in access at [myaccount.google.com/permissions](https://myaccount.google.com/permissions).
- Request access to, correction, export or deletion of your data, or your whole account, by e-mailing [contact@teamclu.ai](mailto:contact@teamclu.ai). Depending on where you live (for example under the EU/UK GDPR, the California CCPA or China's PIPL) you may have further rights, including objecting to processing and lodging a complaint with a supervisory authority. We respond within 30 days.

## 8. Permissions the Extension uses

- `sidePanel` — shows the TeamClu chat in Chrome's side panel.
- `activeTab` — lets the Extension access the tab you are on after you click the TeamClu toolbar button, so a page you approve sharing can be read.
- `scripting` — injects the content script that extracts the page you approved sharing, and shows the link button on allow-listed sites.
- `storage` — keeps your local settings in your browser.
- `identity` — used only for the optional “Sign in with Google” flow.
- Optional site access (`http://*/*`, `https://*/*`) — **not granted at install**. Chrome asks you only when you approve an agent's page request or add a site to the link-button allow-list, and only for that purpose.

## 9. Children

The Extension is not directed to children under 13 (or under 14 in mainland China), and we do not knowingly collect their personal information. If you believe a child has provided us information, contact us and we will delete it.

## 10. Chrome Web Store Limited Use

Our use of information received from Chrome APIs adheres to the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/policies), including the Limited Use requirements.

## 11. Changes to this policy

We will post any change on this page and update the “Last updated” date. If a change is material, we will tell you in the Extension or by e-mail before it takes effect.

## 12. Contact

Questions or requests about this policy or your data: [contact@teamclu.ai](mailto:contact@teamclu.ai) · [www.teamclu.ai](https://www.teamclu.ai)

---

# TeamClu 浏览器扩展隐私政策

*最后更新: 2026 年 10 月 21 日*

本政策说明 TeamClu 团队（下称“TeamClu”或“我们”）在您使用 TeamClu Chrome 扩展（Chrome 应用商店 ID：`nlmkpmokfbboonocdnngddbfpdedkfee`，下称“本扩展”）及其连接的 TeamClu 服务（下称“本服务”）时，如何收集、使用、存储、共享和保护您的信息。

## 1. 单一用途

TeamClu 在 Chrome 侧边栏中提供与团队成员及团队 AI agent 的对话，并在您选择时把正在浏览的网页作为对话上下文分享出去。

## 2. 我们收集的信息

- **账号信息**：邮箱地址和显示名。使用“Google 登录”时，我们会获得您的 Google 账号名称、邮箱和头像（仅 OpenID 的 `email`、`profile` 范围）。使用密码登录时，密码经 TLS 传输到我们的认证服务器，服务器只保存加盐哈希。认证令牌保存在我们的服务器和您浏览器中侧边栏的本地存储里，用于保持登录状态。
- **对话内容**：您在侧边栏发送的消息、附件和文件、会话标题，以及 AI agent 和团队成员的回复。
- **您选择分享的网页内容**：当前标签页的 URL、标题、可见文本、选中文本、链接和简化的页面结构。**只在**以下情况收集：(a) 对话中的 AI agent 请求读取当前页面，**并且您在侧边栏中批准了该请求**；(b) 您点击了在“设置”里加入白名单的网站上出现的 TeamClu 链接按钮（会分享该链接、链接文字和所在页面）。本扩展不在后台读取网页，不申请 `tabs` 权限，也不收集浏览历史。
- **本地设置**：链接按钮白名单、页面访问和诊断开关、界面偏好，只保存在您的浏览器中（`chrome.storage` / 本地 Web Storage）。
- **诊断信息（需主动开启，默认关闭）**：只有在您于“设置”中开启“发送匿名错误报告”后，错误报告（堆栈、扩展和浏览器版本、随机安装 ID、已脱敏的控制台/网络记录）才会发送给错误监控服务商，不附带账号身份和 IP 地址。
- **服务器日志**：与大多数在线服务一样，我们的服务器会记录 IP 地址、时间和请求元数据，用于安全防护、防滥用和故障排查。
- 我们**不**收集支付或财务信息、健康信息、精确位置、按键或鼠标轨迹，也不收集您未选择分享的网页内容。

## 3. 信息的使用

我们仅将信息用于：登录并保障账号安全；在团队内发送和同步消息；把您分享的内容发送给团队的 AI agent 及其使用的 AI 模型以生成回复；运行、保护和排查本服务；以及在您开启诊断后修复崩溃。我们不将信息用于广告，不出售信息，不用于信用评估或借贷，也不用于与本扩展单一用途无关的任何目的。

## 4. 信息的共享

- **您的团队**：团队会话中的消息和分享的网页内容，该团队的成员都可以看到。
- **Agent 宿主**：团队的 AI agent 运行在接入团队的计算机上（TeamClu agent 守护进程），这些计算机可能由 TeamClu 或您的团队成员运营。对话内容（包括您分享的网页内容）会发送到为该会话提供服务的 agent 宿主。
- **AI 模型服务商**：为生成回复，相关对话内容（包括分享的网页内容）会发送给您团队配置的大模型服务商。在我们托管的服务中默认使用 DeepSeek；团队管理员也可以配置其他服务商（例如 OpenAI）或自有模型接口。这些服务商按其 API 条款处理数据。
- **服务提供方**：阿里云（服务器、数据库、文件存储和邮件发送，位于中国大陆）；Google（仅在您使用 Google 登录时）；Sentry，美国（仅在您开启错误报告时）。它们代表我们处理数据以提供本服务。
- **法律要求**：依法律要求，或为保护用户、公众或 TeamClu 的权利、财产和安全时披露。
- 我们从不出售或出租个人信息，也不与数据经纪商或广告商共享。

## 5. 存储、保留与安全

本服务部署在位于中国大陆深圳的阿里云服务器上。数据传输全程 TLS 加密，生产系统访问受到限制，密码只以加盐哈希形式保存。

- 账号数据保留到您注销账号为止。
- 对话和分享的网页内容保留到您或团队管理员删除该会话或团队、或您的账号被删除为止。
- 服务器日志和错误报告只保留有限时间（不超过 90 天），调查安全事件所需的除外。
- 本地设置保留在您的浏览器中，直到您清除数据或卸载本扩展。
- 您申请注销账号后，我们会在 30 天内删除您的账号数据，法律要求保留的除外。

## 6. 跨境传输

您的信息在中国大陆存储和处理。如果您在其他国家或地区使用本扩展，您的信息会被传输到中国，以及上文所列服务商所在的国家或地区（例如 Google 和 Sentry 所在的美国）。我们会按适用法律的要求采取相应措施。

## 7. 您的选择与权利

- 在侧边栏“设置 → 通用 → 隐私”中完全关闭 agent 读取页面，或拒绝任何一次请求。
- 在同一位置随时开启或关闭错误报告。
- 在 `chrome://extensions` → TeamClu → 网站访问权限 中撤销已授予的网站访问权限，或随时卸载本扩展。
- 在 [myaccount.google.com/permissions](https://myaccount.google.com/permissions) 撤销 Google 登录授权。
- 发送邮件至 [contact@teamclu.ai](mailto:contact@teamclu.ai)，申请查阅、更正、导出或删除您的数据或整个账号。根据您所在地区的法律（例如欧盟/英国 GDPR、美国加州 CCPA、中国《个人信息保护法》），您可能还享有拒绝处理、向监管机构投诉等权利。我们会在 30 天内答复。

## 8. 本扩展使用的权限

- `sidePanel`：在 Chrome 侧边栏中显示 TeamClu 聊天界面。
- `activeTab`：在您点击 TeamClu 工具栏按钮后访问当前标签页，以便读取您批准分享的页面。
- `scripting`：注入内容脚本以提取您批准分享的页面，并在白名单网站上显示链接按钮。
- `storage`：在浏览器中保存本地设置。
- `identity`：仅用于可选的“Google 登录”。
- 可选网站访问权限（`http://*/*`、`https://*/*`）：**安装时不授予**。只有在您批准 agent 的页面请求、或把网站加入链接按钮白名单时，Chrome 才会询问您，并且只用于该用途。

## 9. 未成年人

本扩展不面向 13 岁以下（中国大陆为 14 岁以下）的儿童，我们不会故意收集他们的个人信息。如果您认为有儿童向我们提供了信息，请联系我们，我们会将其删除。

## 10. Chrome 应用商店“有限使用”声明

我们对通过 Chrome API 获得的信息的使用，遵守 [Chrome Web Store 用户数据政策](https://developer.chrome.com/docs/webstore/program-policies/policies)，包括“有限使用（Limited Use）”要求。

## 11. 政策变更

任何变更都会发布在本页并更新“最后更新”日期。重大变更会在生效前通过本扩展内的提示或邮件告知您。

## 12. 联系我们

关于本政策或您的数据的问题与请求：[contact@teamclu.ai](mailto:contact@teamclu.ai) · [www.teamclu.ai](https://www.teamclu.ai)
