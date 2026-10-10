# posterkit — 功能海报（英文 · 1920×1080 · Editorial Calm）

> 基线：`feat/product-hunt-launch` · 2026-09-29

| 文件 | 内容 |
|---|---|
| `build-poster.mjs` | 构建入口（ImageMagick，无 ffmpeg 依赖） |
| `layout.mjs` | 版式：主张 + 四卡 + 页脚 NOT BUILT |
| `topics/*.mjs` | **只有文案**，每张卡标注了 `docs/features/` 出处 |
| `out/*.png` | 成片（已入库，不用装 ImageMagick 也能发） |
| `../kits/design.mjs` | 与 videokit 共用的绘图原语（实测字形度量） |

```bash
node posterkit/build-poster.mjs              # 全部 topic
node posterkit/build-poster.mjs sessions     # 只出一张
```

`brew install imagemagick`。**构建以退出码报审计**：任何溢出或缩字都会让
`process.exit(1)`，不会静默出一张坏图。重跑字节级一致（`-strip` 去掉了
ImageMagick 自动写入的时间戳）。

## 现有 topic

| topic | 主张 | 出处 |
|---|---|---|
| `skills-management` | A skill is not a prompt fragment. It is a team asset you can own, version, and audit. | 06 |
| `sessions` | The atom of a chat app is a message. The atom of TeamClu is the session. | 03 |

## 1. 每张图只说一句话

两张海报都是「一句判断 + 四个把它变成真的机制」，**不是功能罗列**。
每张卡的每个数字都能追到 `docs/features/` 的具体小节——被人在评论区追问时
要答得出来。

`sessions` 的四卡：

| 卡 | 机制 | 出处 |
|---|---|---|
| ① THE UNIT | 会话有参与者/权限/绑定 agent/工作区/生命周期；消息只有内容 | 03 §0 |
| ② AGENTS | agent 是**参与者不是服务端**：可离线、可限权、可中途换模型 | 03 §2.2 |
| ③ REPLY FORM | 人的消息是气泡（宽度由内容决定），agent 回复是**笔记**（全宽、有结构） | 03 §3.2 |
| ④ THREADS | **只有 agent 回复能开线程**；线程是独立云会话，主列表隐藏；懒 fork | 03 §6.1–6.2 |

## 2. 页脚那行 NOT BUILT 是故意的

`skills-management`：成员间可见性隔离没做（§1.3），任何成员都能发布、
owner 是责任不是权限（§3.3）。

`sessions`：**@提及不是权限**——被提及不等于被加入会话（§7.3）；**presence 是
actor 级不是 session 级**，同一个人在所有会话里都显示在线（§7.2）。

两条都反直觉且是真实设计边界。只印好话的海报不如印边界——这和 PH FAQ 的
口径一致。

## 3. 改文案

只改 `topics/<slug>.mjs`，然后重跑。

**硬约束，改完必须看审计：**

| 项 | 预算 |
|---|---|
| 卡片正文行数 | **最多 8 行**（`BODY_LINE_BUDGET`，从 `+158` 起，每行 30px，段间距 10px） |
| 卡片标题 | **≤ 19 字符**（27pt 不缩字；超了会被缩，与其它卡不齐） |
| 主张两行 | 62pt，两行都要放得下 1520px |
| 页脚 | 两行，每行 `CONTENT - 260` |

超了会明确报出来：

```
card 3 (AUTO-FOLLOW) body is 10 lines, budget 8
shrank "A participant, not a service" 27→25pt to fit 317px
```

**先跑构建，别先看图。** 第一版 skills 海报就是文字掉出卡片外，是审计抓到的。

## 4. 加一个新 topic

在 `topics/` 建 `xxx.mjs`，default export：

```js
export default {
  slug: 'xxx',                      // → out/xxx-1920x1080.png
  eyebrow: 'FEATURE NAME',
  claim1: '…', claim2: '…',         // 两行，62pt
  sub: '…',                          // 一行
  cards: [                          // 必须正好 4 张
    { label: 'UPPERCASE', title: '≤19 chars', body: ['…', '…'] },
    // 或 { label, title, lead: [[{t:'a'},{t:'b',hi:true}]], note: '…' }
  ],
  notBuilt: ['…', '…'],              // 页脚两行
  site: 'teamclu.ai',
};
```

然后 `node posterkit/build-poster.mjs xxx`。四卡是版式写死的（`renderPoster` 会
校验），少于或多于四张直接报错。

## 5. 排版为什么是"实测"而不是"估算"

`kits/design.mjs` 里所有几何都量，不猜。四个具体原因：

- `-annotate +X+Y` 未设 gravity 时 **Y 是基线**，`-draw rectangle` 是绝对坐标。
  混用会让 coral 色条位置完全错位（videokit 那边修过三轮）。
- **固定 cap 比例不成立**：Arial Bold 实测 0.705–0.75 em 随字号跳
  （92/128、39/54、22/30、15/20），抗锯齿和像素取整造成的。`capOffset()` 按
  font+pointsize 实测。
- **按字数估宽度不成立**：`t.length * 6.6` 这种每字系数在 videokit 里把
  "draft the rollback note" 挤出了自己的 pill。现在 `pill()` 宽度 = 墨迹 +
  padding，`wrap()` 按实测宽度断行。
- **色条位置要明确定义，不能凭感觉**。`accentBar()` 有两个模式：
  `align: 'cap'`（下沿落在文字 cap 线上，gallery 的做法）、
  `align: 'center'`（垂直居中于文字的 cap 高度，贴在文字**旁边**）。
  海报用的是 `'center'` + `x: M - 36`，即**贴在 eyebrow 左边**。

  这里错过两次：第一次挂在文字左边 40px（`x: M - 40`），左边距被打断成三套
  左边界；第二次把色条压到左边距上、落在主张 cap 线上方，结果跑到 eyebrow
  **下面**去了。正确位置是 eyebrow 的**左边**。

（`scripts/build-producthunt-gallery.mjs` 保留了自己的 token 副本——那脚本已稳定
并被 producthunt-kit 引用，刻意不顺手重构。）

## 6. 尺寸

只出了 **1920×1080**。改 `layout.mjs` 顶部的 `W` / `H` 和 `M` / `CARD_*` 即可，
但卡片宽度是四等分，改完**必须重跑审计**确认不溢出。

竖版（小红书 3:4）、方版（即刻 / X 1:1）需要**重排**而不是裁切——四卡横排在
3:4 下每张只剩 ~250px 宽，8 行放不下。说一声我出。
