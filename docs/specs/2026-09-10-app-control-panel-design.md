# APP 控制面：一列摘要，管理进中间 tab — 设计

状态：已实现（2026-09-10）
日期：2026-09-10
相关：`docs/specs/2026-09-08-apps-login-and-custom-domain-design.md`（登录墙）、
`docs/specs/2026-09-09-app-storage-design.md`（文件）、
`docs/specs/2026-08-27-app-data-browser-design.md`（数据）

## 0. 一句话

右侧控制面从「什么都摊开在 280px 里」改成「一行一件事、带个数、点右箭头去中间 tab 管」，
并补上两块目前不存在的能力：**每个页面各自的登录与受众**，和**云端定时任务**。

## 1. 现状核实（2026-09-10 读代码）

`AppControlPanel.tsx` 784 行，把七件事全塞进右侧一列：重命名、本机路径、重新播种、
成员权限（含授权表单）、登录方式（含路径规则表）、线上数据、文件（含上传/删除/清空）、
运行日志、自定义域名、删除。

已经存在的「中间 tab」通道只有两条，都在 `lib/tabs/app-tabs.ts`：

| 已有 | 入口 | tab 组件 |
|---|---|---|
| 线上数据 | `openAppDataTable` | `AppDataTabContent` |
| 运行日志 | `openAppLogs` | `AppLogsTabContent` |

`NativeContent.tsx` 按 target 字符串前缀分发。这次新增四条走同一套。

**两块能力现在完全没有：**

1. **每页受众。** 登录墙的受众 `auth_audience` 是**应用级**的一个值（`any` = 任何登录
   用户 / `org` = 本公司员工），路径规则 `auth_rules` 只有 `required | public` 两档。
   「/admin 只给员工，/ 给任何用户」今天表达不了。
2. **应用的定时任务。** 桌面端的 cron（`apps/desktop/src/commands/cron/`）是按 workspace
   路径分实例的 agent 定时任务，跟部署出去的站点无关。云端一侧，`stripe-reconcile.ts`
   注释里写着「cron 任务」，但仓库里**没有任何调用方** —— 那是手工在阿里云 FC 上建的
   两个定时函数，不在这个仓库。也就是说云端调度器要从零做。

## 2. 目标 / 非目标

**目标**

- 控制面重排成摘要行，管理动作进中间 tab。
- 每条路径规则各自带受众。
- 云端定时任务：到点由云端向这个应用的线上地址发一个 HTTP 请求，本机关机照跑。

**非目标**

- **角色**。终端用户身上没有任何角色概念（网关只透传 user id / email / orgId），
  做角色要新表 + 授权界面 + 网关比对，本轮明确不做。`员工/用户` 这一档就是受众。
- 自定义域名、删除：一个字不改。
- 桌面端 workspace cron：不动，跟这里没关系。

## 3. 控制面的形状

```
● 我的应用
  运行中

应用
  重命名           [____________] [保存]
  本机路径         ~/teams/x/apps/y      [复制] [移动]
  代码版本         线上 b7e2d10 · 分支 main 上还有 3 个提交没部署
  可见性           仅自己和被授权的人 / 全团队可见

管理
  协作权限         3 位成员                        ›
  应用权限         2 条页面规则                    ›
  线上数据         5 张表                          ›
  应用附件         12 个文件 · 3.2 MB              ›
  变量与密钥       6 个变量 · 2 个密钥             ›
  运行日志         查看日志                        ›
  定时任务         2 个任务                        ›

线上
  自定义域名       （原样）

删除
  （原样）
```

每一行只做两件事：说清楚**有多少**，以及把人送进 tab。行本身可点，右端一个 `›`。
计数拿不到时显示的是原因（「未部署」「没有数据库」），不是 0 —— 0 和「不适用」
在这里是两回事。

五条新 target：`app-access:<id>`、`app-auth:<id>`、`app-files:<id>`、`app-cron:<id>`、
`app-env:<id>`。

## 4. 设计 A · 每页受众

`auth_rules` 是 jsonb，**不需要迁移**，只是每条多一个可选键：

```json
[{"path": "/admin", "auth": "required", "audience": "org"},
 {"path": "/",      "auth": "required", "audience": "any"},
 {"path": "/health","auth": "public"}]
```

- `audience` 只在 `auth: "required"` 时有意义，`public` 上出现即忽略（写入时剔除）。
- **缺省不是 `org`，是「跟随应用级 `auth_audience`」。** 存量规则一条都没有这个键，
  把缺省读成 `org` 会让今天设成「任何登录用户」的应用在下次部署后突然把路人挡在外面 ——
  这是最不该发生的方向：**改 UI 不能改变已经生效的墙**。
- 网关侧 `admit()` 现在拿的是 `app.authAudience`，改成拿**命中规则的受众**（最长前缀
  同一条规则，跟 `pathRequiresLogin` 用的是同一次匹配，不做第二次），命中不到或规则没写
  就回落到应用级。

一次匹配返回两样东西（要不要登录、什么受众），而不是匹配两次：两次匹配意味着两套
最长前缀比较，将来一定会有人只改其中一处。

## 5. 设计 B · 云端定时任务

### 5.1 为什么是「打 URL」而不是「跑 agent」

用户选的就是这个：本机关机照跑。跑 agent 需要 daemon 活着，那是桌面端 cron 已经做了
的事。云端这条只做一件事：到点向 `https://<app>.<apps域名><path>` 发一个请求。

### 5.2 表

`amux.app_cron_jobs` — 任务本身；`amux.app_cron_runs` — 每次执行的记录（每个任务保留
最近 20 条，插入时裁剪）。两张表都 `on delete cascade` 挂在 `apps` 上：删应用，任务
和历史一起走。

`next_run_at` 存在表里，是**调度的唯一依据**，也是并发领取的锁：

```sql
update amux.app_cron_jobs
   set next_run_at = <算出来的下一次>, last_run_at = now()
 where id = $1 and next_run_at = $2   -- 读到的那个值
```

条件里带上读到的 `next_run_at`，两个 tick 撞上时只有一个 update 影响到行，另一个拿到
0 行就跳过。不用 `for update skip locked`，因为 PostgREST 给不了显式事务。

### 5.3 cron 表达式：自己算，不加依赖

五段式（分 时 日 月 周），支持 `*`、`,`、`-`、`*/n`、`a-b/n`。不引第三方库：
`services/fc` 要同时打包进 self-host 和 Belayo Dokploy 容器，多一个依赖就是多一处两边不一致的
可能，而这块逻辑一百来行、纯函数、好测。

时区用 IANA 名。做法是反过来算：把「用户写的当地墙上时间」换算成 UTC 时刻，再回读校验
——回读对不上就是这个当地时间不存在。DST 的两个边界因此是**已知且接受**的：春季被跳过的
那一小时回读失败，当天不跑；秋季重复的那一小时只解析出一个时刻，当天**只跑一次**。
写在表注释和测试里。

搜索是「按天粗筛 + 按分钟细筛」：日/月/周不匹配就直接跳到当地第二天零点，所以最坏情况
（`0 0 29 2 *`）也只有约 1500 次日跳。上限 4 年，找不到就 `next_run_at = null`（表达式
永远不会到，比如 2 月 30 日）。

### 5.4 触发

一个 `POST /v1/internal/app-cron/tick`，共享密钥（`APP_CRON_SECRET`）。心跳在外面，
每分钟打一次，两个部署目标打的是同一个端点：

- **self-host（今天在跑的那个）**：compose 里加一个 `app-cron` 服务，对齐整分钟后
  `curl` 循环。**不放 profile 里** —— 放 profile 就是默认不跑，而一个默认不跑的定时
  任务等于没有。
- **阿里云 FC**：`s.yaml` 里声明一个 timer trigger（`app-cron`，六段式 `0 * * * * *`
  —— 阿里云的表达式第一段是秒）。

  **timer 事件不是 HTTP 请求，这一段翻过两次车，两次都是同一个坑。**

  最初写的是「不用 timer trigger，因为 timer 事件不是 HTTP 请求」；看到同账号的
  `banana-api` 上跑着 20 多个 timer trigger 打自己的 HTTP 路径（payload 形如
  `{"path":"/api/cron/…","method":"POST","body":{…}}`，其中就有每分钟一次的），就改
  成了「timer 确实能驱动 web 函数」。**后半句同样是错的**：能跑起来的是那个 payload
  约定，而约定是**函数自己**兑现的，不是 FC 兑现的。

  FC 交给函数的就是 `{triggerTime, triggerName, payload}` —— 没有 rawPath、没有
  method、没有 header。`hono/aws-lambda` 认不出这个形状，`getProcessor` 退回 v1
  processor，读 `event.path` / `event.httpMethod` 读到两个 undefined，拼出来的请求
  404。**没有异常抛出**，所以 FC 记的是一次干净的成功。

  2026-09-10 belayo 上的表现正是如此：`app-cron` 每分钟按时触发（`t-…` 开头的
  requestId，`hasFunctionError: false`），一条任务都没跑；同一个 tick 走 HTTP 是通的。
  排查时先怀疑过 `CRON_TZ=` 前缀 —— 也是错的，同一个函数上不带前缀的
  `oss-abandon-sessions` 一样在触发。**判据只有一条：查 `FCRequestMetrics` 里
  `invocationType: Async` 的记录，有就是在触发，问题在函数里。**

  所以 `src/index.ts` 的 `handler()` 里有一步 `timerEventToHttpEvent()`：认出 timer
  事件，把 payload 里的 `path` / `method` / `body` 翻译成 hono 认得的 v2 事件（host 固
  定 `localhost`，免得撞上按域名路由的应用和登录服务）。不是 timer 事件、或者 payload
  里没有可路由的 `path`，一律原样放行。

  timer **不能**做的是加请求头：payload 只有 `path` / `method` / `body` 三个字段。所以
  密钥走 **body**，端点两种都收（sidecar 发 bearer，timer 放 body）。没走 query 是因为
  query 会进 URL 和访问日志，body 不会。

`APP_CRON_SECRET` 必须**两边都声明**（compose 的 `environment:` 白名单 + `s.yaml`），
少一边就是那一边静默没有 —— CLAUDE.md 里点名的坑，`deploy-env-parity.test.ts` 守着。

密钥没配时端点 401 且不执行任何任务（`sharedSecretMatches` 对空密钥一律拒绝，所以
「没配密钥」等于「没有调度器」，不等于「谁都能触发」）。

### 5.5 请求带不带身份 —— 不带

定时任务发出的请求**不带任何会话**，跟路人走同一道墙。目标路径如果需要登录，网关会 302
到登录页，这一次执行记为失败，错误文案直接指向隔壁那个 tab：

> 这条路径需要登录，而定时任务没有会话。去「应用权限」把它设为公开，
> 再用下面的自定义 header 自己校验。

这是有意的：给定时任务一把绕过登录墙的钥匙（比如复用应用自己的 token），等于给这道墙
开一个新口子，而用户没要这个。任务支持自定义 header，用户想校验就自己放一个密钥进去 ——
安全边界一点没变，而且解法就在旁边一个 tab 里。

### 5.6 权限

- 读任务列表：对这个应用有任何一档权限（`view` 起）。
- 增删改：`admin`。跟 `app_member_access` 是同一套 `resolveAppCallerPermissionForApp`，
  不另起一套判定。

## 6. 端点（先进 OpenAPI，按 CLAUDE.md 的顺序）

| 方法 | 路径 | 谁 |
|---|---|---|
| GET | `/v1/apps/:appId/cron-jobs` | view+ |
| POST | `/v1/apps/:appId/cron-jobs` | admin |
| PATCH | `/v1/apps/:appId/cron-jobs/:jobId` | admin |
| DELETE | `/v1/apps/:appId/cron-jobs/:jobId` | admin |
| POST | `/v1/apps/:appId/cron-jobs/:jobId/run` | admin（立即跑一次） |
| GET | `/v1/apps/:appId/cron-jobs/:jobId/runs` | view+ |
| POST | `/v1/internal/app-cron/tick` | 共享密钥 |

## 9. 设计 C · 变量与密钥

### 9.1 跟 app_secrets 不是一回事

`amux.app_secrets` 装的是**平台替应用铸的**凭证（storage token、OAuth client
secret），kind 是固定的几个。这里装的是**用户自己的**：任意 key、自己起名、部署时写进
函数环境。所以是新表 `amux.app_env_vars`，不是往 app_secrets 里塞 `kind='env:XXX'`。

一行要么明文要么密文，check 约束保证不会两者都有。**明文是故意可读的** ——「这个不是
密钥」是用户逐个 key 做的判断，只有当明文真的能读回来、能改，这个区分才有意义。不想让人
看见的就标成密钥，进 `ciphertext`，**任何端点都不返回它**，包括设置它的人自己。改密钥
= 输入一个新值。

密文的 AAD 是 `env:<KEY>`，所以把 STRIPE_TEST_KEY 的密文搬到 STRIPE_LIVE_KEY 那一行
解不开 —— 跟 app_secrets 绑 kind 是同一个理由。

### 9.2 用户变量盖不掉平台变量

两道独立的防线，因为第一道只防「从这个 API 进来的」：

1. **写入时拒绝保留名**，并说清楚是哪个名字：`PORT` / `NODE_ENV` / `DATABASE_URL` /
   `APP_PUBLIC_URL` / `API_BASE` / `SUPABASE_URL` / `SUPABASE_ANON_KEY`，以及整个
   `TEAMCLU_` 前缀（平台告诉应用「它自己是谁」的东西全在这个前缀下，保留前缀就不用每加一个
   能力就改一次名单）。
2. **finalize 时用户变量先铺、平台变量后盖**。这一道对「不是从这个端点写进表里的行」
   同样有效。

被盖掉的后果比看上去严重：应用会拿到一个错的 `DATABASE_URL`，然后报告「数据库连不上」——
从应用内部完全看不出真正原因。

### 9.3 什么时候生效 —— 下次部署

环境是 finalize 时烤进函数的，改完不重新部署就没用。跟登录墙一样，这必须说出来：刚粘完
一个 API key 的人否则会以为已经生效了。`amux.apps` 加两个时间戳
（`env_updated_at` / `env_deployed_at`），行上派生出 `envPendingRedeploy`，跟
`deployed_auth_mode` 派生 `authModePendingRedeploy` 是同一套做法 —— 状态在行上，不在某
一台桌面的内存里。删除也算改动，也会把时间戳往前推。

### 9.4 权限

- 读：`prompt` 起 —— 写应用代码的人需要知道环境里有什么。
- 增删改：`admin`。
- 列表响应自带 `canWrite`（跟 `listAppFiles` 一样），客户端不用再问一次，两边也就不会
  各说各话。

finalize 读 env 用的是**调用者自己的 client**，不是 service role：那一步已经验过调用者
是 admin，而升权会让「部署」这件事从此依赖 service-role key 配没配 —— 一个根本没有 env
的应用会因此部署不了。

## 10. 可见性

`apps.visibility` 一直是**只在新建时能选、之后永远改不了**：`CreateAppView` 默认
`personal`，而全仓库唯一另一处提到它的是应用库里那个徽章。`updateApp` 其实收
`visibility`，PATCH 路由也在，只是没有任何界面发过这个字段。

RLS 的真实语义（`apps_select_if_visible`）是：

```
is_team_member(team_id) AND (
  visibility = 'team'
  OR 我是创建者
  OR actor_has_app_access(app, 我)      -- 显式授权
)
```

所以 `personal` **不等于「只有我」**：在「协作权限」里授权过的成员照样看得见。真正看不见
的是**没被授权的队友**，以及 **daemon** —— `app_member_access` 挂在 `amux.members` 上，
agent actor 根本拿不到授权（`resolveAppGitCredentialActor` 里那段服务角色重读就是为这个）。

界面上因此有两件事要做对：

1. 选项写的是**它做什么**，不是它叫什么：「仅自己和被授权的人」/「全团队可见」。
   应用库那个徽章需要一个词，所以单独给了 `visibilityTeamBadge`，不共用。
2. **只有改窄才确认**。改宽只会多几个人看得见，吓不到谁；改窄会把应用从每个队友的列表里
   拿走。确认文案必须同时说清两件最容易搞反的事：授权过的人**不受影响**，daemon **会**
   看不见。规则抽成了 `visibilityChangeNeedsConfirm`（Radix Select 在 jsdom 里打不开，
   规则本身才是要测的东西）。

改可见性是**创建者专属**（`apps_update_if_creator`），跟重命名一样。服务端说不出「你不是
创建者」——那会泄漏应用是否存在——所以 404 由客户端翻译成一句人话。

## 12. 应用附件是个文件浏览器

对象存储里**没有目录** —— 看着像文件夹的东西，只是一堆 key 共享到下一个 `/` 为止的前缀。
原来的实现把 `listAppFiles` 的结果平铺成一列，对一个往 `uploads/<user>/<file>` 写东西的
应用来说就是几千行 key，而人想看的大概是六个东西。

做法是让存储层去折叠：`ListObjectsV2` 带上 `Delimiter: "/"`，把下一层以下的全部收进
`CommonPrefixes`，`Contents` 就只剩这一层的对象。于是 `AppFilesPage` 多一个 `folders`。

**delimiter 是 opt-in，不能变成默认**：控制面那一行数的是「这个应用一共多少文件」，用量
统计扫的也是全量 —— 默认加上 delimiter 会把这两处悄悄变成「根目录下有多少」。

界面就是 OSS 控制台那套：面包屑、文件夹在前、名称/修改时间/大小三列。三件小事值得写下来：

- **面包屑从 prefix 推导**，不是点一次累加一段。这样无论怎么到达某个位置（刷新、以后做
  深链接），走出来的路径都一样。
- **上传进当前文件夹**，不是根目录。一个「目的地取决于界面上看不见的东西」的上传按钮，
  就是文件落到没人预期的地方的原因。
- **列头不做排序。** 一页只有 200 条，按大小/时间排序只能排这一页 —— 看着像全量排序、
  其实不是，比不排更糟。顺序就是存储返回的字典序，文件夹在前。

`prefix` 的清洗（`normalizeAppFolderPrefix`）有两条：`..` 段直接丢掉（对象存储没有上级
目录，留着只会指向一个字面量 ".." 的 key），非空 prefix 一定补 `/` 结尾 —— 否则列
`logs` 会把 `logs-archive/` 的文件也列进来，显示在 logs 这个名字底下。

删文件夹复用已有的 `removePrefix`，权限是 `prompt`（跟删单个文件同档：文件夹不是另一种
东西，就是个前缀）。**空 prefix 一律拒绝** —— 那是整个应用，清空应用是另一个 admin 专属的
purge。

### 12.1 上传要求存储桶开 CORS（部署前提，仓库里没人配）

字节是**浏览器直传对象存储**的（签名 URL，不经过 FC），所以浏览器会先发一个 preflight，
桶必须答得上来。`belayo-teamclu-apps` 2026-09-10 实测：

```
$ curl -i -X OPTIONS 'https://belayo-teamclu-apps.oss-cn-shenzhen.aliyuncs.com/app-files/probe' \
    -H 'Origin: http://127.0.0.1:1420' -H 'Access-Control-Request-Method: PUT'
HTTP/1.1 403 Forbidden
<Code>AccessForbidden</Code>
<Message>CORSResponse: CORS is not enabled for this bucket.</Message>
```

也就是说**桌面端上传从来没通过**。仓库里 `grep PutBucketCors|CreateBucket` 一个都没有 ——
桶是手工建的，CORS 没人配过，而失败发生在 PUT 之前，服务端什么也看不到。

规则写在 `deploy/self-host/.env.example` 的 `APPS_OSS_BUCKET` 旁边（来源要同时放
`http://127.0.0.1:1420` 开发端和 `tauri://localhost` 打包端）。

界面这边只能把话说清楚：preflight 被挡时 `fetch` 抛的是裸 `TypeError`（Chromium 是
"Failed to fetch"，桌面用的 WKWebView 是 "Load failed"），跟断网完全一样 —— 直接 toast
出来对唯一能修的人毫无用处。所以文案点名 CORS 和需要放行的 origin，同时**不假装知道**
一定是它（真的可能只是网络不通）。真从存储拿到了状态码（403/500）则原样透出，不提 CORS ——
那会把人支去改一个本来就对的东西。

## 11. 代码版本

「现在线上跑的是哪个 commit」在界面上一直没有答案：`gitCommitSha` 在 app 行上，
`getGitHead` 也有，但它只在部署流程里被用来校验 commit 已推送，从没显示过。

`getRepoHead` 原本只返回 `{ sha }`，但它为了拿 HEAD **已经**先查了一次仓库拿
`default_branch` —— 分支名是白送的，而「落后 3 个提交」不说清楚落后于谁是没法行动的。

提交数要多一次请求（Gitea 的 `/compare/{base}...{head}` 返回 `total_commits`），所以
**做成 `?compare=1` 选项**：部署路径每次部署都会打这个端点、而且只读 `sha`，不该替它多付
一次 forge 往返。

五个状态，只有一个是顺利路径，每个都得有话说：

| 状态 | 显示 |
|---|---|
| 不是我们托管的仓库 | 这个应用用的是外部仓库，看不到它的分支。 |
| 读不到仓库 | 暂时读不到仓库 |
| 从没部署过 | 还没有部署过 · 分支 main 在 a3f91c2 |
| 已是最新 | 线上 a3f91c2 · 已是分支 main 的最新 |
| 落后但数不出来 | 线上 b7e2d10 · 分支 main 上有没部署的改动 |
| 落后 N | 线上 b7e2d10 · 分支 main 上还有 3 个提交没部署 |

「数不出来」不是可以省略的分支：**强推**（force-push）掉已部署的那个 commit 之后
`/compare` 会 404，这时候显示「已是最新」是错的，而且错在最危险的方向。`compareCommits`
因此返回 `null` 而不是抛错，措辞也如实说「有没部署的改动」，不编一个数字出来。

判定写成了纯函数 `describeCodeVersion`，六个状态逐个测；「从没部署过」返回 `null` 而不是
`0`，因为 `0` 会被读成「已是最新」。

## 7. 风险

| # | 风险 | 处理 |
|---|---|---|
| R1 | 存量规则读出 `audience` 缺省值把墙改严 | 缺省是「跟随应用级」，不是 `org`；§4 |
| R2 | 两个 tick 并发把一个任务跑两遍 | `next_run_at` 条件更新领取；§5.2 |
| R3 | `APP_CRON_SECRET` 只声明在一个目标上 | compose 与 s.yaml 同时改，parity 测试守着 |
| R4 | 定时任务打不进有墙的路径 | 明确的失败文案 + 自定义 header；§5.5 |
| R5 | 任务把应用打挂（间隔 1 分钟 × N 个任务） | 每应用任务数上限 20，最小间隔 1 分钟，超时 30s |
| R6 | 运行记录无限增长 | 每任务保留 20 条，插入时裁剪；§5.2 |
| R7 | 用户变量盖掉 DATABASE_URL 等 | 写入拒绝 + finalize 时平台后盖，两道；§9.2 |
| R8 | 改完变量以为已生效 | `envPendingRedeploy` 在行上派生 + tab 里带重新部署按钮；§9.3 |
| R9 | 密钥被搬到另一个 key 名下 | 密文 AAD 绑 `env:<KEY>`；§9.1 |
| R10 | 把应用改窄后队友莫名找不到 | 只在改窄时确认，且文案点名授权与 daemon 两种后果；§10 |
| R11 | 强推后「已是最新」是假的 | compare 失败返回 null，措辞退回「有没部署的改动」；§11 |
| R12 | 每次部署多付一次 forge 往返 | `compare` 是 opt-in，部署路径不传；§11 |

## 8. 实现落点

**后端**

- `services/supabase/migrations/20260910000000_app_cron.sql` — 两张表、RLS、
  以及 `auth_rules` 的新注释（每页受众不需要迁移）。
- `services/fc/src/lib/app-cron-schedule.ts` — 五段式解析 + 时区推算，纯函数。
- `services/fc/src/lib/app-cron-runner.ts` — tick：领取、发请求、记录、裁剪。
- `services/fc/src/lib/apps-auth-paths.ts` — `resolvePathPolicy` 一次匹配两个
  答案；`apps-auth-gate.ts` 的 `admit()` 收下命中规则的受众。
- `services/fc/src/lib/routes/apps.ts` — cron 的 6 个 CRUD + 1 个 tick，env 的 3 个。
- `services/supabase/migrations/20260910010000_app_env_vars.sql` — 变量表 + apps 上
  的两个 env 时间戳。
- `services/fc/src/lib/app-env.ts` — 名字/值校验、保留名、合并顺序。
- `deploy/self-host/docker-compose.yml` 的 `app-cron` 服务 + 两个目标的
  `APP_CRON_SECRET`。

**前端**

- `AppControlPanel.tsx` — 摘要行；`AppTabShell.tsx` — 四个 tab 共用的外壳。
- `AppAccessTabContent` / `AppAuthTabContent` / `AppFilesTabContent` /
  `AppCronTabContent` / `AppEnvTabContent`，target 统一是 `<kind>:<appId>`。
- 删掉 `AppAuthSection` / `AppDataSection` / `AppLogsSection`（都被 tab 取代；
  数据为什么是空的那几句话搬进了数据 tab）。

**没做的**：角色（§2 非目标）。`员工/用户` 这一档就是受众，网关透传的身份里
仍然只有 user id / email / orgId。

## 13. Agent 侧：同一个控制面

控制面上能做的事，agent 通过 `teamclu-introspect` sidecar 也要能做——否则 agent 做到
一半就得停下来请人去点另一半。工具按控制面的块切，一个工具对应桌面端 loopback 上的一个
路由（`apps/desktop/src/commands/introspect_api/apps.rs` 顶部有对照表）：

| 工具 | 控制面 | 动作 |
|---|---|---|
| `manage_app` | 新建、应用组（含本机路径、重新播种）、下载到本机、部署、运行日志、删除 | list / status / sessions / create / update / reseed / download / move_workdir / deploy / logs / delete |
| `manage_app_access` | 协作权限 | list / grant / revoke |
| `manage_app_data` | 线上数据 | tables / rows / update_row / delete_row |
| `manage_app_files` | 应用附件 | usage / list / download / upload / delete / delete_folder / purge / set_quota |
| `manage_app_env` | 变量与密钥 | list / set / delete |
| `manage_app_cron` | 定时任务 | list / create / update / delete / run / runs |
| `manage_app_domain` | 自定义域名 | get / set / verify / remove |

几条和 UI 不一样、但是有意为之的规则：

- **`update` 一次 PATCH 改所有行上的设置**：name / type / visibility / 登录墙四个字段。
  登录墙没有单独成工具——它和改名是同一个 PATCH，拆开只会多一份工具描述。
  `runtime` 不给改：它是每次部署从 `teamclu.app.json` 推出来写回的，改了下次部署就被覆盖；
  `status` 里把 checkout 的声明和行上记录的并排给出。slug / 线上地址不给改。
- **不可逆的动作必须显式点名应用**：`delete` 和 `purge` 不接受"当前工作区就是这个应用"的
  默认值，其它动作接受。
- **按名字找人 / 找任务只认唯一精确匹配**，零个或多个就把候选列表还回去，什么都不做。
- **文件字节在 sidecar 里搬**：桌面端只签 URL，读写路径用的是 agent 自己进程的权限。
- **错误原样透出**：app 路由用 409 表达很多正常状态（没数据库、未部署、超配额、DNS 未生效），
  而 `FcClient` 会把所有 409 折成 `conflict: remote_version=None`，所以 app 路由走自己的
  请求封装，保留状态码、错误码和原文。
- **agent 改完 UI 要跟上**：桌面端每次改动发 `apps:changed-by-agent`，
  `hooks/use-agent-app-changes.ts` 合并一串事件后重读应用列表和控制面计数。

### 13.1 本机那几件事：新建、重新播种、下载、移动目录

这四件事不只是调 Cloud API：要签部署密钥、让 daemon 播种/克隆/移动、再把本机路径写回
云端 workspace 行。前端的做法原样移植到了 `introspect_api/apps/checkout.rs`（文件头有逐个
对照），而不是让桌面进程去调窗口里的 store——agent 的调用得在没人打开应用视图时也能工作。

代价是两份实现，改一边要改另一边：

- **播种**（`runSeed`）：是否取部署密钥看仓库怎么认证（Gitea 托管），不看行状态；密钥用完
  立刻归还；成功写 `ready`、失败写 `error`、daemon 不在什么都不写（仍可重新播种）。克隆用
  调用者**原样输入**的地址（服务端存行前会剥掉里面的凭证），回复里再把凭证剥一遍。
- **新建**的三种来源和建应用对话框一致：模板 / 仓库地址（`imported`）/ 本机目录。本机目录
  先问 daemon：带 origin 的 git 检出 → `localOnly`、原地绑定、不播种；否则 → 我们的仓库、
  **先绑定再播种**（`adoptExisting`），否则会发布一个空的默认目录。目录不存在或 daemon 不在时
  **在建行之前**就拒绝，不留空壳应用。
- **workspace 行**（`ensureAppWorkspaceRow`）：应用自己的行只在无路径或已是本机目录时认领，
  否则是另一台机器的副本，本机另起一行（按路径找或新建）。`createdByMemberId` 发 null——
  服务端从 token 推导、忽略客户端的值。绑定失败不回滚已就位的检出，但会在回复里说出来。
- **重新播种**只对 `pending` / `repo_created` / `error` 开放（同 `canReseed`）。
- **下载**不会克隆到非空目录上。
- **移动目录**不允许移动 agent 自己正在里面跑的那个检出——会把工作目录从当前会话脚下抽走；
  这种情况让用户去控制面板移。

## 14. 类型可改

`apps.type` 以前只在创建时写一次，`PATCH` 会忽略它。现在可改（admin），控制面「应用」组
有一个类型下拉框，agent 走 `manage_app update`。

类型在服务端只决定一件事：finalize 时 `needsDatabase` ——要不要建 schema、注入
`DATABASE_URL`。所以：

- **改到 data_app**：下次部署才建库；代码不会自己用上它。
- **从 data_app 改走**：下次部署起函数里没有 `DATABASE_URL`，用库的代码会挂；数据保留
  （schema 名由 slug + id 决定、建库幂等），改回来就接上。数据浏览器立刻按新类型回答
  「没有数据库」。UI 在这个方向上二次确认。
- **static_web / slides / imported 之间互改**：部署产物完全一样，只影响标签和重新播种写的模板。

「待重新部署」照 `deployed_auth_mode` 的做法：新列 `deployed_type`（finalize 时写入，
迁移 `20260911000000_apps_deployed_type.sql` 回填 live 行），行上派生
`typePendingRedeploy`——**只在两边对要不要数据库的答案不同时为 true**
（`typeChangeNeedsRedeploy`），static_web ↔ slides 不会亮。

部署顺序：`APP_COLUMNS` 现在查 `deployed_type`，所以 Cloud API 不能先于这条迁移上线。
self-host 的 `migrate` 服务先跑；belayo 迁移是手工的，要先迁移再发 FC。
