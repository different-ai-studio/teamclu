# Maker 账号资料 — 财务负责人账号

> 配合 [`../README.md`](../README.md) 使用。这个账号已注册完成，本文档只管
> **资料**（头像、显示名、简介、链接），不管发帖。
>
> **头像为什么是图形不是人像**：这个账号属于一位不愿把真实身份绑定到公开
> 发布的人。通用卡通脸在发布后几小时内就会招来「这是哪个图库头像」的评论，
> 抽象标记则读作一个有意的 handle，而且改版时不必重做。这一条是设计决定，
> 不是妥协——如果之后她本人改变主意要用真人照片，替换 `maker-avatar.svg`
> 再跑一次构建脚本即可。

---

## 1. 头像

| 文件 | 用途 |
|------|------|
| `maker-avatar-1024.png` | **上传这个** |
| `maker-avatar-256.png` | 备用（PH 两个尺寸都接受） |
| `maker-avatar.svg` | 源文件，改设计改这个 |
| `maker-avatar-size-check.png` | 尺寸对照图，**不要上传** |

重新生成：

```bash
node scripts/build-maker-avatar.mjs
```

脚本会渲染 SVG、导出 1024 与 256、出尺寸对照图，并做两项检查：
空白渲染（Chrome 小窗口会返回纯黑图，不检查就会静默通过）和
油墨覆盖率 ≥12%（低于这个值缩到 32px 会糊成一团灰）。

> PH 把所有头像裁成圆形，所以设计必须保证主体严格居中、四周留白。
> 对照图里 32px 那一列就是评论区里的真实观感——**发布前看一眼那一列**。

---

## 2. 显示名（Name）

```
Bertrand
```

与既有 Maker `@b319` 一致（同一人、同一个 git 身份 `b319`）。
用同一个名字而不是新造一个，是为了让 PH 上已有的一次发布
（TradingPlan）和这次发布指向同一个人。

---

## 3. 简介（Bio）

PH 的 bio 上限 **160 字符**。三版，按侧重不同：

**A（推荐 · 讲清楚你是谁 + 在做什么）**

```
Ops and finance side of TeamClu. I handle the numbers; the team handles the agents. MIT-licensed, self-hostable, in beta.
```

121 字符。承认职能边界（运营/财务）而不是假装是工程师，反而更容易在
评论区拿到信任。

**B（更短）**

```
Ops & finance for TeamClu — shared skills and group chat for a team's AI agents.
```

80 字符。

**C（带链接）**

```
Ops and finance side of TeamClu (teamclu.ai). MIT-licensed, self-hostable, in beta.
```

83 字符。

> 别在 bio 里写「基于 OpenCode」这类实现细节：运行时换过，写死会立刻过时
> （见 `../README.md` §8）。也别堆砌头衔，PH 的 bio 只有一行半的阅读预算。

---

## 4. 链接

| 位置 | URL |
|------|-----|
| Website | `https://teamclu.ai/` |
| GitHub | `https://github.com/different-ai-studio/teamclu` |
| Twitter / X | 留空（没有就留空，不要编） |
| Contact email | `support@teamclu.ai` |

⚠️ **不要填 `teamclaw.ai`。** 该域名已不在本项目名下，会 **302 跳到
`workclaw.com`**——那是另一个产品。正确域名是 `teamclu.ai`。

---

## 5. 资料更新清单

| 项目 | 状态 |
|------|------|
| 头像换成 `maker-avatar-1024.png` | ☐ |
| 显示名 `Bertrand` | ☐ |
| Bio 填 A 版 | ☐ |
| Website `https://teamclu.ai/` | ☐ |
| GitHub `https://github.com/different-ai-studio/teamclu` | ☐ |
| X 留空 | ☐ |
| 确认**没有**填 `teamclaw.ai` | ☐ |
| 32px 对照图已看过，图形在评论区尺寸下清晰 | ☐ |

> 改完资料后，PH 的发帖流程仍需先在 `Choose a product...` 下拉里选中已有的
> TeamClu 产品（不要走「填链接新建」）。这一步要真人点击，原因见
> `../README.md` §7.5。
