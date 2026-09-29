# TeamClu 宣传视频 — 英文 · YouTube + Product Hunt

> 基线：`feat/product-hunt-launch` · v0.4.1-beta.71 · 2026-09-29
> 用途：Product Hunt 的 `Demo 视频` 字段（producthunt-kit/README.md §7 最后一个占位符）
> 与 YouTube 首发。

---

## 0. 目录里有什么

| 文件 | 内容 |
|------|------|
| `build-video.mjs` | 构建脚本（ImageMagick 出静帧 → ffmpeg 硬切拼接） |
| `out/teamclu-loop-1080p.mp4` | **成片** 1920×1080 / 30fps / **87.0 秒** / 925 KB / H.264 High |
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

### 规则二：不造界面

**全片只有两张真实产品截图**，只在截图本身就是证据的那两站用：

| 站 | 素材 | 为什么它是证据 |
|---|---|---|
| 1 ASSIGN | `ph-4-group-session-1270x760.png` | @提及 + agent 作为参与者发言，看得见 |
| 4 COMPOUND | `ph-2-team-skills-1270x760.png` | 版本历史 + changelog + 冲突，看得见 |

**BUILD 和 REVIEW 两站没有截图，因为仓库里根本没有。** 没有任何一张 diff
审阅器、编辑器、终端或 Apps 的图（全库搜过）。所以这两站画成**标注式规格图**，
不是伪装成产品截图的假界面——producthunt-kit/README.md §5 那条规矩在这里同样
有效。

REVIEW 站那张「气泡 vs 笔记」的对照图其实是全片信息密度最高的一帧：它是
03 §3.2 那个视觉决定的直接可视化，而那个决定是整个聊天 UI 里最吃重的取舍。

---

## 3. 结构（87 秒）

| # | 入点 | 时长 | 画面 | 类型 |
|---|------|------|------|------|
| 0 | 0:00 | 5s | TeamClu / Assign·Build·Review·Compound | 文字 |
| 1 | 0:05 | 7s | 环全览 +「Most AI tooling starts at build」 | 示意图 |
| 2 | 0:12 | 13s | **1 ASSIGN** — 群聊真实截图 | **真实截图** |
| 3 | 0:25 | 9s | **2 BUILD** — 环高亮 +「runs on your machine」 | 示意图 |
| 4 | 0:34 | 15s | **3 REVIEW** — 气泡 vs 笔记 解剖图 | 示意图 |
| 5 | 0:49 | 15s | **4 COMPOUND** — 技能版本历史真实截图 | **真实截图** |
| 6 | 1:04 | 9s | 环收尾 +「next round starts faster」 | 示意图 |
| 7 | 1:13 | 8s | 六个通道 | 文字 |
| 8 | 1:21 | 6s | 尾卡 | 文字 |

改动 `SCENES` 数组即可增删站，每项是 `kind / dur / onScreen` 加各 kind 自己的
字段。`onScreen` 会原样进 `.srt`。

**砍掉的**（上一版有，这版没有）：工作台全景、通道设置页、浏览器扩展。
理由分别是——工作台不证明任何东西；通道设置页是一排灰开关，是同一个主张最弱的
表达（更好的表达是「能力在内核里」这句话，07 §2，已放进第 7 站）；扩展不在
这个环上。

---

## 4. 编码

`-c:v libx264 -preset slow -crf 18 -profile:v high -level 4.0 -pix_fmt yuv420p
-movflags +faststart -color_primaries bt709 -color_trc bt709 -colorspace bt709`

成片只有 **85 kbps**，看着吓人但正常：9 张静止画面，x264 几乎不用花码率。已验证
**无 banding**——平坦 `#fbfaf7` 区域取 400×300 采样，24 色、标准差 310，是
x264 加的轻微抖动（这反而是缓解 banding 的），不是色阶断裂。YouTube 也会重编。

静帧从 1270×760 放到 1080 高（1.42×）用 Lanczos。字略软，这是 1270px 源的天花板。

---

## 5. 已知短板

1. **无声。** PH 能接受；YouTube 建议照 `voiceover.md` 配音 + 垫音乐。
2. **①②是中文界面**（②ASSIGN 用的是群聊那张）。和 gallery 同一个问题，见
   producthunt-kit §5。应用切英文后重拍、重跑即可。
3. **BUILD 站只有一句话，没有界面。** 因为真跑起来的过程录屏才是诚实的证据。
   想要实拍版本，照 `docs/demo-video-script.md` 录，这条留作备用。
4. **87 秒对 PH 略长。** 要更短就砍第 7 站（通道）并压缩第 4 站，能到 ~60 秒。

---

## 6. 上传

**两条路都得你本人点** —— producthunt-kit/README.md §7.5 已实测：浏览器自动化
能读页面、能填文本，但**给 file input 赋值做不到**。

### Product Hunt

1. 把 MP4 传 YouTube（Unlisted 即可，PH 只要能访问）
2. 链接填进 PH 发帖流程的 media / video 字段
3. 回填 `ph-draft.json` 的 `video` 与 producthunt-kit §7 的 `Demo 视频链接`

### YouTube

见 `youtube.md`。上传时先设 **Unlisted**，PH 流量进来再转 Public。
