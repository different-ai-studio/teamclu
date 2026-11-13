# YouTube 上传素材 — TeamClu 宣传片

> 配套 `videokit/out/teamclu-loop-1080p.mp4`（1920×1080 · 87s · 无声）
> 字符数已逐条核对，括号里是实测长度。

---

## 1. Title（上限 100）

**主用**（63）：

```
TeamClu — The loop your team's AI work actually runs on
```

**备选：**

| 字符 | 标题 |
|------|------|
| 71 | `TeamClu: Assign, Build, Review, Compound — your team's AI work` |
| 66 | `Most AI tools start at build. TeamClu closes the loop.` |
| 62 | `TeamClu — your team and its AI agents, in one working loop` |

> 主用那条和片子第一帧一字不差，标题和片头对得上。
> 备选第二条更冲，但把 `Compound` 这个词丢在标题外了——它是本片最反直觉的一站。

---

## 2. Description

直接复制：

```
Most AI tooling starts at build and stops there. TeamClu is the claim that the loop closes.

ASSIGN → BUILD → REVIEW → COMPOUND, and round again.

▸ ASSIGN — One session, not a 1:1 bot chat. Your teammates and your agents share one context. @mention an agent and it answers as a participant, with its own presence, its own thread, and its own permissions.

▸ BUILD — The agent runs on your machine, hosted by a local daemon. You keep your code, your context and your keys. Only the assets are shared.

▸ REVIEW — An agent does not talk in bubbles. It answers in notes: full width, structured, quotable, with follow-ups you can act on. The diff reviewer is built the same way — agent-first, because you are here to read what changed, not to write from scratch.

▸ COMPOUND — The result becomes a team asset, not a dotfile. Publish a skill once with a changelog and every teammate's agent follows the new version automatically. Edit one locally and you get a conflict to resolve, never a silent overwrite.

And it runs when you are not at the desk. Same session, same capabilities, in WeCom, Feishu, Discord, KOOK, WeChat or Email — because capability lives in the kernel, not in the channel.

MIT licensed, in beta. Built in the open.

▶ Website: https://teamclu.ai/
▶ Repo: https://github.com/different-ai-studio/teamclu
▶ Download: https://github.com/different-ai-studio/teamclu/releases/latest
▶ Product Hunt: [PH link]

Windows and macOS builds. The macOS .dmg is currently unsigned, so Gatekeeper will
flag it — `xattr -cr /Applications/TeamClu.app` clears it.

Chapters
0:00 Assign, build, review, compound
0:12 1 — Assign
0:25 2 — Build
0:34 3 — Review
0:49 4 — Compound
1:04 The loop closes
1:13 Where you already talk

—
If your team already shares prompts in a doc and calls it a system, this is that,
with versioning. I read the issues.
```

> 链接按 PH kit 的规矩：**`teamclu.ai`**，不要用 `teamclaw.ai`（会 302 到无关的
> workclaw.com）。`[PH link]` 发布后换成当天的帖子 URL。
>
> macOS 未签名那段**先留着**，等 `docs/release/desktop.md` 的签名流程走通、
> Release 里换成签名并公证过的构建，就可以删。

---

## 3. Tags（上限 500）

```
teamclu, ai agents, team collaboration, agent workflow, review ai code, ai code review, shared skills, agent skills, group chat, multi agent, local ai, self hosted ai, open source ai, mcp, agent runtime, team knowledge base, wecom, feishu, discord, developer tools
```

（286 字符）

---

## 4. 上传设置

| 项 | 值 | 为什么 |
|----|----|--------|
| Visibility | **Unlisted**，首发当天再转 Public | PH 访客点开 404 的代价 > 晚公开一小时 |
| Category | Science & Technology | — |
| 字幕 | 传 `teamclu-loop-1080p.srt` | 无声片 + 字幕，可达性和检索都受益 |
| 敏感内容 | 不勾 | 无 Sentry、无弹窗、无真实邮箱/内网域名 |
| 播放许可 | Standard | — |
| Monetization | 关闭 | — |

---

## 5. 缩略图

`producthunt-kit/screenshots/thumbnail-512.png` 是**正方形**，直接当 YouTube 缩略图
会被裁成 16:9，主体容易出框。

建议另做一张 1280×720，**沿用片头卡的构图**，这样点进来的第一眼和片子第一帧连着：

```
#fbfaf7 底
x=258 y=436 一条 12×56 的 coral 色条
TeamClu            Arial Bold 128,  #1a1a14
Assign · Build · Review · Compound   Arial 46, #75736a
```

照 `videokit/build-video.mjs` 里 `renderTitle()` 的坐标即可，参数完全一致。

> 一帧里 coral 只出现一次（那条色条），符合 AGENTS.md §1「coral 一帧最多两处」。
>
> 也可以直接跑 `node videokit/build-video.mjs` 后从 `out/stills/00-00-title.png`
> 裁 16:9 —— 但标题会偏左，右侧留白太多，缩略图里字会小。**另做一张更好。**
