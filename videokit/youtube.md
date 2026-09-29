# YouTube 上传素材 — TeamClu 宣传片

> 配套 `videokit/out/teamclu-tour-1080p.mp4`（1920×1080 · 52s · 无声）
> 字符数已逐条核对，括号里是实测长度。

---

## 1. Title（上限 100）

**主用**（64）：

```
TeamClu — One Group Chat Where Your Team and Its AI Agents Work
```

**备选：**

| 字符 | 标题 |
|------|------|
| 65 | `TeamClu: Shared Skills and Group Chat for Your Team's AI Agents` |
| 56 | `Your team's AI agents are personal. We made them shared.` |
| 53 | `TeamClu — AI agents that work in the same chat as your team` |

> 主用那条把最强的两个主张（群聊 / 团队）都放进去了，搜索侧也能吃到
> `group chat`、`team`、`AI agents` 三个词。

---

## 2. Description

直接复制：

```
TeamClu is a shared workspace where your team and its AI agents work in the same group chats.

Two things it makes shared instead of private:

▸ Sessions are group chats. Not 1:1 chats with a bot — add teammates, @mention people, see who's online, and branch any agent reply into its own thread. The agent is a participant, not a service: it can be offline, permission-limited, or switched to another model mid-conversation.

▸ Skills are team assets. Publish one to your team's registry with structured metadata and a changelog, and every teammate's agent follows it automatically. Edit one locally and you get a conflict to resolve — never a silent overwrite.

Knowledge, roles and MCP config are shared the same way, while each member keeps a private context. Agents run on your own machines, hosted by a local daemon — not in our cloud. Reach them from WeCom, Feishu, Discord, KOOK, WeChat or Email, or from the Chrome side panel while you're already on the page.

MIT licensed, in beta. Built in the open.

▶ Website: https://teamclu.ai/
▶ Repo: https://github.com/different-ai-studio/teamclu
▶ Download: https://github.com/different-ai-studio/teamclu/releases/latest
▶ Product Hunt: [PH link]

Windows and macOS builds. The macOS .dmg is currently unsigned, so Gatekeeper will
flag it — `xattr -cr /Applications/TeamClu.app` clears it.

Chapters
0:00 Intro
0:04 One workspace
0:12 Sessions are group chats
0:22 Skills your whole team shares
0:31 Reach your agents anywhere
0:39 Browser side panel
0:46 Get started

—
If your team already shares prompts in a doc and calls it a system, this is that,
with versioning. I read the issues.
```

> 三个链接按 PH kit 的规矩填：**`teamclu.ai`**，不要用 `teamclaw.ai`（会 302 到
> 无关的 workclaw.com）。`[PH link]` 发布后换成当天的帖子 URL。
>
> 最后那段 macOS 未签名的说明**先留着**，等 `docs/release/desktop.md` 的签名流程
> 走通、Release 里换成签名并公证过的构建，就可以删掉。

---

## 3. Tags（上限 500）

```
teamclu, ai agents, team collaboration, group chat, shared skills, agent skills, multi agent, local ai, self hosted ai, open source ai, mcp, agent runtime, team knowledge base, wecom, feishu, discord, kook, ai workspace, ai team, developer tools
```

（341 字符）

---

## 4. 上传设置

| 项 | 值 | 为什么 |
|----|----|--------|
| Visibility | **Unlisted**，首发当天再转 Public | PH 访客点开 404 的代价 > 晚公开一小时 |
| Category | Science & Technology | — |
| 字幕 | 传 `teamclu-tour-1080p.srt` | 无声片 + 字幕，可达性和检索都受益 |
| 敏感内容 | 不勾 | 无 Sentry、无弹窗、无真实邮箱/内网域名 |
| 播放许可 | Standard | — |
|  monetization | 关闭 | — |

---

## 5. 缩略图

`producthunt-kit/screenshots/thumbnail-512.png` 是**正方形**，直接当 YouTube 缩略图
会被裁成 16:9，主体容易出框。

建议另做一张 1280×720：#fbfaf7 底，左上放 coral 色条（和片头卡同一个手势），
一行大字 **"One chat. Your team + its AI agents."**，右下角小字 `teamclu.ai`。
字体、颜色、间距照 `videokit/build-video.mjs` 里的 `cardArgs()`（Arial Bold 128 / 44，
INK `#1a1a14`、MUTED `#75736a`、CORAL `#e85a4a`）——和片头卡完全一致，点击率会比
另起一套样式好。

> coral 一帧里只出现一次（那条色条），符合 AGENTS.md §1「coral 一帧最多两处」。
