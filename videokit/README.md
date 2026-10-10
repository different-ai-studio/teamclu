# TeamClu 宣传视频 — 英文 · YouTube + Product Hunt

> 基线：`feat/product-hunt-launch` · v0.4.1-beta.71 · 2026-09-29
> 用途：Product Hunt 的 `Demo 视频` 字段（producthunt-kit/README.md §7 最后一个占位符）
> 与 YouTube 首发。

---

## 0. 目录里有什么

| 文件 | 内容 |
|------|------|
| `build-video.mjs` | 构建脚本（ImageMagick 出静帧 → ffmpeg 硬切拼接） |
| `out/teamclu-loop-1080p.mp4` | **成片** 1920×1080 / 30fps / **87.0 秒** / 793 KB / H.264 High |
| `out/teamclu-loop-1080p.srt` | 字幕轨，9 条，时间轴与硬切点对齐 |
| `out/stills/*.png` | 9 张 1920×1080 静帧，**就是可再编辑的源** |
| `youtube.md` | YouTube 标题 / 描述 / 标签 / 章节 / 缩略图 |
| `voiceover.md` | 可选配音稿 + 加音轨的命令（**成片无声**） |

重建：

```bash
node videokit/build-video.mjs
VIDEO_SCALE=720 node videokit/build-video.mjs
```

需要 `magick`（`brew install imagemagick`）和带 `libx264` 的 `ffmpeg`。约 1 分钟。

---

## 1. 主线：一个环，不是六个功能

```
ASSIGN ──▶ BUILD ──▶ REVIEW ──▶ COMPOUND
  ▲                                │
  └────────────────────────────────┘
```

**大部分 AI 工具从 BUILD 开始就停住了。** TeamClu 的主张是这个环会闭上：一轮的
产物变成团队资产，所以下一轮起手更快。

这个框架不是编的，是十篇 `docs/features/` 的同一个判断：

| 环上的一站 | 依据 |
|---|---|
| ASSIGN | 03 §0：聊天 App 的原子是**消息**（私有的），TeamClu 的原子是**会话**（一个群） |
| BUILD | 02 §0：agent 不属于客户端，属于 daemon |
| REVIEW | 03 §3.2「agent 回复不是气泡，是笔记」；10 §1–2：diff 审阅器是 agent-first |
| COMPOUND | 06 §0/§4/§6：skill 是团队可拥有、版本化、审计的资产 |

**上一版（已废弃）**是功能巡览——工作台 / 群聊 / 技能 / 通道 / 浏览器扩展。那是
README 的内容，免费的，而且学不到任何能拿去用的东西。参考 git 历史。

---

## 2. 两条硬规则

### 规则一：没有任何运镜

**无缩放、无推拉、无位移、无交叉溶解。** 画面静止，硬切。上一版用 Ken Burns，
读起来就是「幻灯片配了个紧张的摄影机」，所以整条拿掉了。

拼接用 ffmpeg 的 **concat filter**，不用 concat demuxer——后者会把末尾那张图
多按一个完整时长（实测 87 秒的片被渲成 93 秒），而且没法精确指定帧数。

### 规则二：不造界面，也不留中文

**全片没有任何一张产品截图。** 四站全是**标注式规格图**。

这不是偷懒，是被逼的：**仓库里每一张真实截图都有中文。** 拍它们的时候应用跑在
中文界面下：

| 素材 | 状态 |
|---|---|
| `ph-4-group-session`（原②群聊） | 界面全中文 |
| `ph-2-team-skills`（原②技能） | 界面全中文 |
| `images/home.png` | 侧栏/顶栏是英文，但**会话预览里是中文**：`## .opencode/skills/ 技能清单`、`TeamClaw 是一个多智能体协作平台` |
| `listing-kit/screenshots/*` | 中文 |

**没有可替换的干净英文截图。** 与其 P 掉中文或做假界面，不如画成规格图——
规格图是明写「这是示意图」的，不冒充产品截图。内容全部来自
`docs/features/`：会话那帧对着 03 §2 / §7.1–7.3，技能那帧对着 06 §3.1 / §4 / §6。

REVIEW 站那张「气泡 vs 笔记」对照图是全片信息密度最高的一帧：它是 03 §3.2
那个视觉决定的直接可视化，而那个决定是整个聊天 UI 里最吃重的取舍。

### 补真实截图（一条命令）

如果你在**英文界面**下重拍了两张，丢进来重跑即可，构建会自动改用真实截图：

```
videokit/src/assign-en.png      ← 会话：@提及 + agent 作为参与者发言
videokit/src/compound-en.png    ← 技能：版本历史 + changelog + 冲突
```

`SCENES` 里的 `prefer` 字段就是这两个文件名。没放文件时构建会打印
`using the … spec diagram`，不会静默降级。

**拍摄要点**：应用切英文；用一个**演示团队**（不要用真实业务数据，见
`producthunt-kit/README.md` §4 记录过一次 OCR 扫出真实经营数字的教训）；
窗口宽度 1270 以上；英文界面下 `when_not_to_use` 之类字段是英文的，正好。

---

## 3. 结构（87 秒）

| # | 入点 | 时长 | 画面 | 类型 |
|---|------|------|------|------|
| 0 | 0:00 | 5s | TeamClu / Assign·Build·Review·Compound | 文字 |
| 1 | 0:05 | 7s | 环全览 +「Most AI tooling starts at build」 | 规格图 |
| 2 | 0:12 | 13s | **① ASSIGN** — 会话面板（3 人 + 2 agent，含 @提及与笔记回复） | 规格图 |
| 3 | 0:25 | 9s | **② BUILD** — 环高亮 +「runs on your machine」 | 规格图 |
| 4 | 0:34 | 15s | **③ REVIEW** — 气泡 vs 笔记 解剖图 | 规格图 |
| 5 | 0:49 | 15s | **④ COMPOUND** — 技能版本历史（发布门 + changelog） | 规格图 |
| 6 | 1:04 | 9s | 环收尾 +「the next round starts faster」 | 规格图 |
| 7 | 1:13 | 8s | 六个通道 | 文字 |
| 8 | 1:21 | 6s | 尾卡 | 文字 |

改动 `SCENES` 数组即可增删站，每项是 `kind / dur / onScreen` 加各 kind 自己的
字段。`onScreen` 会原样进 `.srt`。

**砍掉的**（更早的版本有）：工作台全景、通道设置页、浏览器扩展。
理由分别是——工作台不证明任何东西；通道设置页是一排灰开关，是同一个主张最弱的
表达（更好的表达是「能力在内核里」那句话，07 §2，已放进第 7 站）；扩展不在
这个环上。

### 排版：全部按实测墨迹，不按字数估

容器尺寸原来用字符数估（`t.length * 6.6`），REVIEW 帧的 follow-up pill 因此
过窄，「draft the rollback note」冲出边框还和下一个 pill 叠在一起。

现在：

- `ink()` 实测每串的墨迹宽度 + 左边距（side bearing），带缓存
- `pill()` 的**宽度就是墨迹 + padding**，并返回宽度供下一个 pill 排版
- `textFit()` 放不下就自动缩字号，并把「缩过」记进审计
- `capOffset()` 按 font+pointsize 实测 cap 线

构建结束会打印排版审计：

```
layout audit: no overflow, nothing shrunk to fit
```

有溢出或缩字时逐条列出，不会静默出一张坏图。

---

## 4. 编码

```
-c:v libx264 -preset slow -crf 18 -profile:v high -level 4.0 -pix_fmt yuv420p
-movflags +faststart -color_primaries bt709 -color_trc bt709 -colorspace bt709
-fflags +bitexact -flags:v +bitexact
```

成片只有 **85 kbps**，看着吓人但正常：9 张静止画面，x264 几乎不用花码率。已验证
**无 banding**——平坦 `#fbfaf7` 区域取 400×300 采样，24 色、标准差 310，是
x264 加的轻微抖动（这反而是缓解 banding 的），不是色阶断裂。YouTube 也会重编。

### 可复现性（这里踩过一个坑）

静帧输出带 `-strip`，MP4 带 `-fflags +bitexact`。两个都不是洁癖，是必需的：

- **没有 `-strip` 时静帧不可复现。** ImageMagick 会往每张 PNG 写
  `date:create` / `date:modify`，像素完全相同的两张图哈希不同，于是
  `out/stills/*.png` 每次重建都让 `git status` 变脏，而 diff 什么都看不出来
  ——这会训练人不再看 git status。
- **没有 `bitexact` 时 MP4 不可复现**，而且**比静帧更难查**：ffmpeg 把
  creation/modification time 写进 `mvhd` atom，那是个**二进制字段，不是可见
  tag**，所以 `ffprobe -show_entries format_tags` 输出是干净的，看不出问题。

  实测：输入静帧的像素签名完全相同（`fa6fdb80…`），MP4 哈希却不同
  （`32a01220…` vs `da946ac6…`）。**这意味着之前几次「重构后字节级不变」的
  结论是靠不住的**——那个信号其实一直在变。加 `bitexact` 后隔 5 秒三次构建
  哈希一致（`eb7dee70…`），并逐帧签名（3s / 20s / 40s / 60s）确认画面内容
  与改前完全一致，即这个修复只动元数据、不动画面。

现在**可以用哈希判断「这次改动有没有动到成片」**。这是它唯一的用途。

静帧从 1270×760 放到 1080 高（1.42×）用 Lanczos。字略软，这是 1270px 源的天花板。

---

## 5. 已知短板

1. **无声。** PH 能接受；YouTube 建议照 `voiceover.md` 配音 + 垫音乐。
2. **全片没有真实界面像素。** 见 §2 规则二——仓库里没有干净的英文截图。补两张
   英文截图进去重跑即可（同一节有拍摄要点）。
3. **BUILD 站只有一句话。** 真跑起来的过程只有录屏才是诚实的证据；想要实拍版本
   照 `docs/demo-video-script.md` 录，这条留作备用。
4. **87 秒对 PH 略长。** 砍掉通道那站并压缩 REVIEW 可到 ~60 秒。
5. **规格图不能证明产品存在。** 这是这一版最大的代价：观众看到的是设计和数据
   结构，看不到真在跑的界面。补上 §2 那两张截图能解决一大半。

---

## 6. 上传

**两条路都得你本人点** —— producthunt-kit/README.md §7.5 已实测：浏览器自动化
能读页面、能填文本，但**给 file input 赋值做不到**。

### Product Hunt

> **2026-10-09：** PH Demo **当前不是本目录的 loop 片**，而是已上传的微信介绍片
> https://youtu.be/aMSSTexvewE（见 `producthunt-kit/README.md` §9.0）。
> 本 videokit 成片仍可作备用；若要换回 loop，再走下面三步。

1. 把 MP4 传 YouTube（Unlisted 即可，PH 只要能访问）
2. 链接填进 PH 发帖流程的 media / video 字段
3. 回填 `ph-draft.json` 的 `video` 与 producthunt-kit §7 的 `Demo 视频链接`

### YouTube

见 `youtube.md`。上传时先设 **Unlisted**，PH 流量进来再转 Public。
