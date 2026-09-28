# TeamClu 发布日社媒 / 社群文案

> 配合 [`README.md`](./README.md) 使用。所有 `[PH link]` 换成当天的 Product Hunt 帖子 URL，
> `[repo]` 换成 `https://github.com/different-ai-studio/teamclu`。
> 主线是**团队协作**：共享 Skills + 会话即群聊。本地优先作为支撑点出现，不当主角。
> 英文段落按平台语调写过，不是同一段复制四遍——每个社区反感的东西不一样。

> **关于链接长度**：X 会把任何链接按 **23 字符**计（t.co 包装），不是按真实 URL 长度。
> 下面每条都按「`[PH link]` 占 23 字符」核算过，换成真实 URL 不会超。
> 用 X Premium 长文则不受此限。

---

## X / Twitter

### Tweet 1（主帖）

```
Launching TeamClu on @ProductHunt 🚀

Your team's AI agents with shared skills and one group chat — instead of everyone teaching a private bot the same things.

Publish a skill once. Every teammate's agent follows it.

[PH link]
```

### Tweet 2

```
Every team has this problem, and it isn't the model.

I teach my agent how we run a release. A teammate teaches theirs the same thing a month later, slightly differently.

The agent is personal. It shouldn't be.

[PH link]
```

### Tweet 3

```
Skills in TeamClu are team assets:

→ publish with metadata + a changelog
→ every teammate's agent follows the new version automatically
→ edit locally and you get a conflict, never a silent overwrite
→ one click reverts a bad version

[PH link]
```

### Tweet 4

```
Sessions are group chats, not 1:1 bot chats:

→ teammates and agents in one context
→ @mentions and presence
→ branch any agent reply into its own thread

The agent is a participant, not a service — it can be offline or permission-limited.

[PH link]
```

### Tweet 5

```
Your team reaches the agents where it already talks: WeCom, Feishu, Discord, KOOK, WeChat, Email. Plus desktop, iOS and a Chrome side panel.

MIT, local-first, in beta. Feedback very welcome 🙏

[repo]
```

---

## LinkedIn

> 少 emoji、讲清楚「为什么」。附 `ph-2-team-skills`（补拍后）或 `ph-1-workspace`。

```
We just launched TeamClu on Product Hunt.

Here's the problem we kept running into: AI agents are personal, and that's the wrong shape for a team.

I teach my agent how we run a release. A teammate teaches theirs the same thing a month later, slightly differently. The agent that actually knows how our work works is the one nobody else can use.

TeamClu makes two things shared instead of private.

First, skills are team assets. You publish one to the team registry with structured metadata and a changelog, and every teammate's agent follows it automatically. When you fix a broken step, the fix reaches people instead of dying in your dotfiles. Edit locally and you get a conflict to resolve — never a silent overwrite.

Second, sessions are group chats. Not 1:1 chats with a bot: add teammates, @mention people, see who's online, and branch any agent reply into its own thread. The agent is a participant, not a service.

Knowledge, roles and MCP config are shared the same way, and each member still keeps a private context. Agents run on your own machines, and your team can reach them from WeCom, Feishu, Discord, KOOK, WeChat or Email.

It's MIT licensed and in beta.

If your team has been circling agent adoption, I'd like to know what's blocking: does everyone run their own agent, or do you share one — and what would you refuse to share?

[PH link]
```

---

## Hacker News（Show HN）

> HN 反感营销腔。标题不加形容词，正文直接讲设计取舍，并且**主动说出没做好的地方**。
> HN 标题上限 80 字符。

```
Show HN: TeamClu – shared skills and group chat for team AI agents
```

```
Author here. TeamClu is an open-source (MIT) workspace where a team and its AI agents
work in the same group chats, with a shared skills registry.

The design bet: an agent's capability should be a team asset, not a personal config.

- Skills live in a per-team registry: structured frontmatter (summary, category,
  when-to-use / when-not-to-use, requires), an append-only version history, and a
  required changelog per version.
- Installed team skills follow latest_version automatically. A daemon-side reconcile loop
  (10 min) diffs the actor's full expected set against a local lockfile and installs/
  removes/swaps accordingly; an MQTT notify only shortens the wait. Reconcile is the
  primary path and the push is an accelerator, because pushes get lost and daemons go
  offline — that way any dropped notification costs 10 minutes, not correctness.
- Automatic updates overwrite local files, so local edits produce a conflict for a human
  to resolve rather than a silent overwrite.
- Sessions are multi-actor: humans and agents share one context, with presence,
  @mentions, and threads (only agent replies can branch; a thread is its own session,
  lazily forked on first send so an unopened thread costs nothing).
- Any team member can publish, edit metadata, or revert — the registry is a team asset,
  so `owner` records responsibility, not permission.

Stack: Tauri 2 + React 19 client, Rust daemon hosting the agents, SwiftUI on iOS.

Honest state: v0.4.1 beta. macOS builds are unsigned until we have a certificate, so
Gatekeeper complains. Skills have no per-member visibility isolation — the tenant key is
shared by the whole team, so it protects against the storage provider, not colleagues.
Onboarding still assumes a technical user.

Happy to answer anything about the reconcile design or the multi-actor session model —
and I'd rather hear where it breaks than where it's nice.

[repo]
```

> 发布时段：HN 更吃美东上午（北京时间 21:00–24:00）。和 PH 同天发会分散精力，建议错开半天。

---

## Reddit

每个 sub 的规矩不同，**不要同一段贴三遍**。

### r/selfhosted

```
TeamClu — self-hosted agents with a shared, versioned skills registry

We open-sourced (MIT) a workspace where a team and its AI agents share group chats and a
per-team skills registry. Self-hosting-relevant parts:

- Agents run in a local daemon on your own hardware, not in our cloud.
- The skills registry is a set of tables in a Supabase/Postgres you run; skill packages are
  content-addressed blobs in S3-compatible storage you control.
- Team sync uses S3-compatible storage or WebDAV. Only two roots leave a machine: a team
  knowledge vault and a shared documents folder.
- Team identity/sessions go through a Cloud API that is also self-hostable.
- Reach the agents from WeCom, Feishu, Discord, KOOK, WeChat or Email.

Installed team skills auto-follow the latest version via a 10-minute reconcile loop in the
daemon, with conflict handling when someone edited a file locally.

It's beta and macOS builds aren't signed yet (Gatekeeper needs an xattr nudge — documented
in the README). Curious whether "share the capability, keep the context private" is the
split people here would actually want.

[repo]
```

### r/LocalLLaMA

```
TeamClu: local agent runtime + a shared skills registry for small teams

Sharing because the runtime and the "share capability, not context" split may be
interesting here.

The daemon hosts agents locally in a process pool keyed by (isolation domain, env revision,
worktree), with multiple concurrent sessions per host process — so more sessions don't
repeat MCP cold starts or base memory. Model choice is per session via a registry; you bring
your own provider/endpoint.

What the team shares is capabilities, not transcripts: a skills registry (versioned,
auto-following latest), knowledge vault, roles and MCP config. Each member keeps private
context. Local file operations go through per-operation permission prompts.

MIT, v0.4.1 beta. Would appreciate feedback on the process-pool design and on where a
local-first team setup should draw the line on what gets synced.

[repo]
```

### r/SideProject

```
Built a shared skills registry + group chat for team AI agents

AI agents are personal by default: everyone teaches their own bot the same things, and the
work happens in a window nobody else can see. TeamClu makes skills a versioned team asset
(every teammate's agent follows the new version automatically) and makes sessions real group
chats with humans and agents in one context.

Local-first, MIT, in beta, launched on Product Hunt today. Feedback on the landing
experience especially welcome — that's the part I'm least sure about.

[PH link] · [repo]
```

---

## 中文社群

### 即刻 / 朋友圈（短）

```
做了个开源（MIT）的 AI agent 工作台 TeamClu，想解决一件很具体的事：agent 是「个人」的，这对团队是错的。

我在自己 agent 里教它我们怎么发版，同事一个月后再教一遍，还教得不太一样。真正懂我们业务的 agent，别人用不上。

所以 TeamClu 把两件事变成共享的：
1. Skills 是团队资产——发布到团队注册表，所有人的 agent 自动跟随新版本；改了会传播，本地脏改会变成冲突而不是被静默覆盖
2. 会话就是群聊——同事和 agent 在同一个上下文里，@提及、在线状态、把某条 agent 回复拉成独立线程

知识库、Role、MCP 配置同样共享，但每个人的私有上下文仍然私有。

今天 Product Hunt 首发，求支持 🙏
[PH link]
```

### V2EX（分享创造节点）

标题：

```
[分享创造] TeamClu：把 agent 的能力变成团队资产，会话就是群聊
```

正文：

```
背景：AI agent 默认是「个人」的。我在自己 agent 里教会它我们怎么发版，同事一个月后再教一遍，还教得不太一样；而真正干了活的对话，躺在只有我能看到的窗口里。

TeamClu 把两件事从私有变成共享：

1. Skills 是团队资产
• 团队注册表：结构化 frontmatter（summary / category / when-to-use / when-not-to-use / requires）+ 追加式版本历史 + 每版必填 changelog
• 已装 skill 自动跟随 latest_version：daemon 侧 10 分钟一轮全量对账（拉「这个 actor 当前应有的完整清单」和本地 lockfile 做差集），MQTT 通知只负责把等待从 10 分钟缩短
• 对账是主干、推送是加速器——推送会丢、daemon 会离线，只处理增量迟早漂移
• 自动更新会覆盖本地文件，所以本地脏改产生冲突交给人决策，不静默覆盖
• 任何成员都能发布/改元数据/撤回：注册表是团队资产，owner 只是责任不是权限

2. 会话就是群聊
• 人 + agent 在同一上下文，有在线状态和 @提及
• 只有 agent 回复能开线程；线程是独立会话，首次发送才懒 fork，没打开就不产生后端开销
• agent 是参与者不是服务端：可以离线、可以被限权、可以中途换模型

技术栈：Tauri 2 + React 19 客户端，Rust daemon 托管 agent，iOS 是 SwiftUI。

现状 v0.4.1 beta，说清楚几个没做好的地方：macOS 包没签名（Gatekeeper 会拦，README 有 xattr 说明）；skill 目前**没有成员间可见性隔离**，团队一把密钥、防的是云厂商不是同事；文档还假设技术用户。

MIT 开源，今天 Product Hunt 首发。欢迎拍砖，尤其是「哪些能力该共享、哪些必须留在个人」这条线怎么划。

[repo]
```

### 知乎 / 公众号（长文骨架）

不要直接翻译 PH 文案——中文读者更关心「为什么现成方案不行」。

1. **开头**：一个具体场景（我在自己 agent 里教了一遍发版流程，同事又教了一遍，还不一样）
2. **诊断**：agent 产品的默认形状是「个人工具」——能力按人重复配置，产出留在私人窗口
3. **TeamClu 的两个反转**：
   - **能力共享**：skill 当团队资产管理（发布门、版本历史、changelog、自动跟随、脏改冲突、一键撤回）
   - **上下文私有**：这条线怎么划，为什么共享根只有 `team-knowledge/` 和 `team-documents/`
   - **会话共享**：为什么「会话」是协作单元而不是消息容器；agent 作为参与者意味着什么（离线/限权/换模型）
   - **权限模型**：为什么逐操作确认比一次性授权更适合 agent；以及「@提及不是权限」
4. **诚实的现状**：beta、未签名、skill 无成员间可见性隔离、文档门槛
5. **结尾**：PH 链接 + 仓库链接 + 欢迎 issue

### 微信 / 企业微信群

```
TeamClu 开源了：agent 的 skill 变成团队资产（发布一次全组自动跟随），会话就是群聊，同事和 agent 在同一个上下文里。
今天 Product Hunt 首发，方便的话帮忙点个赞 🙏 [PH link]
```

> 注意：PH 明确不鼓励组织刷票，微信群里说「来看看/提提问题」比「帮忙投票」安全，
> 被判定操纵投票会直接掉榜。
