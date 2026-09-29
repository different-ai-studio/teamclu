# 配音稿（可选）— 87 秒

> 配套 `out/teamclu-loop-1080p.mp4`（无声）
> 全篇 **237 词 ≈ 81.7 秒**（按 2.9 词/秒），落在 87 秒内，留约 5 秒呼吸。
> 最密的一段 3.27 词/秒（REVIEW），其余都在 2.0–2.8 之间。
> 每段给了词数和词速——**念快了砍掉该段末尾的修饰词，不要加速**。

---

## 逐句

| 入点 | 时长 | 词 | 词速 | 台词 |
|------|------|----|------|------|
| 0:00 | 5.0s | 13 | 2.60 | Most AI tooling starts at build, and stops there. TeamClu closes the loop. |
| 0:05 | 7.0s | 22 | 3.14 | Assign work, let an agent do it, read what it changed, and bank the result as a team asset. Round again — faster. |
| 0:12 | 13.0s | 35 | 2.69 | One session, not a one-to-one bot chat. Your teammates and your agents share one context. Mention an agent and it answers as a participant — with its own presence, its own thread, and its own permissions. |
| 0:25 | 9.0s | 25 | 2.78 | The agent runs on your machine, hosted by a local daemon. You keep your code, your context, and your keys. Only the assets are shared. |
| 0:34 | 15.0s | 48 | 3.20 | And review is the part tools skip. An agent doesn't talk in bubbles. It answers in notes — full width, structured, quotable, with follow-ups you can act on. The diff reviewer is built the same way, agent-first, because you're here to read what changed, not to write from scratch. |
| 0:49 | 15.0s | 39 | 2.60 | The result becomes a team asset, not a dotfile. Publish a skill once with a changelog, and every teammate's agent follows the new version automatically. Edit one locally, and you get a conflict to resolve — never a silent overwrite. |
| 1:04 | 9.0s | 18 | 2.00 | The next round starts faster, because the work is already in the team's hands. That's the whole loop. |
| 1:13 | 8.0s | 20 | 2.50 | And it runs when you're not at the desk. Same session, same capabilities, in every channel you already talk in. |
| 1:21 | 6.0s | 17 | 2.83 | TeamClu. MIT licensed, in beta, built in the open. It's at teamclu.ai — tell me where it breaks. |

**合计 237 词 ≈ 81.7 秒**（按 2.9 词/秒），落在 87 秒内，留约 5 秒呼吸。

---

## 念稿注意

- **0:34 REVIEW 是全片最长也最密的一段（48 词）**，但它也是全片最重要的一站。
  念到这里**放慢**，宁可把 0:49 那段的空档用掉。四句话之间各留半拍：
  `bubble / note / diff reviewer` 是三个独立论点。
- **`@mention` 念 "at-mention"**；0:12 那段的 `one-to-one` 别吞。
- **0:49 词速只有 2.60，有余量**——`never a silent overwrite` 前面可以停半秒，
  这是全片唯一带"承诺"语气的地方。
- **0:1:13 刻意没念六个渠道的名字**，因为名字已经烧在画面上了。念一遍就变
  产品清单了。
- 尾卡 `tell me where it breaks` 要在 1:26 前说完，画面留 1 秒静止。

---

## 录制参数

- 48 kHz；`-c:a aac -b:a 192k` 足够。已有 44.1 kHz 录音就升采样，别重录：
  `ffmpeg -i vo.wav -ar 48000 vo48.wav`
- 峰值 ≤ −1 dBFS，**不要做响度归一化**——YouTube 自己会处理，提前压过会让
  安静段发闷。

---

## 混音（音乐垫 + 配音）

```bash
ffmpeg -i out/teamclu-loop-1080p.mp4 \
       -i vo.wav -i music.mp3 \
  -filter_complex "\
    [1:a]volume=1.0[vo];\
    [2:a]volume=0.12,afade=t=in:st=0:d=1.2,afade=t=out:st=85:d=2[bg];\
    [bg][vo]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[mix]" \
  -map 0:v -map "[mix]" \
  -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart \
  out/teamclu-loop-final.mp4
```

`sidechaincompress` 是关键：有人声时音乐自动往下压 8 dB，没有时回来。
音乐垫 0.12 是**已经压过之后**的基准值，还是吵就调到 0.08。
`afade out` 的 `st` 改成你的音乐实际结束点（本片 87 秒）。

音乐版权：**别用 YouTube 音频库里带 claim 的曲子**。用 Audio Library 里标了
"No attribution required" 的，或买过商用授权的，否则会被限 monetize 甚至
地区屏蔽。
