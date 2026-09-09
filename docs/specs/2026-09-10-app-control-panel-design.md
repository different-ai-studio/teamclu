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
`services/fc` 要同时打包进 self-host 容器和阿里云 FC，多一个依赖就是多一处两边不一致的
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
- **阿里云 FC**：同一个端点，心跳由外部每分钟 `curl` 一次（一行，跟 sidecar 里那条
  完全一样）。这里**没有**用 FC 的 timer trigger：timer 事件不是 HTTP 请求，落到 web
  函数上的路径和头都跟普通请求不同，猜错的结果是这一侧静默没有调度器 —— 而这正是本
  设计要消灭的失败模式。端点是有鉴权的，谁来打都一样。

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
