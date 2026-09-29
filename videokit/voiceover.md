# 配音稿（可选）— 52 秒

> 配套 `out/teamclu-tour-1080p.mp4`（无声）
> 语速按 **3 词/秒** 配的：全篇 **152 词 ≈ 50.7 秒**，落在 52 秒内，
> 最密的一段 3.23 词/秒。每段给了词数和词速——**念快了就把该段末尾的修饰词砍掉，
> 不要加速**，加速会让这条片子听起来像催单。

---

## 逐句

| 入点 | 时长 | 词 | 词速 | 台词 |
|------|------|----|------|------|
| 0:00 | 3.5s | 9 | 2.57 | Your team and its AI agents, in one workspace. |
| 0:04 | 8.0s | 21 | 2.63 | Sessions, knowledge, skills and apps, side by side. Your teammates and your agents are listed together, not split across separate tools. |
| 0:12 | 9.3s | 30 | 3.23 | And the session is a group chat. @mention an agent and it answers as a participant — branch its reply into a thread, and limit its permissions when you need to. |
| 0:22 | 9.3s | 30 | 3.23 | This is the part that scales. Publish a skill with a changelog, and every teammate's agent follows it automatically. Edit locally and you get a conflict, not a silent overwrite. |
| 0:31 | 7.3s | 22 | 3.01 | Your agents run on your own machines, and you reach them where you already talk: WeCom, Feishu, Discord, KOOK, WeChat, or email. |
| 0:39 | 7.3s | 23 | 3.15 | Or just your browser, in the side panel, with the page you're on as context. Send the conversation, not a screenshot of it. |
| 0:46 | 5.8s | 17 | 2.93 | TeamClu. MIT licensed, in beta, built in the open. It's at teamclu.ai — tell me where it breaks. |

**合计 152 词，语速 2.92 词/秒即可填满 52 秒。**

---

## 念稿注意

- **0:12 那段是全片最密的 30 词**，别赶。`@mention` 念 "at-mention"。
- **0:22 的 "This is the part that scales"** 前面留半秒停顿——这句是转折，
  压掉就变成平铺直叙的功能罗列。
- **0:39 结尾 "not a screenshot of it"** 轻轻收，不要上扬。
- 尾卡最后一句 `tell me where it breaks` 要在 0:51 前说完，画面还要留 1 秒静止。

---

## 录制参数

- 采样率 48 kHz，单声道或立体声都行，`-c:a aac -b:a 192k` 足够。
- 响度：最终混音峰值 ≤ −1 dBFS，**不要做响度归一化**——YouTube 会自己处理，
  提前压过会让安静段听起来发闷。
- 如果只有 44.1 kHz 的录音，用 ffmpeg 升采样，别重录：
  `ffmpeg -i vo.wav -ar 48000 vo48.wav`

---

## 混音（音乐垫 + 配音）

一条命令，人声优先、音乐让路：

```bash
ffmpeg -i out/teamclu-tour-1080p.mp4 \
       -i vo.wav -i music.mp3 \
  -filter_complex "\
    [1:a]volume=1.0[vo];\
    [2:a]volume=0.12,afade=t=in:st=0:d=1.2,afade=t=out:st=50:d=2[bg];\
    [bg][vo]sidechaincompress=threshold=0.03:ratio=8:attack=20:release=400[mix]" \
  -map 0:v -map "[mix]" \
  -c:v copy -c:a aac -b:a 192k -shortest -movflags +faststart \
  out/teamclu-tour-final.mp4
```

`sidechaincompress` 是关键：有人声时音乐自动往下压 8 dB，没有时回来。
音乐垫音量 0.12 是**已经压过**之后的基准值，觉得还是吵就调到 0.08。

音乐版权：**别用 YouTube 音频库里带claim的曲子**。用 YouTube Audio Library
标了 "No attribution required" 的，或者买过商用授权的，否则视频会被限 monetize
甚至地区屏蔽。
