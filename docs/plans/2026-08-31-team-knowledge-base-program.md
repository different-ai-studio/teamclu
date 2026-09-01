# 公司级知识库建设方案（Team Knowledge Base Program）

> 状态：草案 v1
> 日期：2026-08-31
> 范围：指导公司内部不同团队基于 TeamClu 建立并运营各自的知识库，
> 并支持跨团队的知识发现与复用。

## 0. 为什么是现在

TeamClu 已经具备了知识库的底层骨架：

- **团队 Markdown vault + 云副本**：`~/.amuxd/teams/<id>/shared/knowledge/`
  通过 amuxd → FC `/sync/*` → OSS 同步，明文、秒级推送（ADR-0008）。
- **Obsidian 直接打开**：wiki link、`[[...]]` 解析、附件目录预置都已落地
  （`docs/architecture/obsidian-compatible-knowledge.md`）。
- **RAG 消费**：桌面端 Tantivy 索引，agent 回复时可以直接引用 vault 内容。
- **冲突治理**：`.conflicts/` sidecar + 冲突决策视图 + 云版本只读视图
  （`packages/app/src/lib/tabs/knowledge-tabs.ts`）。

缺的不是「能不能存」，而是「**怎么组织、怎么流转、怎么让大家愿意写**」。
本文档就是那个答案。

## 1. 定位与边界

**是什么**：每个团队一个 Obsidian 兼容的 Markdown vault，作为该团队的
「唯一事实来源」（single source of truth）。TeamClu 负责同步、检索、
AI 消费、权限边界；Obsidian（或任何 Markdown 编辑器）负责写作体验。

**不是什么**：

- 不是 Notion 式协作文档——不做行级 merge，冲突走 `.conflicts/` 人工决策。
- 不是通用网盘——二进制大文件走对象存储引用，不进 vault。
- 不是 IM 聊天记录归档——聊天是过程，知识库是结论。

## 2. 信息架构：三层模型

```
┌─────────────────────────────────────────────────────────┐
│  L3 公司级发现层  — 知识目录 / 搜索门户 / 精选集合         │
│      （跨团队索引 + 推荐，只读聚合，不回写）                 │
├─────────────────────────────────────────────────────────┤
│  L2 团队 vault   — 每个团队的 knowledge/                  │
│      （写作、评审、发布的唯一场所）                          │
├─────────────────────────────────────────────────────────┤
│  L1 个人草稿层   — 会话记录 / 临时笔记 / AI 对话            │
│      （低门槛捕获，定期「打捞」进 L2）                       │
└─────────────────────────────────────────────────────────┘
```

关键规则：**知识只能向上流动**。L1 → L2 靠「打捞」（人工或 AI 辅助），
L2 → L3 靠「发布」（manifest 声明）。不存在跨团队直接编辑别人 vault 的情况。

### 2.1 团队 vault 的标准目录结构

每个团队的 `knowledge/` 都遵循同一套骨架（`scaffold` 命令一键生成）：

```
knowledge/
├── 00-home.md            # 团队门户：我们是谁 / 做什么 / 常用入口
├── 10-onboarding/        # 新人入职：环境搭建、第一周清单、FAQ
├── 20-domains/           # 业务域知识：一个子域一个目录
│   └── <domain>/
│       ├── _index.md     # 该域的导航页（Obsidian MOC）
│       └── ...
├── 30-decisions/         # ADR：重要决策的来龙去脉
├── 40-runbooks/          # 运维手册：告警处理、发布流程、应急预案
├── 50-glossary.md        # 团队术语表（黑话翻译器）
├── 90-archive/           # 失效内容，只读保留
├── attachments/          # 图片 / PDF / 表格
└── knowledge.manifest.yaml  # 发布清单 + 分类标签（见 §4.2）
```

为什么是数字前缀：Obsidian 文件管理器按名称排序，数字前缀让结构
在原生文件树里也是自解释的，不依赖任何插件。

### 2.2 三种标准页面类型

每种类型对应一个模板（`templates/` 目录内置）：

**域索引页（_index.md / MOC）**
回答「这个域有什么」。人工维护的导航，不是自动生成的列表。
开头必须有 frontmatter：`type: domain-index, owner: @xxx, updated: YYYY-MM-DD`。

**决策记录（30-decisions/*.md）**
回答「当时为什么这么做」。格式轻量：背景 → 选项 → 结论 → 后果。
一旦合并不再大改，修正写新 ADR 并互链。

**运行手册（40-runbooks/*.md）**
回答「出事了怎么办」。面向执行：前置条件 → 步骤 → 验证 → 回滚。
每篇必须有 `last-verified:` 字段，超过 90 天未验证会在 UI 里标黄。

## 3. 工作流：知识的生命周期

### 3.1 捕获（L1 → L2）

降低写的第一道门槛：

- **会话打捞**：在 TeamClu 聊天里选中一段 AI 回复或讨论结论，
  右键「存到知识库」→ 选目标目录 → 自动生成带上下文链接的草稿。
- **每日打捞提醒**：daemon 扫描当天的「想法」会话，把被 👍 或
  被标记的片段汇总成一条待办推到「等待我」。
- **Obsidian 直接写**：主写入面，TeamClu 负责秒级同步给队友。

### 3.2 评审与固化（L2 内部）

- **轻量评审**：非 runbook/ADR 类页面，作者自己发，队友看到问题直接改
  （wiki 精神）。runbook/ADR 需要在 PR 或团队周会上过一遍。
- **owner 制度**：每个 `20-domains/<domain>/` 有明确 owner（写在
  `_index.md` frontmatter），负责该域的整洁，不是唯一作者。
- ** freshness 信号**：`updated` 和 `last-verified` 字段驱动 UI 上的
   freshness 标记（绿/黄/灰），让读者一眼判断可信度。

### 3.3 发布（L2 → L3）

团队决定哪些内容对公司其他团队可见：

```yaml
# knowledge.manifest.yaml
version: 1
team: payment-infra
title: 支付基础设施团队知识库
summary: 支付链路、清结算、对账、渠道接入的领域知识与运维手册
visibility: org            # private | org
domains: [支付, 清结算, 对账]
entry: 00-home.md
collections:
  - name: 新人必读
    paths: [00-home.md, 10-onboarding/, 50-glossary.md]
  - name: 值班手册
    paths: [40-runbooks/]
```

FC 读取 manifest，把声明了 `visibility: org` 的 vault 纳入跨团队索引。
**未声明的默认 private**，只有团队成员可见。

### 3.4 消费

- **团队内**：TeamClu RAG 直接检索本团队 vault；Obsidian 全文搜索。
- **跨团队**：公司知识门户（搜索 + 目录浏览 + 精选集合），只读。
  引用他团队内容时用 `[[team:payment-infra/40-runbooks/xxx]]` 形式的
  跨 vault 链接，点击后请求只读副本。
- **AI agent**：agent 回答时优先引用本团队 vault；跨团队内容作为
  补充上下文，回答中标注来源团队。

## 4. 跨团队共享机制

### 4.1 原则：有边界的开放

- 默认 **team-private**：降低写作者的心理负担（不怕写得糙被全公司看）。
- 显式 **org-visible**：团队主动发布成熟内容，质量自我把关。
- **不建全公司大熔炉 vault**：所有权模糊的地方，内容必然腐烂。

### 4.2 知识目录（Knowledge Catalog）

FC 侧的只读聚合服务：

- 每个 org-visible vault 上报：元信息（团队、简介、domains）、
  条目清单（标题 + 摘要 + 更新时间）、精选集合。
- 提供 `/v1/catalog/teams`、`/v1/catalog/search` 两个端点
  （加入 `docs/openapi/teamclu-api.v1.yaml`）。
- 客户端入口：侧边栏「发现」分组 + 搜索框下的「跨团队知识」tab。

### 4.3 依赖他团队知识的正确姿势

- 想引用 → 用跨 vault 链接，保持单一来源。
- 想修改 → 去对方团队提需求/PR，不在本地复制副本。
- 对方内容不够用 → 那是对方 backlog 的信号，不是自己开副本的信号。

## 5. 治理与运营

### 5.1 角色

| 角色 | 职责 | 投入 |
|---|---|---|
| 团队 Knowledge Champion | 结构整洁、模板落地、打捞提醒跟进 | 每周 ~1h |
| Domain Owner | 自己域的内容质量与 freshness | 随工作自然发生 |
| 公司级协调人（可选） | 维护 catalog、跨团队重复内容仲裁 | 每月 ~2h |

### 5.2 健康度指标（自动统计）

- **覆盖度**：每个 domain 是否有 `_index.md`；新人 onboarding 路径是否完整。
- **新鲜度**：`last-verified` 超期的 runbook 占比；90 天未更新页面占比。
- **使用度**：RAG 引用次数（哪些页面真的被 agent / 人用到）。
- **打捞率**：L1 标记内容有多少最终进入了 L2。

指标展示在团队设置页，不排名、不考核，只用于自我诊断。

### 5.3  onboarding 一个团队的 checklist

1. `teamclu knowledge scaffold` 生成标准目录 + 模板。
2. 团队负责人填 `00-home.md` 和 `knowledge.manifest.yaml`。
3. 指定 1 个 champion + 每个 domain 一个 owner。
4. 第一周：迁移现有散落文档（飞书/Confluence/本地 md）进 `20-domains/`。
5. 第二周：写第一篇 ADR 和第一篇 runbook（从最近的真实事件取材）。
6. 第三周：开一次 30 分钟评审会，过一遍结构，发布 manifest。

## 6. 技术落地路线

依赖已落地的 P0/P1 同步工作（ADR-0008），分三期：

**P2 — 团队内可用（2-3 周）**
- `scaffold` 命令 + 三套模板（MOC / ADR / runbook）。
- 聊天「存到知识库」右键 + 打捞汇总。
- freshness 字段解析 + UI 标记。

**P3 — 跨团队发现（3-4 周）**
- `knowledge.manifest.yaml` schema + FC catalog 端点。
- 客户端「发现」页 + 跨团队只读浏览。
- 跨 vault 链接解析与跳转。

**P4 — 运营闭环（2 周）**
- 健康度统计 pipeline + 团队设置页 dashboard。
- RAG 引用埋点 → 使用度指标。

## 7. 风险与对策

| 风险 | 对策 |
|---|---|
| 写完没人看 | 优先打通 RAG 消费——知识被 agent 引用是最强的正反馈 |
| 结构僵化没人维护 | 结构是脚手架不是法律；champion 每月可重组，ADR 记录理由 |
| 变成第二个文档坟场 | freshness 标记 + 使用度指标让腐烂可见；archive 目录降低删除心理门槛 |
| 跨团队内容重复 | catalog 暴露重复信号；仲裁靠公司协调人，不靠工具强制 |
| 敏感信息误发布 | manifest 默认 private；发布动作需要在团队内二次确认 |

---

## 附录 A：一个产品运营团队的完整示例

以虚构的「用户增长运营组」（5 人，负责拉新、激活、留存活动）为例，
走完从空目录到知识被全公司复用的全过程。每一步都标注了「谁在什么时候
做什么」，可以直接当 onboarding 剧本用。

### 第 0 天：建库（30 分钟，champion 一人完成）

运营主管林娜被任命为 champion。她打开 TeamClu：

```
$ teamclu knowledge scaffold --team growth-ops
✓ 生成 knowledge/ 标准目录
✓ 写入模板：_index.md / adr-template.md / runbook-template.md
✓ 创建 knowledge.manifest.yaml（默认 visibility: private）
```

得到这棵空树：

```
knowledge/
├── 00-home.md
├── 10-onboarding/
├── 20-domains/
├── 30-decisions/
├── 40-runbooks/
├── 50-glossary.md
├── 90-archive/
├── attachments/
└── knowledge.manifest.yaml
```

她做的三件事：

1. 在 `00-home.md` 里写了一段大白话：「我们是用户增长运营组，管拉新、
   激活、留存。新人先看 10-onboarding，出事查 40-runbooks，黑话不懂
   查 50-glossary」。
2. 把 `20-domains/` 拆成三个子域并指定 owner：
   `campaigns/`（活动，owner 是阿杰）、`channels/`（投放渠道，owner
   是雯雯）、`metrics/`（数据口径，owner 是老周）。
3. 填了 manifest 的团队名和简介，visibility 保持 **private**——
   先自己用顺了再发布。

### 第 1 周：迁移 + 第一次打捞

**迁移**（每人半天）：团队把散落在各处的文档搬进 `20-domains/`：

- 阿杰把飞书里的《618 大促复盘》挪到 `20-domains/campaigns/2026-618-retro.md`，
  图片存进 `attachments/`。
- 雯雯把本地 Excel 导出的《各渠道 CPI 基准》整理成
  `20-domains/channels/cpi-benchmark.md`。
- 老周把「新客」定义的五个版本统一成 `20-domains/metrics/new-user-definition.md`——
  这篇直接解决了过去每次周会都要吵「新客到底怎么算」的问题。

**第一次打捞**（自然的）：周三阿杰在 TeamClu 里让 AI 帮他写 push 文案，
AI 给出了一版效果很好的结构。他选中那段回复，右键「存到知识库」→
选 `20-domains/campaigns/` → 自动生成了
`push-copy-formula.md`（草稿），末尾带着原始会话链接。
他花 5 分钟补了个标题和两句说明，存盘。Obsidian 里雯雯刷新就看到了。

### 第 2 周：第一篇 runbook 和 ADR（从真实事件取材）

**Runbook**：周四晚上 push 渠道大面积失败，值班的老周手忙脚乱地处理了
两小时。周五他把过程整理成 `40-runbooks/push-channel-outage.md`：

```markdown
---
type: runbook
owner: 老周
last-verified: 2026-09-04
---

# Push 渠道大面积失败应急手册

## 前置确认
1. 确认是渠道侧问题还是我们侧问题：先看 [渠道状态页]……
```

整个过程 40 分钟——**素材来自真实事件，不是憋出来的**。这正是方案里
说的「从最近的真实事件取材」。

**ADR**：周会上团队决定「以后所有活动复盘必须用统一模板」，阿杰写了
`30-decisions/0001-unified-campaign-retro-template.md`，记录了为什么
（过去五份复盘格式各异，根本无法横向对比）、结论是什么、对以后的要求。

### 第 3 周：评审 + 发布

30 分钟评审会，过了三件事：

- 结构：大家觉得 `channels/` 下该再加 `kol/` 子目录，当场建。
- freshness：老周那篇 runbook 刚验证过，是绿的；雯雯的 CPI 基准是
  90 天前的数据，被标黄了，她当场更新。
- 发布：manifest 改成 `visibility: org`，发布两个精选集合——
  「新人必读」（home + onboarding + glossary）和「活动运营手册」
  （campaigns 域 + push 复盘）。

```yaml
# knowledge.manifest.yaml
version: 1
team: growth-ops
title: 用户增长运营组知识库
summary: 拉新、激活、留存活动的打法、渠道基准与数据口径
visibility: org
domains: [活动运营, 渠道投放, 数据口径]
entry: 00-home.md
collections:
  - name: 新人必读
    paths: [00-home.md, 10-onboarding/, 50-glossary.md]
  - name: 活动运营手册
    paths: [20-domains/campaigns/, 40-runbooks/]
```

发布后，公司知识目录里出现了这个团队。CRM 组的小王在目录里搜
「新客」，找到了老周的《新客定义》，用
`[[team:growth-ops/20-domains/metrics/new-user-definition]]`
链到了自己团队的对齐文档里——**没有复制副本，单一来源**。

### 日常循环（之后每周）

| 时刻 | 发生什么 |
|---|---|
| 随手 | AI 对话里有用的结论 → 右键存库（草稿） |
| 周会前 | champion 看打捞待办列表，催一下该固化的草稿 |
| 周会 | 10 分钟过 freshness 黄/灰页面，该更新的更新、该归档的进 90-archive |
| 出事时 | 先查 40-runbooks；处理完把新经验补进去或写新篇 |
| 每月 | champion 看一眼健康度：打捞率、黄页比例、哪些页面被 RAG 引用最多 |

### 这个例子里每个角色得到了什么

- **林娜（champion）**：每周 1 小时，换来新人入职不再靠人肉带。
- **老周（domain owner）**：runbook 写完第二周就被 RAG 引用了 3 次——
  AI 直接引用他的手册回答值班同事的问题，这是最直接的正反馈。
- **小王（跨团队消费者）**：用「新客」定义时不用再猜，也不用约会对齐，
  链过去就行；定义变了他的链接永远指向最新版。
- **新入职的实习生**：第一天拿到的是 `10-onboarding/` 清单，
  不是「你先随便看看，有问题问大家」。

---

## 附录 B：一个电商供应链团队的对照示例

以虚构的「供应链履约组」（8 人，管采购、仓储、物流履约）为例。
**刻意和附录 A 做差异化**：增长运营组展示的是「知识从对话里长出来」，
供应链组展示的是「知识库在高压、强协作、强时效场景下怎么扛事」。
两个例子放在一起，正好覆盖方案里大部分机制的不同侧面。

### 这个团队有什么不同

| 维度 | 增长运营组（附录 A） | 供应链履约组（本例） |
|---|---|---|
| 知识主力类型 | 打法、复盘、口径 | SOP、应急手册、外部对接协议 |
| 最大的痛 | 口径不一致、经验不传 | 大促值班靠人肉、跨团队协作靠吼、供应商信息散 |
| 写作者画像 | 运营，文字能力好 | 仓储/物流一线，没时间写长文 |
| freshness 敏感度 | 中（季度级过期） | 高（大促前不过一遍要出事） |

这个差异直接体现在目录的重心上——他们的 `40-runbooks/` 是全库最厚的
目录，而且多了一层别的团队不太用的 `70-vendors/`（外部伙伴对接）。

### 第 0 天：建库（多了一步定制）

champion 是履约主管老韩。scaffold 之后他多做了一件事：

```
knowledge/
├── 00-home.md
├── 10-onboarding/
├── 20-domains/
│   ├── procurement/      # 采购
│   ├── warehouse/        # 仓储
│   └── logistics/        # 物流
├── 30-decisions/
├── 40-runbooks/
│   ├── peak-season/      # 大促专项（双11、618）
│   └── daily/            # 日常异常
├── 50-glossary.md
├── 70-vendors/           # 外部伙伴：供应商/物流商对接档案
├── 90-archive/
└── knowledge.manifest.yaml
```

`70-vendors/` 不是标准骨架的一部分，是老韩根据自己团队需要加的——
这正体现了方案的原则：**结构是脚手架不是法律，champion 有权重组**。
他在 `30-decisions/0001-add-vendors-directory.md` 里写了一句话说明理由
（供应商对接信息散在微信里，人一走就丢），留了个痕。

### 第 1 周：迁移的重头戏是「把微信群里的知识挖出来」

供应链团队最大的存量知识不在任何文档系统里，而在**微信群聊天记录和
老员工的脑子里**。他们的迁移策略也因此不同：

- **供应商档案**：仓储主管把主要供应商的对接人、账期、起订量、
  历史坑点整理成 `70-vendors/<供应商名>.md`，一家一页。
  「华东仓那家纸箱厂，旺季会偷偷降克重」这种口头经验第一次落了字。
- **大促 SOP 骨架**：老韩把去年双 11 的值班表、扩容清单、压测记录
  整理成 `40-runbooks/peak-season/double-11-checklist.md` 的初版。
  不完整，但骨架在——**先框后填，不求一次写完**。
- **黑话表**：`50-glossary.md` 记了「截单时间」「波次」「妥投率」
  「逆向物流」这些跨部门协作时经常鸡同鸭讲的词。

### 第 2 周：双 11 备战演练——知识库第一次扛事

距双 11 还有一个月，团队做了一次备战演练。这次演练成了知识库最好的
压力测试和内容来源：

**演练前**：按 `double-11-checklist.md` 逐项过，发现三处去年踩过的坑
没记进去（某物流商分拨中心爆仓预案、预售订单的锁库逻辑、客服工单
激增时的分流规则），当场补。

**演练中**：模拟「主力物流商瘫痪」场景，值班员小赵第一次独立处理，
全程对着 `40-runbooks/peak-season/logistics-failover.md` 操作，
30 分钟完成切换。处理完她把手册里两处写得含糊的步骤改清楚了——
**runbook 的正确性是被「真的用过」验证出来的**，`last-verified`
字段更新为今天。

**演练后**：AI 助手根据演练会话自动生成了打捞待办：「这次演练有 5 段
讨论包含可固化的结论」。老韩花了 20 分钟把其中 3 条固化进库，
2 条判定为一次性信息丢弃。**打捞率 60%，健康**。

### 第 3 周：跨团队协作——这次轮到自己被引用

供应链是公司的「被依赖大户」：客服要查物流异常处理流程，大促运营
要查截单时间，财务要查供应商账期。发布 manifest 后，效应很快出现：

- **客服组**把 `[[team:sc-fulfillment/40-runbooks/daily/logistics-exception]]`
  链进了自己的工单处理手册。以前客服遇到物流异常要拉群问供应链，
  现在 AI 直接引用这篇 runbook 回答——**供应链组的被打扰次数
  肉眼可见地下降**。
- **大促运营组**在备战文档里链了 `50-glossary.md` 的截单时间条目。
  今年第一次，两边对「截单」的理解是同一个定义。
- **财务组**想要供应商账期数据，发现 `70-vendors/` 是 private 的
  （老韩在 manifest 里只发布了 runbooks 和 glossary，
  vendor 档案涉及商务条款，保持团队内可见）。
  财务组提了个需求：能否发布一个脱敏版账期表。老韩建了个
  `70-vendors/payment-terms-public.md`（只含标准账期，不含谈判细节），
  单独发布这篇——**可见性可以细到单篇，不是整个 vault 非黑即白**。

### 双 11 当天：终极检验

- 凌晨 0:40，某仓 WMS 系统卡顿。值班员查
  `peak-season/wms-degradation.md`——这篇是演练后补的——按手册
  切到降级模式，12 分钟恢复。
- 当天 AI 助手引用本库 runbook 回答了值班群里的 17 个问题，
  其中 15 个没再需要人工介入。
- 战后复盘时，团队把当天新增的 3 个异常场景写回了 runbook，
  `last-verified` 全部刷新。**知识库在高压日不是负担，是弹药库**。

### 这个例子里每个角色得到了什么

- **小赵（一线值班员）**：第一次独立处理物流商切换没慌——手册在手，
  而且她改过的版本会帮到下一个值班的人。
- **老韩（champion）**：今年双 11 他的手机比去年安静了一半；
  vendor 档案落了字，人员流动不再是信息黑洞。
- **客服组（跨团队消费者）**：物流异常自助处理率上升，拉群次数下降；
  供应链组从「人肉接口」变回「知识作者」。
- **财务组（边界试探者）**：发现 private 内容后走「提需求→对方发
  脱敏版」的正轨，而不是私下拷贝——**边界机制第一次被真实地使用**。

### 两个附录放在一起看

| 机制 | 附录 A（增长运营） | 附录 B（供应链） |
|---|---|---|
| 打捞 | AI 对话 → push 文案公式 | 演练会话 → 5 条待办固化 3 条 |
| freshness | 季度级（CPI 基准） | 大促级（演练驱动验证） |
| 跨团队 | 被引用「新客定义」 | 被引用 runbook + glossary；vendor 保持 private |
| 结构定制 | 标准骨架够用 | 加了 `70-vendors/`，用 ADR 留痕 |
| 正反馈 | runbook 被 RAG 引用 | 双 11 当天 AI 挡掉 15/17 个问题 |

---

## 附录 C：中英双语模板规范

公司内有英文协作场景的团队（跨境业务、外籍同事、海外伙伴对接），
模板必须中英双语，避免「模板是中文的，写的人只好自己翻译」的摩擦。

**原则：模板双语，内容单语。** 骨架、字段说明、引导文案中英并列；
正文内容由作者选一种语言写，不强制双写。

- scaffold 生成的每个模板，标题、frontmatter 注释、字段标签双语并列，
  格式如 `## 背景 / Background`。
- frontmatter 的 key 保持英文（`owner`, `last-verified`——机器可读，
  双语 key 会破坏解析），value 任意语言。
- `knowledge.manifest.yaml` 的 `summary` 字段建议双语一行：
  `summary: 支付领域知识与运维手册 / Payment domain knowledge & runbooks`。
- 目录名保持英文（`20-domains/` 等），因为这是 URL、wiki link 和
  跨 vault 引用的稳定锚点；目录的中文含义在各自的 `_index.md` 里说明。
- 跨团队引用时，引用方用自己的语言写上下文，被引页面保持原文。

---

## 附录 D：MCP-first 写入架构

原定的「一个 UI 入口」被以下讨论推翻：知识库最高频的写入动作
（scaffold / 从模板建页面 / 聊天打捞）都发生在 agent 会话场景里，
让 agent 直接在对话里完成比让用户找按钮自然得多。打捞动作的
「什么内容值得固化」判断本身是 LLM 任务。

**分工原则：UI 让人看到知识，MCP 让 agent 经营知识。**

### 做 / 不做的边界

- **写路径（MCP）**：scaffold、从模板建页面、打捞、写/改页面、
  检索、manifest 读写、健康度统计。
- **读路径（双轨）**：浏览、发现、catalog——UI 负责；agent 侧用
  `knowledge_search` 作程序化检索。
- **治理动作（UI）**：`visibility: private → org` 的发布确认弹窗；
  `.conflicts/` 冲突决策视图（现有 tab 形态保留）。

### 工具面（v1）

```
knowledge_scaffold          初始化 vault
knowledge_create            从模板建页面（adr / runbook / domain-index / page）
knowledge_salvage           把会话结论固化成草稿（对话高阶工具）
knowledge_write             写/改页面（路径校验限制在 vault 内）
knowledge_search            检索（包一层 Tantivy RAG）
knowledge_manifest_get/set  读/改发布清单
knowledge_health            freshness / 覆盖度统计
```

### 安全约束

- `knowledge_write` 路径校验锁在 vault 根内，防 traversal。
- `manifest_set` 变更 visibility 时必须带确认参数（`confirm: true`），
  纯文本确认无法通过则拒绝——agent 不能静默把库公开。UI 发布弹窗也
  建议保留，作为人和 agent 的双确认通道之一。
- 同步链路复用：MCP 写入落在 `shared/knowledge/`，P0/P1 的
  fs watcher + MQTT 推送原样接管。

### 收益

- 跨端免费：desktop / iOS / daemon 内嵌 chat / 外部 IDE（Claude
  Code、Cursor）调用同一组工具。
- 打捞 = 一次工具调用，不建 UI 流水线。
- UI 快捷入口（右键「存到知识库」）调同一 handler，与 agent 共用
  一套后端，不分裂。

---

## 附录 E：两个示例团队的最终知识库（完整内容）

以下分别是附录 A（用户增长运营组）和附录 B（供应链履约组）三周后的
最终 vault 状态。每篇文档都是真实可落地的完整内容，不是骨架。

### 增长运营组的最终 vault

```
knowledge/
├── 00-home.md
├── 10-onboarding/
│   └── first-week.md
├── 20-domains/
│   ├── campaigns/
│   │   ├── _index.md
│   │   ├── 2026-618-retro.md
│   │   └── push-copy-formula.md
│   ├── channels/
│   │   ├── _index.md
│   │   └── cpi-benchmark.md
│   └── metrics/
│       ├── _index.md
│       └── new-user-definition.md
├── 30-decisions/
│   └── 0001-unified-campaign-retro-template.md
├── 40-runbooks/
│   └── push-channel-outage.md
├── 50-glossary.md
├── 90-archive/
│   └── 2025-q4-campaign-old-format.md
├── attachments/
│   └── 618-retro-chart.png
├── 00-salvage/
│   └── 2026-09-03-ai-push-hook.md
└── knowledge.manifest.yaml
```

#### `00-home.md`

```markdown
---
type: home
updated: 2026-09-04
---

# 用户增长运营组知识库 / Growth Ops Knowledge Base

我们负责拉新、激活、留存活动。新人先看 onboarding，出事查 runbooks，
黑话不懂查 glossary。

## 快速入口 / Quick Links

- 新人入职 / Onboarding → [[10-onboarding/first-week]]
- 活动打法 / Campaigns → [[20-domains/campaigns/_index]]
- 渠道基准 / Channel Benchmarks → [[20-domains/channels/_index]]
- 数据口径 / Metrics Definitions → [[20-domains/metrics/_index]]
- 应急手册 / Runbooks → [[40-runbooks/]]
- 术语表 / Glossary → [[50-glossary]]

## 值班 / On-call

每周一人，排班表在飞书日历。值班期间 runbook 是第二责任人。
```

#### `20-domains/metrics/new-user-definition.md`

```markdown
---
type: domain-knowledge
owner: 老周
updated: 2026-09-02
---

# 新客定义 / New User Definition

## 结论 / Definition

**新客 = 注册后 7 天内完成首次核心行为的用户。**

核心行为按业务线定义：
- 电商：首单支付成功
- 内容：首次发布或首次互动（点赞/评论/分享）

## 为什么是这个定义 / Rationale

之前有五版口径（注册即新客、注册 3 天、注册 7 天有活跃、
首单、首互动），每次周会都对不齐。2026-08-28 周会定为
「7 天 + 首次核心行为」，理由：
- 3 天太短，周末注册的用户还没到活跃高峰
- 纯注册太宽，羊毛党占比失真
- 首单/首互动是真实价值动作

## 历史口径对照 / Legacy Mappings

| 旧口径 | 与新口径差异 | 数据修正系数 |
|---|---|---|
| 注册即新客 | 高估 ~40% | ×0.6 |
| 注册 7 天有活跃 | 高估 ~15% | ×0.85 |
| 首单（电商） | 基本一致 | ×1.0 |
```

#### `40-runbooks/push-channel-outage.md`

```markdown
---
type: runbook
owner: 老周
last-verified: 2026-09-04
---

# Push 渠道大面积失败应急手册 / Push Channel Outage Runbook

**触发条件**：push 送达率 5 分钟内下降 >50%，或多个渠道同时告警。

## 前置确认 / Prerequisites

1. 确认是渠道侧还是我们侧：先看 [渠道状态页](https://status.example.com)
2. 拿到值班权限：push 后台 + 降级开关权限
3. 通知链路：@值班群 → @渠道对接群

## 步骤 / Steps

1. **确认影响面**：后台「渠道健康」看板，确认是哪个渠道（个推/极光/FCM）
2. **切降级通道**：后台 → 推送管理 → 降级开关 → 选备用渠道
3. **验证恢复**：发一条测试 push 给测试机组，确认送达
4. **观察 10 分钟**：送达率恢复到 >90% 才算稳定
5. **回填记录**：在本文档末尾追加本次事件（时间、渠道、原因、耗时）

## 验证 / Verification

- 测试机收到 push
- 渠道健康看板送达率 >90%
- 无新增告警

## 回滚 / Rollback

如果备用渠道也失败：关闭 push 全量推送，只保留事务性 push
（订单通知、安全验证码），等渠道恢复后逐步放开。

## 历史事件 / Past Incidents

| 日期 | 渠道 | 原因 | 耗时 |
|---|---|---|---|
| 2026-09-03 | 个推 | 渠道证书过期 | 42min |

## 相关链接 / Related

- [[30-decisions/0001-unified-campaign-retro-template]]
- [渠道状态页](https://status.example.com)
```

#### `30-decisions/0001-unified-campaign-retro-template.md`

```markdown
---
type: adr
status: accepted
updated: 2026-09-01
---

# ADR-0001: 活动复盘统一模板 / Unified Campaign Retrospective Template

## 背景 / Context

过去五份活动复盘格式各异：有的只写数据，有的只写感受，
有的连目标都没对齐。无法横向对比，也无法沉淀方法论。

## 选项 / Options Considered

### A. 自由格式，只做内容清单
- 优点：写起来快
- 缺点：无法对比，信息密度参差

### B. 固定模板：目标 → 数据 → 打法 → 问题 → 沉淀
- 优点：可横向对比，强制对齐目标
- 缺点：写起来多花 20 分钟

### C. 用 AI 自动生成初稿，人工改
- 优点：最快
- 缺点：依赖数据接入，一期做不到

## 结论 / Decision

选 B。模板固定为五段：目标回顾 → 核心数据 → 打法拆解 →
问题与原因 → 可复用沉淀。从 2026-09 起所有活动复盘必须使用。

## 后果 / Consequences

- 复盘平均耗时从 1h → 1.5h，但可读性和复用性显著提升
- 新模板已沉淀到 [[20-domains/campaigns/_index]] 作为默认模板
```

#### `00-salvage/2026-09-03-ai-push-hook.md`

```markdown
---
type: salvage
source: chat
session-id: sess_20260903_1847
salvaged: 2026-09-03
---

# AI 生成的 push 文案钩子公式 / AI Push Hook Formula

在会话中测试出效果较好的 push 文案结构：

**公式**：场景钩子 + 利益点 + 紧迫感 + 行动指令

**示例**：
> 「睡前刷手机的你，今晚 8 点限时折扣最后 2 小时 → 点我抢购」

**效果**：A/B 测试点击率比平铺直叙版高 34%。

**注意**：紧迫感只对价格敏感型用户有效，品牌型用户会反感。
```

#### `knowledge.manifest.yaml`

```yaml
version: 1
team: growth-ops
title: 用户增长运营组知识库 / Growth Ops Knowledge Base
summary: 拉新、激活、留存活动的打法、渠道基准与数据口径 / Growth tactics, channel benchmarks, metrics definitions
visibility: org
domains: [活动运营, 渠道投放, 数据口径, Growth, Marketing]
entry: 00-home.md
collections:
  - name: 新人必读 / Onboarding
    paths: [00-home.md, 10-onboarding/, 50-glossary.md]
  - name: 活动运营手册 / Campaign Playbook
    paths: [20-domains/campaigns/, 40-runbooks/]
```

### 供应链履约组的最终 vault

```
knowledge/
├── 00-home.md
├── 10-onboarding/
│   └── first-week.md
├── 20-domains/
│   ├── procurement/
│   │   └── _index.md
│   ├── warehouse/
│   │   ├── _index.md
│   │   └── wms-degradation.md
│   └── logistics/
│       ├── _index.md
│       └── carrier-failover.md
├── 30-decisions/
│   └── 0001-add-vendors-directory.md
├── 40-runbooks/
│   ├── daily/
│   │   └── logistics-exception.md
│   └── peak-season/
│       ├── double-11-checklist.md
│       ├── logistics-failover.md
│       └── wms-degradation.md
├── 50-glossary.md
├── 70-vendors/
│   ├── _index.md
│   ├── huadong-packaging.md
│   └── payment-terms-public.md
├── 90-archive/
├── attachments/
│   └── wms-degradation-flow.png
├── 00-salvage/
│   └── 2026-09-04-drill-findings.md
└── knowledge.manifest.yaml
```

#### `00-home.md`

```markdown
---
type: home
updated: 2026-09-05
---

# 供应链履约组知识库 / Supply Chain Fulfillment Knowledge Base

我们管采购、仓储、物流履约。出事查 runbooks，大促看 peak-season，
供应商信息在 70-vendors。

## 快速入口 / Quick Links

- 新人入职 / Onboarding → [[10-onboarding/first-week]]
- 大促手册 / Peak Season → [[40-runbooks/peak-season/]]
- 日常异常 / Daily Ops → [[40-runbooks/daily/]]
- 供应商档案 / Vendor Profiles → [[70-vendors/]]
- 术语表 / Glossary → [[50-glossary]]

## 值班 / On-call

7×24 轮值，交接班必须过一遍当天的异常记录。
```

#### `40-runbooks/peak-season/double-11-checklist.md`

```markdown
---
type: runbook
owner: 老韩
last-verified: 2026-09-05
---

# 双 11 大促备战清单 / Double 11 Peak Season Checklist

**时间线**：T-30 天启动，T-1 天封网。

## T-30 至 T-14：准备期 / Preparation

- [ ] 各仓扩容方案确认（仓储组）
- [ ] 物流商运力锁定 + 备用物流商协议签署（物流组）
- [ ] 压测完成：WMS、OMS、TMS 峰值 3 倍（技术组）
- [ ] 客服工单分流规则更新（客服组）
- [ ] 供应商备货计划确认（采购组）

## T-14 至 T-1：演练期 / Drill

- [ ] 全链路压测（含降级切换）
- [ ] 值班表确认 + 值班权限检查
- [ ] 应急预案演练：[[logistics-failover]]、[[wms-degradation]]
- [ ] 封网：禁止非紧急变更

## T-0：大促当天 / Peak Day

- [ ] 0:00-2:00 高峰值班双人在岗
- [ ] 每 30 分钟巡检一次核心指标
- [ ] 异常处理：先查本目录 runbook，处理完回填

## T+1 至 T+7：复盘期 / Retrospective

- [ ] 异常事件逐条回填到对应 runbook
- [ ] 复盘会议输出 ADR（如有流程变更）
```

#### `40-runbooks/peak-season/logistics-failover.md`

```markdown
---
type: runbook
owner: 小赵
last-verified: 2026-09-05
---

# 主力物流商瘫痪切换手册 / Primary Carrier Failover Runbook

**触发条件**：主力物流商（默认中通）分拨中心瘫痪，预计恢复 >4 小时。

## 前置确认 / Prerequisites

1. 确认瘫痪范围：联系物流商区域经理，确认是分拨中心还是全网
2. 备用物流商协议已签署且运力确认（平时维护）
3. WMS 切换权限（值班组长以上）

## 步骤 / Steps

1. **锁定受影响订单**：WMS → 订单查询 → 筛选「已发货未揽收」+
   物流商=中通 → 导出清单
2. **通知客服**：[[40-runbooks/daily/logistics-exception]] 同步话术，
   客服侧提前准备应对用户咨询
3. **切换备用物流商**：WMS → 物流配置 → 切换默认物流商为「韵达」
4. **补发滞留订单**：对步骤 1 的清单逐单打回 → 重新分配韵达 → 重新发货
5. **监控切换后指标**：揽收率、妥投率 30 分钟内应恢复到基线 90%

## 验证 / Verification

- 新订单物流商已切换为韵达
- 滞留订单全部补发完毕
- 揽收率/妥投率恢复基线

## 回滚 / Rollback

主力物流商恢复后，切回默认配置。已发出的韵达订单不召回，
让两个物流商并行消化存量。

## 历史事件 / Past Incidents

| 日期 | 场景 | 耗时 | 备注 |
|---|---|---|---|
| 2026-09-04 | 演练：模拟中通瘫痪 | 30min | 小赵首次独立操作 |

## 相关链接 / Related

- [[double-11-checklist]]
- [[40-runbooks/daily/logistics-exception]]
```

#### `70-vendors/huadong-packaging.md`

```markdown
---
type: vendor-profile
owner: 仓储组
updated: 2026-09-02
---

# 华东纸箱厂 / Huadong Packaging Co.

## 基本信息 / Basic Info

- 对接人：张经理 / Manager Zhang
- 联系方式：138-xxxx-xxxx
- 账期：月结 60 天 / Net 60
- 起订量：5000 个 / MOQ 5000 units

## 历史合作记录 / History

- 2025-03 至今，供应各仓纸箱
- 2026-06 大促期间交货延迟 3 天，原因是原材料涨价排产紧张

## 注意事项 / Notes

- **旺季会偷偷降克重**：2025 年双 11 期间发现纸箱克重从 250g 降到 230g，
  未通知。旺季收货必须抽检克重。
- 交期承诺偏乐观，实际按承诺 +2 天做安全库存。
```

#### `30-decisions/0001-add-vendors-directory.md`

```markdown
---
type: adr
status: accepted
updated: 2026-09-01
---

# ADR-0001: 新增 70-vendors 目录 / Add 70-vendors Directory

## 背景 / Context

供应商对接信息（联系人、账期、历史坑点）散在微信聊天记录和
老员工脑子里。人一走，信息就丢。标准知识库骨架里没有合适的
位置放这类内容。

## 结论 / Decision

新增 `70-vendors/` 目录，一家供应商一页。这个目录不发布到公司
目录（manifest 里 visibility 保持 private），因为涉及商务条款。

## 后果 / Consequences

- 供应商信息有了唯一存放点
- 结构偏离标准骨架，但在本目录有 ADR 留痕
- 后续如有通用需求，可以推动骨架标准更新
```

#### `knowledge.manifest.yaml`

```yaml
version: 1
team: sc-fulfillment
title: 供应链履约组知识库 / Supply Chain Fulfillment Knowledge Base
summary: 采购、仓储、物流履约的 SOP、应急手册与供应商档案 / SOPs, runbooks, and vendor profiles for fulfillment
visibility: org
domains: [供应链, 仓储, 物流, 大促, Supply Chain, Logistics]
entry: 00-home.md
collections:
  - name: 新人必读 / Onboarding
    paths: [00-home.md, 10-onboarding/, 50-glossary.md]
  - name: 大促手册 / Peak Season Playbook
    paths: [40-runbooks/peak-season/]
  - name: 日常异常处理 / Daily Operations
    paths: [40-runbooks/daily/, 50-glossary.md]
# 注意：70-vendors/ 不在任何 collection 中 — 商务条款保密，
# 仅 payment-terms-public.md 单独发布
```

### 两个 vault 的对照速览

| 维度 | 增长运营组 | 供应链履约组 |
|---|---|---|
| 页面总数 | 12 篇 | 14 篇 |
| 最厚目录 | `20-domains/`（打法沉淀） | `40-runbooks/`（SOP 密集） |
| 特色目录 | 标准骨架够用 | 加了 `70-vendors/`（ADR 留痕） |
| 打捞频率 | 低（周 1-2 次） | 高（演练/大促期间每天） |
| 跨团队被引用 | 新客定义（CRM 组） | 物流异常手册（客服组）、术语表（大促运营组） |
| visibility | org（全部） | org（除 vendor 档案外） |
| freshness 驱动 | 季度数据更新 | 演练验证 + 大促实战 |
