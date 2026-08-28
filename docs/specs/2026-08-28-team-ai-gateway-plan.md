# 实现计划：Team AI Gateway（Phase 0 + Phase 1）

> 依据：[`docs/specs/2026-08-28-team-ai-gateway-design.md`](./2026-08-28-team-ai-gateway-design.md)（待评审）
> 日期：2026-08-28
> 范围：只覆盖设计稿的 **Phase 0（网关 MVP，只增不删）** 与 **Phase 1（客户端切换）**。
> Phase 2（Credits 强制）/ 3（删 LiteLLM）/ 4（Stripe）不在本计划内，见设计稿 §11。
> 本文中裸写的 `§x.y` 一律指**设计稿**的章节。

---

## 总览

```text
P0.0  三个阻塞验证 —— 结论可能改设计，先做
P0    services/ai-gateway 起来 + migration + compose/Caddy/CI 只增不删
      → 网关能出字、能落 ai_usage_logs；LiteLLM 一行未动
P1    amuxd /v1/ai 代理 + tc_gateway_token + 按团队灰度改 llm_base_url
      → 灰度团队的流量走新网关；随时可用一条 UPDATE 回滚
```

**贯穿全程的铁律：Phase 0/1 不删除任何 LiteLLM 相关的东西**（容器、路由、env、Caddy 段、CI 步骤）。设计稿 §11 的排期就是为了避免「Phase 0 上线瞬间打挂全部已装桌面端」。

---

## P0.0 — 阻塞验证（先做，结论回写设计稿）

这三件事的结论会改设计，**必须在动手写网关之前拿到**。

### 0.1 上游在 `stream_options.include_usage` 下是否真回 usage

- [ ] 直接 curl DeepSeek 的 `/chat/completions`，`stream: true` + `stream_options: {include_usage: true}`，看末帧有没有 `usage`。
- [ ] 记录：不带该字段时是否完全没有 usage（决定 §4.4「无 usage → estimated」这条分支有多常走）。
- [ ] 若上游根本不支持该字段：设计稿 §6.6 第 3 条要改写，estimated 变成主路径而非兜底，§4.6 的预留额度也要相应放大。

### 0.2 GoTrue `/auth/v1/user` 的延迟与限流

- [ ] 在 compose 网络内压一下 `supabase.auth.getUser(token)`：P50/P99 延迟、有没有速率限制。
- [ ] 结论决定 §6.2.1 的 60 秒缓存是否够用，或者要不要退回 JWKS 本地验签。
- [ ] 顺带确认：token 被吊销后该接口多久开始拒绝（缓存 TTL 的安全上界）。

### 0.3 真实价目表

- [ ] 拿到 DeepSeek（及任何要接的上游）**当前**的每 1M token 单价。
- [ ] 按 §4.4.1 换算成 credits（元/1M × 1,000,000）填进 catalog。
- [ ] `deploy/self-host/ai/catalog.example.yaml` 里现在全是**占位数字**，别当真。

---

## P0 — 网关 MVP（只增不删）

### 1. `services/ai-gateway/` 骨架

- [ ] `package.json`：独立 npm 包（**不进 pnpm workspace** —— `pnpm-workspace.yaml` 只含 `apps/*` 和 `packages/*`，`services/*` 各自用 npm，照抄 `services/fc/` 的模式）。
- [ ] 依赖只有五个：`hono`、`@hono/node-server`、`postgres`、`jose`、`yaml`。
- [ ] `Dockerfile`：照抄 `services/fc/Dockerfile` 的两阶段（`node:20-slim` build → runtime，`npm ci --omit=dev`，`USER node`，HEALTHCHECK 打 `/healthz`）。
- [ ] `tsconfig.json` 用于构建，`tsconfig.test.json` 用于 typecheck。
      ⚠️ **两个必须分开且都要能过** —— FC 的 `build` 用 `tsconfig.json`、`typecheck` 用 `tsconfig.test.json`，所以 typecheck 绿**不代表**镜像能构建成功，而镜像构建失败会连带整个 self-host 部署挂掉。

### 2. Migration + pgTAP

- [ ] 新建 `services/supabase/migrations/<ts>_ai_gateway_credits.sql`，内容见设计稿 §5.2 的五张表。
- [ ] **`team_credit_balance` 不要加 `CHECK (balance_credits >= 0)`** —— 退款会合法地把余额打成负数（§4.9.5），注释要一起写进去挡住后人。
- [ ] 建 `ai_gateway` role 并按 §5.2 末尾授权（只给这五张表 + `actors`/`teams`/`team_workspace_config` 只读）。
- [ ] ⚠️ **同一个 PR 里改 `services/supabase/tests/020_oss_sync_schema.sql`** —— 那里的 `indexes_are` 是精确集合断言，加了索引它必红。迁移是对的、红的是断言。
- [ ] 本地跑一遍 pgTAP 套件确认 42 个用例仍全绿。

### 3. catalog 加载与启动校验

- [ ] 读 `/app/catalog.yaml`，解析三层（providers / backend_models / public_models）。
- [ ] **启动时校验，不通过就拒绝启动**（fail fast 好过运行时半残）：
  - 每条 route 的 `backend` 存在；每个 backend 的 `provider` 存在；每个 provider 的 `api_key_env` 在环境里有值。
  - `public_models` 必须含**三档 tier**：`default` / `pro` / `max`（§4.3.1，客户端写死的唯一契约），缺任何一个就拒绝启动。
  - 外加两个**过渡别名** `deepseek-v4-flash` / `deepseek-v4-pro`（§4.3.2）—— 老客户端还在发它们，Phase 3 才移除。
- [ ] **未知 model id → 403 `model_not_allowed`，绝不静默回落到 `default`**。静默回落会让发错 id 的客户端长期跑在错档位上且毫无征兆。
- [ ] ⚠️ YAML 里价格写**纯数字**，不要下划线分隔：YAML 1.2 会把 `1_000_000` 解析成字符串。

### 4. token 校验 + actor 解析

- [ ] 从 `services/fc/src/auth/verify.ts` **复制**校验逻辑，文件头注明来源（§6.5 已接受这处复制，代价是 schema 变更要两边改）。
- [ ] 按 `BACKEND_KIND` 分两条路：`supabase` → 调 GoTrue `/auth/v1/user`；`postgres` → `jose` + JWKS。**两条都不需要签名密钥。**
- [ ] 按 token 哈希做 60 秒缓存，**只缓存 `sub`**。
- [ ] ⚠️ **不要缓存「有权访问 teamId」** —— 成员被移出团队后必须立刻失效，所以 `actors` 那条查询每次都真查。
- [ ] 成员校验就是那一条查询：`SELECT id, actor_type FROM amux.actors WHERE team_id = $1 AND user_id = $2`，查不到 → 403 `not_a_team_member`。

### 5. 转发与四处改写

- [ ] `POST /v1/teams/:teamId/chat/completions`、`GET /v1/teams/:teamId/models`、`GET /healthz`。
- [ ] `GET /models` 的每档带上 `estimatedPricing`（取该档**最高价**路由，与 §4.4 预留口径一致）。Phase 2 的账单页要用它算积分↔token 换算表（§12.3）——**现在顺手加，免得 Phase 2 再回来改网关**。
- [ ] 四处必做改写（§6.6）：`body.model` 换成 upstream 名、按 `supported_params` 过滤未知参数、注入 `stream_options.include_usage`、替换鉴权头。
- [ ] **客户端原本没要 usage 时，要把末尾那个只含 usage 的 chunk 吃掉**，别让 agent runtime 收到预期外的帧。
- [ ] SSE 逐 chunk 直通、不 buffer；旁路 tee 出末帧 usage。
- [ ] 客户端断连 → `AbortController` 传到上游。
- [ ] 上游 4xx/5xx 原样透传，**不结算**；只有 `failover` 策略换下一条路由。

### 6. 用量落库（只记不扣）

- [ ] 每请求写一行 `amux.ai_usage_logs`，含 `public_model_id` + `backend_model_id` + `usage_source`。
- [ ] **Phase 0 不碰 `team_credit_balance`、不写 `credit_ledger`、不做预留** —— 强制是 Phase 2 的事。
- [ ] 这一点必须提前跟运营讲清楚：**Phase 0/1 期间上限仍然只在上游 provider key 上**，和今天一样。

### 7. `/internal/*` 路由

- [ ] service token 中间件，与 JWT 路径完全分开。
- [ ] `GET /internal/models` —— **别漏这条**。FC 的 `getWorkspaceConfig`（`services/fc/src/lib/pg-repo/teams.ts:159-186`）今天靠 `LITELLM_MASTER_KEY` 拉模型目录填 `availableModels`；换网关后 FC 没有终端用户 JWT，只能走内网 token。
- [ ] top-up / quota 两条可以先留桩（Phase 2 才用），但路由和鉴权先搭好。

### 8. compose + Caddy（只增不删）

- [ ] `deploy/self-host/docker-compose.yml` 新增 `ai-gateway` 服务，`depends_on: db healthy`，healthcheck 打 `/healthz`。
- [ ] `docker-compose.podman.yml` **同步改一份**（两份都在用）。
- [ ] Caddyfile 新增 `handle_path /ai/* { reverse_proxy ai-gateway:4001 }`。
      注意用 `handle_path`（会剥掉 `/ai` 前缀）而不是 `handle`：请求 `https://api.<domain>/ai/v1/teams/X/chat/completions` 到网关时是 `/v1/teams/X/chat/completions`，正好对上路由。
- [ ] `litellm` / `litellm-init` / `/llm/*` / `/ui/*` / `/litellm-asset-prefix/*` **一个都不动**。

### 9. env：两个目标都要声明

- [ ] `AI_GATEWAY_ENDPOINT`（沿用原义：对外、给客户端）指向 `https://api.<domain>/ai/v1`。
- [ ] 新增 `AI_GATEWAY_INTERNAL_URL`、`AI_GATEWAY_SERVICE_TOKEN`。
- [ ] ⚠️ **三个都必须同时写进 `services/fc/s.yaml` 和 compose 的 `fc:` `environment:` 映射** —— compose 的 environment 是显式白名单，漏一个就在那个目标上静默丢失，而且 `services/fc/test/deploy-env-parity.test.ts` 和 `scripts/lib/env-manifest.test.js` 会红。
- [ ] `AI_GATEWAY_SERVICE_TOKEN` 加进 `deploy/self-host/bootstrap/gen-secrets.sh`。
- [ ] `.env.example` 和 `.env.local.example` 补文档。

### 10. CI：加等待与 smoke，不删旧的

- [ ] ⚠️ **`.github/workflows/self-host-deploy.yml` 的 `on.paths` 加 `services/ai-gateway/**`** —— 现在只有 `deploy/self-host/**`、`services/fc/**`、`services/supabase/migrations/**`，不加的话推了网关代码根本不触发部署。
- [ ] `upsert_env` 三个 `AI_GATEWAY_*`（在现有 `LITELLM_URL` 那行旁边加，**不要替换它**）。
- [ ] 加 `until docker compose ps ai-gateway | grep -q healthy` 的等待，与现有 litellm 等待**并列**。
- [ ] 新增 `deploy/self-host/smoke/ai-gateway-smoke.sh`，与 `litellm-smoke.sh` 并列跑。

### 11. smoke 覆盖面

- [ ] `/healthz` 通。
- [ ] 无 token → 401。
- [ ] 有效 token 但 teamId 不是自己的团队 → **403**（这条是 §6.2 那个越权口子的回归测试，别省）。
- [ ] `GET /models` 返回非空且包含全部现网 id。
- [ ] 一次非流式 `chat/completions` 打通，并在 `ai_usage_logs` 落一行。
- [ ] 一次流式请求，确认首字节及时到达（不是收完才吐）。
- [ ] 三档 tier 各打一次通；发一个不存在的 model id → 403（不是 200 也不是回落）。

---

## P1 — 客户端切换

### 12. daemon `ai:invoke` scope + 代理路由

- [ ] `apps/daemon/src/http/` 新增模块，路由 `/v1/ai/teams/:teamId/*path` → 上游 `/v1/teams/:teamId/*path`。
- [ ] ⚠️ **上游地址由 daemon 读云端 `llm_base_url` 解析，必须支持转发到两种上游**（新网关 / 老 LiteLLM）。客户端写死之后，§11.1 那条「一条 UPDATE 灰度、一条 UPDATE 回滚」的杠杆就落在这里 —— 解析点从客户端后移了一跳到 daemon。只支持新网关等于没有回滚路径。
- [ ] teamId 走路径显式传递，不靠 daemon 推断（省掉一整类「切团队后记到旧团队账上」的 bug）。
- [ ] 新增 scope `ai:invoke`，加进 `daemon_config.rs` 的 scope 列表。
- [ ] ⚠️ **绑定地址不一定是 loopback**：`apps/daemon/src/http/server.rs:74-96` 明确支持绑 `0.0.0.0`/`[::]`，所以鉴权是硬要求，不能靠「本地所以安全」。
- [ ] ⚠️ **新模块要在 `apps/daemon/tests/support/crate_modules.rs` 和 `apps/daemon/tests/http_apps.rs` 各声明一份**。漏了会让 5 个集成测试二进制编译失败，而 `--bin` 跑起来全绿看不出来。提交前跑 `cargo test -p amuxd --all-targets --no-run`。

### 13. 放宽三个全局中间件

`apps/daemon/src/config/daemon_config.rs` 的默认值对 LLM 流量都太紧：

- [ ] `max_body_bytes` 默认 **1 MiB** —— `provider.team` 声明的 context limit 是 256k token，对应 JSON 请求体轻松超过，**会直接 413**。新增 `http.ai_max_body_bytes`，默认 32 MiB。
- [ ] `rate_limit_rps` 20 / `burst` 60 —— agent 的并行 tool call 会突刺。`/v1/ai/*` 走独立桶或豁免。
- [ ] `max_sse_per_token` **8** —— 每个流式补全占一条，很容易打满。AI 流不计入这个计数。
- [ ] SSE 逐 chunk 转发；客户端取消要能传到上游。注意这与现有 `/v1/sessions/:id/stream` 不同：那个是 daemon 自己产的 SSE，这个是**转发上游**的，是新场景，单独测。

### 13.5 客户端 provider 写死

- [ ] `crates/teamclu-runtime-env/src/team_provider.rs` 的 `mutate_team_provider`：`models_out` 不再从云端 `provider.models` 构造，改为固定三档 `default` / `pro` / `max`（§4.3.1）。
- [ ] baseURL 仍在运行时拼（本地 amuxd 端口 + teamId）；`llm_enabled` 仍来自云端。**只有模型列表和 provider 形状写死。**
- [ ] 随之可以简化的：`managed_llm_config` 返回的 `models` 字段、FC `getWorkspaceConfig` 的 `availableModels`（`services/fc/src/lib/pg-repo/teams.ts:159-186`，今天靠 `LITELLM_MASTER_KEY` 拉目录）。
      ⚠️ **但先不要删** —— iOS 和 FC 管理面还可能在读；本期只让桌面端不依赖它，清理留到 Phase 3 与 openapi 收敛一起做。
- [ ] `apps/daemon/src/runtime/managed_llm.rs` 的 reconcile TTL 缓存**保留**：它现在的作用退化为跟踪 `enabled` 与 `base_url` 的变化，而 `base_url` 正是灰度杠杆，不能停。

### 14. `${tc_gateway_token}` 替换 `${tc_api_key}`

五处派生点，一个都不能漏：

- [ ] `crates/teamclu-runtime-env/src/merge.rs:11` —— `sk-tc-` 派生本体
- [ ] `crates/teamclu-runtime-env/src/team_provider.rs:118-129` —— 跨 reconcile 保住已解析 key 的逻辑**原样保留**，只把匹配前缀换掉
- [ ] `crates/teamclu-runtime-env/src/{env_catalog,personal_secrets,mcp_resolve}.rs` —— `tc_api_key` 作为已知 secret 名
- [ ] `apps/desktop/src/commands/env_vars.rs:251` —— **桌面侧另有一份同样的派生逻辑**
- [ ] `packages/app/src/lib/team-provider.ts:11` —— 注释里的契约描述

### 15. 残留 `sk-tc-*` 清洗

- [ ] reconcile 时若 `options.apiKey` 匹配 `^sk-tc-`，视同「未解析」，用新占位符覆盖。
- [ ] **没有这一步，老设备升级后会拿着作废 key 打新网关，表现为持续 401 且用户无任何自愈手段。**

### 16. 灰度切换（改数据，不改代码）

- [ ] 单团队灰度：`UPDATE amux.team_workspace_config SET llm_base_url = 'https://api.<domain>/ai/v1/teams/' || team_id::text WHERE team_id = '<uuid>';`
- [ ] 回滚就是同一条 UPDATE 改回去。
- [ ] 观察：该团队正常出字，且 `ai_usage_logs` 的 token 数与上游对得上。
- [ ] 全量后再把 `AI_GATEWAY_ENDPOINT` 指向新网关，让没有显式 `llm_base_url` 的团队（走 fallback 分支）也自动切过去。

### 17. 验证

- [ ] 桌面端跑一个真实会话，确认流式体验没退化（首字节延迟、中断能传到上游）。
- [ ] `tests/e2e/smoke-team-share-onboarding.test.ts` 仍绿（它引用了 litellm 流程，Phase 1 不该动它）。
- [ ] `pnpm test:unit`、`pnpm rust:clippy`、`cargo test -p amuxd --all-targets --no-run`。

---

## 本计划不含

| 内容 | 在哪 |
|---|---|
| Credits 预留 / 结算 / quota 强制、存量团队补发额度 | 设计稿 §4.6 / §4.8.1，Phase 2 |
| FC credits 端点、openapi 的 `litellmTeamId` 松绑 | §7.1 / §8，Phase 2 |
| **设置页账单页 + 现有 Token 用量页迁移数据源** | §12，Phase 2。P0 只需把 `estimatedPricing` 提前加进 `GET /models` |
| 删 LiteLLM 容器 / 路由 / Caddy 段 / CI 步骤 / `_litellm` 库 | §11.5 的 gate，Phase 3 |
| Stripe 充值 | §4.9，Phase 4 |

---

## 风险检查清单

| 项 | 动作 |
|----|------|
| 上游不回 usage | P0.0.1 必验；结论会改 §4.4 和 §4.6 的预留额度 |
| **推 `services/fc/**` 或 `migrations/**` 到 main 会立即自动部署** | 迁移和 FC 改动合并即上线，不要在没准备好时合 |
| 新目录不在部署触发路径里 | P0.10 第一条，`on.paths` 加 `services/ai-gateway/**` |
| typecheck 绿但镜像构建失败 | 两个 tsconfig 都要过；构建失败会连带整个 self-host 部署挂 |
| pgTAP `indexes_are` 精确断言 | 同 PR 改 `020_oss_sync_schema.sql` |
| daemon 新模块漏声明在测试 crate root | `cargo test -p amuxd --all-targets --no-run` |
| `cargo fmt` 在 apps/daemon 上会重排 ~51 个无关文件 | 只 fmt 自己改的文件，别跑裸 `cargo fmt` |
| 桌面端裸 `cargo test` 必挂在 build.rs | 用 `rust-cli.js test` 或 `CI=1` |
| env 只写了一个部署目标 | `deploy-env-parity.test.ts` 会红，两边都写 |
| 灰度切换后老 key 残留 | P1.15 的清洗逻辑 |
| 客户端写死后误删灰度杠杆 | P1.12 第二条：daemon 必须能转发到两种上游，否则无回滚路径 |
| 老客户端仍在发 vendor model id | catalog 保留过渡别名到 Phase 3（§4.3.2） |

---

## 建议提交切分

1. `feat(ai-gateway): service skeleton + catalog loader + healthz`
2. `feat(db): ai gateway credits tables + pgtap index assertions`
3. `feat(ai-gateway): token verify, actor resolution, membership check`
4. `feat(ai-gateway): openai-compatible proxy with SSE passthrough + usage logging`
5. `feat(deploy): add ai-gateway to compose/caddy/CI (litellm untouched)`
6. `feat(daemon): /v1/ai proxy with ai:invoke scope and relaxed limits`
7. `feat(runtime-env): pin team provider to default/pro/max tiers`
8. `refactor(runtime-env): tc_api_key → tc_gateway_token + stale key cleanup`

前五条是 Phase 0，可以整体合并后独立验证；后三条是 Phase 1。

---

## 开始前

等你说 **「按计划实现」**，或指定先做 P0.0 的哪一项。

⚠️ 另外：设计文档和 `deploy/self-host/ai/` 目前在工作区仍是 untracked，git 里唯一的副本是一个既不在分支上也不在 reflog 里的游离 commit。动手之前建议先把它们正式提交到 `docs/ai-gateway-design` 分支上。
