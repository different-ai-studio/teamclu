# Product Hunt 发布材料 — TeamClu

> 基线：`main` · `package.json` v0.4.1-beta.71 · 整理于 2026-09-16，定稿于 2026-09-28
> 用途：按字段复制粘贴到 [Product Hunt 发帖页](https://www.producthunt.com/posts/new)。
> 说明：PH 表单里的内容（Name / Tagline / Description / Maker comment）都是**英文**，
> 每段旁边的中文是给你看的填写提示，不要粘进表单。

**这一版的叙事主线是团队协作**：团队共享的 Skills（版本化、自动跟随）+ 会话即群聊
（多人 + agent 同一个上下文）。「跑在自己机器上」从主角降为支撑点——它是「为什么能做到
共享能力层而不用交出上下文」的答案，不是卖点本身。本仓库此前没有 PH 材料，这份是新建的。

---

## 0. 目录里有什么

| 文件 | 内容 |
|------|------|
| `README.md` | 本文档：PH 表单文案、Maker 评论、FAQ、清单、时间线 |
| `social-launch.md` | 发布日社媒/社群文案（X、LinkedIn、HN、Reddit、即刻、V2EX、知乎） |
| `ph-draft.json` | 同一套文案的机读版本，字段与本文一一对应 |
| `src/README.md` | 截图来源与「如何重拍」说明 |
| `src/team-skills.png` | ② 的原始截图：团队技能详情（版本历史 / owner / 恢复） |
| `src/group-session.png` | ④ 的原始截图：会话里的 @提及与 agent 参与者 |
| **PH Demo（YouTube）** | https://youtu.be/aMSSTexvewE — 微信介绍片 · Unlisted · 见 §9.0 |
| `../videokit/README.md` | **备用** 87 秒 loop 片说明（ASSIGN→BUILD→REVIEW→COMPOUND） |
| `../videokit/out/teamclu-loop-1080p.mp4` | 备用成片 1920×1080 / 87.0s / 793 KB（**无声**） |
| `../videokit/youtube.md` · `voiceover.md` | 备用片的 YouTube 文案 / 配音稿 |
| `screenshots/ph-1-workspace-1270x760.png` | Gallery ①（主图）：团队工作台 |
| `screenshots/ph-2-team-skills-1270x760.png` | Gallery ②：**团队共享 Skills** |
| `screenshots/ph-3-channels-1270x760.png` | Gallery ③：多通道网关 |
| `screenshots/ph-4-group-session-1270x760.png` | Gallery ④：**会话即群聊** |
| `screenshots/ph-5-extension-1270x760.png` | Gallery ⑤：浏览器侧边栏 |
| `screenshots/thumbnail-512.png` / `thumbnail-240.png` | 方形 Logo（PH 会裁成圆形） |

Gallery 由**真实产品截图**合成，不是模拟图。重新生成：

```bash
node scripts/build-producthunt-gallery.mjs
```

需要 `magick`（`brew install imagemagick`）。脚本会校验输出必须是 1270×760。

> ✅ **Gallery 5 张已齐。** 第 2、第 4 位（团队共享 Skills、会话即群聊）是从真实应用里现拍的，
> 原图存在 `src/`，重跑脚本即可复现。第 4 位做过一次裁剪，原因**必须看 §4**。

---

## 1. PH 表单字段（直接复制）

### Name

```
TeamClu
```

### Tagline（限 **60 字符**）

主推：

```
Shared skills and group chat for your team's AI agents.
```

（55 字符）

备选（都已核过 ≤60 字符）：

| 字符数 | Tagline |
|--------|---------|
| 51 | `One group chat where your team and its agents work.` |
| 51 | `Give your whole team the same AI agents and skills.` |
| 54 | `Your team's AI agents — shared skills, one group chat.` |
| 55 | `Team agents: shared skills, shared context, group chat.` |

> 如果更想突出「不用把上下文交给云」，可退回上一版的
> `Local AI agents your whole team can share.`（42）——但团队向的两个功能就没在 tagline 里了。

### Link

PH 要求一个可点击的落地链接。**填 `https://teamclu.ai/`** —— 这是现有官网。

站点在私有仓 `different-ai-studio/teamclaw-website`（仓库名里的 `teamclaw` 是
`teamclaw → teamclu` 改名时留下的旧名，**不是域名**），经 GitHub Actions 部署到
Cloudflare Pages。

> ⚠️ **别用 `teamclaw.ai`。** 该域名已不在本项目名下，`https://teamclaw.ai`
> 会 **302 跳到 `workclaw.com`** —— 那是另一个产品。历史域名 `teamclaw.tech`
> 已经 301 到 `teamclu.ai`，`teamklo.com` 当年买了没绑（404）。
> 唯一正确的域名是 **`teamclu.ai`**。

| 选项 | URL | 说明 |
|------|-----|------|
| **A（填这个）** | `https://teamclu.ai/` | 现有官网，英文 + 中文 |
| B | `https://github.com/different-ai-studio/teamclu` | 兜底：源码树，团队向产品不理想 |

> 发布前确认三件事（详见 §5）：域名能打开、**页面 og 标签能出预览卡片**、
> 站上叙事与本材料一致。前两项是纯技术项，第三项已按「群聊 + 版本化团队技能」
> 重排过首页。

### Description（PH 上限实测 **500 字符**）

> ⚠️ **实测修正**：PH composer 的 Description 计数器是 **500**。本仓库早先那版
> 「中版 779 字符」**根本放不进去**。下面 415 字符这版保留了团队主线，已用于草稿。

**推荐（415 字符）**

```
TeamClu is a shared workspace where your team and its AI agents work in the same group chats.

Sessions are group chats, not 1:1 bot chats: add teammates, @mention people, branch an agent reply into a thread, and see who's online.

Skills are team assets: publish one with a changelog and every teammate's agent follows it automatically. Edit locally and you get a conflict, never a silent overwrite.

MIT, in beta.
```

**短版（302 字符）** —— 想更克制时用：

```
TeamClu is a shared workspace where your team and its AI agents work in the same group chats. Skills are versioned team assets: publish one and every teammate's agent picks it up automatically. Knowledge, roles and MCP config are shared too, while each member keeps a private context. Open source, MIT.
```

### 各字段实测上限（来自 live composer）

| 字段 | 上限 | 我们填的 |
|------|------|---------|
| Name of the launch | 40 | `TeamClu`（7） |
| Tagline | 60 | 55 |
| **Description** | **500** | 415 |
| Links to the launch | — | `https://teamclu.ai/` |
| Is this an open source project? | 勾选 | ✅ 已勾（MIT） |
| X account of the launch | — | **留空**（没有账号，不要编） |
| 「What inspired you to build this?」 | 未见计数器 | 1137 字符（Maker 故事，见 `ph-draft.json` 的 `story`） |

### Topics / Launch tags

PH 的标签是**固定词表**，我们早先写的名字对不上。实测对应关系：

| 我们想表达 | PH 里的实际标签 |
|-----------|----------------|
| 团队协作 | `Team collaboration software` |
| AI | `AI Agents` |
| 效率 | `Productivity` |

最多选 3 个，且 **Launch tag 是必填**——不填就点不动「Next step: Images and media」。

### Pricing

```
Free
```

> MIT 开源、可自托管。不要写「Free + 后续收费」这类模糊表述。

### Thumbnail / Gallery

| 位置 | 文件 | 状态 |
|------|------|------|
| Thumbnail / Logo | `screenshots/thumbnail-512.png` | ✅ |
| Gallery ①（主图） | `screenshots/ph-1-workspace-1270x760.png` | ✅ 团队工作台 |
| Gallery ② | `screenshots/ph-2-team-skills-1270x760.png` | ✅ **团队技能详情**（现拍） |
| Gallery ③ | `screenshots/ph-3-channels-1270x760.png` | ✅ 多通道 |
| Gallery ④ | `screenshots/ph-4-group-session-1270x760.png` | ✅ **群聊里的 @提及**（现拍，已裁剪） |
| Gallery ⑤ | `screenshots/ph-5-extension-1270x760.png` | ✅ 侧边栏 |

每张的一句话（PH 若支持 caption，或用于正文/社媒）：

1. Your team and its agents, one workspace
2. **Skills your whole team shares** — publish once, everyone's agent follows
3. Meet your agents where you already talk
4. **Sessions are group chats** — teammates and agents in one thread
5. Agents in your browser side panel

> ②④ 是这一版的主线，图对题；其余别为了凑数再塞扩展功能的图。

---

## 2. Maker 首发评论（发布后 5 分钟内发）

已换成 Bertrand（见 §7 的确认依据）。PH 不喜欢「求 upvote」的措辞，这条里没有，别加。

```
Hey Product Hunt 👋

I'm Bertrand, and I build TeamClu.

Every team I know has the same problem with AI agents, and it isn't the model. It's that the agent is personal. I teach mine how we run a release; a teammate teaches theirs the same thing a month later, slightly differently. And the work itself happens in a chat window nobody else can see.

So TeamClu makes two things shared instead of private.

1. Skills are team assets. You publish one to your team's registry with structured metadata and a changelog. Every teammate's agent follows it automatically — when you fix a broken step, the fix actually reaches people instead of dying in your dotfiles. Change it and it propagates; edit locally and you get a conflict to resolve, never a silent overwrite.

2. Sessions are group chats. Not 1:1 chats with a bot: add teammates, @mention people, see who's online, and branch any agent reply into its own thread. The agent is a participant, not a service — it can be offline, permission-limited, or switched to another model mid-conversation.

Knowledge, roles and MCP config are shared the same way, and each member still keeps a private context. Agents run on your own machines, and your team can reach them from WeCom, Feishu, Discord, KOOK, WeChat or Email.

It's MIT licensed and in beta.

I'd genuinely like to hear how your team handles this today: does everyone run their own agent, or do you share one? And what would you refuse to share? 🙏

Repo: https://github.com/different-ai-studio/teamclu
```

---

## 3. FAQ（可直接回评论，或放落地页）

| Question | Answer |
|----------|--------|
| How does a skill reach my teammates? | You publish it to the team registry. Installed team skills follow `latest_version` automatically on a background reconcile loop — no "please update your skill" messages. |
| What if I edit a shared skill locally? | You get a conflict to resolve. Automatic updates never silently overwrite your local edits. |
| What if someone publishes a bad version? | Every version is immutable with a changelog, and one click re-publishes an older version as the new latest. |
| Who is allowed to publish? | Any team member. The registry is a team asset — `owner` means responsibility, not permission. |
| Can two people talk to the same agent? | Yes. A session is a group chat with human and agent participants. |
| Do @mentions grant access? | No. Being mentioned does not add you to a session. |
| Does the whole team share one context? | No. Skills, knowledge, roles and MCP config are shared; each member keeps a private context. |
| Can a skill be secret from some teammates? | Not today. Encryption is one key per team shared by all members — it protects against the storage provider, not against colleagues. Per-person skill visibility is not built yet. |
| Can I use it alone? | Yes, everything works for a single user. |
| Where do the agents run? | On your own machines, hosted by the local `amuxd` daemon — not in our cloud. |
| Is it production-ready? | It's v0.4.1 **beta**. Use it, file issues, expect rough edges. |

---

## 4. ②④ 两张团队图怎么来的（以及为什么 ④ 是裁过的）

这两张不是素材库里翻出来的，是从**正在运行的桌面应用**里现拍的，原图存在 `src/`：

| 文件 | 内容 | 对应主张 |
|------|------|---------|
| `src/team-skills.png` | 技能详情：`general • v2`、负责人（Bertrand）、「什么时候用 / 什么时候别用」、版本列表（**v2 已安装** + changelog「support windows」+ v1）、**恢复此版本**、退役 | skill 是版本化的团队资产 |
| `src/group-session.png` | 会话「询问操作系统与技能管理」：用户 **@xiaomei** 提问 → agent 作为参与者回复（带引用「回复你」、处理过程、结构化表格） | 会话是群聊，agent 是参与者 |

重跑即可复现（脚本会校验输出必须是 1270×760）：

```bash
node scripts/build-producthunt-gallery.mjs
```

### ④ 是裁过的 —— 上线前请确认这一点

完整窗口版**不能用**。左侧会话列表会露出真实业务数据，我逐张 OCR 扫到过：

```
WeCom group: wrOOCIYgAAze..          （企业微信群 ID）
**今天（9/15）核销额：767.26元，24笔..   （真实经营数字）
用ngrok分享本地模型
我想获取https://life.douyin.c..
```

所以 ④ 只裁了中间对话列（695×640），把会话列表切成画面外。已复扫 5 张成品图，
`sensitive_hits = 0`。

**代价**：④ 看不见参与者头像簇和在线状态，所以这张的 caption 也相应改成
「teammates and agents in one thread」，**没有**写 threads / presence——图里没有的东西不写。

**想要完整三栏版**（带参与者头像，对「群聊」更有说服力）有两条路：用一个**演示团队**重拍，
或先把那几个含业务数据的会话归档。然后把新图覆盖 `src/group-session.png` 重跑脚本即可。

> 另：② 里出现了 `负责人，Bertrand`（发布者本人，通常没问题），以及 SKILL.md frontmatter
> 里一个 actor UUID。介意 UUID 的话我可以把详情页那一块裁掉。

---

## 5. 发布前清单

| 项目 | 说明 |
|------|------|
| ☑ **§4 的两张团队截图已拍** | 原图在 `src/`；④ 已裁掉含业务数据的列表列 |
| ☐ **确认 ④ 的裁剪可接受** | 否则用演示团队重拍完整三栏版，见 §4。**这是当前最该补的一项**——「群聊」主张最有说服力的部分（参与者头像簇、在线状态）恰恰不在图里 |
| ☐ 决定 ②④ 是否重拍英文版 | PH 主流量在英文区，而 ②④ 是**中文界面**。`src/README.md` 写了重拍方法（应用切语言 + 演示数据）。不重拍也能发，只是转化率打折——自己权衡 |
| ☑ **Demo 视频已上传 YouTube** | **PH 用这个：** https://youtu.be/aMSSTexvewE （微信产品介绍片 · ~60s · Unlisted · 频道 b319）。见 §7 / §9。备用 loop 片仍在 `videokit/out/teamclu-loop-1080p.mp4` |
| ☐ 官网已同步并确认 | `teamclu.ai` 是现有官网（私有仓 `teamclaw-website`）。发布前确认：域名能打开、**分享链接能出预览卡片**（og 标签）、首页叙事与本材料一致、站上无模拟图冒充产品截图 |
| ☑ **确认 GitHub 仓库 public** | 已核实：`different-ai-studio/teamclu` 为 PUBLIC（2026-09-28） |
| ☐ **切一个新 release** | 线上最新是 `v0.4.1-beta.43`（2026-09-05），代码已到 `beta.71`——**落后 28 个版本**。访客按下 install 拿到的是三周前的构建。见 §6 |
| ☐ 安装包可下载 | GitHub Releases 的 `.dmg` / `.exe` 可用；macOS 未签名会被 Gatekeeper 拦，README 已有 `xattr -cr` 说明 |
| ☑ 截图里没有真实团队数据 | 已对 5 张成品 OCR 复扫敏感串，命中 0（见 §4） |
| ☑ **Gallery 5 张 + Logo 就绪** | 见 §1 表格。7 张文件已入库，且删掉后重跑 `node scripts/build-producthunt-gallery.mjs` 可逐像素复现 |
| ☑ Maker 评论定稿 | 见 §2，姓名已填 Bertrand |
| ☐ PH 账号确认可用 | 用真人个人号，比品牌号更容易被社区接受；先确认能正常发帖 |
| ☐ 3–5 位朋友愿意在发布日留言 | 只约「来聊聊/提问题」，不要组织刷票 |
| ☐ 发布时间 | PT 00:01（北京时间夏令时 15:01 / 冬令时 16:01），周二至周四较好 |

> **仍然只能由你本人提供**：Maker 真名、联系邮箱、是否公开 X 账号。见 §7。
> X 账号留空是对的——表单要求这一项，但没有就是没有，编一个更糟。

---

## 6. Launch Day 时间线（北京时间）

### 先决条件：切一个 release

线上最新是 `v0.4.1-beta.43`（2026-09-05），代码已到 `v0.4.1-beta.71`——**中间差 28 个
版本**。PH 访客看到 Download 按钮、按下去、拿到三周前的构建，这是最容易毁掉第一印象
的地方，且发生在落地页已经说服他之后。具体命令见 `docs/release/desktop.md`；要点：

1. 在 `main` 上打 tag（不是 beta 分支），走完整签名流程产出 `.dmg` / `.exe` + `latest.json`
2. 确认 `build.config.production.json` 的 updater `endpoints` 指向
   `github.com/different-ai-studio/teamclu/releases/latest/download/latest.json`（已正确）
3. 发完打开 `https://github.com/different-ai-studio/teamclu/releases/latest`，
   **用无痕窗口点一遍下载链接**——`latest` 是重定向，最容易在这里断
4. 落地页的下载按钮指的就是这个 `latest` 地址，所以第 3 步通过，落地页就自动跟着对

### 时间表

| 时间 | 动作 |
|------|------|
| D-7 | 切 release；补拍团队图；Gallery/落地页定稿；约好 3–5 位朋友 |
| D-3 | 社媒预热（`social-launch.md`）；可选 PH Coming Soon |
| D-1 | 复查 `https://teamclu.ai/` 可访问、`releases/latest` 能下、截图无敏感信息 |
| **D-Day 15:01** | 发布 → 立刻发 Maker 评论 |
| D-Day +30min | 开始逐条回复评论（早点回，别堆到晚上） |
| D-Day 当天 | 中文社群二次传播（`social-launch.md` 中文段） |
| D+1 | 看数据、把反馈收成 issue；别只回夸你的评论 |

> PH 的日榜从 PT 00:01 起算，24 小时后结算。规则偶有调整，发布前在 PH 后台再确认一次。

---

## 7. 待你填写的占位符

```
Maker 姓名：Bertrand                   ← 已确认（2026-09-28，见下）
PH 账号：@b319                          ← 已确认
PH 帖子 URL：________________
落地页 URL：https://teamclu.ai/          ← 现有官网（勿用 teamclaw.ai，会跳到 workclaw.com）
GitHub 仓库：https://github.com/different-ai-studio/teamclu   （已确认 public）
下载链接：https://github.com/different-ai-studio/teamclu/releases/latest   （待切新版）
X / Twitter：@________________          ← 没有就留空，不要编
联系邮箱：support@teamclu.ai           ← 已确认，取自官网 Footer
Demo 视频：微信产品介绍片（~60s · 1280×720）    ← 2026-10-09 定为 PH Demo
Demo 视频链接（YouTube）：https://youtu.be/aMSSTexvewE   ← Unlisted · 频道 b319 · 填进 PH media
备用 loop 片：videokit/out/teamclu-loop-1080p.mp4      ← 87s 无声规格图，暂不作为 PH Demo
```

> `[PH link]` 在 `social-launch.md` 里出现 10 处，发布后统一换成当天的帖子 URL。

**Maker 姓名怎么确认的**（不是猜的）：已登录的 PH 账号是 `@b319`，其 profile 页
显示名为 **Bertrand**（加入于 2026-08-08，已发布过 TradingPlan）；git 提交身份为
`b319 <weigan.huang@gmail.com>`；截图里的「负责人 · Bertrand」是同一人。

**由谁发布：只用 `@b319`，不要用第二个账号重发**（2026-09-28 决定）。

财务负责人另有一个账号（`lynnlin603@gmail.com`）。曾经考虑用它重新发布
TeamClu，**已否决**，原因是三条具体的：

1. `@b319` 名下已有 in-progress 的 TeamClu 产品条目，换号发会在 PH 上产生
   **两个 TeamClu 产品**。产品名唯一性由 PH 人工裁定，重复条目轻则被合并。
2. PH 明确禁止多账号操作同一产品。用小号重发抬排名是风控重点识别对象，
   一旦被判定，损失的不是这个帖子，而是这个域名之后所有发布能力。
3. 新账号零历史、零社区关系，首发日没有人可以动员；而 `@b319` 已有一次
   发布记录。

**替代做法**：在 `@b319` 的 TeamClu 帖子里把财务负责人加为 **co-maker**，
发布时两个名字一起显示。既表达了「谁在管这件事」，又完全避开重复产品。

> ⚠️ 加 co-maker 必须由**帖子所属账号**（`@b319`）操作，不能反过来。所以
> 资料（头像、显示名、bio）要在新账号里先填好，再切回 `@b319` 加人 ——
> 顺序反了会把资料存进错的账号。

---

## 7.5 PH 当前的实际提交流程（2026-09-28 实测，与 §1 的描述不同）

§1 的字段表是 2026-09-16 对着 composer 记的。**今天从 `producthunt.com/posts/new`
进去，第一屏不是 Name/Tagline/Description 那一套**，而是「选产品或填链接」：

| 元素 | 内容 |
|------|------|
| 标题 | Submit a product |
| `Choose a product...` | 从已有产品里选（用于「Launching again?」，让新 launch 关联到原产品） |
| `www.producthunt.com` | Link to the product，填链接则是**新建产品** |
| `Get started` | 主 CTA |
| 提示 | **Your existing in progress posts: TeamClu** |

该账号下 `TeamClu` 已存在一个 in-progress 产品条目（`/products/teamclu` 返回 404，
因为未发布；Maker History 里只有 TradingPlan）。

> ⚠️ **所以要选 `Choose a product...` 里已有的 TeamClu，不要走「填链接新建」那条路**，
> 否则会变成两个产品条目。
>
> 这个下拉是自定义组件，只响应**可信用户事件**（trusted event）。以下六种脚本
> 方式全部试过、全部无效：原生 value setter + `input`/`change`、逐字符
> `KeyboardEvent`、`pointerdown`/`mousedown`/`focus`/`click` 组合派发。
> **这一步只能真人点击。**
>
> 选完之后才会进入 §1 描述的 Name / Tagline / Description / Topics / Pricing。
> **所以 §1 的字段名与上限需要在选完产品之后重新核对一遍**，别直接照抄。

### 浏览器自动化的可行边界

这次实测下来，值得记一笔，免得下次重走：

| 能力 | 状态 |
|------|------|
| AppleScript `execute javascript` 读页面 / 设值 / 读回验证 | **可用**（需在 `View → Developer` 勾选 Allow JavaScript from Apple Events） |
| 上传图片（file input） | **不可用** — 脚本无法给 file input 赋值 |
| 点击 React 自定义下拉 | **不可用** — 只认真实事件 |
| 按屏幕坐标点击 / 键盘输入 | **不可用** — Chrome 窗口在另一个 macOS Space，`screencapture` 抓不到，autoui 的视觉后端 API key 无效 |

入口脚本是 `ph-driver.mjs`（按 URL 匹配 producthunt.com 的标签页并执行传入的 JS）。
它读得到页面、填得了文本、验得了结果，但凡是需要「真实用户」的动作就卡住。

---

## 8. 事实基线（写文案时依据的事实，便于复核）

**团队向（这一版的主线）**

| 事实 | 来源 |
|------|------|
| Skill 是「团队可以拥有、版本化、审计的资产」，不是提示词片段 | `docs/features/06-skills-roles-marketplace.md` §0 |
| 团队 Skills Registry：发布门 6 个必填字段、追加式版本历史、changelog、owner（可转交） | 同上 §3.1、§4 |
| **任何团队成员都能发布新版 / 改元数据 / 撤回**；owner 只是责任不是权限 | 同上 §3.3 |
| **已装团队 skill 自动跟随 `latest_version`**：daemon 10 分钟对账 + MQTT 加速 | 同上 §6.1、§6.2 |
| 脏改保护：本地改动不被静默覆盖，产生冲突走人工决策 | 同上 §6.4 |
| 一键撤回：旧版内容重发为 `latest+1` | 同上 §6.4 |
| 市场为注册表补第二个入口，且**订阅上游版本** | 同上 §8 |
| Role = 一组 skill 的命名组合；`/` 弹窗分 Roles / Skills / Commands | 同上 §9 |
| 团队共享 agent（`visibility='team'`）：管理员装 skill，承载它的机器在下个对账周期拉到 | 同上 §7 |
| 会话是**协作单元**：多个 actor（人 + agent）在同一上下文 | `docs/features/03-session-collaboration-realtime.md` §0 |
| `session_participants` + 在线状态（MQTT `actor/state`），人类绿点 / agent 珊瑚点 | 同上 §7.1、§7.2 |
| @提及有独立快捷入口；**提及不是权限**，不等于加入会话 | 同上 §7.3 |
| 线程：只有 agent 回复能开线程，是独立 cloud session，首次发送才懒 fork | 同上 §6.1、§6.2 |
| agent 是参与者不是服务端：可离线、可限权、可中途换模型 | 同上 §2.2 |
| 消息级动作：引用 / 复制 / 重新生成 / 反馈 / 星级 / token 用量 | 同上 §8 |

**支撑向**

| 事实 | 来源 |
|------|------|
| 产品名 **TeamClu** | `apps/desktop/tauri.conf.json` → `productName`；`README.md` |
| 版本 v0.4.1-beta.71 | `package.json`、`apps/desktop/Cargo.toml`、`apps/daemon/Cargo.toml` |
| MIT 许可 | `LICENSE`、`README.md` |
| 客户端：Desktop / iOS / Expo / Chrome MV3 | `README.md` → Clients |
| 六个通道：WeCom、Feishu、Discord、KOOK、WeChat、Email | `README.md`、`build.config.json` → `features.channels` |
| 知识库：Markdown vault，路径级 ACL + 版本历史 | `README.md` → Features |
| 团队同步走 S3 兼容存储，共享根只有 `team-knowledge/` 与 `team-documents/` | `README.md` → Team collaboration |
| 本地运行时由 `amuxd` 托管 | `README.md` → How it works；`docs/architecture/pi-agent-backend.md` |

**被追问时要注意的三点（文案里刻意没放大，但别答错）**

1. **skill 没有成员间可见性隔离。** 现有加密是一个团队一把密钥、全体共用，
   防的是云厂商不是同事（`06` §1.3）。FAQ 里已经如实写了，被追问别含糊。
2. **@提及不是权限。** 通道里 @bot 的语义是「这条消息给 agent」，不是「把人拉进会话」（`03` §7.3）。
3. **品牌名。** 规范名是 **TeamClu**，唯一真相源是 Rust 的
   `crates/teamclu-runtime-env/src/storage_namespace.rs` 里的
   `OFFICIAL_STORAGE_DIR = "teamclu"`；`build-config.ts` 默认值、
   `resolve-brand-profiles.mjs` 官方档案、`build.config.production.json`、
   扩展两个 locale 的 `appName` 全都是 `teamclu`。
   `brand-parity.test.ts` 断言 `isOfficialBrand("teamclaw")` **必须为 false**——
   `teamclaw` 是被定义为白牌名的，不是官方名。
   仍然残留 `TeamClaw` 字样的只有 `build.config.json`（gitignored 的本地开发配置，
   **不是发布路径**；改成 `teamclu` 前先确认本机没有 `~/.teamclaw/` 下的旧数据）
   和 CDN 上的旧域名 `teamclaw.ucar.cc`。
   另外 `README.md` 架构图仍写 `local agents … opencode (default)`，
   而 pi 自 2026-09-04 起是唯一本地运行时（ADR-0014）——文案不点名任何运行时，
   所以不受影响，但别照 README 答。

---

## 9. Demo 视频

### 9.0 当前 PH Demo（已定稿）

| 项 | 值 |
|----|-----|
| **YouTube** | https://youtu.be/aMSSTexvewE |
| Watch | https://www.youtube.com/watch?v=aMSSTexvewE |
| 可见性 | Unlisted（PH 能嵌；首发日再视情况转 Public） |
| 频道 | b319（`weigan.huang@gmail.com`） |
| 素材 | 微信导出的产品介绍片 · ~60s · 1280×720 |
| YouTube 标题 | `TeamClu — Local AI Agents for Teams \| Product Intro` |
| 回填 | `ph-draft.json` → `video.youtubeUrl` · §7 占位符 |

发帖时把上面的链接粘进 PH media / video 字段即可。

> **2026-10-09 决定：** PH Demo 用这条微信介绍片，**不用**下面的 87s loop。
> loop 仍保留作备用素材（叙事更贴 ASSIGN→BUILD→REVIEW→COMPOUND）。

### 9.1 备用：87s loop 片（未用作当前 PH Demo）

**成片**：`videokit/out/teamclu-loop-1080p.mp4` · 1920×1080 · 30fps · **87.0 秒** ·
793 KB · H.264 High / yuv420p / faststart / bt709 · **无音轨**
**字幕**：`videokit/out/teamclu-loop-1080p.srt`（9 条）
**重建**：`node videokit/build-video.mjs`（约 1 分钟，需 ImageMagick + ffmpeg）

细节、两条硬规则、已知短板和混音命令见 **`videokit/README.md`**。YouTube 侧的
标题/描述/标签/章节在 `videokit/youtube.md`，配音稿（237 词，已配平）在
`videokit/voiceover.md`。

### 主线：一个环

```
ASSIGN ──▶ BUILD ──▶ REVIEW ──▶ COMPOUND ↺
```

「大部分 AI 工具从 BUILD 开始就停住了。TeamClu 的主张是这个环会闭上。」

这和 §1 那条叙事主线**同源**——PH 打的两个主张正好是环上的两站：
**ASSIGN = 会话即群聊**，**COMPOUND = 团队共享 Skills**。所以视频不是把 §1 的
文案念一遍，是把它画成一个流程。

### 它是什么形态

**全片静止、硬切，没有任何运镜**（无缩放、无推拉、无交叉溶解）。上一版用 Ken
Burns，读起来是「幻灯片配了个紧张的摄影机」，已整条拿掉。

**全片没有任何一张产品截图**——四站全是**标注式规格图**。原因和 §5 那个问题
是同一个：**仓库里每一张真实截图都有中文**（拍的时候应用跑在中文界面）。
`images/home.png` 虽是英文界面，但会话预览里仍然是 `## .opencode/skills/ 技能
清单`。没有可替换的干净英文截图，与其 P 掉中文或造假界面，不如画规格图——
规格图是明写「这是示意图」的。内容全部来自 `docs/features/`。

在英文界面下重拍两张，放到 `videokit/src/assign-en.png` 与
`videokit/src/compound-en.png`，重跑构建即自动改用真实截图。拍摄要点见
`videokit/README.md` §2。

REVIEW 站那张「气泡 vs 笔记」对照图是全片信息密度最高的一帧（03 §3.2）。

### 砍掉了什么

工作台全景、通道设置页、浏览器扩展。前者不证明任何东西；通道设置页是同一主张
最弱的表达（更好的表达是「能力在内核里」，07 §2，已放进倒数第二站）；扩展不
在这个环上。

### 填进 PH 的步骤

§7 的 `Demo 视频链接` 要的是**一个可访问的链接，不是文件上传**——§7.5 已实测，
自动化无法给 file input 赋值。

**当前状态（2026-10-09）：已完成。** 直接用 https://youtu.be/aMSSTexvewE 。

若以后要换成 loop 片，再走一遍：

1. 把 `videokit/out/teamclu-loop-1080p.mp4` 传 YouTube（**Unlisted**）
2. 复制链接，填进 PH 发帖流程的 media / video 字段
3. 回填 §7 的 `Demo 视频链接` 与 `ph-draft.json` 的 `video.youtubeUrl`

### 已知短板

1. **无声。** PH 能接受；YouTube 建议照 `videokit/voiceover.md` 配音 + 垫音乐。
2. **没有真实界面像素。** 见上。这是这一版最大的代价——观众看到设计与数据结构，
   看不到真在跑的界面。补上那两张英文截图能解决一大半。
3. **BUILD 站只有一句话。** 真跑起来的过程只有录屏才是诚实的证据；想要实拍版本
   照 `docs/demo-video-script.md` 录，这条留作备用。
4. **87 秒对 PH 略长。** 砍掉通道那站并压缩 REVIEW 可到 ~60 秒。
