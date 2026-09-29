# posterkit — 功能海报

> 基线：`feat/product-hunt-launch` · 2026-09-29
> 英文 · 1920×1080 · Editorial Calm

| 文件 | 内容 |
|---|---|
| `build-poster.mjs` | 构建脚本（ImageMagick，无 ffmpeg 依赖） |
| `out/skills-management-1920x1080.png` | **成片** Skills 管理海报 |
| `../kits/design.mjs` | 与 videokit 共用的绘图原语（实测字形度量） |

```bash
node posterkit/build-poster.mjs
```

需要 `magick`（`brew install imagemagick`）。重跑字节级一致（已验证 sha256
`ab2488abad…`）——`kits/design.mjs` 的 `run()` 统一过滤了 ImageMagick 会自动
写入的 `date:create` / `date:modify`，所以 git 不会每次构建都脏。

---

## 1. 这张图只说一句话

> **A skill is not a prompt fragment.
> It is a team asset you can own, version, and audit.**

这是 `docs/features/06-skills-roles-marketplace.md` §0 的原话（"skill 不是『给
agent 的提示词片段』，而是『团队可以拥有、版本化、审计的资产』"）。**不是功能
罗列**——下面四张卡是把这句话变成真的机制，每个数字都能追到出处：

| 卡 | 机制 | 出处 |
|---|---|---|
| ① PUBLISH GATE | 6 个必填字段，`when_not_to_use` 最关键 | 06 §4 |
| ② VERSION HISTORY | 追加式版本历史，每次发版必填 changelog | 06 §3.1 |
| ③ AUTO-FOLLOW | 10 分钟后台对账，无 update 按钮 | 06 §6.1 |
| ④ CONFLICTS | 脏改产生冲突人工决策，不静默覆盖 | 06 §6.4 |

**刻意不放的**：Roles、ClawHub 市场、权限面板。06 §9 说 role 本质是「一组 skill
的命名组合」，跟着 skill 机制走，不该单独立一栏。

---

## 2. 页脚那行 "NOT BUILT" 是故意的

> Per-member skill visibility. One key per team, shared by all members — it
> protects against the cloud provider, not against colleagues. And any team
> member can publish: owner is responsibility, not permission.

两条都是 06 里的原话（§1.3 / §3.3）。**只印好话的海报不如印出边界的可信**——
这和你 PH FAQ 里如实写「skill 没有成员间可见性隔离」是同一个选择。第二句
（owner 是责任不是权限）反直觉，值得直接说出来。

---

## 3. 改文案

全部在 `build-poster.mjs` 顶部的 `CLAIM_1/2`、`SUB`、`CARDS`、`NOT_BUILT`
四个常量里。

**卡片高度是硬约束**：`CARD_H = 440`，正文从 `+158` 开始，每行 30px，段间距
10px，所以每张卡最多 **8 行**（240 + 20）。改文案后必须重跑看审计输出：

```
layout audit: no overflow, nothing shrunk to fit
```

超了会逐条报出来，例如：

```
card 3 (AUTO-FOLLOW) body overruns by 8px
```

**这一版已经踩过一次**：AUTO-FOLLOW 初稿 10 行，文字直接掉出卡片外。是审计抓到
的，不是眼睛。改文案时先跑构建，别先看图。

---

## 4. 排版为什么是"实测"而不是"估算"

`kits/design.mjs` 里所有几何都量，不猜。原因很具体：

- `-annotate +X+Y` 未设 gravity 时 **Y 是基线**，而 `-draw rectangle` 是绝对坐标。
  两者混用会让 coral 色条浮在标题上方并压住字（视频那边已经修过三轮）。
- **固定 cap 比例不成立**：Arial Bold 实测 0.705–0.75 em 随字号跳
  （92/128、39/54、22/30、15/20），抗锯齿和像素取整造成的。所以
  `capOffset()` 按 font+pointsize 实测。
- **按字数估宽度不成立**：`t.length * 6.6` 这种每字系数把视频里
  "draft the rollback note" 挤出了自己的 pill。现在 `pill()` 的宽度就是墨迹
  + padding，`wrap()` 按实测宽度断行。

`kits/design.mjs` 被 videokit 和 posterkit 共用，所以两边共享同一套已修好的规则。
（`scripts/build-producthunt-gallery.mjs` 保留了自己的 token 副本——那个脚本已经
稳定并被 producthunt-kit 引用，刻意不顺手重构。）

---

## 5. 尺寸

只出了 **1920×1080**。要别的比例改 `W` / `H` 和 `M`、`CARD_*` 几个常量——注意
卡片宽度是 `(CONTENT - CARD_GAP*3)/4` 的四等分，改宽度要重跑审计确认不溢出。

需要竖版（小红书 3:4）或方版（即刻/X 1:1）的话直接说，布局要重排而不是简单裁切。
