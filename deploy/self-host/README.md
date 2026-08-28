# TeamClu Self-Host

One-shot Docker Compose deployment of the full TeamClu backend stack.

---

## Quick start（首次启动）

**本地开发（推荐）：**

```bash
cd deploy/self-host

# 1. 使用本地预设（已含 CADDY_TLS_MODE=off、127.0.0.1 MQTT、免邮件验证等）
cp .env.local.example .env

# 2. 派生密钥 + 校验 + 创建 volumes 软链（Podman 必需）
./bootstrap/gen-secrets.sh

# 3. 启动全栈
./bootstrap/up.sh

# 4. 健康检查
./bootstrap/check.sh
```

**生产 / 自定义域名：** 用通用模板：

```bash
cd deploy/self-host
cp .env.example .env
# 编辑 JWT_SECRET、POSTGRES_PASSWORD、五个域名、CADDY_TLS_MODE=acme …
./bootstrap/gen-secrets.sh
./bootstrap/up.sh
```

**桌面客户端联调：**

```bash
cp packages/app/.env.local.example packages/app/.env.local
pnpm tauri:dev
```

`.env.local.example` 仅需填写 `JWT_SECRET` 时可改用 `.env.example`；本地预设已内置 dev 占位密钥，**仅限本机**，上服务器前请更换。

**生成随机密钥（可选）：**

```bash
# JWT_SECRET（64 位 hex）
openssl rand -hex 32

# POSTGRES_PASSWORD
openssl rand -base64 24 | tr -d '/+=' | head -c 32
```

写入 `.env` 后重新执行 `./bootstrap/gen-secrets.sh`。

---

## 日常启停

```bash
cd deploy/self-host

# 启动（或重启）
./bootstrap/up.sh

# 停止（保留数据）
docker compose down
# Podman 用户若 docker 是 podman 别名，同上；或：
# podman-compose --in-pod false -f docker-compose.yml -f docker-compose.podman.yml down

# 停止并清数据（慎用）
docker compose down -v
```

---

## 运行时选择：Docker Desktop vs Podman

| | Docker Desktop | Podman（macOS 常见） |
|---|---|---|
| 检测 | `docker compose version` **无** `podman-compose` 提示 | 出现 `Executing external compose provider ... podman-compose` |
| 启动命令 | `./bootstrap/up.sh` 或 `docker compose up -d` | **必须** `./bootstrap/up.sh` |
| 宿主端口 | Caddy `80` / `443` | Caddy `8080` / `8443`；FC 直连 `9000` |
| 依赖链 | 完整 `depends_on: service_healthy` | 通过 `docker-compose.podman.yml` 简化 |
| **VM 内存** | Docker Desktop 默认 8GiB+ | **默认仅 2GiB** — Supabase + EMQX 易 OOM；见下方 |

Podman 用户 **`不要`** 直接跑裸 `docker compose up -d`，容易遇到：

- `getxattr .../volumes/db/jwt.sql: no such file` → 先跑 `gen-secrets.sh`（会创建 `volumes` 软链）
- `depends on container ... not found` → 用 `./bootstrap/up.sh`（`--in-pod false` + podman overlay）
- `rootlessport cannot expose privileged port 80` → `up.sh` 自动映射 `8080`/`8443`

**Podman Machine 内存（MQTT 必需）：** 默认 `2GiB` 不够跑完整 Supabase + EMQX。桌面端 MQTT 报 `connection closed by peer` 时，先查 EMQX 是否被 OOM 杀：

```bash
podman inspect teamclaw-self-host_emqx_1 --format '{{.State.OOMKilled}}'   # true = 内存不足
podman machine stop
podman machine set --memory 8192 --cpus 4
podman machine start
cd deploy/self-host && podman-compose --in-pod false -f docker-compose.yml -f docker-compose.podman.yml up -d --force-recreate emqx
```

建议 **≥ 6GiB**（推荐 8GiB）。改完后 `./bootstrap/check.sh` 应看到 `emqx (MQTT)` healthy。

---

## 本地开发（macOS / Podman）

### 1. `.env` 推荐配置

```dotenv
CADDY_TLS_MODE=off
FC_DOMAIN=api.example.com
SUPABASE_DOMAIN=supabase.example.com
MQTT_DOMAIN=mqtt.example.com
STUDIO_DOMAIN=studio.example.com
EMQX_DASHBOARD_DOMAIN=emqx.example.com
```

然后：

```bash
./bootstrap/gen-secrets.sh
./bootstrap/up.sh
```

`gen-secrets.sh` 在 `off` 模式下会写入 `CADDY_SITE_SCHEME=http://`，让 Caddy **监听容器内 80 端口**（配合 `8080:80` 映射）。若只设 `auto_https off` 而不加 `http://` 前缀，Caddy 2.x 仍会绑在 `:443`，导致 `8080` 无响应。

### 2. 本地访问（不要改 `/etc/hosts`）

`.env` 里的 `FC_DOMAIN`、`MQTT_DOMAIN` 等是为 **Caddy 虚拟主机** 与 **服务器 DNS** 准备的。本地联调时 **不要** 把它们写进 `/etc/hosts`——否则本机会一直把 `api.example.com` 解析到 `127.0.0.1`，后续部署到真实服务器、或同一台机器上要验证线上域名时容易踩坑。

本地推荐一律用 **环回地址 + 端口**；需要验证 Caddy 路由时用 **curl 的 `Host` 头**（CLI 可设，浏览器不能靠改 hosts 来模拟生产域名）。

| 服务 | 本地推荐 URL | 说明 |
|------|----------------|------|
| Cloud API（客户端 / Desktop） | `http://127.0.0.1:9000` | FC 已映射 `9000`，**首选** |
| Cloud API（测 Caddy 反代） | `http://127.0.0.1:8080` + `Host: api.example.com` | 见下方 curl 示例 |
| Supabase（测 Caddy） | `http://127.0.0.1:8080` + `Host: supabase.example.com` | 浏览器打开需真实 DNS，本地一般用 Studio 容器或 CLI |
| EMQX MQTT TCP（Desktop） | `mqtt://127.0.0.1:1883` | 配合 `MQTT_BROKER_URL` |
| EMQX WebSocket（Web 浏览器） | `ws://127.0.0.1:8083/mqtt` | 需在 compose 暴露 `8083:8083`（默认只暴露 `1883`）；见 §4.C |

### 3. 验收

```bash
# 一键健康检查（推荐）
./bootstrap/check.sh

# 若 fc/caddy 卡在 Created，可顺带尝试拉起
./bootstrap/check.sh --try-start
```

手动探测：

```bash
# FC 直连
curl -s http://127.0.0.1:9000/healthz
# {"ok":true}

# 经 Caddy 反代（Host 头模拟 .env 里的 FC_DOMAIN，无需改 hosts）
curl -s http://127.0.0.1:8080/healthz -H 'Host: api.example.com'
# {"ok":true}

# E2E（栈就绪后）
cd ../../services/fc && sh ../../deploy/self-host/smoke/run-e2e.sh
```

`check.sh` 会检查关键容器状态、FC/Caddy HTTP 探针，并在失败时打印修复建议；退出码 `0` = 核心栈正常，`1` = 有关键问题。

### 4. 本地客户端联调（Desktop / Web）

客户端 **不能** 在设置里改 Cloud API 地址——`cloudApiUrl` 只在 **构建/开发时** 通过环境变量注入（见 `packages/app/src/lib/server-config.ts`）。MQTT 地址则在登录后由 `GET /v1/config/bootstrap` 下发，并缓存在 `localStorage`（键 `teamclu.serverConfig`）。

#### A. 后端 `.env`

若已 `cp .env.local.example .env`，则已包含 `MQTT_BROKER_URL=mqtt://127.0.0.1:1883` 与 `ENABLE_EMAIL_AUTOCONFIRM=true`。若用 `.env.example`，请手动补上这两项。

修改后重启 FC 容器使 bootstrap 生效：

```bash
cd deploy/self-host
docker compose restart fc
# Podman：podman restart teamclaw-self-host_fc_1
```

#### B. Desktop（Tauri）——推荐直连 FC

```bash
cp packages/app/.env.local.example packages/app/.env.local
```

或手动创建 **`packages/app/.env.local`**：

```dotenv
VITE_CLOUD_API_URL=http://127.0.0.1:9000
```

然后启动桌面客户端（**必须** 在存在 `.env.local` 后启动，以便 Rust 与前端共用同一 `VITE_CLOUD_API_URL`）：

```bash
pnpm tauri:dev
# 跳过向导：pnpm tauri:dev -- --skip-setup --skip-daemon-onboarding
```

Rust 侧（`apps/desktop/build.rs`）在编译时烘焙 `CLOUD_API_URL`；`pnpm tauri:dev` 会通过 `scripts/rust-build-env.js` 读取 `packages/app/.env.local`。若你改了 `.env.local` 后 Team Shared 仍报 `PGRST301`，**完全退出** 桌面进程再跑一次 `pnpm tauri:dev`（触发 Rust 重编译）。

Desktop 本地联调 **用 `:9000` 直连即可**，不必经 Caddy，也 **不要** 为 `.env` 里的域名改 `/etc/hosts`。

#### C. 纯 Web 前端（`pnpm dev`）

API 同样用环回地址。浏览器 MQTT 必须走 **WebSocket**；Caddy 按 `MQTT_DOMAIN` 做虚拟主机，浏览器连 `127.0.0.1:8080` 时无法带上正确的 `Host`，因此 **不要** 用 `ws://mqtt.example.com:8080` + hosts，改为 **直连 EMQX WS 端口**：

1. 在本地临时暴露 EMQX WebSocket（默认 compose 只映射 `1883`）。例如在 `deploy/self-host/docker-compose.override.yml`（勿提交）：

```yaml
services:
  emqx:
    ports:
      - "8083:8083"
```

2. 重启 emqx 后，在 `packages/app/.env.local`：

```dotenv
VITE_CLOUD_API_URL=http://127.0.0.1:9000
VITE_MQTT_WS_URL=ws://127.0.0.1:8083/mqtt
```

本地 Web 联调成本较高时，优先用 **Desktop（Tauri）** 测 self-host 后端。

#### D. 本地登录（无 SMTP）

self-host 默认 **没有真实邮件服务器**，登录页的「发送验证码」会失败（`Error sending magic link email`）。本地推荐：

**方式 1 — 快速试用（匿名，推荐）**

`.env.local.example` 已设 `ENABLE_ANONYMOUS_USERS=true`。若你用的是旧 `.env`，请加上并重启 auth：

```bash
cd deploy/self-host
# .env 中：ENABLE_ANONYMOUS_USERS=true
grep -q '^ENABLE_ANONYMOUS_USERS=true' .env || echo 'ENABLE_ANONYMOUS_USERS=true' >> .env
podman-compose --in-pod false -f docker-compose.yml -f docker-compose.podman.yml up -d --no-deps auth
```

桌面端登录页点 **「快速试用」**（Try anonymously），无需邮箱。

**方式 2 — 邮箱+密码（CLI，桌面 UI 暂无密码登录）**

`ENABLE_EMAIL_AUTOCONFIRM=true` 时可直接注册，无需收邮件：

```bash
curl -s -X POST http://127.0.0.1:9000/v1/auth/signup \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"your-local-password"}'

curl -s -X POST http://127.0.0.1:9000/v1/auth/signin-password \
  -H 'Content-Type: application/json' \
  -d '{"email":"you@example.com","password":"your-local-password"}'
```

返回的 `access_token` 可用于 API 调试；桌面端仍需 OTP 或匿名登录。

**方式 3 — 真实 SMTP**

在 `.env` 配置可用的 `SMTP_*`（或接入 Mailpit 等），OTP 邮件才能发到真实邮箱。

登录/升级账号的邮件模板已改为**仅发送 6 位验证码**（无 Magic Link），模板在 `supabase/email-templates/`，由 `templates-server` 容器供 GoTrue 拉取。部署后需重启 `auth` 与 `templates-server` 容器生效。

**方式 4 — Google 登录**

三端（桌面 loopback、iOS `ASWebAuthenticationSession`、Expo）都走同一条链路：
客户端 → FC `/v1/auth/oauth/google/authorize` → 302 → GoTrue
`/auth/v1/authorize?provider=google`。GoTrue 未配置 Google 时这一步直接 400
`Unsupported provider: provider is not enabled`，客户端只会看到一个失败的浏览器窗口。

前置：Google Cloud Console 里建一个 **Web application** 类型的 OAuth client
（**不能用 Desktop app 类型** —— 它注册不了 https 重定向，而 GoTrue 是在服务端
用 client_secret 去 Google 换 token 的，Desktop client 必然 `redirect_uri_mismatch`）。
Authorized redirect URI 填：

```
https://<SUPABASE_DOMAIN>/auth/v1/callback
```

然后在 `.env` 里：

```bash
cd deploy/self-host
ENABLE_GOOGLE_SIGNUP=true
GOOGLE_CLIENT_ID=<web client id>
GOOGLE_CLIENT_SECRET=<web client secret>
# 客户端回调必须在允许列表里，否则 GoTrue 会把 redirect 改写回 SITE_URL
ADDITIONAL_REDIRECT_URLS=http://127.0.0.1:*/callback,teamclu://auth-callback
docker compose up -d --no-deps auth
```

线上 ECS 不用手改 `.env`：把 `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` 设成
GitHub Actions secret，`self-host-deploy.yml` 会同步进 `.env` 并按两者是否都存在
自动开关 `ENABLE_GOOGLE_SIGNUP`；删掉 secret 即关闭。

**如果机器在墙内，还需要一个出网代理。** GoTrue 每次 authorize 都要拉
`accounts.google.com` 的 OIDC discovery；拉不到就挂到网关超时（现象是 504
`request_timeout`，很容易误判成 GoTrue 有 bug）。设 `AUTH_EGRESS_PROXY`
（线上同样走 GitHub secret）：

```bash
AUTH_EGRESS_PROXY=https://user:password@proxy.example.com:3129
```

**必须是 `https://`，即到代理这一跳本身也加密。** 用明文 `http://` 代理时，
`CONNECT accounts.google.com:443` 这一行在链路上是可见的，会被按关键词重置 ——
表现为代理明明连上了 Google，却写不回那个 `200 Connection established`。
外层 TLS 的 SNI 是代理自己的域名，不含敏感关键词，所以能过。

注意这条链路上有两个"必须能到 Google"的角色，别混淆：**服务端**（GoTrue 换
token、验签）和**终端用户浏览器**（打开 Google 授权页）。代理只解决前者。

桌面端按钮另受 `build.config.*.json` 的 `auth.google` 控制，默认 `false`，
服务端跑通后再打开。

##### Apple 登录（iOS 原生，和 Google 不是一条路）

iOS 用系统弹窗拿到 id_token，POST 给 FC `/v1/auth/signin-idtoken`，FC 再转
GoTrue `/auth/v1/token?grant_type=id_token`。**没有浏览器跳转，也没有
client_secret**：这条 grant 是拿 Apple 的公开 JWKS 验签的。

因此只要两个变量，且都不是机密（默认已开，`.env` 里通常不用写）：

```bash
ENABLE_APPLE_SIGNUP=true
# 逗号分隔的 aud 白名单，就是 iOS 的 bundle id
APPLE_CLIENT_IDS=tech.teamclaw.mobile,com.teamclu.mobile
```

没开的现象很有迷惑性：系统弹窗先走完、看着像成功了，最后才报
`Provider (issuer "https://appleid.apple.com") is not enabled`，容易被当成 iOS 端 bug。

**`appleid.apple.com` 走直连，不走 `AUTH_EGRESS_PROXY`**（已在 `NO_PROXY` 里）。
墙内直连 Apple 本来就通（~0.7s），而那个代理的目标白名单是给 Google 配的，
Apple 过去会撞上 tinyproxy 的 `Filtered`，最终表现成 id_token grant 500
`unexpected_failure` —— 和"没开 provider"是两回事，日志里要分清。

#### E. 切换后端后清理缓存

若之前连过线上环境，清掉浏览器/Tauri WebView 里的 MQTT 缓存，避免沿用旧 broker：

- 开发者工具 → Application → Local Storage → 删除 `teamclu.serverConfig`
- 或退出登录后重新登录

#### F. 验收客户端链路

```bash
# 1. API 可达（与 VITE_CLOUD_API_URL 一致）
curl -s http://127.0.0.1:9000/healthz

# 2. bootstrap 里的 MQTT（需先注册/登录拿到 token；或看 FC 容器 env）
docker compose exec fc printenv MQTT_BROKER_URL
# 期望：mqtt://127.0.0.1:1883

# 3. 桌面/Web 登录 → 创建团队 → 发消息；MQTT 连不上时查 1883 端口与上一步 env
```

设置页「通用」里显示的 Cloud API URL 为只读，来自上述 `VITE_CLOUD_API_URL` 或 `build.config.json`，属正常现象。

---

## Prerequisites

| Requirement | Detail |
|---|---|
| **Docker Engine** | 24+ with Compose v2 plugin — **或** Podman + podman-compose（见上） |
| **`JWT_SECRET`** | Minimum 32 characters; everything else is derived from it |
| **`POSTGRES_PASSWORD`** | Any strong password for the Supabase Postgres superuser |
| **DNS A-records** | Five subdomains → host IP（`CADDY_TLS_MODE=acme` 时必需） |
| **Ports** | 生产：`80` + `443`；Podman 本地：`8080` + `8443` + `9000` + `1883` |
| **`openssl`** | Required by `bootstrap/gen-secrets.sh` |

---

## Bootstrap 脚本说明

| 脚本 | 作用 |
|------|------|
| `bootstrap/up-app.sh` | 基础栈 + migrate 已 OK 时，仅重建并启动 fc/caddy（Podman 常见） |
| `bootstrap/check.sh` | 快速健康检查：关键容器状态 + FC/Caddy HTTP 探针；失败时输出修复建议；`--try-start` 可尝试拉起卡住的 fc/caddy |
| `bootstrap/reset-data.sh` | 清卷并重建（`.env` 的 `POSTGRES_PASSWORD` 与已有 Postgres 卷不一致时用） |
| `bootstrap/gen-secrets.sh` | 从 `JWT_SECRET` 派生 `ANON_KEY` / `SERVICE_ROLE_KEY` / `MQTT_SERVICE_TOKEN`；校验 `POSTGRES_PASSWORD`；根据 `CADDY_TLS_MODE` 写入 Caddy 变量；创建 `volumes` → `supabase/volumes` 软链 |
| `bootstrap/link-volumes.sh` | 单独创建 volumes 软链（`gen-secrets.sh` 已自动调用） |
| `bootstrap/up.sh` | 检测 Docker/Podman；应用 `docker-compose.podman.yml`；清理残留容器；按序等待 db → migrate → fc → caddy |
| `init/gitea-bootstrap.sh` | Gitea 首次安装：建 org（`GITEA_OWNER`）、bot 用户、API token；幂等，可重复执行 |

---

## One-shot bring-up（生产 / Docker Desktop）

```bash
cd deploy/self-host
cp .env.example .env
# 填写 JWT_SECRET、POSTGRES_PASSWORD、五个域名、ACME_EMAIL
# CADDY_TLS_MODE=acme（默认）

./bootstrap/gen-secrets.sh
./bootstrap/up.sh
# 或：docker compose up -d
```

Caddy 会自动申请 Let's Encrypt 证书。Migration 首次启动时执行，之后幂等跳过。

### 失败后重置

```bash
cd deploy/self-host
./bootstrap/gen-secrets.sh
./bootstrap/up.sh
```

若修改过 `CADDY_TLS_MODE`，还需清 Caddy 持久化配置（否则会沿用旧 autosave）：

```bash
docker compose stop caddy   # 或 podman stop teamclaw-self-host_caddy_1
docker volume rm teamclaw-self-host_caddy_config   # 保留 caddy_data 可留证书
./bootstrap/gen-secrets.sh
./bootstrap/up.sh
```

---

## Services

| Service | Image | Role |
|---|---|---|
| `db` | `supabase/postgres` | Postgres 15 (Supabase fork); data volume `db_data` |
| `auth` | `supabase/gotrue` | GoTrue JWT auth service |
| `rest` | `postgrest/postgrest` | PostgREST — REST layer over Postgres |
| `realtime` | `supabase/realtime` | WebSocket broadcast + presence |
| `storage` | `supabase/storage-api` | File storage API |
| `imgproxy` | `darthsim/imgproxy` | On-the-fly image transforms for storage |
| `meta` | `supabase/postgres-meta` | Postgres metadata REST API |
| `studio` | `supabase/studio` | Supabase Studio dashboard UI |
| `kong` | `kong` | API gateway; internal entry point for all Supabase services |
| `vector` | `timberio/vector` | Log collector; reads from Docker socket |
| `emqx` | `emqx/emqx:5.10.3` | MQTT broker with JWT authenticator |
| `migrate` | `postgres:15-alpine` | One-shot migration runner; exits 0 when done |
| `litellm-init` | `postgres:15-alpine` | One-shot; creates the `_litellm` database inside `db`; exits 0 when done |
| `litellm` | `ghcr.io/berriai/litellm-database` | AI 网关；FC 在此开团队预算与虚拟 key |
| `fc` | built from `services/fc` | TeamClu Cloud API (Node.js); the only app-level backend |
| `caddy` | `caddy:2` | Reverse proxy + automatic TLS; **only service with host ports** |
| `cron` _(opt-in)_ | `curlimages/curl` | Polls FC cron endpoints every 15 min |
| `gitea` | `gitea/gitea:1.22` | Per-app private git repos (Apps module); HTTP via Caddy, SSH on host `GITEA_SSH_PORT` |
| `postgres` _(opt-in)_ | `postgres:15-alpine` | Standalone Postgres backend for FC when `BACKEND_KIND=postgres` |

**Host ports（因运行时而异）：**

| 运行时 | 映射 |
|--------|------|
| Docker Desktop | Caddy `80`/`443`；EMQX `1883` |
| Podman rootless | Caddy `8080`→80、`8443`→443；FC `9000`；EMQX `1883` |

Gitea SSH（Apps 模块 git push/fetch）另映射 **`GITEA_SSH_PORT`（默认 `2222`）→ 容器 `:22`**。生产 ECS 安全组须放行该端口，否则笔记本/daemon 无法 push。

其余服务仅在 `teamclaw-self-host_default` 内部网络通信。

---

## Gitea（Apps 模块 git）

Gitea 为每个 app 提供私有 git 仓（`tc-app-{appId}`）。HTTP/HTTPS 经 Caddy 反代；**SSH 不经过 Caddy**，客户端直连 `GITEA_DOMAIN:GITEA_SSH_PORT`（默认 `2222`）。

### 1. `.env` 变量

| 变量 | 说明 |
|------|------|
| `GITEA_DOMAIN` | Caddy 虚拟主机 + `ssh_url` 里的主机名 |
| `GITEA_SSH_PORT` | 宿主机 SSH 映射（默认 `2222`） |
| `GITEA_URL` | FC 调 Gitea REST API 的 base URL（无尾斜杠）。生产用 `https://<GITEA_DOMAIN>`；compose 内也可用 `http://gitea:3000` |
| `GITEA_OWNER` | 拥有所有 app 仓的 org（如 `teamclaw-apps`） |
| `GITEA_TOKEN` | bot 用户的 API token（bootstrap 脚本生成） |
| `GITEA_ADMIN_*` / `GITEA_BOT_*` | 首次 bootstrap 用；见 `.env.example` |

三者 `GITEA_URL` + `GITEA_TOKEN` + `GITEA_OWNER` 缺一，建 app 会 503 `gitea_unavailable` 并点名空变量。

### 2. 首次部署（生产 / ECS）

```bash
cd deploy/self-host
# .env 中设置 GITEA_DOMAIN、GITEA_SSH_PORT、GITEA_ADMIN_PASSWORD、GITEA_BOT_PASSWORD …
./bootstrap/gen-secrets.sh
./bootstrap/up.sh

# 等 gitea healthy 后一次性 bootstrap
./init/gitea-bootstrap.sh
# 输出 GITEA_TOKEN=… → 写入 .env
docker compose up -d fc
```

**安全组：** 除 80/443/1883 外，ECS 须允许入站 **TCP `GITEA_SSH_PORT`**（默认 2222），否则开发者笔记本无法 `git push`。

DNS：为 `GITEA_DOMAIN` 添加 A 记录指向本机（与 api/supabase 等同级）。

### 3. 本地开发

`.env.local.example` 已含 `GITEA_DOMAIN=gitea.example.com`、`GITEA_SSH_PORT=2222`、`GITEA_URL=http://gitea:3000`。Caddy 在 `:8080` 反代 HTTP：

```bash
curl -s http://127.0.0.1:8080/api/healthz -H 'Host: gitea.example.com'
# ok

# SSH（映射到宿主机 2222）
ssh -p 2222 git@127.0.0.1
```

本地 bootstrap 同上：`./init/gitea-bootstrap.sh`。

### 4. 验收清单（Task 0 / 设计 §9.4 第一层）

手动步骤（本 session 不跑 ECS E2E）：

- [ ] `docker compose ps gitea` → healthy
- [ ] `curl https://<GITEA_DOMAIN>/api/healthz`（或本地 Host 头）→ `ok`
- [ ] `./init/gitea-bootstrap.sh` → org + bot + `GITEA_TOKEN`
- [ ] FC 容器 `printenv GITEA_URL GITEA_OWNER` 非空；`GITEA_TOKEN` 已设置
- [ ] 从笔记本：`ssh -p $GITEA_SSH_PORT -T git@$GITEA_DOMAIN`（Gitea 会回复 shell 不可用 — 说明 SSH 可达）
- [ ] （后续 Task）建 app → seed push → `git-head` → deploy — 需真实桌面 + daemon

`services/fc` 守卫：

```bash
cd services/fc && npx tsx --test test/deploy-env-parity.test.ts
```

---

## Internal vs public URL split

Two URL pairs carry different values depending on who is calling:

### Supabase

| Variable | Value | Used by |
|---|---|---|
| `SUPABASE_URL` | `http://kong:8000` | FC (internal, over Docker network) |
| `SUPABASE_PUBLIC_URL` | `http(s)://${SUPABASE_DOMAIN}` | Clients (browser, mobile, desktop) |

`gen-secrets.sh` 在 `CADDY_TLS_MODE=off` 时写 `http://`，否则 `https://`。
Podman 本地需在 URL 后加端口（如 `:8080`）。

### MQTT

| Path | Value | Used by |
|---|---|---|
| Internal plaintext | `mqtt://emqx:1883` | FC service (inside Docker network) |
| Public WebSocket | `wss://${MQTT_DOMAIN}/mqtt` | Clients (browser WS, mobile, desktop) |

Caddy proxies `${MQTT_DOMAIN}` to EMQX's WebSocket listener on port 8083
(`/mqtt` path). FC connects directly to port 1883 over plaintext — the env var
`MQTT_USE_TLS=false` makes this explicit.

---

## EMQX authentication model

EMQX uses a single **HMAC/HS256 JWT authenticator** (configured in
`emqx/emqx.conf`). The JWT is read from the **MQTT password field**; the
MQTT username is ignored for auth purposes.

- **End-user clients** (desktop, mobile) pass their **Supabase session JWT**
  (signed with `JWT_SECRET`) as the MQTT password. No separate MQTT credential
  is needed.
- **FC service** passes `MQTT_SERVICE_TOKEN` as the MQTT password. This token
  is also a JWT signed with `JWT_SECRET`, minted by `gen-secrets.sh` with
  `role=service_role`.

`EMQX_JWT_SECRET` is the **base64-encoded** form of `JWT_SECRET`
(`secret_base64_encoded=true` in emqx.conf). `gen-secrets.sh` derives it
automatically:

```bash
EMQX_JWT_SECRET="$(printf '%s' "$JWT_SECRET" | openssl base64 -A)"
```

Signatures are made against the raw `JWT_SECRET`, so Supabase-issued tokens
verify correctly against the EMQX authenticator without any re-signing.

---

## Migrations

Migrations are applied automatically on every `docker compose up -d` by the
`migrate` service. They are **idempotent**: each file is tracked in
`_selfhost.schema_migrations`; on re-run the log shows:

```
skip (already applied): 20240101000000_init.sql
...
apply-migrations: done
```

No migration is applied twice. Re-running `up` is safe.

The marker table deliberately lives in its own `_selfhost` schema rather than
`public`: app migrations (e.g. `move_teamclu_to_amux`) relocate every `public`
base table into `amux`, which would sweep the marker along and break tracking
mid-sequence. See `init/apply-migrations.sh`.

To check migration status:

```bash
docker compose logs migrate
```

---

## Object storage (external OSS)

OSS is **not bundled**. Fill in the Alibaba OSS credentials in `.env`:

```dotenv
ACCESS_KEY_ID=<your-key-id>
ACCESS_KEY_SECRET=<your-key-secret>
ROLE_ARN=acs:ram::123456789:role/teamclu-oss
BUCKET=teamclu-team
REGION=cn-shenzhen
ENDPOINT=https://oss-cn-shenzhen.aliyuncs.com
```

If left blank (the default), the FC service starts normally but **file-sync
(team workspace OSS sync) will be unavailable**. All other API functionality
is unaffected.

---

## Opt-in profiles

### Cron (scheduled background jobs)

```bash
docker compose --profile cron up -d
```

Adds the `cron` service, which POSTs to FC's `/internal/cron` endpoint every
15 minutes for OSS-related maintenance tasks. Requires `CRON_TRIGGER_SECRET`
to be set in `.env` (gen-secrets does **not** generate this; pick any random
string).

### Standalone Postgres backend

```bash
# In .env:
BACKEND_KIND=postgres
DATABASE_URL=postgres://postgres:postgres@postgres:5432/postgres

docker compose --profile postgres up -d
```

Adds a dedicated `postgres:15-alpine` container for FC to use directly instead
of routing through the Supabase stack. Useful for minimal deployments that do
not need GoTrue auth or PostgREST.

### Running the daemon (opt-in)

The TeamClu daemon (`amuxd`) can run inside the stack as an opt-in service. On
first start it **auto-joins a team** using a one-time invite token, persists its
identity to the `amuxd_state` volume, connects to EMQX, and registers itself as
an **agent actor** in the team. It then provides presence + MQTT connectivity.

The image bundles **opencode** as the ACP agent. To actually run agent sessions,
point it at an OpenAI-compatible LLM via `OPENCODE_*` in `.env` (base URL + key +
model). If `OPENCODE_API_KEY` is left blank, the daemon stays **presence-only**
(joins + MQTT, but agent discovery is disabled and it won't run sessions).

> opencode caveat: `opencode acp` does not implement ACP `session/cancel`, so
> interrupting a running turn has no effect (the turn runs to completion).

A team must exist before the daemon can join. Then:

```bash
# 1. Mint a daemon invite (uses the first team if you don't pass a TEAM_ID).
#    Prints an AMUXD_JOIN_TOKEN=... line.
./amuxd/mint-invite.sh                 # or: ./amuxd/mint-invite.sh <TEAM_ID>

# 2. In .env, set the join token and (to run agents) the LLM provider:
#    AMUXD_JOIN_TOKEN=<token from step 1>
#    OPENCODE_BASE_URL=https://your-openai-compatible-endpoint/v1
#    OPENCODE_API_KEY=<your key>
#    OPENCODE_MODEL=<model id>

# 3. Build + start the daemon.
docker compose --profile daemon up -d --build amuxd

# 4. Watch it claim the invite and connect.
docker compose logs -f amuxd
```

The daemon reaches the cloud API at the internal `http://fc:9000`
(`TEAMCLU_CLOUD_API_URL`, set in `docker-compose.yml`) and resolves its MQTT
broker (`mqtt://emqx:1883`) from `GET /v1/config/bootstrap`. It authenticates to
EMQX with its actor id + Supabase access token (the single JWT authenticator
accepts it — see [EMQX authentication model](#emqx-authentication-model)).

To re-join a different team, remove the persisted identity first:

```bash
docker compose --profile daemon down
docker volume rm teamclaw-self-host_amuxd_state
# then set a fresh AMUXD_JOIN_TOKEN and bring it back up
```

---

## TLS modes

`CADDY_TLS_MODE` 控制 Caddy 行为。修改后 **必须** 重新跑 `./bootstrap/gen-secrets.sh`，
必要时清 `teamclaw-self-host_caddy_config` volume，再 `./bootstrap/up.sh`。

| Mode | Value | Effect |
|---|---|---|
| `acme` | `CADDY_TLS_MODE=acme` | **默认。** Let's Encrypt。需公网 DNS + 80/443 可达。 |
| `internal` | `CADDY_TLS_MODE=internal` | 内置 CA 自签证书（`tls internal`）。本地 HTTPS 测试。 |
| `off` | `CADDY_TLS_MODE=off` | 纯 HTTP。Caddy 监听容器 **:80**（`CADDY_SITE_SCHEME=http://`）。 |

`gen-secrets.sh` 派生：

| 变量 | `off` | `internal` | `acme` |
|------|-------|------------|--------|
| `CADDY_GLOBAL_TLS` | `auto_https off` | （空） | （空） |
| `CADDY_SITE_TLS` | （空） | `tls internal` | （空） |
| `CADDY_SITE_SCHEME` | `http://` | （空） | （空） |

Caddyfile 站点地址为 `{$CADDY_SITE_SCHEME}{$FC_DOMAIN}` 等，避免 `off` 模式下误绑 `:443`。

**本地 smoke 示例：**

```dotenv
CADDY_TLS_MODE=off
FC_DOMAIN=api.example.com
SUPABASE_DOMAIN=supabase.example.com
# ...
```

**本地 HTTPS 示例（Docker Desktop，标准 443）：**

```dotenv
CADDY_TLS_MODE=internal
FC_DOMAIN=api.localhost
SUPABASE_DOMAIN=supabase.localhost
```

编辑 `.env` 后：`./bootstrap/gen-secrets.sh` → `./bootstrap/up.sh`。

---

## Health checks

```bash
# FC — Podman 本地已暴露 9000
curl -s http://127.0.0.1:9000/healthz

# FC — 经 Caddy（Podman 用 8080 + Host 头）
curl -s http://127.0.0.1:8080/healthz -H 'Host: api.example.com'

# FC — 容器内（Docker Desktop 未映射 9000 时）
docker compose exec -T fc node -e \
  "fetch('http://localhost:9000/healthz').then(r=>r.text()).then(console.log)"

# EMQX
docker compose exec -T emqx /opt/emqx/bin/emqx ctl status

# Supabase Kong（容器内）
docker compose exec -T fc node -e \
  "fetch('http://kong:8000/health').then(r=>r.text()).then(console.log)"

# LiteLLM 网关（宿主机 loopback）
curl -s http://127.0.0.1:4000/health/liveliness
```

## LiteLLM AI 网关

随 `docker compose up` 默认启动。FC 通过 `LITELLM_MASTER_KEY` 调用其管理 API
（`/team/new`、`/key/generate`、`/key/info`）为每个团队开预算和虚拟 key,支撑
`POST /v1/teams/:id/litellm/setup`。

**数据库**：不单独起 postgres。`litellm-init` 在 Supabase 的 `db` 容器里建一个
独立的 `_litellm` 数据库（LiteLLM 的 prisma schema 有约 20 张表,放进 `postgres`
会和应用表冲突）——与 Supabase 自己的 `_supabase`/`_analytics` 是同一套做法。
建库用一次性 service 而不是 `volumes/db/*.sql`,因为 init 脚本只在**集群首次
初始化**时执行,已经部署过的栈永远不会跑到。

**网络**：不经 Caddy,没有公网域名。FC 走 `http://litellm:4000`;管理操作走宿主机
`127.0.0.1:4000`（要用 UI 就本地 SSH 隧道）。master key 是完整管理凭证,除非有
防火墙,否则不要把它发布到 `0.0.0.0`。

**配置模型**：开箱没有任何模型。`store_model_in_db: true` 已打开,可在管理 UI 里
加模型并持久化到 `_litellm`;也可以改用 `litellm/config.yaml` 里注释掉的静态
`model_list`,并把对应 key 写进 `.env`。

```bash
# 加一个模型（示例）
curl -s http://127.0.0.1:4000/model/new \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" \
  -H 'Content-Type: application/json' \
  -d '{"model_name":"gpt-4o","litellm_params":{"model":"openai/gpt-4o","api_key":"sk-..."}}'
```

> **`.env` 里的 `LITELLM_URL` 留空是正常的 —— compose 会替换成内置网关。**
> `docker-compose.yml` 用 `${LITELLM_URL:-http://litellm:4000}` 兜底,所以留空即指向
> 栈内 LiteLLM。只有改用**外部**网关时才需要显式填。
>
> 若绕过 compose 直接把空的 `LITELLM_URL` 传给 FC,`services/fc/src/lib/litellm.ts`
> 现在会**直接抛错**(拒绝猜测 AI 网关地址),而不是静默回落到某个第三方托管网关 ——
> 早期版本的这个回落行为已移除。该检查只在 `LITELLM_MASTER_KEY` 已配置时才会触达,
> 因此完全不跑 LiteLLM 的部署不受影响。
>
> **Rust 版（`litellm-rust`）暂不可用**：仍是 early beta,只有 amd64、无 arm64,且
> `v1.89.3` 实测所有路由（含 `/team/new`、`/v1/chat/completions`）均返回 404。等它补齐
> 管理 API 后,换掉 image 一行即可,`config.yaml` 官方承诺不变。

### Storage smoke (image upload)

Verifies the object-storage data-path end to end — creates a public bucket,
uploads a PNG through the Storage API (via Kong), downloads it from the public
URL, and asserts the bytes round-trip. Run after the stack is healthy:

```bash
./smoke/image-upload.sh
# PASS: image uploaded and round-tripped byte-for-byte
```

It uses the `SERVICE_ROLE_KEY` from `.env` (bypasses RLS — operator smoke, not
an end-user auth test) and runs a throwaway `curl` container on the compose
network, so it needs no host-published ports.

---

## Teardown

```bash
# Stop all services and remove volumes (destroys all data)
docker compose down -v

# Also remove the env file
rm -f .env .env.bak
```

---

## Troubleshooting

| 现象 | 原因 | 处理 |
|------|------|------|
| `JWT_SECRET missing or < 32 chars` | `.env` 未填 | 生成随机串写入 `.env`，再 `gen-secrets.sh` |
| `POSTGRES_PASSWORD missing` | `.env` 未填 | 同上 |
| `getxattr ... jwt.sql: no such file` | Podman 路径解析 | `./bootstrap/gen-secrets.sh`（创建 `volumes` 软链） |
| `depends on container ... not found` / `no container ... fc_1 found` | podman-compose 把 migrate→fc 依赖 ID 写进容器，migrate 重建后 fc 无法 start | **务必** `./bootstrap/up.sh`（会先起基础栈 → migrate → 无依赖重建 fc/caddy）；或 `./bootstrap/check.sh --try-start` |
| `rootlessport ... port 80` | Podman 无法绑特权端口 | 用 `up.sh`（8080/8443） |
| Caddy `8080` Empty reply | `off` 模式未设 `http://` 前缀 | `gen-secrets.sh` + 清 `caddy_config` volume + 重启 caddy |
| `supabase-auth` / `supabase-analytics` password failed | `down -v` **不会**删 bind mount `supabase/volumes/db/data`，旧 Postgres 密码仍在 | `./bootstrap/reset-data.sh`（脚本会 `rm -rf supabase/volumes/db/data`） |
| `supabase-db` password 错误 | 旧数据卷用了空密码初始化 | `docker compose down -v` 后重来（**清数据**） |
| migrate / fc 一直 Created | 上游 healthcheck 未过 | `podman logs supabase-db`；确认 `POSTGRES_PASSWORD` |
| 桌面 MQTT **Disconnected** / `connection closed by peer` | EMQX 被 OOM 杀（Podman VM 默认 2GiB） | `podman inspect teamclaw-self-host_emqx_1 --format '{{.State.OOMKilled}}'`；`podman machine set --memory 8192` 后重建 emqx（见 §运行时 Podman 内存） |
| Team Shared Enable → `PGRST301` / `wrong key type` | 前端连 `127.0.0.1:9000` 但 Rust 仍烘焙 `build.config.json` 的远程 API | 确认 `packages/app/.env.local` 含 `VITE_CLOUD_API_URL=http://127.0.0.1:9000`；**退出** 桌面后重跑 `pnpm tauri:dev`；Settings → General 里 Server 应显示 `127.0.0.1:9000` |
| `emqx` 重启次数极高 / health `starting` | 同上，或 healthcheck 在启动期失败 | 增大 Podman 内存；`podman logs teamclaw-self-host_emqx_1` 查 `high_system_memory_usage` |

---

## Configuration reference

All variables live in `.env` (copied from `.env.example`).

| Variable | Required | Description |
|---|---|---|
| `JWT_SECRET` | **yes** | Master secret; ≥32 chars |
| `POSTGRES_PASSWORD` | **yes** | Supabase Postgres superuser password |
| `ANON_KEY` | auto | Derived by `gen-secrets.sh` |
| `SERVICE_ROLE_KEY` | auto | Derived by `gen-secrets.sh` |
| `MQTT_SERVICE_TOKEN` | auto | Derived by `gen-secrets.sh` |
| `EMQX_JWT_SECRET` | auto | Derived by `gen-secrets.sh` (`base64(JWT_SECRET)`) |
| `FC_DOMAIN` | **yes** | Public domain for the FC API |
| `SUPABASE_DOMAIN` | **yes** | Public domain for Supabase/Kong |
| `MQTT_DOMAIN` | **yes** | Public domain for MQTT WebSocket |
| `STUDIO_DOMAIN` | **yes** | Public domain for Supabase Studio |
| `EMQX_DASHBOARD_DOMAIN` | **yes** | Public domain for EMQX dashboard |
| `GITEA_DOMAIN` | for apps | Public domain for Gitea web/API (Caddy) |
| `GITEA_SSH_PORT` | no | Host SSH port for git push/fetch (default `2222`) |
| `GITEA_URL` | for apps | FC → Gitea REST API base URL |
| `GITEA_TOKEN` | for apps | Bot API token (bootstrap mints) |
| `GITEA_OWNER` | for apps | Org owning app repos |
| `CADDY_TLS_MODE` | no | `acme` (default) / `internal` / `off` |
| `CADDY_GLOBAL_TLS` | auto | Derived by `gen-secrets.sh` |
| `CADDY_SITE_TLS` | auto | Derived by `gen-secrets.sh` |
| `CADDY_SITE_SCHEME` | auto | `http://` when `off`, else empty |
| `CADDY_HTTP_PORT` | no | Host HTTP port (default `80`; Podman `8080` via `up.sh`) |
| `CADDY_HTTPS_PORT` | no | Host HTTPS port (default `443`; Podman `8443` via `up.sh`) |
| `ACME_EMAIL` | for acme | Let's Encrypt contact |
| `DOCKER_SOCKET_LOCATION` | no | Docker socket path (default: `/var/run/docker.sock`); used by the `vector` log collector |
| `BACKEND_KIND` | no | `supabase` (default) or `postgres` |
| `CRON_TRIGGER_SECRET` | for cron | Shared secret for `/internal/cron` |
| `DATABASE_URL` | for postgres profile | Postgres connection string |
| `POSTGRES_BACKEND_PASSWORD` | no | Password for the opt-in standalone `postgres` service (default: `postgres`) |
| `ACCESS_KEY_ID` | no | Alibaba OSS key ID |
| `ACCESS_KEY_SECRET` | no | Alibaba OSS key secret |
| `ROLE_ARN` | no | Alibaba RAM role ARN for OSS |
| `BUCKET` | no | OSS bucket name (default: `teamclu-team`) |
| `REGION` | no | OSS region (default: `cn-shenzhen`) |
| `ENDPOINT` | no | OSS endpoint URL |
| `CODEUP_ORG_ID` / `CODEUP_PAT` / `CODEUP_BOT_USERNAME` | for apps | Managed-git org + PAT used to create each app's repo. Missing → `POST /v1/apps` fails at the repo step |
| `APPS_DB_ADMIN_URL` | for apps | Superuser / CREATEDB URL on the compose Postgres (defaults to `postgres://postgres:$POSTGRES_PASSWORD@db:5432/postgres`). Used to create per-org DBs `tc_org_<orgId>` and per-app schemas. Blank with no compose default → data_app finalize fails naming this var |
| `APPS_DB_APP_URL` | for data_app on FC | Postgres URL whose **host** is injected into each deployed app's `DATABASE_URL`. Required when `APPS_DB_ADMIN_URL` uses compose-internal `db` — deployed functions run on external Alibaba FC and cannot resolve that hostname. Use a VPC-reachable private IP, RDS URL, etc. |
| `APPS_FC_VPC_ID` / `APPS_FC_VSWITCH_ID` / `APPS_FC_SECURITY_GROUP_ID` | for data_app on FC | VPC attachment for deployed app functions. Required when `APPS_DB_APP_URL` is set — without it the function cannot reach an internal RDS host. Use a dedicated security group (not the RDS-managed one) |
| `APPS_FC_ENDPOINT` / `ALIYUN_ACCOUNT_ID` | for apps | Account-scoped FC 3.0 data-plane host (`<accountId>.<region>.fc.aliyuncs.com`). Not the OSS `ENDPOINT`; set one of the two |
| `LITELLM_URL` | no | 留空即用内置网关（compose 默认 `http://litellm:4000`）。仅在改用**外部**网关时才设置 |
| `LITELLM_MASTER_KEY` | auto | `gen-secrets.sh` 生成（`sk-` 前缀）；LiteLLM 管理凭证,同时交给 FC |
| `LITELLM_UI_USERNAME` | no | 管理 UI 用户名（默认 `admin`） |
| `LITELLM_UI_PASSWORD` | auto | `gen-secrets.sh` 生成 |
| `LITELLM_PORT` | no | 网关在宿主机 loopback 的端口（默认 `4000`） |
| `OPENAI_API_KEY` | no | 上游 provider key；供 `litellm/config.yaml` 里的 `os.environ/` 引用 |
| `ANTHROPIC_API_KEY` | no | 同上 |

## Single-image platform mode

If your platform allows only one Docker image and one exposed port, use the experimental all-in-one target in `deploy/self-host/all-in-one/`. It keeps the Compose deployment unchanged and routes Cloud API, auth, storage, realtime, and MQTT-over-WebSocket through one HTTP entrypoint.
