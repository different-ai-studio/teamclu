# App 文件存储 — 一个 bucket、每 app 一个前缀，与它的权限模型

- **Date**: 2026-09-09
- **Status**: **已实施**（2026-09-09，三个阶段一次做完）。决策逐条落定见 §9；§2.4 的云配额已实测并修正了两处初稿结论；§12 的验收标准已在真实账号上跑过。实施中偏离本稿的两处写在 §13。
- **Path**: `docs/specs/2026-09-09-app-storage-design.md`
- **Scope**: 给每个 app 一块可存放文件的 OSS 空间：控制面里能浏览/上传/下载/删除，部署后的 app 运行时能读写自己那块。含 bucket 划分、key 布局、凭证形态、权限档位、配额计量、删除语义。
- **Builds on**: `docs/specs/2026-08-27-apps-first-class-design.md`（控制面、`view`/`prompt`/`admin` 三档、§7.2 删除语义）、`docs/specs/2026-08-27-app-data-browser-design.md`（控制面里操作线上资源的既有形状）
- **Non-goals**: 图片处理与缩略图、CDN 与自定义分发域名、跨 app 共享文件、对象版本历史、本地开发时的存储模拟、把 team 知识库的 blob 迁进来

> 沿用同系列的规矩：**所有对现网行为的陈述都带 `file:line`，实现时以代码为准，不以本文为准。**
> 唯一的例外是 §2.4 的云厂商配额——代码里查不到，已于 2026-09-09 用只读 API 在
> 线上账号实测，实测值与初稿的两处出入写在原地。

---

## 1. 现状（已核对代码）

### 1.1 OSS 今天只放一件东西

app 相关的 OSS 对象只有一个，就是构建产物：

```
apps/<appId>/code.zip
```

由 `appOssObjectName()` 生成（`services/fc/src/lib/provisioning/app-deploy.ts:141`），
daemon 用一个 30 分钟有效期的预签名 PUT 上传（`services/fc/src/index.ts:101-102`），
FC 从同一个 key 读代码（`fc-client.ts:149-150`）。

**没有任何"应用的用户数据"存在 OSS 上。** 这是一块空地，不是改造。

### 1.2 「靠前缀分隔租户」是仓库已经表过态的原则

`services/fc/src/lib/team-blob-storage.ts:24-30` 的模块注释写死了它：

> On S3 everything shares ONE bucket (`BUCKET`) and is separated by key prefix,
> so a deployment needs exactly one bucket to provision and one policy to reason about

**但线上实际是两个 bucket**（2026-09-09 实测，见 §2.4）：

| bucket | 由谁解析 | 装什么 |
|---|---|---|
| `teamclu-app` | `APPS_OSS_BUCKET`（apps profile，§1.3） | `apps/<appId>/code.zip` |
| `teamclu-self-host-storage` | `BUCKET`（默认 profile） | `team-blobs/`、`team-skills/` |

两者都在 `cn-shenzhen`，账号 `1457752404144823`。注释写的是那套代码自己的取舍，
不是整个部署的形状——引用它时要按"**同一个 bucket 内靠前缀分隔租户**"来理解，
而不是"全世界一个 bucket"。

**app 文件落在 `teamclu-app`**，也就是 apps profile 解析出来的那个，与 `code.zip`
同 bucket 不同顶层前缀（§3.1）。理由见 §1.3：apps profile 和默认 profile 在
self-host 上可以是两套凭证、两个 endpoint，跨过去就会 403。

### 1.3 凭证：apps 用的是独立 profile，不是默认那把

`resolveAppsOss()`（`provisioning/apps-oss.ts:58`）解析出 `AppsOssProfile`。
两种形态：

| 形态 | 触发条件 | 说明 |
|---|---|---|
| 专用 profile | `APPS_ACCESS_KEY_ID` 非空 | self-host 的形状。**不继承** `ENDPOINT` / `S3_FORCE_PATH_STYLE`，因为默认那套指向 MinIO |
| 共享 profile | 未设 | 阿里云 FC target，一个账号管全部 |

`appsRegion()`（`apps-oss.ts:47`）同时决定函数所在区和代码 bucket 所在区——
**FC 只能从同区的 OSS bucket 加载代码**，所以这是一个旋钮而不是两个。
新增的文件存储必须复用同一个 profile 和同一个 region，否则会出现"代码在 A 区、
文件在 B 区"的部署，而这个错误只会在 FC API 内部报出来。

### 1.4 app 运行时的凭证是在 finalize 时注入 env 的

`finalizeDeploy()`（`app-deploy.ts:239-281`）组装 env 后交给 `ensureFunction`
（`fc-client.ts:165` / `:195` 的 `environmentVariables`）。今天注入的是
`PORT` / `NODE_ENV` / `DATABASE_URL` / platform OAuth 那几个。

**Postgres 那套是本设计要照抄的形状**：一个共享库 → 每 app 一个 schema →
每 app 一个只能看自己 schema 的登录角色（`app-postgres.ts:38-46`，`search_path`
被钉死）→ 密码每次部署重置（`app-postgres.ts:28-31`，注释解释了不重置会怎么坏）
→ 通过 `DATABASE_URL` 注入。

存储的对应物就是：一个共享 bucket → 每 app 一个前缀 → 每 app 一份只能碰自己前缀
的凭证 → 通过 env 注入。**同构是刻意的**：运维只需要理解一套心智模型。

### 1.5 权限判据已经存在，不要另起一套

`resolveAppCallerPermissionForApp()`（`supabase-repo.ts:3696-3725`）返回
`view` / `prompt` / `admin`，并且**创建者恒为 `admin`**（`:3709-3711`）。
`app_member_access` 表在 baseline 里
（`services/supabase/migrations/20260601000000_baseline.sql:4138`）。

一个必须知道的边界：**agent actor 拿不到 per-app 授权**——`app_member_access`
是按 `amux.members` 建的，agent 不是 member。`supabase-repo.ts:3761-3767` 的注释
已经写明并接受了这一点，git credential 那条路因此走的是 team-scoped 的粗粒度授权。
本设计沿用同一处理，见 §4.4。

---

## 2. 决策一：一个 bucket，每 app 一个前缀

**不是一个 app 一个 bucket。**

### 2.1 三条理由

1. **bucket 是 region 级稀缺资源，而 app 是用户随手创建的对象。** 实测每 region
   上限 100（现用 2），可调但**单次增量不得超过 100**（§2.4）——也就是说这个上限
   不是"提一次工单就解决"，而是每多 100 个 app 提一次工单。撞配额的时刻是
   "创建 app"或"首次部署"，这是最难向用户解释、也最难降级的失败点。前缀方案没有
   这个上限。
2. **它会给 provisioning 加一条新的失败路径。** 建 bucket 需要给 apps 那把 key
   加上 `oss:PutBucket`，这比"在一个已知 bucket 里读写对象"大一个数量级的权限；
   同时多出"bucket 建了但 app 行没写成"这类需要对账的中间态。
   `docs/specs/2026-07-28-app-types-design.md` §2 已经因为同样的理由否掉过
   "静态类型走 OSS 静态网站托管"——原话是"会多出第二条部署路径、第二套失败模式"。
3. **和 §1.2 的既定原则一致。** 团队知识库、skill 包、app 产物都在一个 bucket 里
   靠前缀分开。app 文件没有理由成为唯一的例外，而一个例外意味着运维要同时理解
   两种布局。

### 2.2 per-bucket 真正赢的地方，以及怎么补

诚实列出来，避免后面被当成"没想到"重新提起：

| per-bucket 的优势 | 前缀方案的补法 |
|---|---|
| 用量/计费天然按 bucket 统计 | **这是唯一的实际代价**，必须自己记账，见 §5 |
| 凭证泄漏的爆炸半径限于一个 app | 用前缀受限的 STS 策略解决，不需要 bucket 边界，见 §4.1 |
| 单 app 数据整体导出/交接 | 少数场景，用 §2.3 的逃生舱 |
| 独立的 CORS / 防盗链 / 静态网站配置 | 本轮 Non-goal；真要做时也用 §2.3 |

生命周期规则（自动清理临时文件）**不构成** per-bucket 的理由：OSS 的 lifecycle
rule 原生支持按 prefix 匹配。

### 2.3 逃生舱：`apps.oss_bucket`

`amux.apps` 加一个 nullable 的 `oss_bucket` 列。null = 共享 bucket（全部现存 app）。
**key builder 从 app 行里读 bucket，而不是读常量**——这一条即使第一版永远只写 null
也要做到，否则将来"给某个大客户单独一个 bucket"是一次跨全代码库的改造，而现在只是
一行数据。

### 2.4 外部约束（2026-09-09 实测，非传闻）

下面的数字决定了 §2.1 的第 1 条。**已经拿线上账号 `1457752404144823` 实测过**
（只读 API：`GetCallerIdentity` / OSS `ListBuckets` / RAM `GetAccountSummary` /
Quotas `ListProductQuotas ProductCode=oss` / RAM `ListRoles`），结果如下：

| 约束 | 实测值 | 现用量 | 备注 |
|---|---|---|---|
| OSS bucket 上限 | **100，且是「每 region」不是「每账号」** | 2 | `QuotaActionCode=bucketlimit`，可调，**但单次调整增量不得超过 100** |
| RAM 用户上限 | 5000 | 2 | 比传闻的 1000 宽 |
| RAM 角色上限 | 1000 | 22（全是阿里云服务关联角色） | |
| **自定义策略上限** | **1500** | **0** | per-app 方案真正的天花板，见下 |
| 每用户 AK 数 | 2 | — | 决定 AK 轮转的操作空间 |
| 每用户可附加策略数 | 10 | — | |
| STS token 最长有效期 | **43200（12h），已验证** | — | 建 `teamclu-app-storage` 时按 43200 申请，被接受；实测 `AssumeRole` 拿到 12 小时后过期的凭证 |

**两处修正了本文初稿：**

1. bucket 上限是**每 region 100**，不是每账号 100。听上去更宽，实际结论更硬：
   调整"单次增量不超过 100"，也就是说要撑到 5000 个 app 需要提 49 次工单。
   per-bucket 方案不是"配额可以提"，是"配额只能一格一格地提"。
2. RAM 用户上限是 5000 不是 1000。但这不救 per-app RAM 用户方案——**真正的天花板
   是自定义策略的 1500**：每个 app 要一条前缀受限的策略，1500 个 app 就到顶，
   而且每个用户最多只能附加 10 条策略、每个用户最多 2 把 AK（轮转时要腾挪）。
   per-app RAM 角色同理，天花板 1000。

**STS 有效期已确认为 12 小时**：建角色时按 43200 申请被直接接受。这一条本来也不影响
设计——即使只有 1 小时，方案只是刷新更频繁，而刷新逻辑无论如何都要写（红线 3）。

> **实测中发现的一个独立问题——已于 2026-09-09 当天修掉**
>
> `GetCallerIdentity` 曾返回 `IdentityType: "Account"` / `Arn: acs:ram::…:root`
> ——**self-host 的 `.env` 里放的是主账号 AccessKey**。FC 容器（以及任何能读到那个
> `.env` 或容器 env 的东西）因此持有整个阿里云账号的完全控制权，远不止 OSS。
>
> **现状**：已换成 RAM 用户 `teamclu-selfhost`，附自定义策略
> `teamclu-selfhost-fc-oss`——OSS 仅限 `teamclu-app` / `teamclu-self-host-storage`
> 两个桶的对象操作与列举，FC 仅限 `acs:fc:cn-shenzhen:<account>:*`，其余（RAM、
> ECS、RDS、DNS、账单）一概没有。盒子 `.env` 的四个变量
> （`ACCESS_KEY_ID` / `ACCESS_KEY_SECRET` / `APPS_ACCESS_KEY_ID` /
> `APPS_ACCESS_KEY_SECRET`）与 GitHub 环境 `self-host-production` 的
> `TEAMCLAW_ALIYUN_*` 两处都已换。
>
> **两处一起换是必须的**：`self-host-deploy.yml:119-120` 每次部署都会把 GitHub
> secret 同步回盒子 `.env`（`sync_env ACCESS_KEY_ID`），只改盒子会在下一次部署被
> 覆盖回去。`APPS_ACCESS_KEY_*` 不在同步列表里，只活在盒子上。
>
> **仍待人工完成**：禁用主账号那把旧 AK。主账号 AccessKey 没有 OpenAPI，只能在
> 控制台「AccessKey 管理」里做。旧值仍留在盒子的
> `.env.bak.before-ak-rotation-20260909`（已 chmod 600）里以备回滚。

---

## 3. Key 布局

### 3.1 两个顶层前缀，因为删除语义不同

```
apps/<appId>/code.zip          ← 已有：控制面产物。删 app 时真删
app-files/<appId>/<path...>    ← 新增：应用的用户数据。删 app 时保留
```

**不要写成 `apps/<appId>/files/`。**

first-class 设计稿 §7.2 已经定了删除语义：FC 函数、HTTP 触发器、`code.zip`、
GoTrue OAuth client **真删**；Postgres schema 与角色**保留**，理由是"里面是用户
自己的业务数据，删了不可逆而我们没有备份"。app 文件属于后者。

今天的 teardown 删的正是 `appOssObjectName(appId)` 这一个对象
（`app-delete.ts:114-116`）。如果用户数据是 `apps/<appId>/` 的子树，那么"把这个
前缀整个清掉"这个迟早有人会写的清理动作，会连用户文件一起抹掉。分成两个顶层前缀，
让"删产物"和"留数据"在 key 空间上**不可能**搞混——这不是靠代码纪律，是靠布局。

### 3.2 路径规则

- `<path...>` 是应用自己定义的相对路径，允许多级目录，允许 `/`。
- 服务端必须拒绝的：绝对路径、`..` 段、空段、以 `/` 开头、超过 1024 字节的 key、
  控制字符。校验放在 key builder 里，**不是**放在每个调用点。
- 在 HTTP 路径里传对象路径时，一律用 **base64url 编码的不透明串**，与数据浏览器的
  `:rowKey` 同一手法（`routes/apps.ts:129-131` 的注释解释了为什么：值里含 `/`
  也要能活过一个 path segment）。同一个仓库里同一个问题只该有一种解法。

---

## 4. 权限：四类主体，两套机制

### 4.1 部署后的 app 运行时 → STS，前缀受限

**不能把 apps profile 那把长期 AK 注进函数 env**，尽管这最像今天注入
`DATABASE_URL` 的做法。那把 key 能读写**每一个** app 的前缀，还能读写每一个 app
的 `code.zip`。而 app 的代码是 agent 写的、用户一键部署的——等于把跨租户读取权
交给 LLM 产物。这是真正的租户隔离破口，不是理论风险。

**做法**：一个共享 RAM 角色（`APPS_STS_ROLE_ARN`），`AssumeRole` 时传 session
`Policy`，把有效权限收窄到该 app 的前缀。有效权限 = 角色策略 ∩ session 策略。

```
Resource: acs:oss:*:*:<bucket>/app-files/<appId>/*
Action:   oss:GetObject, oss:PutObject, oss:DeleteObject, oss:ListObjects(带 prefix 条件)
```

一个角色、一条策略，app 数量无上限。对照被否的两条：per-app 的方案要给每个 app
一条自定义策略，实测上限 1500（§2.4）；per-app 角色的上限是 1000；而每个 RAM 用户
只能有 2 把 AK，轮转时没有腾挪空间。

**前置条件（§2.4 末尾）**：`AssumeRole` 的前提是有一个受限主体去 assume。这一条
**已经满足**——2026-09-09 已把主账号 AK 换成 RAM 用户 `teamclu-selfhost`。实施时
要给它的策略补上 `sts:AssumeRole`（当前策略只有 OSS + FC，没有 STS）。

**三条实施红线**：

1. **必须有一个断言生成的 policy JSON 字符串的单测。** policy 写错不会报错，
   只会静默地放开跨 app 读取——没有任何运行时信号。这条测试是这个方案唯一的守卫。
2. `ListObjects` 的前缀限制要写成条件（`oss:Prefix`），只在 Resource 上限制
   bucket 对 List 类操作是不够的。
3. token 过期时间要回传给 app，让它在过期前刷新；**不要**让 app 靠 403 来发现过期。

**这里引入了 FC 今天没有的东西：app 自己作为 API 调用方。**

现有的 `deployToken` 不是反例——它是存在 app 行上的一次性 nonce
（`supabase-repo.ts:3392`、`:3450`），`finalizeDeploy` 仍然跑在**用户 JWT** 下并
调用 `resolveAppCallerPermissionForApp`（`:3448`）。也就是说 FC 至今没有"app 本身"
这个认证主体。

新增它的具体形状：

- deploy 时生成 app 专属 token，密封进 `amux.app_secrets`（kind 取 `storage_token`；
  `seal()` 把 kind 当 AAD 绑定，`app-secrets.ts:41-53`），同时写进函数 env。
- **每次 finalize 都重新生成**，和 DB 密码同样处理（`app-postgres.ts:28-31` 那段
  注释解释了"只在创建时设一次"会怎么坏：第二次部署起，注入的凭证从未被应用过）。
- 该路由**不经过用户 JWT、不经过 RLS**，所以必须用 service role 自己做授权：
  常量时间比较、失败不区分"app 不存在"和"token 不对"、失败要记事件但不记 token。
- 这是本设计**最大的一处新增攻击面**，评审时请单独看 §10。

### 4.2 控制面里的人 → `app_member_access` 三档

形状对齐数据浏览器（`routes/apps.ts:133-171`），档位对齐 first-class §5.2：

| 档位 | 能做 | 不能做 |
|---|---|---|
| `view` | list、下载（签名 GET） | 写入 |
| `prompt` | + 上传、删除单个对象 | 改配额、批量清空 |
| `admin` | + 改配额、批量清空、看用量明细 | — |

**授权继续留在 repository 层**，复用 `resolveAppCallerPermissionForApp`，
不要在 route 层另起一套判断——`routes/apps.ts` 里现有的路由全都只做参数解析
和 404，这个分工要保持。

### 4.3 站点访客 → 第一版不做公开前缀

访客的授权是 app 自己的业务逻辑（`authMode`），他们永远不接触 OSS 凭证：
要么由 app 服务端代取，要么由 app 服务端换一个短期签名 URL 再重定向。

**第一版不提供 `app-files/<appId>/public/` 这样的公开可读前缀。** 理由是
first-class §7.4 记录过的同一类事故：用户在控制面把 app 改成"需要登录"，会认为
站点此刻已受保护——如果文件走的是公开前缀，它们仍然公网可取，而这个落差没有任何
界面会提示。安全预期落空比功能不生效严重。

真要公开分发（头像、静态资源）时单独立项，连同 CDN 与防盗链一起设计。

### 4.4 agent / daemon

`app_member_access` 按 `amux.members` 建，**agent actor 不可能持有 per-app 授权**
（`supabase-repo.ts:3761-3767`）。所以 agent 要读写 app 文件，只能走与 git
credential 相同的 team-scoped 粗粒度路径：该 app 所属 team 里的任一 agent actor
均可。

这比 member 规则粗，**是有意接受的**，和 git credential 那处保持一致。
不要为存储发明第二套 agent 授权模型。

---

## 5. 配额与计量：说清楚代价

OSS 按 bucket 计量，**没有按前缀的原生用量统计**。这是 §2.2 里认下的那笔账。

**不要在 PUT 路径上同步扣配额。** app 通过 STS 直写时我们根本不在链路上，同步配额
是假的——它只会拦住走控制面的那一小部分写入，给人一种配额生效了的错觉。

做法是**异步计量 + 在发凭证时卡**：

1. 定期 `ListObjectsV2` 扫该前缀（1000 key 一页，很便宜），或用 OSS Inventory，
   把结果写进 `apps.storage_bytes` + `apps.storage_counted_at`。
2. 超配额时**拒绝再签发带写权限的 STS token / 预签名 PUT**，而不是拒绝某一次 PUT。
3. **一致性是最终一致的，这句话要写进列的 comment 里**，否则下一个人会以为配额是
   硬的，并在此之上做出错误的产品承诺（比如按用量计费）。

`apps.storage_quota_bytes` 为 null 时取部署级默认值（`APPS_STORAGE_QUOTA_BYTES`），
这样调整全局默认不需要回填每一行。

---

## 6. 生命周期与删除

| 事件 | 对 `app-files/<appId>/` 的处理 |
|---|---|
| 删除 app | **保留**，与 Postgres schema 同等待遇（first-class §7.2） |
| 重新部署 | 不动。文件与代码版本无关 |
| 超配额 | 不删，只停止签发写凭证（§5） |
| app 主动清理临时文件 | 用前缀维度的 lifecycle rule，`app-files/<appId>/tmp/` 之类 |

`app-delete.ts` 的 teardown **只删 `appOssObjectName(appId)` 这一个对象**，
现在已经是这个行为（`:114-116`），本设计要求它保持不变，并在该处加一行注释说明
`app-files/` 前缀是**故意不删**的——否则下一个读这段代码的人会以为是漏了。

删除对话框的措辞同步补一句"上传的文件会保留"，与 §7.3 已有的"数据库保留"并列。

---

## 7. 接口

全部挂在 `/v1/apps/:appId/storage/` 下，先在 `docs/openapi/teamclu-api.v1.yaml`
定契约（CLAUDE.md 规定的顺序）。

| 方法 | 路径 | 主体 | 最低档位 |
|---|---|---|---|
| GET | `/v1/apps/:appId/storage/usage` | 人 | `view` |
| GET | `/v1/apps/:appId/storage/objects?prefix=&after=&limit=` | 人 | `view` |
| GET | `/v1/apps/:appId/storage/objects/:key/url` | 人 | `view` |
| POST | `/v1/apps/:appId/storage/sign-upload` | 人 | `prompt` |
| DELETE | `/v1/apps/:appId/storage/objects/:key` | 人 | `prompt` |
| POST | `/v1/apps/:appId/storage/purge` | 人 | `admin` |
| PUT | `/v1/apps/:appId/storage/quota` | 人 | `admin` |
| POST | `/v1/apps/:appId/storage/sts` | **app 自己**（§4.1） | — |

`:key` 是 base64url 编码的对象路径（§3.2）。`sts` 那条是唯一不接受用户 JWT 的路由，
它在 OpenAPI 里要用不同的 security scheme 标出来，不能和其余混在一起。

---

## 8. 配置与迁移清单

**迁移**（`amux.apps` 加列，全部 nullable，无回填）：

```sql
alter table amux.apps
  add column if not exists oss_bucket text,
  add column if not exists storage_bytes bigint,
  add column if not exists storage_counted_at timestamptz,
  add column if not exists storage_quota_bytes bigint;
```

注意 `docs/specs/` 同系列踩过的坑：self-host 的迁移角色是 `postgres` 而非
CI 的 `supabase_admin`，`add column if not exists` 在非 owner 下即使无事可做也会
报错——**要用存在性判断包起来**。

**新增 env**（`APPS_STS_ROLE_ARN`、`APPS_STORAGE_QUOTA_BYTES`）：

按 CLAUDE.md 的部署约定，**必须同时**声明在 `services/fc/s.yaml` 和
`deploy/self-host/docker-compose.yml` 的 `fc:` 服务 `environment:` 白名单里，
漏一边会在其中一个 target 上静默缺失。`services/fc/test/deploy-env-parity.test.ts`
会守住这一点；**注意不要引入 `FC_` 前缀的变量名**，那是 Alibaba FC 的保留前缀，
会让整个 deploy 被 400 拒。

**新增依赖**：`@alicloud/sts20150401`（与已有的 `@alicloud/fc20230330`、
`@alicloud/dysmsapi20170525` 同一套 SDK 约定）。仅 §4.1 阶段需要，阶段一不引入。

**代码落点**：

- `provisioning/apps-oss.ts` — 加 `appFilesPrefix(appId)` 与 key 校验，和已有的
  `appOssObjectName` 放在一起，让两个前缀在同一屏里可见
- `provisioning/app-storage.ts`（新）— STS 签发、policy 构造、policy 断言测试
- `lib/routes/apps.ts` — §7 的路由
- `supabase-repo.ts` — 授权与列表实现
- `app-delete.ts` — 只加注释，不改行为

---

## 9. 决策与被否决的方案

| # | 方案 | 结论 | 理由 |
|---|---|---|---|
| 1 | 一个 app 一个 bucket | **否** | §2.1：配额、新失败路径、与既有原则冲突 |
| 2 | 用户数据放 `apps/<appId>/files/` | **否** | §3.1：与"删产物、留数据"的语义在 key 空间上会混 |
| 3 | 把 apps 的长期 AK 注进函数 env | **否** | §4.1：等于给 LLM 产物跨租户读取权 |
| 4 | per-app RAM 用户 / per-app RAM 角色 | **否** | 实测天花板：自定义策略 1500 / 角色 1000（§2.4），且每用户仅 2 把 AK，轮转无腾挪空间 |
| 5 | app 的每次文件操作都回调 Cloud API 换签名 URL | **否，但保留为阶段一** | 把控制面放进应用的热路径；不过阶段一本来就只有控制面，见 §11 |
| 6 | 同步扣配额 | **否** | §5：STS 直写绕过我们，同步配额是假的 |
| 7 | 提供公开可读前缀 | **本轮否** | §4.3：与 authMode 的安全预期冲突 |
| 8 | 为 agent 单独做 per-app 存储授权 | **否** | §4.4：`app_member_access` 结构上不支持 agent，沿用 team-scoped |

---

## 10. 明确接受的风险

1. **STS session policy 写错会静默放开跨 app 访问。** 没有运行时信号。唯一的守卫
   是 §4.1 红线 1 的那条断言测试，以及一次人工的跨 app 越权实测（拿 A 的 token 去
   读 B 的前缀，必须 403）。
2. **`/storage/sts` 是 FC 里第一个不走用户 JWT 的业务路由。** 它必须自己做授权，
   走 service role，没有 RLS 兜底。这类代码在本仓已经有过教训（RLS 会静默吞写入），
   评审要单独看。
3. **用量是最终一致的**，因此不能在它之上做按量计费的产品承诺。
4. **文件在删 app 后保留，会积累无主数据。** 与 Postgres schema 同一性质，同一处
   欠账；真要回收需要一个独立的、有人工确认的运维流程，不在本轮。
5. **`apps.oss_bucket` 第一版恒为 null**，等于一条没有测试覆盖的分支。要么在单测里
   构造一个非 null 的 app 覆盖 key builder，要么明确接受它是死代码直到被用上。
6. ~~self-host 的 `.env` 持有主账号 AccessKey~~ —— **2026-09-09 已换成受限 RAM
   用户**（§2.4）。**剩一件人工尾巴**：主账号那把旧 AK 还没禁用，只能在控制台做。
   在它被禁用之前，这把 key 的历史副本（GitHub secret 的旧版本、容器 env、
   `.env.bak`）仍然是有效凭证。

---

## 11. 实施顺序

**阶段一：只做控制面，零新增认证主体、零新增 SDK。**

1. ~~核实 §2.4 的配额~~ —— **已于 2026-09-09 完成**，结论与修正见 §2.4
2. 迁移（§8）+ `appFilesPrefix` + key 校验 + 单测
3. OpenAPI 契约（人相关的 7 条路由）
4. repository 实现 + 三档授权
5. 控制面 UI：文件列表、上传、下载、删除
6. `app-delete.ts` 加注释；删除对话框措辞

到这里用户已经能用了：人可以往 app 的空间里放文件，app 的代码可以在部署时把它们
当成静态资源读——**只是 app 运行时还不能写**。这一刀切得干净，因为它不需要
`@alicloud/sts20150401`，不需要新的认证主体，也不需要 §10 的风险 1 和 2。

**阶段二：app 运行时读写（STS）。**

7. ~~先换掉主账号 AK~~ —— **2026-09-09 已完成**（§2.4）。实施本阶段时只需给
   `teamclu-selfhost-fc-oss` 策略补 `sts:AssumeRole`。
8. RAM 角色与策略（人工，一次性）
9. `app-storage.ts` + policy 断言测试 + 跨 app 越权实测
10. `storage_token` 的生成、密封、注入（挂在 `finalizeDeploy` 上）
11. `/storage/sts` 路由
12. 模板与 `AGENTS.md` 里给出读写文件的示例，否则 agent 不会知道这个能力存在

**阶段三：配额计量。**

13. 定期扫描 + `storage_bytes` 回写
14. 超配额时拒发写凭证

阶段一与阶段二之间**不移动任何字节**——key 布局在阶段一就定死，这是把它先想清楚
的全部意义。

---

## 12. 验收标准

- [ ] 一个 app 的 STS token 读另一个 app 的前缀，返回 403（人工实测，留记录）
- [ ] policy JSON 的断言测试存在，且改动 `appFilesPrefix` 会让它变红
- [ ] `view` 档位的成员上传返回 403，`prompt` 成功
- [ ] agent actor 走 team-scoped 路径可读写，跨 team 的 agent 不行
- [ ] 删除一个有文件的 app：函数没了、`code.zip` 没了、`app-files/<appId>/` 一个
      对象不少
- [ ] 二次部署后，注入的 `storage_token` 与 `app_secrets` 里密封的一致（对照
      `DATABASE_URL` 那个坑）
- [ ] `s.yaml` 与 compose 的新 env 双边齐全，`deploy-env-parity.test.ts` 绿
- [ ] key 校验拒绝 `..`、绝对路径、超长 key，且拒绝发生在 builder 而非调用点

---

## 13. 实施与本稿的两处偏离（2026-09-09）

写在这里而不是改正文，因为两处都是实施时才拿到的信息，改掉正文会让"为什么这么定"
的推理链断掉。

### 13.1 STS 调用没有用 `@alicloud/sts20150401`

§8 原本要求加这个依赖。实际用的是手写的 RPC v1 签名（`app-storage.ts` 的
`signRpcV1`）。理由不是"少一个依赖"本身：

- 这段签名器在 9 月 9 日的配额审计里已经打过真实账号（RAM / STS / Quotas 三个
  产品），是**验过的**代码；
- 而 @alicloud SDK 的请求形状在同一天已经坑了一次——`listFunctions` 传字面量报
  `tmpReq.validate is not a function`，因为它要的是 `ListFunctionsRequest` 实例。

二十行跑通过的代码，胜过一个还要再学一遍形状的依赖。取舍写在
`app-storage.ts` 的模块注释里。

### 13.2 多了一个 `auth: "app-token"` 路由模式

§4.1 只说"要引入 app 自己作为调用方"，没说怎么接。实现是在
`hono-adapter.ts` 的 `RouteOptions.auth` 上加第四个取值：它拿到 service-role
仓库，**但不认证任何东西**——真正的门是
`mintAppStorageCredentials` 里的常量时间比较。适配器里那段注释明确写了这一点，
因为"有个 auth 模式"很容易被下一个人读成"这条路由已经被鉴权了"。

---

## 14. 实施记录（2026-09-09）

**云侧**（一次性，人工）：

- RAM 角色 `teamclu-app-storage`，`MaxSessionDuration=43200`，信任策略只允许
  `acs:ram::1457752404144823:user/teamclu-selfhost` assume。
- 角色策略 `teamclu-app-storage-oss`：OSS 对象操作限 `<apps bucket>/app-files/*`，
  ListObjects 限该桶且带 `oss:Prefix` 条件。这是**上限**，每次请求的 session
  policy 在此之上再收窄到单个 app。
- 用户策略 `teamclu-selfhost-fc-oss` 加了一条 `sts:AssumeRole`（新版本并设为默认，
  没有新加一条策略——每用户可附加策略上限是 10）。
- 盒子 `.env` 写入 `APPS_STS_ROLE_ARN` 与 `APPS_CLOUD_API_URL`。**代码尚未部署**，
  这两个值要到下次 self-host 部署才会真正生效。

**§12 验收标准的实测结果**（用 app A 的 session policy 打真实 OSS）：

| 动作 | 期望 | 实测 |
|---|---|---|
| A 写自己前缀 | 200 | 200 |
| A 读自己对象 | 200 | 200 |
| A 写 B 的前缀 | 403 | 403 AccessDenied |
| A 读 B 的前缀 | 403 | 403 AccessDenied |
| A 写 `apps/<id>/code.zip` | 403 | 403 AccessDenied |
| A 列整个 bucket | 403 | 403 AccessDenied |
| A 删自己对象 | 204 | 204 |
| 12 小时会话 | 接受 | 接受 |

倒数第三条值得单独说：它证明拿到存储凭证的 app **改不了自己的构建产物**——
`code.zip` 在 `apps/` 前缀下，而 session policy 只覆盖 `app-files/`。这是 §3.1
把两个前缀分开的一个额外好处，当时没想到。

**留在人工手上的一件事**：主账号旧 AK 仍未禁用（控制台操作，无 OpenAPI）。

