# Belayo Dokploy 目标部署架构

- **Status**: Accepted, production pre-route ready; accelerated cutover pending 2-hour shadow soak
- **Date**: 2026-09-11
- **Scope**: Belayo 托管环境的 Cloud API、AI Gateway、MQTT、Registry、Gitea、Supabase 入口与发布流程
- **Related**:
  - [`services/fc/Dockerfile`](../../services/fc/Dockerfile)
  - [`services/fc/s.yaml`](../../services/fc/s.yaml)
  - [`deploy/belayo/registry/docker-compose.yml`](../../deploy/belayo/registry/docker-compose.yml)
  - [`deploy/self-host/docker-compose.yml`](../../deploy/self-host/docker-compose.yml)
  - [`docs/openapi/teamclu-api.v1.yaml`](../openapi/teamclu-api.v1.yaml)

## 1. 结论

Belayo 的托管计算与公网入口逐步统一到 Dokploy，但不迁移数据库、对象存储和 Apps 的
Alibaba Function Compute runtime，也不迁移 self-host 测试环境。

目标边界如下：

- Dokploy 是 Belayo 服务部署的控制面。
- Traefik 是 Belayo 唯一的 HTTP/HTTPS 公网入口，独占 manager 的 80/443。
- Cloud API、AI Gateway 各自产出不可变容器镜像，并共享同一种 Dokploy 发布约束。
- Supabase/RDS、OSS、EMQX 和 Gitea 可以继续位于专用节点，但必须通过稳定的服务名或
  明确登记的私网端点访问，不能把临时主机 IP 散落在多个 Traefik 文件中。
- self-host 继续使用 Docker Compose + Caddy，只要求服务端口、URL 行为、环境变量和
  smoke test 与 Belayo 对齐，不要求代理实现相同。
- Cloud API 迁移时保留当前真实生产入口 `teamclaw-api.ucar.cc`。品牌域名切换是另一项
  工作，不与运行时迁移同时进行。

## 2. 背景与目标

### 2.1 当前问题

Belayo 目前是混合部署：

- Cloud API `teamclaw-belayo-live-api` 运行在 Alibaba FC。
- Cloud API shadow 已作为容器运行在 Dokploy 的 `dokploy-worker-2`。
- AI Gateway、Registry、Gitea、EMQX、Supabase 分布在 Dokploy Swarm 或同 VPC 的专用
  ECS 节点。
- Traefik 既代理 Swarm 服务，也通过手写文件代理固定私网 IP。
- FC 由本地 `.env.belayo.local` + `s deploy` 手工发布；Dokploy 服务使用另一套环境变量
  和发布方式。
- 数据库 migration 仍由人工执行，没有统一的发布门禁。

这导致同一份 Cloud API 代码存在三种容易漂移的配置面：self-host Compose、FC
`s.yaml`、Dokploy Application。

### 2.2 目标

1. Cloud API 从 Alibaba FC 平滑迁移到 Dokploy，客户端入口不变。
2. 一个代码提交生成一个不可变镜像，并能确定运行中的准确版本。
3. self-host 与 Belayo 共享环境变量契约、内部端口和 smoke test。
4. 一个 hostname 只有一个入口所有者，避免 Caddy、FC gateway、Traefik 重复管理证书。
5. 迁移可在数分钟内通过 DNS 回滚，不伴随数据库迁移。
6. 定时任务、MQTT、Apps provisioning、OSS、登录和推送能力不能在“健康检查为绿”时
   静默缺失。

### 2.3 非目标

- 不迁移 self-host 测试环境。
- 不把 Supabase/RDS 搬进 work2。
- 不更换 OSS bucket 或数据路径。
- 不把用户创建的 Apps 从 Alibaba FC 搬到 Dokploy。
- 不在本次迁移中把 `teamclaw-api.ucar.cc` 改名为 `teamclu-api.ucar.cc`。
- 不在本次工作中实现 Belayo 的 Apps 自定义域名 catch-all；该能力继续是 self-host
  Caddy 的环境差异。

## 3. 2026-09-11 实时基线

### 3.1 节点

| 节点 | 当前职责 | 公网入口 |
|---|---|---|
| `dokploy-manager` | Dokploy、Traefik、Dokploy Postgres/Redis | `47.107.171.43:80/443/2222` |
| `dokploy-worker-2` | Cloud API shadow、Registry | 经 manager Traefik |
| `dokploy-work1-emqx` | EMQX | 当前直接发布多个 MQTT/管理端口 |
| `dokploy-supabase` | Supabase/Kong | 经 manager Traefik |
| `query-service` | Query Service | 经 manager Traefik |
| `launch-advisor-20260908` | Gitea、已缩容的 AI Gateway 回滚服务 | 经 manager 的固定私网 IP 路由 |

Swarm 节点当前均为 `Ready/Active`。Cloud API shadow 被固定在
`dokploy-worker-2`，运行副本为 `1/1`。

### 3.2 入口与服务

| 入口 | 当前后端 | 证书/入口方式 | 备注 |
|---|---|---|---|
| `teamclaw-api.ucar.cc` | Alibaba FC `teamclaw-belayo-live-api` | FC custom domain | 当前生产入口，`/healthz` 为 200 |
| `teamclu-api-shadow.ucar.cc` | Dokploy Cloud API `:9000` | Cloudflare + Origin CA + Traefik | shadow，`/healthz` 为 200 |
| `ai-gateway.service.ucar.cc` | `teamclu-ai-gateway-iiq8f3:4001` | Traefik + Let's Encrypt | overlay service discovery；work2 单副本 |
| `supa-live.service.ucar.cc` | `172.18.29.180:8000` | Traefik + Let's Encrypt | Kong 入口 |
| `registry.service.ucar.cc` | worker2 Registry `:5000` | Traefik + Let's Encrypt | push/pull 分权 |
| `git.service.ucar.cc` | `172.18.29.207:3000` | Traefik + Let's Encrypt | SSH 另走 manager `:2222` |
| `query.service.ucar.cc` | `172.18.29.201:9001` | Traefik + Let's Encrypt | 同时存在自动与手写两份 router |
| `iot.service.ucar.cc` | Dokploy application `:8080` | Traefik + Let's Encrypt | Belayo 业务服务 |
| `service.ucar.cc` | Dokploy `:3000` | Traefik + Let's Encrypt | Dokploy 控制面 |

当前 `teamclu-api.ucar.cc` 没有 DNS 记录。仓库部分旧文档把它写成 Belayo 线上入口，
与实时状态不符。

### 3.3 Cloud API parity

生产 FC 与 Dokploy shadow 当前都满足：

- `GET /healthz` 返回 200。
- `GET /v1/config/public` 返回相同的 Belayo feature profile。
- Web SSO 均指向 `https://admin.mx5.cn/sign-in`。
- Cloud API 容器监听 `9000`，镜像自带 Docker healthcheck。

这只证明无认证公共配置对齐，不代表鉴权、MQTT、OSS、Apps provisioning、定时任务和
推送已经完成端到端验证。

### 3.4 生产预备与即时验收（2026-09-11）

- Dokploy Application 已增加 `teamclaw-api.ucar.cc -> :9000` 的 HTTPS Traefik
  route；公网 DNS 仍指向 FC，因此尚未切流。
- Cloudflare Origin CA 已为 `teamclaw-api.ucar.cc` 单独签发并注册到 Dokploy。通过
  `--resolve teamclaw-api.ucar.cc:443:47.107.171.43` 验证 SNI、`/healthz`、公共配置和
  CORS preflight 均通过。
- Cloud API shadow 运行不可变镜像 `shadow-6a9ebe3a7`，registry digest 为
  `sha256:0cb22d51fdee9e2b52839d138482361456eb0b70db2f20b7e9131f250bb97e9d`。
- Dokploy Application 的 env 已从字面量 `\\n` 修正为真实逐行变量，并去掉 value 的
  外层 dotenv 引号；修复前 `/healthz` 会假绿、业务路由报缺少 `SUPABASE_URL`，且 Web
  SSO storage key 带多余引号。
- Dokploy Compose `Cloud API Cron` 已部署；stack service 固定在
  `dokploy-worker-2`，当前 desired/running 为 `0/0`。FC `app-cron` timer 仍是唯一
  scheduler。
- `deploy/belayo/smoke/cloud-api-e2e.mjs` 已连续通过，并在最终 env 规范化后复验：登录刷新、team
  bootstrap、session/message、跨租户 RLS、MQTT WSS roundtrip、Gitea provisioning、
  OSS roundtrip、真实 FC App 发布、cron 单窗口单 run 及 tick 鉴权。
- Registry 额外验证 pull 凭据可读但不能 push，push 凭据可创建并取消上传会话。

即时验收通过不替代 Phase 1 的 shadow soak。由于当前生产流量较低，2026-09-11 决定采用
6 小时加速方案：切流前累计观察 2 小时，并以主动全链路 E2E 补足自然流量样本；完成该
门禁前不改生产 DNS，也不交接 scheduler。DNS 与 scheduler 在 Phase 4 同一变更窗口执行。
原 24 小时探针可继续运行作为附加证据，但不再是 FC 删除的硬等待条件。

## 4. 目标架构

```text
                         Cloudflare DNS / Edge
                                  |
                                  v
                    47.107.171.43 : 80 / 443
                       Dokploy manager / Traefik
                     /            |             \
                    /             |              \
        Cloud API :9000     AI Gateway :4001    HTTP services
        worker2, 1 replica   Swarm service       Registry/Gitea/
              |                                  Supabase/Query
              |
      +-------+--------+-------------+----------------+
      |                |             |                |
   Supabase/RDS       EMQX           OSS          Alibaba FC API
   private network   work1       external/VPC     Apps runtime only
```

### 4.1 控制面与工作负载边界

manager 只承担：

- Dokploy 控制面。
- Traefik 公网入口。
- Dokploy 自己的 Postgres/Redis。
- 镜像构建的临时任务；构建目录必须可回收，不能成为服务运行依赖。

manager 不运行 Belayo Cloud API、AI Gateway、Registry 或 EMQX 业务副本。

初始阶段 Cloud API 固定在 `dokploy-worker-2`，单副本运行。它解决的是 FC 迁移和发布
一致性，不提供节点级高可用。后续增加第二个通用 worker 后，Cloud API 才改为两个副本
跨节点调度。

### 4.2 Cloud API

Cloud API 使用 [`services/fc/Dockerfile`](../../services/fc/Dockerfile) 构建：

- 内部端口固定 `9000`。
- Traefik 只做 Host 路由、HTTP 到 HTTPS 跳转和 TLS termination。
- CORS、鉴权、限流和业务路径由 Cloud API 自己处理。
- 第一阶段保持 `PG_POOL_MAX=1`，不在迁移时同时调整数据库连接行为。
- 容器使用不可变 tag，例如 `teamclu-cloud-api:<git-sha-9>`；禁止生产使用 `latest`。
- Dokploy desired state 和 Swarm running image 必须同时更新并在发布后比对。

推荐初始资源边界：

| 项目 | 初始值 |
|---|---|
| replicas | 1 |
| placement | `node.hostname == dokploy-worker-2` |
| memory limit | 1 GiB |
| healthcheck | 镜像内 `/healthz` |
| update order | `start-first` |
| rollback | Swarm 自动回退到上一镜像 |

Cloud API 不发布 host port，只加入 `dokploy-network`，由 Traefik 按服务名访问。

### 4.3 AI Gateway

AI Gateway 已从 `172.18.29.207:4001` 固定 IP 路由迁入主 Swarm：

- 服务加入 `dokploy-network`。
- Traefik 通过服务名和 `4001` 访问，不直接写 ECS 私网 IP。
- Cloud API 迁入 Dokploy 后，`AI_GATEWAY_INTERNAL_URL` 使用 overlay service DNS，不再
  绕公网域名。
- 公网 `ai-gateway.service.ucar.cc` 保留，供已有外部调用方使用。
- 发布 workflow 不再通过“第二跳 SSH + host-mode port”更新服务；无 host port 后使用
  `start-first` rolling update。

workflow 已绑定 Dokploy application `k6yinm2sXoijFw2rQ1OXX` 与 service
`teamclu-ai-gateway-iiq8f3`，并产出 arm64/amd64 多架构镜像。旧外部应用保留为
0 副本回滚配置，不再接收公网流量。

### 4.4 MQTT

当前客户端入口：

```text
MQTT_BROKER_URL=wss://mqtt.service.ucar.cc/mqtt
MQTT_PUBLIC_TCP_BROKER_URL=mqtt://transport.service.ucar.cc:1883
MQTT_USE_TLS=true
```

2026-09-11 已在 Dokploy 为 `emqx` Compose 服务增加
`mqtt.service.ucar.cc` HTTPS domain，Traefik 转发到 EMQX WebSocket listener
`:8083`。EMQX 继续固定在 work1。Cloud API 影子实例和生产 FC 均已切换到上述配置。

上线验证已完成 TLS、HTTP 101 WebSocket upgrade，以及使用 Cloud API 服务账号执行的
connect、subscribe、publish、receive roundtrip。生产 bootstrap 已使用真实登录态确认返回
WSS、native TCP 和 `useTls=true`；另以同一用户 JWT 完成 WSS connect 和 actor-scoped
subscribe。原生 TCP 入口 `:1883` 同时保持可达。

迁移验证完成后：

- 保留确有 native client 使用的 `1883`，以及验证可用后的 `8883`。
- 从安全组和 host publish 中移除公网 `8083`、`8084`、`18083`。
- EMQX Dashboard 只允许私网/VPN，或另建带强认证和 IP allowlist 的 Traefik router。
- 不在 Traefik 与 EMQX 间共享证书文件；WSS 由 Traefik termination，原生 MQTTS 由
  EMQX 自己管理证书。

### 4.5 Registry 与 Gitea

Registry 维持现有设计：

- worker2 单副本。
- blob 存储在 OSS，不依赖节点本地卷。
- Traefik 按 HTTP method 区分 push/pull basic auth。
- 不开放 host port。

Gitea 是有状态服务，迁移计算节点不是本设计的前置条件。短期保留专用节点，但将其作为
一项受管外部服务登记；HTTP 由 Traefik 代理，SSH 由 manager 的专用 `:2222` TCP
entrypoint 转发。未来若迁入 Swarm，必须先设计数据卷备份和恢复，不能把它与 Cloud API
切流合并执行。

### 4.6 Supabase/RDS 与 OSS

本次保持原位置和数据不变：

- Cloud API 容器继续通过 VPC 私网访问 Supabase/Kong 和 RDS。
- `SUPABASE_PUBLIC_URL` 保持客户端可访问的稳定地址。
- team blobs、skills、Apps artifact 和 Registry blobs 继续使用现有 OSS bucket/prefix。
- 迁移不运行 DDL；数据库 migration 是独立的、显式批准的步骤。

## 5. 域名与证书

### 5.1 hostname 所有权

| hostname | 目标所有者 | 说明 |
|---|---|---|
| `teamclaw-api.ucar.cc` | Traefik | 生产兼容入口，迁移时保持不变 |
| `teamclu-api-shadow.ucar.cc` | Traefik | 迁移 canary；稳定后可删除或限制访问 |
| `teamclu-api.ucar.cc` | 保留 | 未来品牌别名，不参与本次迁移 |
| `ai-gateway.service.ucar.cc` | Traefik | AI Gateway 公网入口 |
| `mqtt.service.ucar.cc` | Traefik | MQTT over WSS 标准入口 |
| `registry.service.ucar.cc` | Traefik | Registry |
| `git.service.ucar.cc` | Traefik | Gitea HTTP |

### 5.2 证书策略

`teamclaw-api.ucar.cc` 当前 CNAME 到 Alibaba FC。在 DNS 切换前，Traefik 无法稳定使用
HTTP/TLS challenge 预签该域名。因此生产 Cloud API 推荐沿用 shadow 已验证的模式：

1. 在 Dokploy 安装覆盖生产 hostname 的 Cloudflare Origin CA 证书。
2. Traefik router 使用自定义证书，不配置 Let's Encrypt resolver。
3. Cloudflare 设为 Full (strict)。
4. 切换 DNS 到 proxied record，origin 指向 Dokploy manager。

其他直接解析到 manager、且 ACME 验证稳定的 `*.service.ucar.cc` 域名继续使用 Traefik
Let's Encrypt。一个 hostname 只能由一个入口管理证书，不共享 Caddy/FC/Traefik 的证书
文件。

## 6. 环境变量契约

### 6.1 单一变量集合

Cloud API 代码仍有多个运行目标，因此保留一个统一变量契约：

```text
source code reads
       |
       +-- self-host compose allowlist
       +-- Alibaba FC s.yaml allowlist (回滚期)
       +-- Belayo Dokploy cloud-api allowlist
```

现有 [`deploy-env-parity.test.ts`](../../services/fc/test/deploy-env-parity.test.ts) 已约束
Compose 与 `s.yaml`。迁移实现时将 Dokploy Cloud API manifest 纳入同一测试，任何仅
存在于一个目标的变量都必须写明理由。

### 6.2 配置归属

| 类别 | 示例 | 存放位置 |
|---|---|---|
| 非敏感运行配置 | profile、公开 URL、region、bucket 名 | 仓库 deployment manifest |
| 密钥 | Supabase key、MQTT 密码、签名密钥、Gitea token | Dokploy encrypted environment |
| 云资源凭据 | Alibaba AK、role ARN、Stripe/APNS secret | Dokploy encrypted environment |
| 临时运维凭据 | `/workspace/env` 中的 CLI key | 仅运维机，不作为部署源 |
| feature 默认值 | `APP_FEATURES_PROFILE=belayo` 对应内容 | `feature-profiles.ts`，随代码版本发布 |

不把 secret value 写入 Git、设计文档、Traefik dynamic file 或 workflow 日志。

### 6.3 切流时必须保持的 URL

以下值必须继续使用生产 canonical origin，不能指向 shadow：

- `AUTH_BASE_URL=https://teamclaw-api.ucar.cc`
- `APPS_CLOUD_API_URL=https://teamclaw-api.ucar.cc`
- Stripe return/webhook URL 中的 Cloud API origin
- 任何签名 issuer/audience 中的 Cloud API origin

`APP_FEATURES_PROFILE` 必须显式为 `belayo`。Traefik 不添加 CORS header，所以容器目标由
Hono 继续拥有 CORS，不能沿用一个“代理已经处理 CORS”的错误配置。

## 7. 发布设计

### 7.1 镜像流水线

Cloud API 与 AI Gateway 各有独立 workflow：

1. checkout 指定 commit。
2. 运行目标服务测试和环境变量契约测试。
3. 在 ARM64 builder 构建镜像。
4. 运行镜像内 smoke，例如确认 `dist/server.js` 存在并启动 `/healthz`。
5. 推送 ACR immutable tag。
6. 更新 Dokploy desired image。
7. rolling update。
8. 验证 running image digest、replicas、container health 和公网 health。

不能只执行 `docker service update` 而不更新 Dokploy 数据；否则下一次 Dokploy redeploy 会
回滚到旧镜像。优先使用稳定 Dokploy API；若当前版本没有满足要求的 API，直接更新
Dokploy Postgres 只能作为有版本检查、事务和回读验证的过渡方案。

### 7.2 migration 门禁

发布应用与执行 migration 是两个动作：

- 默认不执行 migration。
- migration 先于依赖它的新镜像。
- 记录 migration filename、目标数据库和执行时间。
- 发布 workflow 只检查“所需 migration 已存在”，不自行运行 DDL。

### 7.3 定时任务单一执行者

Alibaba FC 当前通过 timer trigger 每分钟调用 `app-cron`。Dokploy 容器没有 FC timer，
必须部署与 self-host 相同语义的 cron sidecar。

任何时刻只能有一个生产 scheduler：

- shadow 阶段：FC timer 开启，Dokploy cron 关闭。
- 切流阶段：先停 FC timer，再开启 Dokploy cron，允许短暂少跑一分钟，禁止双跑。
- 回滚阶段：先停 Dokploy cron，再恢复 FC timer。

cron 验收不能只看进程存活，必须证明一个测试 job 在预期窗口只产生一次 run record。

## 8. 迁移计划

### Phase 0：冻结基线

- 保存 FC function 配置、custom domains、triggers 和环境变量**名称**快照。
- 导出 Dokploy Application/Domain/Certificate 配置，不导出 secret value 到 Git。
- 记录当前生产镜像/代码版本。
- 建立本设计第 10 节的 smoke baseline。

### Phase 1：加固 shadow

- 将 shadow 改为正式 deployment manifest 管理。
- 补齐环境变量名称检查和不可变镜像发布。
- 保持 cron 关闭。
- 完成公共配置、登录、authenticated CRUD、MQTT、OSS、Registry、Apps provisioning
  的端到端测试。
- 连续观察至少 2 小时，确认无连接泄漏和异常重启；低流量期间持续运行 5 分钟业务探针、
  30 分钟控制面探针，并在切流前再执行一次完整 E2E。

### Phase 2：对齐依赖入口

- AI Gateway 从固定 IP 改为 overlay service discovery。
- 增加 MQTT WSS Traefik route。
- 清理 `query.service.ucar.cc` 重复 router。
- 收敛 EMQX 公网端口。

这些工作可以在 Cloud API DNS 切换前完成，并分别回滚。

### Phase 3：生产域名预备

- 将 `teamclaw-api.ucar.cc` TTL 从当前 600 秒提前降低。
- 安装并验证 Cloudflare Origin CA。
- 在不改公网 DNS 的前提下，通过 `--resolve`/origin probe 验证 Traefik production router。
- 再次确认 Dokploy 环境变量中的 canonical URL 仍是生产 hostname。

### Phase 4：切流

1. 确认 FC 和 Dokploy 运行相同 commit/兼容 schema。
2. 切换 `teamclaw-api.ucar.cc` 到 Cloudflare proxied Dokploy origin。
3. 用唯一请求标识和 Traefik/Cloud API 日志确认公网请求实际进入 work2，不能只依赖
   `/healthz` 和 DNS 结果推断。
4. 连续验证 health、登录、authenticated read/write、MQTT publish。
5. 先停止 FC timer 并确认 `enabled=false`，再开启 Dokploy cron，验证一个调度窗口恰好
   执行一次；禁止两个 scheduler 短暂重叠。
6. 前 30 分钟高频观察错误率，并在 T+30 分钟、T+2 小时和 T+6 小时执行完整 E2E。

DNS 切换且 FC timer 停止后，FC 完成逻辑下线；function 在 T+6 小时前保留为回滚目标。

### Phase 5：收尾

- T+2 小时的完整 E2E 通过且期间无回滚触发条件后，移除 FC custom domain。
- T+6 小时再次完成完整 E2E；通过后，将 function、trigger、custom domain 和环境变量
  配置快照保存到受控存储（secret value 不进入 Git），再删除
  `teamclaw-belayo-live-api`。
- 原 24 小时业务/控制面探针继续运行到期，用作删除后的 Dokploy 稳定性观察。
- 删除 shadow hostname，或将它改为受限运维入口。
- 更新 `full-backend-stack.md` 中与实时状态冲突的 Belayo 描述。
- 品牌域名 `teamclu-api.ucar.cc` 如需启用，另开独立兼容性任务。

## 9. 回滚

### 9.1 触发条件

满足任一条件立即回滚：

- health 连续失败或 Traefik 5xx 明显上升。
- 登录、refresh token 或 Web SSO issuer 不一致。
- authenticated CRUD 失败。
- bootstrap 不返回 MQTT，或 MQTT roundtrip 失败。
- OSS/附件上传失败。
- Apps provisioning/Registry 出现系统性错误。
- cron 重复执行。

### 9.2 回滚步骤

1. 停止 Dokploy cron sidecar。
2. 将 `teamclaw-api.ucar.cc` DNS 恢复为 FC CNAME。
3. 等待 TTL 并验证请求回到 FC。
4. 恢复 FC timer trigger。
5. 验证 health、登录、MQTT 和 cron 单次执行。

迁移期间禁止执行不可向后兼容的数据库 migration，这保证 DNS 回滚后旧 FC 代码仍可工作。

## 10. 验收标准

### 10.1 HTTP 与身份

- `/healthz` 返回 200。
- `/v1/config/public` 与 FC baseline 等价。
- Web SSO 登录、token refresh、登出成功。
- JWT issuer/audience 与 `teamclaw-api.ucar.cc` 一致。
- CORS 对 Tauri、允许的 Web origin 正常，对未知 origin 拒绝。

### 10.2 业务数据

- 测试 team 的 sessions/messages read/write 成功。
- RLS 行为与 FC 一致。
- Realtime/消息路径无重复写入。

### 10.3 MQTT

- bootstrap 返回 WSS 与 native TCP 地址。
- Desktop/Web 使用 `wss://mqtt.service.ucar.cc/mqtt` 完成 connect、subscribe、publish。
- native client 使用保留的 TCP/TLS 地址完成相同 roundtrip。

### 10.4 文件与 Apps

- team blob/skill blob 上传下载成功。
- Registry push 用户可 push，pull 用户不可 push，两者均可 pull。
- 创建一个测试 App，完成 artifact、function deploy、log 查询和删除。
- 一个 cron App 在一个调度窗口只执行一次。

### 10.5 运维

- running image digest 与发布 commit 对应。
- Cloud API container health 为 healthy；切流前 2 小时无异常重启，切流后至 T+6 小时无
  异常重启，且 T+30 分钟、T+2 小时、T+6 小时完整 E2E 均通过。
- manager 不承载业务 workload。
- 日志进入现有 Aliyun SLS/LoongCollector，并可按 service、node、commit 查询。
- 回滚演练在 TTL 窗口内完成。

## 11. 已知债务与后续决策

1. `full-backend-stack.md` 把 Belayo FC 写成已下线，与实时状态冲突。
2. `teamclu-api.ucar.cc` 在文档和测试中出现，但当前没有 DNS；不能把它当线上验证目标。
3. Dokploy 的 file mount 只在 manager 物化；AI Gateway workflow 目前用一次性 Swarm
   helper 在 rolling update 前将 catalog 同步到 work2。长期应改为原生 Swarm config
   或将该能力纳入 Dokploy。
4. `query.service.ucar.cc` 同时存在自动和手写 router，手写高优先级规则覆盖自动规则。
5. EMQX 直接发布了 `8083/8084/18083`，入口和管理面尚未收敛。
6. 当前只有一个通用应用 worker，Cloud API 迁移后仍不具备节点级高可用。
7. Dokploy 配置尚未形成可 review 的完整声明；需要在不提交 secret 的前提下逐步配置即代码化。

## 12. 实施拆分

建议按可独立验收和回滚的任务拆分：

1. Belayo Cloud API deployment manifest + env parity guard。
2. Cloud API immutable image workflow + Dokploy rolling deploy。
3. AI Gateway service discovery 与 workflow 修复。
4. MQTT WSS Traefik route + EMQX 端口收敛。
5. Query duplicate router 清理。
6. Cloud API authenticated/OSS/Apps/cron smoke suite。
7. `teamclaw-api.ucar.cc` Cloudflare/Traefik production cutover。
8. FC rollback retention 与最终下线。
