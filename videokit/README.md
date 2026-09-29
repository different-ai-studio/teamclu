# TeamClu 宣传视频 — 英文 · YouTube + Product Hunt

> 基线：`feat/product-hunt-launch` · v0.4.1-beta.71 · 2026-09-29
> 用途：Product Hunt 的 `Demo 视频` 字段（producthunt-kit/README.md §7 里唯一还空着的占位符）
> 与 YouTube 首发。

---

## 0. 目录里有什么

| 文件 | 内容 |
|------|------|
| `build-video.mjs` | 构建脚本（ImageMagick 出静帧 → ffmpeg Ken Burns + 交叉溶解） |
| `out/teamclu-tour-1080p.mp4` | **成片** 1920×1080 / 30fps / 52.0s / 9.2 MB / H.264 High |
| `out/teamclu-tour-1080p.srt` | 字幕轨（时间轴与交叉溶解点对齐） |
| `youtube.md` | YouTube 标题 / 描述 / 标签 / 章节 / 缩略图 |
| `voiceover.md` | 可选配音稿 + 加音轨的命令（**当前成片是无声的**） |

重建：

```bash
node videokit/build-video.mjs
VIDEO_SCALE=720 node videokit/build-video.mjs    # 小一号的 PH 上传版本
```

需要 `magick`（`brew install imagemagick`）和带 `libx264` 的 `ffmpeg`。整条链约 30 秒。

---

## 1. 这条片子是什么形态，以及为什么

**它是静帧 + 运镜，不是录屏。** 五张画面就是 PH gallery 的那五张**真实截图**
（`producthunt-kit/screenshots/`，由 `scripts/build-producthunt-gallery.mjs` 从实拍
PNG 合成），视频只加了推拉镜头和交叉溶解，**没有凭空造任何一个界面**。

这样做的两个理由：

1. PH kit 自己定的规矩（`producthunt-kit/README.md` §5）是「站上无模拟图冒充产品截图」。
   录屏拿不到之前，宁可用真实截图做运镜，也不做假界面。
2. 今天就能交付。录屏要 2–3 个账号跨机器对台词，脚本里已经写了不能实时演。

**但要诚实说明它的上限：这条片子展示的是界面，不是 agent 真的在流式回你一句话。**
后者才是最有说服力的部分。所以：

- PH 用它 → 完全够，52 秒，零成本，填上 §7 的空位。
- YouTube 想要更好 → 照 `docs/demo-video-script.md` 录一版真的，成片留作备用。

---

## 2. 结构（52 秒）

| 时间 | 画面 | 压屏标题（已烧进静帧） |
|------|------|------------------------|
| 0:00 | 片头卡 | TeamClu / Shared skills and group chat… |
| 0:04 | 三栏工作台 | Your team and its agents, one workspace |
| 0:12 | 群聊 | **Sessions are group chats** |
| 0:22 | 团队技能 | **Skills your whole team shares** |
| 0:31 | 通道网关 | Meet your agents where you already talk |
| 0:39 | 浏览器侧边栏 | Agents in your browser side panel |
| 0:46 | 尾卡 | TeamClu / teamclu.ai / MIT · open source · in beta |

顺序是**叙事顺序，不是 gallery 顺序**：工作台先立"这是什么"，然后把 PH 的两个
主主张（群聊、团队共享技能）放在最长的两个停留（各 10 秒），通道和浏览器收尾。

---

## 3. 改画面 / 改顺序

`build-video.mjs` 顶部的 `SCENES` 数组就是全部配置，每项：

```js
{ kind: 'shot', slug: '03-team-skills', src: 'ph-2-team-skills-1270x760.png',
  dur: 10, z0: 1.0, z1: 1.12, fx: 0.5, fy: 0.52, caption: '…' }
```

- `src` — gallery 里的文件名。换新截图只需先重跑
  `node scripts/build-producthunt-gallery.mjs`，视频会自动用上。
- `dur` — 停留秒数。
- `z0 → z1` — 运镜。`1.0 → 1.12` 是推近，`1.12 → 1.0` 是拉远。
- `fx/fy` — 焦点（画面比例）。
- `caption` — 会写进 `.srt`，保持和画面上的字一致。

### ⚠️ 焦点不要乱调，会切掉标题

五张静帧的**标题和副标题是烧进去的**，位置大约 y 0.12–0.21、x 0.10–0.56。
zoompan 永远取以焦点为中心、`1/z` 宽的窗口，所以可见上边界是 `fy − 1/(2z)`。

第一版就踩了这个坑：`03-team-skills` 用了 `fy 0.62 / z 1.16`，上边界落在 0.19，
标题被裁掉，片子开场是 **"kills your whole team shares"**。

**约束：`z ≤ 1.12` 时 `fy ≤ 0.52`**（可见上边界 ≥ 0.12），`fx ≤ 0.51`。

想强调某个区域，**先把标题重拍成没有烧屏字的一版**，再推镜头；不要靠加大 zoom。

改完请抽查每个场景**运镜的极值帧**（推近看最后一帧，拉远看第一帧）：

```bash
ffmpeg -v error -ss 31 -i out/teamclu-tour-1080p.mp4 -frames:v 1 /tmp/peak.png
```

---

## 4. 编码参数

`-c:v libx264 -preset slow -crf 19 -profile:v high -level 4.0 -pix_fmt yuv420p
-movflags +faststart -color_primaries bt709 -color_trc bt709 -colorspace bt709`

`pix_fmt yuv420p` 和 `+faststart` 是硬要求：前者是 YouTube 兼容底线，后者让
浏览器不下载完整个文件就能起播。色域按 bt709 标，否则播放器会把 `#fbfaf7`
的暖白底色偏冷。

静帧从 1270×760 放到 1080 高（1.42×）用的是 Lanczos，之后补了一道很轻的
`unsharp=5:5:0.5`。字是**略微偏软**的——这是 1270px 源的天花板，不是 bug。
真要锐，得重拍更高分辨率的原图。

---

## 5. 还是没有声音

成片**无音轨**。PH 能接受，YouTube 也能接受，但配一段音乐或配音会明显更好。
拿到音频后一行接上：

```bash
ffmpeg -i out/teamclu-tour-1080p.mp4 -i vo.wav \
  -c:v copy -c:a aac -b:a 192k -shortest \
  out/teamclu-tour-final.mp4
```

配音稿和时间轴在 `voiceover.md`。

---

## 6. 上传

**两条路都得你本人点** —— producthunt-kit/README.md §7.5 已经实测过：浏览器自动化
能读页面、能填文本，但**给 file input 赋值做不到**。所以下面每一行都要手动。

### Product Hunt

1. 先把 MP4 传到 YouTube（设成「公开」或「不公开」，PH 需要能访问）。
2. 复制视频链接，填进 PH 发帖流程的 media / video 字段。
3. 回填本文件对应信息到 `producthunt-kit/ph-draft.json`（加 `video` 字段），
   并把 §7 的 `Demo 视频：` 那一行填上。

### YouTube

标题 / 描述 / 标签 / 章节见 `youtube.md`。上传时：

- **Visibility**：首发当天先 `Unlisted`，等 PH 流量过来再转 `Public`
  （PH 访客点开你的视频 404 的代价，比晚公开一小时大）。
- 勾 **「这不含敏感内容」**（无 Sentry、无弹窗、无真实邮箱/内网域名）。
- 缩略图见 `youtube.md` 最后一节。
