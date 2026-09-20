# Product Hunt 发布材料 — TeamClu

> 基线：`main` · `package.json` v0.4.1-beta.62 · 整理于 2026-09-16
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
| `src/README.md` | 截图来源与「如何重拍」说明 |
| `src/team-skills.png` | ② 的原始截图：团队技能详情（版本历史 / owner / 恢复） |
| `src/group-session.png` | ④ 的原始截图：会话里的 @提及与 agent 参与者 |
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

### Link ⚠️ 有个缺口

PH 要求一个可点击的落地链接。**这个仓库里没有官网/落地页**。可选：

| 选项 | URL | 说明 |
|------|-----|------|
| A（推荐） | `https://github.com/different-ai-studio/teamclu` | 需确认仓库为 public |
| B | `https://github.com/different-ai-studio/teamclu/releases` | 直接指向安装包 |
| C | `https://teamclaw.ucar.cc/beta/` | 国内 Beta CDN（旧 TeamClaw 域名，前缀 `beta`） |

> 团队向的产品尤其吃亏：PH 来的人第一眼应该看到「团队共享 skill 长什么样」，
> 而不是源码树。建议至少做一个单页落地页，把 `ph-2` / `ph-4` 两张图放上去。

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
| Links to the launch | — | GitHub 仓库 URL |
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

`[Your name]` 换成你的真名。PH 不喜欢「求 upvote」的措辞，这条里没有，别加。

```
Hey Product Hunt 👋

I'm [Your name], and I build TeamClu.

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
| ☐ **确认 ④ 的裁剪可接受** | 否则用演示团队重拍完整三栏版，见 §4 |
| ☐ 落地页就绪 | 当前缺口。至少让陌生人 10 秒内知道这是什么、怎么装 |
| ☐ 确认 GitHub 仓库 public | Link 字段与 Maker 评论都指向它 |
| ☐ 安装包可下载 | GitHub Releases 的 `.dmg` / `.exe` 可用；macOS 未签名会被 Gatekeeper 拦，README 已有 `xattr -cr` 说明 |
| ☑ 截图里没有真实团队数据 | 已对 5 张成品 OCR 复扫敏感串，命中 0（见 §4） |
| ☐ Gallery 5 张 + Logo 上传 | 见 §1 表格 |
| ☐ Maker 评论定稿 | 见 §2，换掉 `[Your name]` |
| ☐ 3–5 位朋友愿意在发布日留言 | 只约「来聊聊/提问题」，不要组织刷票 |
| ☐ 账号用真人个人号 | 比品牌号更容易被社区接受 |
| ☐ 发布时间 | PT 00:01（北京时间夏令时 15:01 / 冬令时 16:01），周二至周四较好 |

---

## 6. Launch Day 时间线（北京时间）

| 时间 | 动作 |
|------|------|
| D-7 | 补拍两张团队图；Gallery/落地页定稿；约好 3–5 位朋友 |
| D-3 | 社媒预热（`social-launch.md`）；可选 PH Coming Soon |
| D-1 | 复查 Link 可访问、安装包可下、截图无敏感信息 |
| **D-Day 15:01** | 发布 → 立刻发 Maker 评论 |
| D-Day +30min | 开始逐条回复评论（早点回，别堆到晚上） |
| D-Day 当天 | 中文社群二次传播（`social-launch.md` 中文段） |
| D+1 | 看数据、把反馈收成 issue；别只回夸你的评论 |

> PH 的日榜从 PT 00:01 起算，24 小时后结算。规则偶有调整，发布前在 PH 后台再确认一次。

---

## 7. 待你填写的占位符

```
Maker 姓名：________________
PH 帖子 URL：________________
落地页 URL：________________          ← 当前不存在，见 §1「Link 有个缺口」
GitHub 仓库：https://github.com/different-ai-studio/teamclu   （确认 public）
下载链接：________________
X / Twitter：@________________
联系邮箱：________________
Demo 视频：________________
```

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
| 版本 v0.4.1-beta.62 | `package.json`、`apps/desktop/Cargo.toml`、`apps/daemon/Cargo.toml` |
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
3. **品牌名与过时 README。** 代码已完成 `teamclaw → teamclu` 改名（commit `a7d65c3b`），
   PH 统一用 **TeamClu**；但 `build.config.json` 的 `app.name` 仍是 `TeamClaw`，
   CDN 也还有旧域名 `teamclaw.ucar.cc`。另外 `README.md` 架构图仍写
   `local agents … opencode (default)`，而 pi 自 2026-09-04 起是唯一本地运行时（ADR-0014）——
   文案不点名任何运行时，所以不受影响，但别照 README 答。
