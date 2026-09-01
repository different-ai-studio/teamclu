# TeamClu 完整后端系统部署指南

**Audience:** 运维 / 平台 / 后端  
**Status:** Living document — 以仓库内脚本与 `deploy/self-host/` 为准  
**API 契约:** [`docs/openapi/teamclu-api.v1.yaml`](../openapi/teamclu-api.v1.yaml)

> **只有一个环境：self-host。** 全栈跑在一台自建 ECS（`47.112.210.217`）上，由
> `deploy/self-host/docker-compose.yml` 编排。以下子域**全部**指向这台机器：
>
> | 用途 | 地址 |
> |---|---|
> | Cloud API (`/v1`) | `https://api.teamclu-dev.ucar.cc` |
> | Supabase 网关 | `https://supabase.teamclu-dev.ucar.cc` |
> | Studio | `https://studio.teamclu-dev.ucar.cc` |
> | EMQX Dashboard | `https://emqx.teamclu-dev.ucar.cc` |
> | MQTT over WSS | `wss://mqtt.teamclu-dev.ucar.cc/mqtt`（443）；明文 `47.112.210.217:1883` |
>
> 域名里的 `-dev` 是**历史遗留命名**，不代表这是 dev 层级 —— 它就是唯一环境。既没有
> 单独的 "prod"，也没有单独的 "dev"。
>
> **命名提示：** `services/fc/` 目录名同样是历史遗留 —— 它**不是**阿里云函数计算，而是
> Cloud API 服务，由 compose 构建成容器运行。早先的阿里云 FC 部署（`teamclu-sync`）、
> 独立 RDS 实例、`cloud.ucar.cc`、`ai.ucar.cc` 均**已下线**。

---

## 1. 后端由哪些部分组成

TeamClu 的后端不是单一服务，而是一套协作组件。客户端（Desktop / iOS / Mobile）**只通过 Cloud API 访问业务数据**，不直连 Supabase。

```
┌─────────────┐     HTTPS       ┌──────────────────────┐
│   客户端     │ ──────────────► │  Cloud API           │
│ Desktop/iOS │                 │  services/fc (容器)   │
└──────┬──────┘                 └──────────┬───────────┘
       │                                   │
       │ wss/mqtt                          │ 内部 HTTP
       ▼                                   ▼
┌─────────────┐                 ┌──────────────────────┐
│    EMQX     │                 │  Supabase 栈          │
│  MQTT 总线   │                 │  Auth + PostgREST +   │
└──────▲──────┘                 │  Realtime + Storage   │
       │                         └──────────┬───────────┘
       │ mqtt                               │ SQL
       │                                    ▼
┌─────────────┐                 ┌──────────────────────┐
│  amuxd      │                 │  Postgres (amux 库表) │
│  Agent 宿主  │                 └──────────────────────┘
└─────────────┘

可选：
  • 阿里云 OSS — 团队工作区文件同步（外部服务，非本机）
  • AI Gateway — 团队共享模型（团队自己填 baseUrl；栈内也仍跑着待退役的 LiteLLM 容器）
```

| 组件 | 代码路径 | 职责 | 是否必需 |
|------|----------|------|----------|
| **Cloud API** | `services/fc/` | 唯一客户端业务入口：`/v1/*` 团队/会话/消息/邀请/bootstrap | **必需** |
| **Postgres + amux schema** | `services/supabase/migrations/` | 业务表、RLS、RPC | **必需** |
| **Supabase Auth (GoTrue)** | self-host 栈 | 登录、JWT、refresh token | **必需** |
| **PostgREST + Kong** | self-host 栈 | REST 层；Cloud API 内部 passthrough | **必需**（`BACKEND_KIND=supabase` 时） |
| **Realtime** | self-host 栈 | 部分补偿/订阅（主 live 走 MQTT） | 推荐 |
| **Storage** | self-host 栈 | 附件 bucket | 推荐 |
| **EMQX** | self-host 栈 | Session 内实时消息；对外 wss、对内 1883 | **必需** |
| **Caddy / 反向代理** | self-host 栈 | TLS、域名路由 | 对外必需 |
| **阿里云 OSS** | Cloud API 环境变量 | 团队 share / 工作区同步（外部对象存储） | 可选（无则 sync 不可用） |
| **LiteLLM** | self-host 栈（compose 服务） | 遗留 AI 网关，Cloud API 已不再调用它；等待退役 | 可选 |
| **amuxd** | `apps/daemon/` | Agent 运行时；通常跑在用户设备而非中心机房 | 按场景 |

---

## 2. 部署方式：Self-Host（Docker Compose 一键栈）

**启动文档（详细）：** [`deploy/self-host/README.md`](../../deploy/self-host/README.md)

```bash
cd deploy/self-host
cp .env.example .env
# 填写 JWT_SECRET、POSTGRES_PASSWORD、五个域名
# 本地 Podman/macOS：CADDY_TLS_MODE=off
./bootstrap/gen-secrets.sh
./bootstrap/up.sh          # 推荐；Podman 必需
# Docker Desktop 也可：docker compose up -d
```

**Podman 本地访问：** Caddy `http://api.example.com:8080`，FC 直连 `http://127.0.0.1:9000`。

### CI 自动部署（唯一发布路径）

push 到 `main` 且改动 `deploy/self-host/**`、`services/fc/**` 或
`services/supabase/migrations/**` 时，`.github/workflows/self-host-deploy.yml`
自动 SSH 到 ECS：`git pull` → `docker compose build fc` → `up -d` → 等健康 →
跑 `run-e2e.sh`。也可 `workflow_dispatch` 手动触发。

> 换言之：**合入 `main` 即部署**，无需手动脚本。

---

## 3. 部署前准备清单

### 3.1 基础设施

- [ ] **域名与 DNS**：5 个子域（Cloud API / Supabase / MQTT / Studio / EMQX Dashboard）指向同一台机器；本地验收可用 `CADDY_TLS_MODE=internal`
- [ ] **TLS**：Let's Encrypt（`acme`）或内网 CA（`internal`）；本地 Podman/macOS 可 `off`
- [ ] **Postgres 15+**：由栈内 Supabase fork 镜像提供（`db` 服务）
- [ ] **出站网络**：Cloud API 需能访问阿里云 OSS 与模型供应商；Supabase / MQTT / AI 网关均在同一 compose 网络内
- [ ] **端口**：仅 Caddy 暴露 80/443

### 3.2 密钥与账号

| 变量 / 凭证 | 用途 |
|-------------|------|
| `JWT_SECRET`（≥32 字符） | Supabase + EMQX JWT 共用；Self-host 一切 derived key 的根 |
| `POSTGRES_PASSWORD` | 数据库 superuser |
| `ANON_KEY` / `SERVICE_ROLE_KEY` | Supabase API；可由 `gen-secrets.sh` 派生 |
| `ACCESS_KEY_ID` / `ACCESS_KEY_SECRET` | 阿里云 OSS AK |
| `ROLE_ARN` | OSS STS 扮演角色 |
| `MQTT_SERVICE_TOKEN` | Cloud API 连 EMQX 的服务 JWT |
| `PUSH_WEBHOOK_SECRET` | 推送 webhook 校验 |
| `APNS_*` | iOS 推送（生产必需则填真实值） |
| `LITELLM_MASTER_KEY` | LiteLLM 容器自身的 admin key（Cloud API 已不用） |

完整变量清单以 [`deploy/self-host/.env.example`](../../deploy/self-host/.env.example)
与 [`deploy/self-host/docker-compose.yml`](../../deploy/self-host/docker-compose.yml) 为准。

### 3.3 数据库 Schema

**常规路径：** 无需手动操作 —— 每次 `docker compose up -d` 时 `migrate` 容器按文件名
字典序幂等地应用 `services/supabase/migrations/*.sql`。

标记表落在**独立的 `_selfhost` schema**（`_selfhost.schema_migrations`），**不是**
`public`：应用侧 migration（如 `move_teamclu_to_amux`）会把 `public` 下所有基表迁到
`amux`，标记表若在 `public` 会被一起搬走、导致跟踪中断。见
[`deploy/self-host/init/apply-migrations.sh`](../../deploy/self-host/init/apply-migrations.sh)。

`seed.sql` 默认**不**应用（`APPLY_SEED=true` 才开，仅供本地 dev）。

迁移编写策略见 [`services/supabase/migrations/README.md`](../../services/supabase/migrations/README.md)。

**PostgREST 必须包含 `amux`：**

```dotenv
PGRST_DB_SCHEMAS=public,storage,graphql_public,amux
```

新增 `amux` 下的表 / RPC 后，PostgREST 需要 reload schema cache 才可见
（`NOTIFY pgrst, 'reload schema'`），否则会 404。

---

## 4. 分组件部署步骤

### 4.1 Supabase 栈

Self-host 已打包：`db`、`auth`、`rest`、`realtime`、`storage`、`kong`、`studio` 等。

**关键配置：**

- 内部 URL：`SUPABASE_URL=http://kong:8000`（FC 容器内）
- 对外 URL：`SUPABASE_PUBLIC_URL=https://${SUPABASE_DOMAIN}`
- GoTrue SMTP：默认 placeholder，真实邮件需配置 SMTP
- Storage：依赖 `imgproxy`；附件 smoke 见 `deploy/self-host/smoke/image-upload.sh`

### 4.2 Cloud API（`services/fc`）

> 目录名 `fc` 是历史遗留，与阿里云函数计算无关：它是一个由 compose 构建的普通容器。

**构建与运行：**

```bash
cd deploy/self-host
docker compose build fc && docker compose up -d fc
```

本地开发（不进容器）：`cd services/fc && npm install && npm run build`。

**核心环境变量**（权威来源：[`deploy/self-host/docker-compose.yml`](../../deploy/self-host/docker-compose.yml) 的 `fc` 服务 + [`.env.example`](../../deploy/self-host/.env.example)）：

| 变量 | 说明 |
|------|------|
| `BACKEND_KIND` | `supabase`（默认）或 `postgres` |
| `SUPABASE_URL` | Cloud API → Kong 内部地址（`http://kong:8000`） |
| `SUPABASE_PUBLIC_URL` | 返回给客户端的 Supabase 公网 URL |
| `SUPABASE_SERVICE_ROLE_KEY` | 服务端操作 |
| `SUPABASE_ANON_KEY` | Auth proxy |
| `MQTT_BROKER_URL` | 发布 MQTT ping |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | 服务账号 |
| `DATABASE_URL` | FC 直连 Postgres 的旁路：cron 任务、Apps 每应用库。`/v1` 业务 API 不用它 |
| `AUTH_BASE_URL` | Apps 平台登录所签 JWT 的 issuer/audience；**应显式设为 `https://api.teamclu-dev.ucar.cc`** |

> ⚠️ `services/fc/src/auth/base-url.ts` 对 `AUTH_BASE_URL` 是 fail-closed 的：留空
> 会直接抛错而不是回落到默认值。但 `services/fc/s.yaml` 那一层仍带着**已下线**的
> `https://cloud.ucar.cc` 默认值，所以走阿里云 FC 部署时必须显式配置。

**运行时功能开关（feature flags）：** `/v1/config/public` 与 `/v1/config/bootstrap`
会把一部分开关下发给客户端，客户端拿它覆盖自己 `build.config*.json` 里烘死的默认值
——改登录方式、渠道开关不再需要重新打包客户端。

| 变量 | 说明 |
|------|------|
| `APP_FEATURES_PROFILE` | 选用哪份 profile。compose 默认 `self-host`（那台机器就是唯一一个环境）；**`s.yaml` 故意没有默认值** |
| `APP_FEATURES_JSON` | **应急覆盖**，逐键盖在 profile 之上。日常不要用 |

现有三份 profile，一个运行中的 Cloud API 对应一份：

| profile | 部署 | 服务的品牌 |
|---|---|---|
| `self-host` | `api.teamclu-dev.ucar.cc` | 官方 TeamClu（`build.config.production.json`） |
| `belayo` | `teamclu-api.ucar.cc` | betly（品牌私仓 `brands/betly`） |
| `copilot361` | `copilot.accounting.i.test.shopee.io` | Copilot 361（品牌私仓 `brands/copilot361`） |

`s.yaml` 不给默认值，是因为它同时部署 belayo 和 copilot361 两个后端——任何默认值对其中一个都是**别的品牌的开关**（copilot361 若继承了 `belayo`，会给从没提供过手机登录的用户打开手机登录）。不设 = 不覆盖，永远安全。每个 env 文件自己写 profile 名，`deploy-aliyun-fc.sh` 的确认 banner 会打印出来。

**持久的值在代码里，不在环境变量里**：`services/fc/src/lib/feature-profiles.ts`。
原因是 belayo（Alibaba FC）那边 `s deploy` 会**整体重写** function 的环境变量表，
某个变量在这次部署所用的 env 文件里缺失不等于「保持现值」，而等于「清空」——登录
方式一旦只配在 env 里，一次无关的常规部署就会让登录按钮消失。放代码里则跟着版本走，
可 review、有 git 历史。

改一个开关 = 改 `feature-profiles.ts` 提 PR：self-host 合并到 main 自动部署生效，
belayo 跟着下次手工部署生效。

两条不下发的规则，别绕：

- **`updater` 永远不下发。** 它同时关掉启动自检，远程关错会让已装机群体失去自更新
  能力，只能手动重装。代码里的白名单直接把它丢掉，即使写进 env 也不生效。
- **`auth.webSSO` 是 AND 不是覆盖。** 允许注入 session 的 admin console 域名烘在
  桌面端二进制里（`WEBSSO_ADMIN_HOSTS`），服务端单方面打开不会生效，也不该生效。

验证（两个环境都要，belayo 没有 CI 门禁）：

```bash
curl -s https://api.teamclu-dev.ucar.cc/v1/config/public | jq   # self-host
curl -s https://teamclu-api.ucar.cc/v1/config/public | jq       # belayo
```

三份 profile 的初始值都是**照抄各自品牌 build config 已经烘死的值**，所以开启这套机制
当天客户端行为零变化——服务端只是把每个客户端本来就相信的东西再讲一遍。之后改开关就
只改 `feature-profiles.ts`，不用重新打包客户端。

品牌 build config 改了要记得同步这里：一边是默认值、一边是覆盖值，两边漂移的表现是
「开关在网络请求回来的瞬间翻转」，很难查但很好避免。

没设 profile 时返回 `{}` 属于正常（= 不覆盖）。容器日志里的
`[config] features profile=… keys=N` 是区分「没配」和「配了但没生效」的唯一手段。

**定时任务：** `docker compose --profile cron up -d`，cron 容器按计划打
`POST /internal/cron`（带 `x-cron-secret`）。

### 4.3 EMQX

- 认证：**HS256 JWT**，密码字段传 Supabase session JWT 或 `MQTT_SERVICE_TOKEN`
- `EMQX_JWT_SECRET` = `base64(JWT_SECRET)`（`gen-secrets.sh` 自动处理）
- 对外：`wss://${MQTT_DOMAIN}/mqtt`（Caddy 反代 8083）
- 对内：`mqtt://emqx:1883`

客户端 bootstrap：`GET /v1/config/bootstrap` 返回 broker URL 与连接参数。

### 4.4 阿里云 OSS（团队同步）

在 FC 环境配置：

```dotenv
ACCESS_KEY_ID=...
ACCESS_KEY_SECRET=...
ROLE_ARN=acs:ram::...:role/teamclu-oss
BUCKET=teamclu-team
REGION=cn-shenzhen
ENDPOINT=https://oss-cn-shenzhen.aliyuncs.com
```

未配置时 FC 正常启动，**团队工作区 OSS 同步不可用**。

### 4.5 团队 AI 网关

**Cloud API 自己不再开通任何网关。** 团队的共享模型是一份配置，通过
`PUT /v1/teams/:id/llm-config` 写入 `{ enabled, baseUrl, models }`，daemon 从
`GET /v1/teams/:id/workspace-config` 的 `llm` 块读走，密钥则由 daemon 本地按
`sk-tc-{actor_id[..40]}` 推导，不经过任何开通接口。

LiteLLM 容器（`ghcr.io/berriai/litellm-database`，库 `_litellm` 由 `litellm-init`
建在同一个 Postgres 上）**仍留在 compose 里**，Caddy 也仍把 `/llm/*` 反代到它 ——
既有团队的 `baseUrl` 还指着那条路径。Cloud API 与它已完全解耦，退役是单独一步。

### 4.6 amuxd（Agent 宿主）

**通常不在中心后端部署**，而是：

- Desktop 安装包自带 + launchd/systemd 服务
- Self-host 可选：`docker compose --profile daemon up -d --build amuxd`
- 开发机：`scripts/deploy-daemon.sh`

Daemon 需要：

1. 有效的 team invite token（`./amuxd/mint-invite.sh`）
2. Cloud API URL（bootstrap 拉 MQTT）
3. LLM 端点（`OPENCODE_*`）才能跑 agent session

---

## 5. 客户端对接

桌面 / iOS 构建时 baked 的 Cloud API 地址来自 `build.config.production.json`：

```json
{
  "cloudApiUrl": "https://api.teamclu-dev.ucar.cc"
}
```

| 场景 | URL |
|------|-----|
| Self-host（唯一环境） | `https://api.teamclu-dev.ucar.cc` |
| 自建的其他实例 | `https://${FC_DOMAIN}` |

**发布桌面版前：** 若 Cloud API 有 breaking 变更，需先让 Cloud API + migration 部署完成（合入 `main` 即自动部署），再发客户端。见 [`docs/release/desktop.md`](../release/desktop.md)。

Web 开发可覆盖：`VITE_CLOUD_API_URL=...`

---

## 6. 推荐部署顺序

日常改动由 CI 自动完成（见 §2）。以下顺序适用于**从零搭建一台新机器**：

```
1. Postgres + 跑 migration（baseline 或 incremental）
2. Supabase 栈（Auth / REST / Realtime / Storage）
3. 确认 PostgREST 已加载 amux schema
4. EMQX + JWT 认证配置
5. 部署 Cloud API (FC)，填入 Supabase / MQTT / OSS env
6. Caddy / 域名 / TLS
7. Smoke：healthz → bootstrap(401) → auth → create team
8. （可选）LiteLLM、OSS cron、daemon profile
9. 更新客户端 cloudApiUrl 并验证端到端
```

实际上 1–8 步在一台配好 `.env` 的机器上就是 `./bootstrap/gen-secrets.sh && ./bootstrap/up.sh` —— compose 已编排好依赖与迁移顺序。

---

## 7. 验收与监控

### 7.1 Health / Smoke

**Self-host：**

```bash
# FC
docker compose exec -T fc node -e "fetch('http://localhost:9000/healthz').then(r=>r.text()).then(console.log)"

# 公网
curl -s https://${FC_DOMAIN}/healthz

# E2E 套件
cd services/fc && sh ../../deploy/self-host/smoke/run-e2e.sh

# Storage
./smoke/image-upload.sh
```

**健康巡检（GitHub Actions）：** `.github/workflows/prod-canary.yml` 每 30 分钟探测
`https://api.teamclu-dev.ucar.cc`（可用仓库变量 `PROD_API_URL` 覆盖），失败时告警企微：

- `GET /v1/config/bootstrap` → 401
- `GET /v1/config/public` → 200

（原来探的 `POST /register` / `POST /token` 已随阿里云 STS 直连 OSS 的模式一起删掉。）

### 7.2 SQL 验收（amux）

```sql
SELECT count(*) FROM information_schema.tables
 WHERE table_schema='amux' AND table_type='BASE TABLE';  -- 期望 ~37

SELECT count(*) FROM pg_policies
 WHERE schemaname='amux' AND policyname='teams_org_guard';  -- 期望 1
```

### 7.3 业务 Smoke（REST via amux profile）

```bash
curl -sS "https://${SUPABASE_DOMAIN}/rest/v1/teams?select=id&limit=1" \
  -H "apikey: $ANON_KEY" \
  -H "Authorization: Bearer $ANON_KEY" \
  -H "Accept-Profile: amux"
```

### 7.4 FC 单元 / 集成测试

```bash
cd services/fc && npm test
cd services/supabase && npm test   # pgTAP（若已配置）
```

---

## 8. 运维与常见问题

| 现象 | 排查方向 |
|------|----------|
| 客户端报 schema 过旧 / `disable_team_share` | Cloud API 与 Supabase migration 未同步部署 |
| MQTT 连不上 | 检查 `MQTT_BROKER_URL`、Caddy WS 路由、JWT secret 一致性 |
| PostgREST 404 on `amux.*` | `PGRST_DB_SCHEMAS` 缺 `amux` 或未 reload |
| LiteLLM 503 `litellm_unavailable` | `LITELLM_MASTER_KEY` 未配置 |
| Cloud API 启动即报 `LITELLM_URL is not set` | 绕过了 compose 的默认值；显式设 `http://litellm:4000` |
| OSS sync 失败 | RAM 角色、`ROLE_ARN`、Bucket 权限 |
| Agent 不在线 | amuxd 未运行 / 未 claim invite / 需重启 daemon 重新 advertise |
| 部署成功但 API 异常 | 参考 prod-canary；检查容器是否健康、env 是否完整 |

**日志：** `docker compose logs -f fc`（或 `emqx` / `auth` / `migrate`）。

**回滚：**

- 服务：回滚 `main` 上的提交，CI 会重新部署；或在机器上 `git checkout <sha> && docker compose up -d --build fc`
- 停栈：`docker compose down`（加 `-v` 会**清库**）
- Schema：无自动回滚 —— 迁移只前滚，需要撤销就补一个新的 migration 文件

---

## 9. 相关文档索引

| 文档 | 内容 |
|------|------|
| [`deploy/self-host/README.md`](../../deploy/self-host/README.md) | Self-host 完整操作手册 |
| [`deploy/self-host/docker-compose.yml`](../../deploy/self-host/docker-compose.yml) | 服务编排 + 环境变量权威来源 |
| [`deploy/self-host/.env.example`](../../deploy/self-host/.env.example) | 可配置项清单 |
| [`.github/workflows/self-host-deploy.yml`](../../.github/workflows/self-host-deploy.yml) | 自动部署流水线 |
| [`services/supabase/migrations/README.md`](../../services/supabase/migrations/README.md) | Migration 策略 |
| [`docs/architecture/v2.md`](../architecture/v2.md) | 架构总览 |
| [`docs/openapi/teamclu-api.v1.yaml`](../openapi/teamclu-api.v1.yaml) | API 契约 |
| [`CLAUDE.md`](../../CLAUDE.md) | Cloud API 端点与版本发布约定 |

---

## 10. 最小可用 vs 完整能力对照

| 能力 | 最小部署 | 完整部署 |
|------|----------|----------|
| 登录 / 团队 / 会话 / 消息 | Supabase + FC + EMQX + migration | 同左 |
| 实时聊天 | EMQX | EMQX |
| 附件 | + Storage | + Storage |
| 团队文件同步 | + OSS + cron | + OSS + cron |
| AI Gateway / 用量 | + LiteLLM（栈内） | 同左 |
| iOS 推送 | + APNS 全套 env | 同左 |
| 中心机房 Agent | + amuxd daemon profile | 同左 |
| Apps 模块（per-app 部署） | + `APPS_DB_ADMIN_URL`、CodeUp 等 | 见 apps specs |

**最小四步：** `.env` → `gen-secrets.sh` → `up.sh` → `curl http://127.0.0.1:9000/healthz`（或 `:8080` 经 Caddy）。
