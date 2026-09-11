# 内置 Skills 市场设计

> 目标落位：`docs/architecture/skills-marketplace.md`
> 状态：**已实现（P0–P3）** — 见 `docs/plans/2026-08-21-skills-marketplace.md`。
> 前置阅读：`docs/architecture/team-skills-registry.md`（下文简称「registry 文档」）。
> 本文只描述**市场**，registry 的表、API、自动跟随、脏改保护都当既有设施用，不重述。

## 1. 要解决什么

registry 已经能把一个 skill 分发给全团队，但**进入 registry 只有一个入口**：某个成员
自己盘上有一个 skill，走 `sharePersonalSkill`（`stores/team-share-browser.ts:1108`）打包
上传发成 v1。

于是一支新团队开箱是空的。他们要么自己写，要么去设置里的两个外部市场找——而那两个
市场装到的是**个人盘**，和团队 registry 毫无关系：

| 来源 | 实现 | 落点 |
|---|---|---|
| skills.sh | **扒 HTML**（`commands/skillssh.rs:353` 的 `parse_skillssh_html`）+ `npx skills add` | `~/.agents/skills`，个人 |
| ClawHub | `https://cn.clawhub-mirror.com` 的外部 API（`commands/clawhub.rs:5`） | `~/.agents/skills`，个人 |

两个都不受我们控制：页面结构一改抓取就死，镜像站一停市场就空，而且抓回来的条目**没有
registry 要求的那 6 个必填字段**（registry 文档 §6），引入团队时要人现场补一遍表单。

**本设计要做的是给 registry 补第二个入口**：一份我们自己策展的目录，条目天生带齐结构化
字段，一键成为团队 skill，并且**订阅上游**——目录发新版，团队跟着走。

**明确不解决**：个人安装。设置里的 ClawHub / skills.sh 面板原样保留，管的还是个人盘。
两者的关系见 §11 待定 #8。

## 2. 三个已定的取舍

设计开始前拍死的三条，后面所有结构都从这里长出来：

| # | 取舍 | 理由 |
|---|---|---|
| 1 | 目录是**第一方的、FC 托管的**，**只通过一套发布 API 管理**，和任何 git 仓库无关 | 目录内容要能随时改而不发版、self-host 要能自己策展而不 fork 我们的 repo。代价和补偿见 §5 |
| 2 | 引入后是**订阅式**，上游发版自动跟随到团队 `latest_version` | 上游是我们自己，不是任意 GitHub 仓库。信任前提成立，这条才成立——见 §9 的硬约束 |
| 3 | 订阅的**投影做在服务端**，客户端零改动 | 两条对账循环都打 `GET /v1/teams/:id/skills`，让市场的新版在那里就已经是团队的新版，下游什么都不用知道 |

第 3 条是本设计能便宜的全部原因，值得展开（§7.1）。

**git 在本设计里不出现在任何位置**——不是注册表、不在分发路径上、不被 FC 读取、不被产品
调用，目录内容也不以文件形式存在于任何仓库。整条链路是：发布 API → Postgres + 对象存储
→ FC → 签名 URL → 客户端。三条被排除的做法各自记着理由，免得被重新提出来：

**客户端直读仓库。** 私有仓库的读凭据要发到每台用户机器——内置一个 token 就不私有了，
现建一套按用户发 token 的服务比建两张表贵得多。而 `CLAUDE.md` 写死了「`git` is not
invoked anywhere in the product」，git share 是被**刻意删掉**的，重新引入意味着 Windows
上的 git 依赖、clone/pull 状态、浅克隆策略全都回来。

**把 git 当注册表本身**（不建目录表，FC 只拉一个 `index.json` 当索引）。算下来是负的：
省两张只读表的迁移，换来两个新环境变量、一个 CI bucket 密钥、一套 lockfile 加三道 CI
闸门、删除护栏从结构性退化成纪律、几百条的规模天花板，外加 FC 里一处「市场不走 repository
模式」的例外。

**内容即代码**（目录源放 `marketplace/`，CI 打到 FC）。这条曾是本文的 §5，换掉的理由是
耦合：目录内容改一个字要走一次 PR + 一次 CI，self-host 想有自己的目录得 fork 我们的
repo，而主仓库是 public 的、目录内容跟着公开与否又是另一个要单独决策的问题。**它带走了
两样必须补回来的东西——策展评审和撤回——由 §5 的两步发布和 revert 端点顶上。**

## 3. 方案总览

```
运维（持密钥）                      FC /v1                      客户端
─────────────────────────────────────────────────────────────────────────
发布 CLI / curl  ────────────────>  POST /v1/admin/marketplace/*
  zip + 6 个必填字段                   ├─ blob prepare/complete
                                       │    └─ 对象存储 team-skills/marketplace/blobs/…
                                       ├─ versions        建行，不生效
                                       └─ promote         latest_version 前进
                                       marketplace_skills                （不知道市场存在）
                                       marketplace_skill_versions
                                            │
浏览市场                      ──────>  GET /v1/marketplace/skills
引入团队                      ──────>  POST /v1/teams/:id/skills/adopt
                                         └─ 建 team_skills（订阅态）
                                            + team_skill_versions v1
                                            │
                                       GET /v1/teams/:id/skills  ←─── 每 10 分钟
                                         └─ 惰性对齐：订阅项落后就补一行
                                            │
                                            ▼
                                       现有自动跟随管线原样接手
                                       （签名 URL → 解压 → 回写 frontmatter →
                                         清单 → 判脏 → 换文件）
```

一句话：**市场不是一条新的分发管线，是往 registry 里写行的一个新写入者。**

## 4. 数据模型

新增两张表；包体进对象存储，**不进 `amuxc_blobs`**。

### 4.1 目录侧：两张新表

`marketplace_skills` —— 每个目录项一行

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | uuid pk | |
| `slug` | text unique | 全局唯一，`^[a-z0-9][a-z0-9-]{1,63}$` |
| `display_name` | text | |
| `publisher` | text | 第一方标识（品牌名 / 合作方），**不是用户** |
| `summary` / `category` / `when_to_use` / `when_not_to_use` / `requires` | | 与 `team_skills` **同构同名**，这是一键引入不用填表的原因 |
| `tags` | text[] | 检索用，和 `category` 分开：category 是枚举、可比较，tags 是自由词、可搜索 |
| `status` | text | `draft` \| `published` \| `delisted` |
| `latest_version` | int | |
| `created_at` / `updated_at` | | |

**刻意没有 `adopt_count` 这一列。** 「被多少个团队引入过」从 `team_skills` 数
（`count(*) where upstream_slug = X and origin = 'marketplace'`，走 §4.2 那个部分索引）。
存成计数列只会漂移，而这个数没有任何一条路径需要它是精确的实时值。

`marketplace_skill_versions` —— 追加式，结构照抄 `team_skill_versions`

| 列 | 说明 |
|---|---|
| `skill_id` / `version` | 唯一索引 `(skill_id, version)` |
| `content_hash` / `size` / `object_path` | 见 §4.2 |
| `changelog` | **必填**，和团队发版同一条规矩 |
| `summary` / `when_to_use` / `when_not_to_use` / `requires` | 快照冗余，理由同 registry 文档 §4 |

**不复用 `amuxc_blobs`。** 那张表按 `team_id` 隔离（`db/schema/oss-sync.ts:18`），目录不属于
任何团队。给它塞一行「无主 blob」会污染一张被团队文件同步共用的表，也会让它的 GC 面对
一类它没有设计过的行。目录版本行自己带 `object_path`，就够了。

### 4.2 包体存哪，以及一个必须写进代码的断言

包体和团队自己发布的包**共用同一个命名空间**，只是第一段路径不同：

```
team-skills/teams/<teamId>/blobs/sha256/<aa>/<bb>/<hash>   团队发布的包（已有）
team-skills/marketplace/blobs/sha256/<aa>/<bb>/<hash>      市场的包（本设计新增）
```

> **措辞要准：`SKILLS_STORAGE_BUCKET` 在两个后端上不是同一种东西。**
> `blobStorageFor`（`lib/team-blob-storage.ts:247`）分两条路——`TEAM_BLOBS_BACKEND=s3` 时
> 它是**共享桶里的 key 前缀**（self-host 的 MinIO、阿里云 FC 目标的阿里云 OSS 都走这条），
> 不设时才是 Supabase Storage 的**桶名**。所以「市场没有引入任何新存储」是字面成立的：
> 用的就是团队包体今天躺的那个命名空间。

**由此来的一条硬性要求。** `team-blob-storage.ts:26` 已经为团队包体和知识库 blob 记过同一
类账：

> their object paths are byte-identical (both content-addressed the same way), so without it
> a skill package and a knowledge blob would be the same object — harmless while both exist,
> **fatal the moment one side's GC deletes it out from under the other**.

同样的逻辑对 `marketplace/` 成立，而且更危险：市场的包**刻意不在 `amuxc_blobs` 里**（上一
小节），所以任何「扫 `team-skills` 命名空间、删掉 `amuxc_blobs` 里没有的对象」式的回收，
会把整片市场包静默删光，而症状要等到某个团队下一次安装才暴露。

落地时这是一句断言，不是一段代码：**blob 回收只允许按 `teams/<teamId>/` 前缀遍历，
`marketplace/` 前缀由目录侧自己负责。** 配一个测试锁住它。

### 4.3 团队侧：`team_skills` 加四列

```sql
alter table team_skills
  add column origin text not null default 'local',      -- 'local' | 'marketplace'
  add column upstream_slug text,                        -- marketplace_skills.slug
  add column upstream_subscribed boolean not null default false,
  add column upstream_detached_at timestamptz;

create index on team_skills (upstream_slug) where origin = 'marketplace';
```

那个部分索引是 §4.1「被多少团队引入过」的来源，顺带服务 §7.1 的对齐扫描。

`team_skill_versions` 加三列：

```sql
alter table team_skill_versions
  add column upstream_version int,                      -- 这一版对应市场的第几版
  add column blob_scope text not null default 'team',   -- 'team' | 'marketplace'
  add column object_path text;                          -- blob_scope='marketplace' 时必填
```

`blob_scope` + `object_path` 是**不复制包体**的开关。今天
`GET .../versions/:v/download` 走 `content_hash → amuxc_blobs(team_id) → oss_key → 签名`
（`pg-repo/team-skills.ts:586`）；订阅项走 `object_path → 签名`，同一个命名空间、同一个签名
函数（`lib/skills-storage.ts`），只是省掉了中间那次查表。

**`object_path` 写进团队自己的版本行、而不是每次回目录表查**，是刻意的：这一行一旦写下，
它的下载就再也不依赖目录项还在不在、`status` 是什么。§7.3 的优雅降级全靠这一条。

> **为什么不把目录包体复制进团队命名空间。** 那样这两列和下载解析器的分支都不用写，代价是
> 一个目录项被 N 个团队引入就在存储里躺 N 份完全相同的字节。整个 blob 层是内容寻址的、
> 存在的意义就是去重，让市场成为唯一一个反着来的写入者说不过去。而且 `BlobStorage`
> （`lib/team-blob-storage.ts:83`）现在只有 upload/download/stat/remove，没有 `copy`——
> 两个后端各加一遍复制实现，并不比加两列便宜。

## 5. 目录内容从哪来：一套发布 API

目录**没有源文件仓库，也没有后台管理界面**。它只有一套服务端 API，谁持有运维密钥谁就能写。

### 5.1 发版流程

包体上传照抄团队发布那条路（`commands/team_skills.rs:605`/`:650` 的
`skill-blobs/prepare` + `complete`），只是换了作用域：

```
① POST /v1/admin/marketplace/skill-blobs/prepare   { contentHash, size }
     ← { objectPath, requiresUpload, presignedPut }
② PUT  <presignedPut>  <zip 字节>                   （已存在的内容直接跳过）
③ POST /v1/admin/marketplace/skill-blobs/complete  { contentHash, size }
     HEAD 校验对象真的在，标记 verified
④ POST /v1/admin/marketplace/skills/:slug/versions
     { contentHash, size, changelog, summary, whenToUse, whenNotToUse, requires }
     ← 建 marketplace_skill_versions 行，published_at = null
⑤ POST /v1/admin/marketplace/skills/:slug/versions/:v/promote
     ← published_at = now，marketplace_skills.latest_version = v
```

**④ 和 ⑤ 分开是刻意的，它是本设计里唯一一处「第二双眼睛」。**

内容即代码时代，「写」和「生效」天然被一次 PR 合并隔开。纯 API 之后，如果发版是一次调用，
那**一次手滑就在 10 分钟内到达每一个订阅团队的每一台机器**（§7.1 的对齐周期）。两步把这个
窗口还回来：④ 之后版本行存在但惰性对齐看不见它（对齐读的是 `latest_version`，而
`latest_version` 只在 ⑤ 动），可以先拉下来验，验完再 ⑤。

代价是发版从一次调用变成两次。这是本设计接受的唯一一处仪式感。

### 5.2 撤回：一步，不是两步

```
POST /v1/admin/marketplace/skills/:slug/versions/:v/revert
  → 用 v 版的 blob 建一个新版本行，直接 promote 成 latest+1
  → changelog 自动填「撤回至 v{n}」
```

blob 是内容寻址的、历史版本全留着，所以这只是一次元数据写入，**零字节上传**。

**和发版刻意不对称：撤回不分两步。** 撤回是止血，让它慢没有道理。发版的两步是防手滑，
撤回本身就是在收拾手滑。

**这个端点是自动跟随的上线硬门槛**，理由见 registry 文档 §8.2 四——手动模式下坏版本的扩散
取决于每个人自己点，自动跟随把它压缩成一个对账周期。**没有撤回不能开订阅。**

**刻意不做 `latest_version` 回退**：那会让某些团队的 `installed_version > latest_version`，
`hasUpdate` 的比较立刻失去意义，对齐也说不清该升还是该降。只往前滚是唯一自洽的方向——这条
和 registry 内部的版本语义保持一致。

### 5.3 鉴权：一个共享密钥，fails closed

沿用 `lib/shared-secret.ts` 的 `sharedSecretMatches` + `x-webhook-secret` 头（
`PUSH_WEBHOOK_SECRET` / `CRON_TRIGGER_SECRET` 已经是这个模式），新增
`MARKETPLACE_ADMIN_SECRET`，作用域限死 `/v1/admin/marketplace/*`。

那个函数**在密钥未配置时全部拒绝**，注释里写清了为什么——`provided !== secret` 的朴素写法
会让未配置的部署把空头当成匹配，「看起来有守卫，实际全开」。对本设计这正好是想要的默认值：

> **不配 `MARKETPLACE_ADMIN_SECRET` = 这台部署没有市场。** 目录表空着、列表端点返回空、
> 客户端隐藏入口（§10.1）。这不是错误状态，是「没开这个功能」。

**新增环境变量：一个。** 必须同时进 `deploy/self-host/docker-compose.yml` 的
`environment:` 白名单和 `deploy/belayo/cloud-api.env.keys`，缺一个就在某一边静默丢失
（`CLAUDE.md` 的老规矩）。

> 上一版设计（内容即代码）在这里写的是「新增环境变量：零」。换成纯 API 之后那句话不再成立，
> 多的就是这一个密钥。

### 5.4 谁来调这个 API

**本设计不规定调用方，但必须有一个，否则目录永远是空的。** 这是落地时的第一件事，不是
可选项。倾向是一个运维 CLI：

```
pnpm marketplace:publish ./path/to/skill-dir --slug deploy-check --changelog "…"
```

读目录里的 `SKILL.md` + 一个 `catalog.yaml`（6 个必填字段），打 zip，跑完 ①–④，把 ⑤ 留给
人另外一条命令。**注意它和被否掉的「内容即代码」的区别**：这里 `catalog.yaml` 是 CLI 的
输入格式，不是仓库里的权威副本；skill 目录放在哪台机器的哪个路径都行，发完就没它的事了。

其他可能的调用方（都不排斥，也都不在 P0）：桌面端给运维账号开一个隐藏入口、或者干脆手工
`curl`。见待定 #2。

### 5.5 被换掉的两样东西，账要记清

| 内容即代码提供的 | 纯 API 之后 |
|---|---|
| 策展评审（两个条目职责是否重叠、`when_not_to_use` 写得对不对，在 diff 上判断） | **没有替代品。** 6 个必填字段仍由 API 校验，但那只管「填了没」，不管「填得对不对」 |
| 审计（`git log` / `git blame` 精确到人和时间） | 退化成 `marketplace_skill_versions.created_by` 一列，而且只到**密钥粒度**——密钥是共享的，记不到人 |
| 撤回（`git revert` 再发一版） | §5.2 的 revert 端点，语义等价 |
| 生效前的一道人为闸门（PR 合并） | §5.1 的 ④/⑤ 两步 |

前两行是真实的净损失，写在这里不是为了翻案，是为了目录内容多起来、开始互相打架的时候，
有人能翻到这一节知道当初的取舍在哪，以及补救的方向是什么（引入时的相似度提示，§13 P2）。

## 6. API

按 CLAUDE.md 规定的顺序：`docs/openapi/teamclu-api.v1.yaml` → `lib/repository-contract.ts`
→ `lib/routes/marketplace.ts` → `lib/pg-repo/marketplace.ts` → `services/fc/test/`
→ 客户端接线。

### 读侧（任何登录用户）

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/v1/marketplace/skills` | 目录列表，支持 `q` / `category` / `cursor`；带 `adoptedByTeam` 标记（传 `teamId` 时） |
| GET | `/v1/marketplace/skills/:slug` | 详情 + 版本列表 |

`adoptedByTeam` 让市场面板能直接显示「已引入 · 团队 v3 · 跟随中」，不用客户端自己 join。

### 引入与订阅（团队成员）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/teams/:id/skills/adopt` | `{ marketplaceSlug, slug?, version? }` → 建 `team_skills`（订阅态）+ v1 |
| POST | `/v1/teams/:id/skills/:slug/detach` | 断开订阅，停在当前版本，团队从此拥有它 |

`slug` 选填：目录 slug 和团队里已有的撞名时改个名引入，订阅仍然按 `upstream_slug` 成立
（见 §8 撞名）。

### 目录发布（`x-webhook-secret`，见 §5.3）

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/v1/admin/marketplace/skill-blobs/prepare` | 拿签名 PUT，已有内容直接跳过上传 |
| POST | `/v1/admin/marketplace/skill-blobs/complete` | HEAD 校验后标记 verified |
| POST | `/v1/admin/marketplace/skills` | 建目录项 |
| POST | `/v1/admin/marketplace/skills/:slug/versions` | 建版本行，**不生效** |
| POST | `/v1/admin/marketplace/skills/:slug/versions/:v/promote` | 生效：`latest_version` 前进 |
| POST | `/v1/admin/marketplace/skills/:slug/versions/:v/revert` | 撤回，一步到位（§5.2） |
| PATCH | `/v1/admin/marketplace/skills/:slug` | 改元数据 / `status=delisted` |

前两个是团队侧 `skill-blobs/prepare|complete` 的目录作用域孪生体，逻辑一样、只是对象前缀
不同（§4.2）。

**没有 `DELETE`。** 下架是 `delisted`，不是删行——见 §7.3。

**这一整组在密钥未配置时全部 401**（§5.3 的 fails-closed），所以一台没打算做市场的
self-host 不需要做任何事就是关着的。

### 改到的已有端点

- `GET /v1/teams/:id/skills` —— 加惰性对齐（§7.1），响应多两个字段 `origin` / `upstreamSubscribed`
- `GET /v1/teams/:id/skills/:slug/versions/:v/download` —— 按 `blob_scope` 分支签名
- `POST /v1/teams/:id/skills/:slug/versions` —— 对订阅项先断开再发版（§7.2）
- `PATCH /v1/teams/:id/skills/:slug` —— 订阅期间拒改快照字段（§7.2）

## 7. 订阅语义

这一节是本设计的正文，其余都是接线。

### 7.1 惰性对齐：不做主动推送

目录发版**不 fan-out**。对齐挂在 `GET /v1/teams/:id/skills` 的处理里：

```
对该团队每个 upstream_subscribed 的行：
  m = marketplace_skills[upstream_slug]
  若 m.status ≠ 'published' → 见 §7.3，不在这里处理
  若 (该行最新版的 upstream_version) < m.latest_version：
      插入 team_skill_versions 一行：
        version          = team_skills.latest_version + 1
        upstream_version = m.latest_version
        blob_scope       = 'marketplace'
        object_path / content_hash / size / 快照字段 ← 市场最新版那条
        changelog        = 合并跳过的各版
      team_skills.latest_version = greatest(latest_version, 新版本号)
      team_skills 的快照字段 ← 市场最新版
```

目录和团队数据在同一个库里，所以整段对齐和它所在的读请求共用一个事务——不存在「目录读到
一半」这种中间态。

对齐读的是 `latest_version`，而 `latest_version` **只在 promote 时前进**（§5.1）。所以一个
刚上传、还没 promote 的版本对这段逻辑完全不存在——这正是那两步想要的效果。

**为什么是惰性而不是推送。** registry 文档 §8.1 已经把这条论证做完了：「对账是主干，
MQTT 是加速器」。这里更极端一点——两条对账循环（桌面端
`components/TeamSkillAutoFollow.tsx`、daemon `runtime/team_skills.rs`）每 10 分钟都会打
这个端点，它天然就是一个覆盖所有在线团队的时钟。主动 fan-out 要写一遍遍历、一遍重试、
一遍补偿，换来的只是把最坏 10 分钟压缩成秒级；而没人在线的团队本来也没有交付对象。

唯一约束是**幂等 + 并发安全**：唯一索引 `(skill_id, version)` + `on conflict do nothing`，
写完重读 `latest_version`。多个客户端同时打这个端点是常态，不是异常。

**跳版只补最新一行。** 团队离线期间市场发了 v5、v6、v7，对齐只造一个团队版本指向 v7，
changelog 合并三段。团队的版本号数的是**交付次数**，不是上游的发布次数；造两个从没有人
跑过的中间版本，只会让版本历史更难读。1:1 镜像的另一种取法见待定 #1。

### 7.2 断开订阅：三种触发

| 触发 | 谁做 | 之后 |
|---|---|---|
| 团队成员在这个 skill 上发自己的版本 | 自动 | `upstream_subscribed=false`，保留 `upstream_slug` 做溯源展示 |
| 详情页「断开订阅」 | 手动 | 停在当前版本，团队从此拥有它 |
| 目录项下架或从索引中消失 | 自动 | 同上，并打标「市场已下架」（§7.3） |

第一条是必须的，而且理由和 registry 文档 §8.2 三是**同一条，只是高了一层**：那里保护的是
「盘上的手工修改不能被无人值守地覆盖」，这里保护的是「团队发布的版本不能被上游无人值守地
覆盖」。没有这一条，一个成员修好了目录里那一步错的流程、发成团队 v4，10 分钟后市场的 v7
就把它抹了——而且没有任何人看着。

**订阅期间元数据只读。** 对齐会用市场的快照覆盖 `team_skills` 的 summary / category /
when_to_use / when_not_to_use，所以订阅期间 `PATCH` 这些字段必须**拒绝**，UI 上做成禁用 +
一行「断开订阅后可编辑」。让人改了、下一个 tick 静默改回去，是比拒绝更坏的诚实度。

这不违反 registry 文档 §5「任何成员都能改」——他们仍然能改，只是要先按一下断开，而那一下
恰好就是这个状态本身。

### 7.3 下架不卸载

目录项 `status=delisted` 后：已引入的团队**保留**该 skill、自动断开订阅、详情页显示
「市场已下架，已转为团队自有」。不自动卸载、不自动装 `superseded_by`。

理由照抄 registry 文档 §8.2 二：让正在跑的流程突然失能，比多留一个废 skill 糟糕得多。
下架是给人看的信号，不是给机器执行的指令。

**`DELETE` 之所以不存在**（§6），也是这个原因——目录版本行是团队 `blob_scope='marketplace'`
版本的元数据来源，删掉它等于把别人已经装好的东西的出处抹掉。护栏做成结构性的（API 里压根
没这个动作）而不是纪律性的：想删得先去加一个端点，那个 PR 会被人看见。

即便如此，删了也不该炸——这就是 §4.3 让 `object_path` 落在团队自己的版本行上的意义：
包还在存储里，目录项消失只让它**不再更新**，不会让任何人手上的东西坏掉。

## 8. 引入与落盘：字节从哪来

### 8.1 引入（用户点一下）

```
点「引入团队」
  → POST /v1/teams/:id/skills/adopt { marketplaceSlug, version? }
      FC：读目录项 → 建 team_skills（6 个字段全部快照自目录项，
                     status='published'，origin='marketplace'，
                     upstream_slug=…，upstream_subscribed=true，
                     owner_actor_id=引入者）
        + 建 team_skill_versions v1（blob_scope='marketplace'，
                     object_path/content_hash/size 抄自目录版本行，
                     upstream_version=N，changelog=「引自市场 <slug> v N」）
  → PUT /v1/teams/:id/skills/:slug/install   给引入者自己记一笔（现有端点）
```

**零字节移动。** 客户端没有下载、没有打包、没有上传。对比 `sharePersonalSkill` 那条路
（`team_skill_pack_and_upload` 打 zip → prepare → PUT → complete → publish），差别是市场的
字节在运维发版那一刻就已经在存储里了（§5.1 的 ①–③），从来不需要经过用户的机器。

**默认给引入者装上。** 在市场里点「引入」的人显然是想要这个 skill 的，让他再去列表里找一遍
点安装是白走一步。团队其他成员照旧自助（registry 文档 §4：发布 ≠ 推送给所有人），团队
agent 走详情页的「安装到」选择器。

**撞名。** 目录 slug 和团队已有 slug 撞了，`adopt` 返回 409，UI 给两个出口：换个 slug 引入
（订阅按 `upstream_slug` 成立，和 slug 无关），或取消。**不做静默改名**——沿用
`SkillSlugTakenError` 在 `sharePersonalSkill` 里已经建立的交互。

### 8.2 落盘：现有管线，一行不改

这一段没有任何新代码，写在这里是因为「包到底怎么到我盘上的」是读者一定会问的问题，而答案
恰好也是「客户端零改动」这条主张的证据。

```
每 10 分钟对账 ──> GET /v1/teams/:id/skills        算出「该装 X v1」
              ──> GET …/versions/1/download        拿短时效签名 URL
              ──> GET <签名 URL>                    字节，直连对象存储
                                                    不经过 FC 业务 API
              ──> 解压 → 回写 frontmatter → 建安装态清单 → lockfile
                  → permission.skill → 落盘
```

桌面端：`components/TeamSkillAutoFollow.tsx` 起 tick →
`stores/team-share-browser.ts:738` 先 `resolveDownload(teamId, slug, version)` 拿到 `{url}`，
`:739` `invoke('team_skill_install', { downloadUrl: url, … })` → Rust
`commands/team_skills.rs:443` `client.get(&req.download_url)` 取字节 →
`extract_zip_to_dir`（`crates/teamclu-skillpack` 的路径穿越守卫）→ 回写 frontmatter →
`build_manifest`（**必须在回写之后**，registry 文档 §8.2 三）→ lockfile →
`permission.skill` → `~/.agents/skills/<slug>/`。

daemon（团队 agent）同构：`runtime/team_skills.rs:226` 调 `Backend::team_skill_download`
（trait 文档在 `backend/mod.rs:309` 写死了对应端点），`:232` 拿字节，落
`~/.amuxd/teams/<id>/cloud/skills/`——**不是** `~/.agents/skills`，两条对账循环共用一个安装
根目录会互删（registry 文档 §12 末尾）。

**「客户端零改动」是结构性的，不是承诺。** `team_skill_install` 的 `download_url` 是**入参**
（`commands/team_skills.rs:106`），Rust 安装端根本不知道 URL 从哪来；daemon 侧同理。服务端
`resolveDownload` 加一个 `blob_scope` 分支后返回形状完全不变（`{url, contentHash, size}`），
所以两端连「这个包来自市场」都不知道。

**`object_path` 客户端永远见不到**——它只在目录表、`team_skill_versions`、FC 三者之间流转，
客户端拿到的始终只是一个短时效签名 URL。daemon 那段代码的注释说明了为什么必须如此：

> The signed URL carries its own credentials; sending the daemon's bearer token to object
> storage would leak it to a third party.

## 9. 信任边界（订阅式成立的唯一前提）

订阅式自动跟随的意思是：**目录的发布者对每一个订阅团队的每一台机器有写权限**，延迟 10 分钟，
无人值守。这只在发布者是我们自己时可以接受。

纯 API 之后这条边界收缩成了一句话，而且比之前更锋利：

> **持有 `MARKETPLACE_ADMIN_SECRET` = 对所有订阅团队所有机器的写权限**，生效延迟一个对账
> 周期，无人值守。

比合并权限更危险的地方在于：密钥可以被复制而不留痕，没有第二个人天然在场，也没有 `git log`
能回溯是谁用的。**这个密钥的等级等同于生产数据库口令，不是一个「运维小工具的 token」**，
存放和轮换要按那个等级对待。

三条已经在设计里的对冲：

- **两步发版**（§5.1）——一次手滑不会立刻扩散
- **一步撤回**（§5.2）——扩散了能立刻止血，且是自动跟随的上线硬门槛
- **fails closed**（§5.3）——没配密钥的部署，这组端点全部 401，没有「默认开着」的状态

**写死一条约束：目录一旦开放外部投稿（fork PR），订阅式必须同时降级为「提示不自动」。**
两件事必须一起改，不能先开投稿再补开关。

在此之上的常规防线（都已存在，不新建）：

- 解压走 `crates/teamclu-skillpack` 的 `sanitize_zip_path` / `apply_zip_mode`，路径穿越已防
- `permission.skill` 写入沿用现有安装管线
- blob 回收的前缀边界（§4.2），配测试锁住
- 上传走 `prepare`/`complete` 两步（§5.1），`complete` 的 HEAD 校验挡住「登记了一个不存在
  的对象」——沿用团队发布路径已有的做法

## 10. 桌面端 UI

**入口在第二列 header，市场开在第三列主内容区。** 不是弹窗、不是设置页——目的地是团队，
入口就该在团队共享里，而市场是一个要横向比较很多条目的浏览行为，值得整个主内容区。

### 10.1 第二列：多一个按钮

`sidebar/TeamShareListColumn.tsx` 的 header 现在是 `刷新 / (+) / 搜索` 三个 `h-7 w-7` 的
ghost 按钮。`section === 'skills'` 时在刷新左边插一个：

- 图标 `Store`
- title「浏览市场」
- 点击 `openDetail({ kind: 'marketplace' })`
- 市场打开时按钮走常规选中态。**不用 coral**——`AGENTS.md` 规定 coral 是品牌强调色、每屏
  最多两处，一个常驻入口按钮不配占用它
- **目录为空时整个按钮不渲染**（没配 `MARKETPLACE_ADMIN_SECRET` 的部署恒定是这个状态，
  §5.3）。不是禁用态——一个点开只有空列表的入口，比没有这个入口更让人困惑

### 10.2 第三列：市场面板

`lib/tabs/teamshare-target.ts` 的 `TeamShareTarget` 联合加两个成员：

```ts
| { kind: 'marketplace' }
| { kind: 'marketplace-item'; slug: string }
```

`encodeTeamShareTarget` / `decodeTeamShareTarget` / `teamShareSectionForTarget` 三处跟着加
分支（后者返回 `'skills'`，让左导航的 Skills 行保持高亮）。`TeamShareTabContent.tsx` 里
`kind === 'marketplace'` 渲染新的 `MarketplacePane`。

**列表视图**

```
header    Store 图标 · 「Skills 市场」· 搜索框 · 分类下拉
行         name  ·  slug(mono)  ·  summary 一行截断
           右侧：未引入 → [引入团队]
                 已引入 → Check(muted) + 「团队 v3 · 跟随市场 v7」
                 已引入已断开 → 「已断开」(muted)
```

**详情视图**（同一面板内的二级视图，不占列表位）

```
标题     display_name + slug(mono) + publisher
元数据   category · 市场 v7 · 更新时间 · 已被 N 个团队引入
正文     summary
         何时使用        ← when_to_use
         何时不要用      ← when_not_to_use
         依赖            ← requires（有才显示）
版本     版本列表 + changelog，可展开
操作     [引入团队]（已引入时降级为「已在团队里」+ 跳转到团队详情）
```

**「何时不要用」必须和「何时使用」视觉并列**，理由和 registry 文档 §9.3 完全一致，而且在
市场里更重要：在团队详情页读它是为了用对，在市场里读它是为了在两个相似条目之间做选择——
藏起来就等于没填。

**离线。** 目录拉不到时显示上次的缓存 + 一个「离线」标记，**不显示空列表**。这条沿用
`runtime/team_cloud_config.rs` 立下的「失败不缩水」规矩：一次拉取失败永远不能被读成
「目录空了」。

### 10.3 团队 skill 详情页的订阅态

`teamshare/SkillDetail.tsx` 加四处：

- 标题旁一个「市场」徽标（`origin === 'marketplace'`），点它跳回市场详情
- 版本行旁一行 muted 小字「跟随市场 v7」或「已断开 · 停在市场 v5」
- 订阅期间元数据表单禁用 + 「断开订阅后可编辑」；「断开订阅」放次操作位
- 发新版按钮**加一次确认**：「发布团队版本会断开与市场的订阅，之后市场更新不再自动同步」

## 11. 待定问题

| # | 问题 | 倾向 |
|---|---|---|
| 1 | 跳版时补最新一版还是 1:1 镜像上游每一版 | 只补最新（§7.1）。1:1 的好处是团队版本号和市场版本号有稳定双射，代价是制造从没交付过的版本 |
| 2 | 发布 API 的调用方做成什么 | 倾向一个运维 CLI（§5.4）。桌面端隐藏入口、手工 curl 都不排斥，但 P0 必须至少有一个，否则目录是空的 |
| 3 | 引入是否默认给引入者安装 | 倾向默认装（§8.1）。反方意见：管理员替团队引入但自己不想要 |
| 4 | 团队改了 slug 后，怎么表达「和市场那条是同一个」 | 详情页显示 `upstream_slug`；列表里是否也要显示待定 |
| 5 | 现有 blob 回收到底怎么遍历 | §4.2 那条断言要落成测试，先得确认今天的回收路径是按 `teams/<id>/` 走还是按整个命名空间走 |
| 6 | 密钥怎么轮换 | `sharedSecretMatches` 只认一个值，轮换期没有双密钥窗口。发布是低频动作，短暂停机可能可以接受——但要确认 |
| 7 | 多品牌（belayo / copilot361）的目录 | 各自的 FC 各自一份目录表、各自一个密钥，天然隔离。要不要有跨品牌同步一份「通用条目」的机制待定 |
| 8 | 设置里的 ClawHub / skills.sh 面板何时退役 | 目录内容长到能覆盖常用场景之前不动；skills.sh 的 HTML 抓取是第一个该退的（最脆） |
| 9 | 目录项能不能声明「只对某些平台可用」 | `requires` 已有位置（registry 文档 §4），但市场列表要不要按当前平台过滤待定 |

## 12. 明确不做

- 外部投稿 / 用户发布到市场（见 §9，这条一破，订阅式必须同时改）
- 市场里的付费、评分、评论
- 跨团队 / 组织级的私有市场
- 市场条目的在线编辑器（发布是一次 API 调用，编辑器是调用方的事）
- 个人安装走市场（保留给设置里的现有面板，见待定 #8）
- **任何形式的 git 参与**：客户端直读仓库、git 当注册表、内容即代码。三条都在 §2 里连
  理由记着，免得被重新提出来
- 目录的后台管理界面（只有 API，见 §5）
- 管理员审核流程（两步发版不是审核，是防手滑；真正的审核需要一个现在不存在的人）

## 13. 分期

**P0 — 能看能引（快照式，先不订阅）**
- 两张目录表 + `GET /v1/marketplace/skills{,/:slug}`
- 发布 API 全套（§6 那七个）+ `MARKETPLACE_ADMIN_SECRET` 进两处白名单
- **撤回端点**（§5.2）——它是 P1 订阅的硬门槛，放 P0 做掉，别拖
- 一个能调这个 API 的东西（§5.4），否则目录永远是空的
- `team_skills` 四列 / `team_skill_versions` 三列的迁移
- `POST /v1/teams/:id/skills/adopt`（写 `upstream_subscribed=false`）
- 下载解析按 `blob_scope` 分支 + §4.2 的回收前缀断言与测试
- 第二列入口 + 第三列 `MarketplacePane`（列表 + 详情 + 引入）

到这里已经能用：市场能浏览、能一键成为团队 skill、现有自动跟随把它铺到全团队。

**P1 — 能跟随**
- 惰性对齐（§7.1）
- 断开订阅的三种触发（§7.2）+ 订阅期间元数据只读
- `SkillDetail.tsx` 的订阅态、断开按钮、发版确认

**P2 — 能治理**
- `delisted` 语义（§7.3）
- 「已被 N 个团队引入」（从 `team_skills` 数，不存计数列）
- `POST /v1/admin/marketplace/align` 加速（只削延迟，不是正确性的一部分，见 §7.1）
- **引入时的相似度提示**（复用 registry 文档 §6 的相似度检查）——这是 §5.5 里那两样净损失
  唯一的补救方向，优先级比它在 P2 里的位置看起来要高

**P3 — 收摊**
- skills.sh 的 HTML 抓取退役（`commands/skillssh.rs`）
- 目录内容按平台过滤（待定 #9）
