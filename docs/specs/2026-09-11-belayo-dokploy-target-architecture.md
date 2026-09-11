# Belayo Dokploy 生产架构

- **Status**: Active
- **Updated**: 2026-09-11
- **Scope**: Belayo Cloud API、AI Gateway、MQTT、Registry、Gitea、Supabase 入口与发布边界

## 1. 当前结论

Belayo Cloud API 已完成从 Alibaba Function Compute 到 Dokploy 的迁移。旧 Cloud API
function、trigger 和 custom domain 已删除，不再是发布或回滚目标。

Alibaba Function Compute 仍用于用户创建的 Apps runtime。这与历史目录名
`services/fc/` 是两件事：该目录本身是容器化 Cloud API，同时包含 Apps provisioning
所需的 Alibaba FC 客户端代码。

生产边界：

- Dokploy 管理 Belayo 的容器工作负载。
- Traefik 是 Belayo HTTP/HTTPS 公网入口。
- Cloudflare 为 `teamclaw-api.ucar.cc` 提供 DNS/Edge，origin 指向 Traefik。
- Cloud API 和 AI Gateway 使用不可变镜像发布。
- Belayo 数据库 migration 保持人工执行，不属于应用发布流水线。
- self-host 是测试环境，继续使用 Docker Compose + Caddy，不迁移到 Dokploy。

## 2. 服务与所有权

| 能力 | 当前所有者 | 约束 |
|---|---|---|
| Cloud API | Dokploy application `AyIydhRyN4pMT0_Y0TXvq` | service `teamclu-cloud-api-shadow-qjau6z`，固定 `dokploy-worker-2:9000` |
| Cloud API ingress | Cloudflare + Traefik | `teamclaw-api.ucar.cc`，TLS 在 Traefik origin 终止 |
| Cloud API cron | Dokploy Compose `VVHIpEDQ8RojW-0qIMoy4` | 单副本，调用 Cloud API internal tick |
| AI Gateway | Dokploy application `k6yinm2sXoijFw2rQ1OXX` | service `teamclu-ai-gateway-iiq8f3:4001` |
| MQTT WSS | Traefik + EMQX | `wss://mqtt.service.ucar.cc/mqtt` |
| Registry | worker2 Registry + Traefik | blob 在 OSS；pull/push 分权 |
| Gitea | 专用节点 + Traefik | HTTP 经 `git.service.ucar.cc`；SSH 经专用 TCP entrypoint |
| Supabase/RDS | 专用节点/RDS | Cloud API 走 VPC 私网；migration 人工执行 |
| 用户 Apps runtime | Alibaba Function Compute | 不属于已退役的 Cloud API FC |

manager 只承载 Dokploy 控制面、Traefik、Dokploy Postgres/Redis 和临时构建工作，不承载
Cloud API、AI Gateway 等业务副本。

## 3. Cloud API 发布

发布入口是 [`.github/workflows/belayo-cloud-api.yml`](../../.github/workflows/belayo-cloud-api.yml)：

1. 对 `services/fc` 做 typecheck、部署契约测试和 production build。
2. 构建 `linux/amd64` 镜像，以 git SHA 前 9 位作为不可变 tag。
3. 通过 Dokploy manager 已有的 Alibaba ACR 登录推送镜像。
4. 对主 Swarm service 执行 `start-first` rolling update。
5. 验证 `1/1`、目标 worker、实际运行镜像、内部 health 和公网 health/config。
6. 验证通过后回写 Dokploy control-plane 的 desired image。
7. 任一步失败时恢复旧 Swarm 镜像和旧 desired image。

生产镜像禁止使用 `latest`。running image 和 Dokploy desired image 必须一致，否则下一次
Dokploy redeploy 会回到错误版本。

AI Gateway 使用独立的
[`.github/workflows/belayo-ai-gateway.yml`](../../.github/workflows/belayo-ai-gateway.yml)，
但遵守相同的不可变镜像、worker placement、滚动更新和 smoke 约束。

## 4. 数据库 migration

Belayo migration 必须继续人工执行：

- Cloud API workflow 不监听 `services/supabase/migrations/**`。
- workflow 不运行 Supabase CLI、migration script 或业务库 DDL。
- 依赖 migration 的代码只能在目标 migration 已人工应用并记录后发布。
- migration 只前滚；撤销通过新的 migration 完成。
- 发布 workflow 中对 Dokploy Postgres 的 `application.dockerImage` 更新只是控制面状态同步，
  不是 Belayo 业务数据库 migration。

环境变量名称由
[`deploy/belayo/cloud-api.env.keys`](../../deploy/belayo/cloud-api.env.keys) 和 self-host Compose
allowlist 共同约束。secret value 只保存在 Dokploy、GitHub Secrets 或受控运维环境中，
不得进入 Git、文档或 workflow 日志。

## 5. 路由与证书

| hostname | 所有者 | 后端 |
|---|---|---|
| `teamclaw-api.ucar.cc` | Cloudflare + Traefik | Cloud API `:9000` |
| `ai-gateway.service.ucar.cc` | Traefik | AI Gateway `:4001` |
| `mqtt.service.ucar.cc` | Traefik | EMQX WebSocket `:8083` |
| `registry.service.ucar.cc` | Traefik | Registry `:5000` |
| `git.service.ucar.cc` | Traefik | Gitea HTTP `:3000` |

一个 hostname 只能有一个入口和证书所有者。Belayo 不读取或共享 self-host Caddy 的证书；
self-host 也不复制 Traefik dynamic configuration。

Traefik 只负责 Host/path routing 和 TLS termination。Cloud API 自己负责 CORS、鉴权、
限流和业务路径。

## 6. self-host 对齐边界

self-host 保留 Docker Compose + Caddy，但必须与 Belayo 对齐：

- Cloud API 监听 `9000`，AI Gateway 监听 `4001`。
- `/healthz` 由镜像提供。
- 环境变量名称保持 parity；明确记录少量环境特有变量。
- MQTT WSS 客户端路径保持 `/mqtt`。
- Cloud API 到 AI Gateway 使用环境内服务发现，不绕公网。
- 两边使用相同 API、CORS 和 feature profile 解析语义。

不要求对齐代理实现、证书存储、数据库位置或部署编排工具。

## 7. 发布验收与回滚

常规发布门禁：

- Cloud API `/healthz` 为 200。
- `/v1/config/public` 返回有效 Belayo profile。
- Swarm 为 `1/1`，任务位于 `dokploy-worker-2`，镜像 tag 与发布 commit 对应。
- Cloud API 不发布 host port，只通过 `dokploy-network` 由 Traefik 访问。

高风险改动还应人工验证登录/refresh、authenticated CRUD、RLS、MQTT WSS、OSS、Apps
provisioning 和 cron 单窗口单 run。

Cloud API 回滚只在 Dokploy 内恢复上一不可变镜像和配置快照。旧 Cloud API FC 已删除，
禁止把它重新创建为应急回滚路径。

## 8. 已知债务

- E2E cleanup 删除测试 team 时会命中遗留 `public.teams` 引用（`42P01`），需修复旧
  trigger/function 并清理遗留测试组织。
- AI Gateway 的 Dokploy file mount 目前依赖 workflow 的一次性 Swarm helper 同步到
  worker；长期应改为原生 Swarm config 或 Dokploy 支持的声明方式。
- 当前只有一个通用应用 worker，Cloud API 不具备节点级高可用。
- Dokploy 配置尚未形成不含 secret value 的完整配置即代码导出。
