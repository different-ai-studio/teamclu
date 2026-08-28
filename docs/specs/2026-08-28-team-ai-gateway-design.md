# Team AI Gateway：替换 LiteLLM 设计

- **Date**: 2026-08-28
- **Status**: DESIGN — 待评审后分期实现
- **Scope**: `services/ai-gateway/`（新建）、`services/fc/`（业务 API + 充值/限额管理面）、`apps/daemon/`（本地转发）、`crates/teamclu-runtime-env/`、`apps/desktop/`（`sk-tc-` 派生逻辑）、`packages/app/`（设置页）、`services/supabase/migrations/`、`deploy/self-host/`、`docs/openapi/teamclu-api.v1.yaml`
- **Replaces**: LiteLLM 容器、`/v1/teams/:id/litellm/*`、`_litellm` 数据库、`sk-tc-*` virtual key 体系
- **Related**: `docs/specs/2026-06-15-litellm-token-usage-rds-design.md`（本设计落地后作废）、`docs/architecture/personal-env-and-runtime-env.md`（`TC_ACCESS_TOKEN_FILE`）、`docs/adr/0007-amuxd-holds-model-capability-not-preference.md`

---

## 1. 背景与问题

当前团队共享 LLM 走 LiteLLM + virtual key。目标是用 **独立 `teamclu-ai-gateway` 服务** 替换，鉴权用 **JWT access token**，计费用 **Credits（积分）** 而非 LiteLLM 的 budget 概念。

### 1.1 为什么不继续用 LiteLLM

评审第一个问题一定是这个，所以先答。四条理由都能在仓库里指到证据：

| 问题 | 证据 |
|------|------|
| **per-team token 统计要企业版** | `services/fc/src/lib/litellm-usage.ts:1-9` —— 开源版 HTTP API 给不出按团队的 token 数，我们只能绕过 API 直连 `_litellm` 库 SELECT `LiteLLM_SpendLogs`。等于已经在维护一个「读 LiteLLM 内部表」的耦合。 |
| **virtual key 与登录态割裂** | key 是本地按 `sk-tc-{actor_id[..40]}` 推导的（`crates/teamclu-runtime-env/src/merge.rs:11`），既不是登录凭证也不能吊销；成员离职后 key 依然有效，除非单独去 LiteLLM 删。 |
| **budget 是 USD，产品要的是积分** | `LITELLM_DEFAULT_TEAM_MAX_BUDGET_USD`（`litellm.ts:36`）只在 provisioning 时写一次，改它不影响已存在的团队；而且没有「充值」这个概念，只有一个封顶数。 |
| **运维成本** | prisma 拥有 ~20 张表，必须独立数据库（`docker-compose.yml:102-133` 的 `litellm-init` 一次性服务就是为此存在），镜像 `litellm-database:v1.83.3-stable` 每次部署要单独拉+等 prisma migrate（`self-host-deploy.yml:263-310`）。 |

### 1.2 前提：今天的上游全是 OpenAI 兼容端点

这是自建网关可行的**技术前提**，必须显式记下来。`deploy/self-host/litellm/config.yaml` 里 5 条 `model_list` 全部是 `openai/<model>` + `api_base: https://api.deepseek.com`，没有一条走 Anthropic Messages / Gemini 原生协议。所以网关可以是一个 **纯 fetch 转发 + 少量 body 改写**，不需要任何协议翻译层。

**推论（写进决策记录）**：一旦要接 Anthropic 原生 / Gemini 原生协议，必须补一个翻译层 —— 那正是 LiteLLM 今天在替我们干的事。接入非 OpenAI 协议的上游 = 一个独立的、需要重新评审的决定，不能顺手加进 catalog。

### 1.3 一个不能丢的 LiteLLM 行为

`litellm_settings.drop_params: true`（`config.yaml` 末尾）：agent runtime（opencode / pi）会发 OpenAI 参数的**超集**，LiteLLM 在静默丢弃上游不认的参数。自建网关必须提供等价能力，否则上游会因为未知参数直接 400。见 §6.6。

---

## 2. 设计原则

1. **协议不变**：opencode / pi 继续 OpenAI Chat Completions；不重写 agent adapter。
2. **独立网关服务**：LLM 流式、Credits 账本、限额校验放在 `services/ai-gateway/`，不塞进 FC。
3. **JWT 鉴权**：`Authorization: Bearer <access_token>`；无 per-user API key 表。
4. **Credits 模型**：团队有 **余额（balance）**；成员有 **周期限额（quota）**；充值加余额，用量扣余额。
5. **配置分层**：operator 管上游 provider；team admin 管 model tier + 成员限额；用户不填 key。
6. **只增不删地迁移**：新旧网关并存到观察期结束，客户端灰度切换，最后才删 LiteLLM。见 §11。

---

## 3. 目标架构

```
┌──────────────────────────────────────────────────────────────────────────┐
│  Agent (opencode / pi)                                                    │
│  provider.team.baseURL                                                    │
│    → http://127.0.0.1:<amuxd>/v1/ai/teams/<teamId>                        │
│  provider.team.options.apiKey → ${tc_gateway_token}（daemon 会话令牌）      │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │  ai-sdk 自动拼 /chat/completions、/models
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  amuxd 本地代理  /v1/ai/teams/:teamId/*                                    │
│  ─ 校验 daemon 会话令牌（scope: ai:invoke）                                 │
│  ─ 换成 cloud access token → Bearer JWT                                    │
│  ─ 独立 body cap / 独立限流 / SSE 直通（见 §9）                             │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │
                                ▼
┌──────────────────────────────────────────────────────────────────────────┐
│  teamclu-ai-gateway  (services/ai-gateway/)                               │
│  POST /v1/teams/:teamId/chat/completions                                  │
│  GET  /v1/teams/:teamId/models                                            │
│  ─ 校验 token → sub（照抄 FC，无签名密钥）                                  │
│  ─ (teamId, sub) → amux.actors → actor_id（同时即成员资格证明）             │
│  ─ 查团队 balance、成员 period quota → 不足则 402                          │
│  ─ 路由 catalog.yaml → 上游；改写 body.model；注入 usage 采集               │
│  ─ 记 usage + 扣 credits + 写 ledger                                       │
└───────────────────────────────┬──────────────────────────────────────────┘
                                │
                                ▼
                         DeepSeek / OpenAI / …（均为 OpenAI 兼容，见 §1.2）

┌──────────────────────────────────────────────────────────────────────────┐
│  FC (Cloud API) — 业务面，不 proxy LLM 字节流                              │
│  workspace-config.llm（enabled / models / baseUrl）                        │
│  GET 余额 & 用量展示、成员限额 CRUD、充值下单                                │
│  → 经 AI_GATEWAY_INTERNAL_URL + service token 调网关 /internal/*           │
└──────────────────────────────────────────────────────────────────────────┘
```

### 3.1 多部署目标

`services/fc/` 有两个部署目标（见 CLAUDE.md「Deployment — one environment, two deploy targets」），且线上不止 self-host 一套：`services/fc/s.yaml` 那条手工部署路径上还跑着独立环境，用的是独立数据库。

**决定：每个部署目标各跑一个 `ai-gateway` 实例，绑自己的数据库。** 理由：credits 账本必须和 `amux.actors` / `amux.teams` 在同一个库里（§5.1），跨环境共用一个网关就意味着跨库查成员资格，做不到。

因此：

- catalog.yaml 是 **per-deployment** 的运维配置，不是仓库里的单一真相；仓库只提供 `catalog.example.yaml`。
- 上游 provider key 也是 per-deployment 的。
- **Phase 3 删 LiteLLM 时必须两套都已经切完**，否则会打挂另一套。这条进 §11 的 gate 条件。

---

## 4. Credits 模型（不用 budget）

### 4.1 概念

| 概念 | 说明 |
|------|------|
| **Credit** | 团队消费单位。**1 credit = 1e-6 元上游成本**（§4.4.1）；DB/API 用 `bigint` credits，UI 展示「积分」= credits/10,000 |
| **Team balance** | 团队共享钱包余额。充值、赠送、管理员调整 → **加**；AI 调用 → **减** |
| **Member quota** | 成员在 **一个周期内** 最多可消耗的 credits 上限（从团队 balance 里扣，不是成员单独钱包） |
| **Reservation** | 请求进行中的预留额度。防止并发超发，见 §4.6 |
| **Usage log** | 每次请求记 token + 折算 credits，用于报表与 quota 累计 |

**不用** LiteLLM 的 `max_budget` / `budget_exceeded` 术语；API 错误码用 `insufficient_credits`（团队余额不足）、`quota_exceeded`（成员周期限额已满）。

### 4.2 两层控制

```
请求能否通过？
  1. llm_enabled 且 model 在团队白名单内           → 否则 403 model_not_allowed
  2. team.balance - 在途预留 >= 本次预留额          → 否则 402 insufficient_credits
  3. member 本周期已用 + 在途预留 + 本次 <= quota   → 否则 402 quota_exceeded
     （quota 为 null = 不限，仅受团队余额约束）
```

团队没钱 → 全员停；团队有钱但某成员触顶 → 只拦该成员。

**余额耗尽是硬停，不降级。** 明确否掉「余额不足时自动路由到最便宜的 backend 继续服务」：

- 静默降级会让 agent **继续工作但产出质量下降，且无人察觉**。定时任务尤其危险 —— 无人值守地持续产出低质量结果。失败是可见的，降级不是。
- 降级还会和团队的模型白名单、§4.6 的预留逻辑打架（预留是按 public model 的最高价算的）。

也不做透支宽限：账本出现负余额就需要一整套追缴逻辑，收益不抵复杂度。运营侧的正确解法是**余额低水位告警**，不是让它跌破零。

### 4.3 模型目录：对外名 vs 上游名（1:n）

客户端（opencode / pi / 设置页）只接触 **对外 model id**（public model）。网关内部再解析到 **上游 provider + 他们的 model name**。二者分开维护，**1 个对外 id 可对应 N 条上游路由**。

```
客户请求  model: "max"
              │
              ▼
┌─────────────────────────┐
│  public_models.max       │  对外 catalog + **定价**（§4.4）          
│  routes[] (1:n)          │
└───────────┬─────────────┘
            │ 路由策略 pick 一条
            ▼
┌─────────────────────────┐
│  backend_models.gpt-4o  │  实际上游：provider + upstream_model（无定价）
│  → openai/gpt-4o        │  cost 可选，仅供毛利报表
└─────────────────────────┘
            │
            ▼
        上游 API（body.model = upstream_model）
```

**维护位置**：operator 配置文件，容器内挂载为 `/app/catalog.yaml`。仓库里的示例见 `deploy/self-host/ai/catalog.example.yaml`。

**路由策略**

| `routing` | 行为 |
|-----------|------|
| `priority` | 按 `routes` 顺序，第一条可用即用 |
| `weighted` | 在可用路由中按 `weight` 随机（如某档大部分走 flash、少部分走 pro） |
| `failover` | 先试第一条，上游 429/5xx/超时则试下一条 |

团队 `llm_models` / 设置页只存 **public id**，不出现 `deepseek-v4-pro`。

`GET /v1/teams/:teamId/models` 返回 public 层 `{ id, name }`；**不**暴露 upstream 名。桌面端在 §4.3.1 之后不再调它（列表已写死），这个端点保留给 FC 的管理面、iOS 与将来的其他客户端。

#### 4.3.1 对外只有三档：`default` / `pro` / `max`

**决定：客户端侧的团队 provider 写死，模型固定为三档 tier。**

```
public_models = { default, pro, max }     ← 唯一对外契约
```

Tauri 端不再从云端拉团队的模型列表：`provider.team` 的形状与这三个 id 由客户端固定持有，只有 baseURL 在运行时拼（本地 amuxd 端口 + teamId），`llm_enabled` 仍来自云端。

**为什么写死是安全的**：三档 tier 本来就是**稳定名字**，真正会变的是它们指向哪个上游 —— 而那层映射在服务端的 catalog 里（§4.3）。改后端、调价、加权重、切供应商都**不需要发客户端**。今天 `litellm/config.yaml` 的注释写的就是这个意图：「The app selects a capability tier, not a vendor model.」本设计把它变成硬契约。

代价说清楚：**真要加第四档就需要发一次客户端**。这是刻意接受的 —— 加档是产品决策，不该是一次配置改动。

#### 4.3.2 过渡期要保留 vendor 名作为别名

线上今天还对外暴露着两个 vendor 名（`deepseek-v4-flash` / `deepseek-v4-pro`），而且它们已经存进了各团队的 `team_workspace_config.llm_models`。

新客户端不再读 `llm_models`，所以那份存量数据变成死数据、不会造成故障。**但老客户端还在发这些 id**，所以：

- **Phase 0–1**：catalog 的 `public_models` 里保留这两个 vendor 名，各指向对应 backend，作为**过渡别名**。收到就正常服务。
- **Phase 3**（老客户端已全部退场，与删 LiteLLM 同一个 gate）：从 catalog 移除，同时清理 `llm_models` 里的死数据。

网关对**未知 model id** 一律 403 `model_not_allowed`，不要静默回落到 `default` —— 静默回落会让一个发错 id 的客户端永远拿到错误档位却毫无征兆。

### 4.4 Credits 折算（按三档 tier 自主定价）

**定价挂在 `public_models.*.pricing`（default / pro / max），不挂在 backend 上。** 我们自己定价，不锚定上游成本。

```
credits = ceil(input_tokens  × input_per_1m_credits  / 1_000_000)
        + ceil(output_tokens × output_per_1m_credits / 1_000_000)
```

三档各一组 `(input_per_1m_credits, output_per_1m_credits)`，就这么多。

#### 4.4.0 自主定价换掉了什么

早期草案把 credits 锚定在上游成本、定价挂在 `backend_models` 上。实测上游之后那条路会背上三层复杂度，而自主定价把它们**全部消掉**：

| 锚定上游会带来的问题 | 自主定价后 |
|---|---|
| **峰谷价差 2 倍**（DeepSeek 谷时价是峰时一半，峰时为 UTC 周一至周五 01:00–04:00 与 06:00–10:00） | 消失。这是我们的成本波动，不是用户的价格波动，由毛利吸收 |
| **prompt 缓存命中价约为未命中的 1/30**，实测同前缀命中率 99.4%（`hit=3456 / miss=20`），不拆分计价就等于按 30 倍收费 | 消失。缓存省下来的是**我们的毛利**，用户看到的是稳定单价 |
| **混合路由的档位单价不确定**（`max` 会 failover 到差一个数量级的两个 backend），预留只能按最高价估 | 消失。`max` 无论落到哪个 backend，用户付的都是同一个价 |
| 上游价目表是美元，需要 FX 换算且会漂 | 消失。credits 是我们自己的单位 |

**但仍然要记录成本侧的明细。** `ai_usage_logs` 保留 `cached_input_tokens` 与实际命中的 `backend_model_id` —— **计费不看它们，毛利分析看**。缓存命中率掉下来、或某档路由成本翻倍，只有这两列能提前告诉我们。**计费简单，记录详细**，这是两件事。

`backend_models.*.cost` 是**可选**字段，纯给毛利报表用，不参与任何扣费；不维护也不影响系统运行。

#### 4.4.0.1 一条仍然躲不掉的上游适配

定价与上游脱钩了，但 **usage 的取法仍是 per-provider 的协议差异**：

- **DeepSeek**：无条件返回 usage，挂在**最后一个正常 chunk**（带 `finish_reason`）上，不是独立帧。
- **OpenAI**：需要注入 `stream_options.include_usage`，且会额外发一个 `choices` 为空的独立 usage 帧 —— 客户端原本没要的话，网关要把这一帧吞掉。

所以 catalog 的 provider 上要声明 `usage_mode: always | needs_stream_options`，§6.6 按它分支。

另两条实测结论：**未知参数被容忍**（`some_bogus_param` 照样 200），§1.3 的 `drop_params` 替代降级为防御性、不阻塞 Phase 0；**`reasoning_tokens` 已计入 `completion_tokens`**（实测 24 = 24），输出不用单独加，但 reasoning 会吃光 `max_tokens`（实测 24 token 全被 reasoning 用掉、`content` 为空），§4.6 的预留要按「输出全是 reasoning」估。

#### 4.4.1 credit 单位：必须细到 `ceil` 落进噪声

这个公式对单位的选取**不是中立的**。如果 1 credit 取得太粗，`ceil` 会系统性高估：

```
flash 输入 20 credits/1M token，一次 5,000 token 的请求：
  5000 × 20 / 1_000_000 = 0.1  →  ceil = 1     ← 多收 10 倍
```

agent 一次会话有几十次这种小请求，所以这是常态而不是边缘情况。

**约束：单价要定得让「一次典型请求 ≥ 数千 credits」。** 具体数值是产品定价决策（附录 F），但无论定多少都必须满足这条，否则 `ceil` 会吃掉小请求。

满足该约束的一个量纲示例：`default` 档输入定为 `1,000,000 credits / 1M token`（即 1 credit ≈ 1 个输入 token），其余档按倍数展开。

| 项 | 取值 |
|---|---|
| catalog 里的数值 | 每 1M token 收多少 credits，由我们自己定 |
| 典型请求量级 | 5,000 input token ≈ 5,000 credits，`ceil` 误差 0.02% |
| `bigint` 上限 | 9.2e18 credits = 9.2e12 元，不可能溢出 |
| UI 显示 | 「积分」= `credits / 10_000` |

**UI 只展示余额与聚合，不展示单次请求成本。** 余额（万级积分）和单次成本（0.0x 积分）差 5 个数量级，任何单一显示单位都会在一端难看；单次成本只出现在会话/日聚合里。

**credits 是我们自己的定价单位，与上游成本无关。** 上游涨价、换供应商、缓存命中率变化都不改变用户看到的单价 —— 变的是毛利。充值时的元↔积分换算是另一个独立的运营参数。

| 阶段 | 做法 |
|------|------|
| 请求前（预留） | 该档的单价 × 预估 token 数（输入按字节估、输出按 `max_tokens` 上限），见 §4.6 |
| 请求后（结算） | 按**该档单价** + 上游 usage 的 token 数精确扣费，冲销预留。落哪个 backend 不影响金额 |
| 无 usage | 按 `max_tokens`（缺省时按该 backend 的 `default_max_output_tokens`）上限保守扣，并在 `ai_usage_logs.usage_source` 记 `estimated` |

**用量日志**同时记 `public_model_id`（计费依据）与 `backend_model_id` + `cached_input_tokens`（成本/毛利依据，不参与计费）。

**Credit ↔ 货币**：见 §4.4.1。网关内部只认 credits，不做任何汇率换算；元 → credits 的换算（含加价）发生在 FC 的充值入口，货币金额由支付侧自己留痕在 `credit_ledger.note`。

### 4.5 成员限额配置

Team owner 可设 `limit_credits`（null = 不限）。管理 API 在 FC；enforcement 在 gateway。周期口径见附录 A。

**`period` 是团队级的，不是成员级。** 画限额界面时发现的错配：如果成员各用各的周期，「本周期已用」这一列就不可比，报表也讲不通。所以 `period` 落在 `team_credit_settings` 上，`member_credit_quota` 只存每人的 `limit_credits`。

### 4.6 并发与超发（一期就要有解）

**问题**：「请求前查余额 > 0，请求后结算」在流式 + 并发下必然超发 —— N 个并发请求都看到余额充足，各自跑掉几十万 token。agent runtime 天然是并发的（一个会话里多个 tool call 并行），这不是边缘情况。

**方案：预留（reservation）+ 结算冲销**，一个表 + 一次行锁：

```
请求开始（同一事务）：
  SELECT balance_credits FROM amux.team_credit_balance
    WHERE team_id = $1 FOR UPDATE;
  reserved := SELECT COALESCE(SUM(amount_credits),0)
                FROM amux.credit_reservation
               WHERE team_id = $1 AND state = 'held';
  hold := estimate(public_model, body)      -- 见下
  IF balance - reserved < hold THEN 402 insufficient_credits
  INSERT INTO amux.credit_reservation (..., state='held', expires_at=now()+interval '10 min')
  COMMIT;                                    -- 锁只持有毫秒级，不跨越上游请求

请求结束（同一事务）：
  actual := settle(backend_model, usage)
  UPDATE amux.team_credit_balance SET balance_credits = balance_credits - actual ...
  INSERT INTO amux.credit_ledger (kind='usage', amount_credits = -actual, ...)
  UPDATE amux.credit_reservation SET state='settled' WHERE id = $1
  INSERT INTO amux.ai_usage_logs (...)
```

`estimate()` 一期用一个保守常数：`最高价路由 × (输入 token 估算 + max_tokens)`。输入 token 估算不引 tiktoken —— 按 `字节数 / 3` 粗算即可（宁可高估，预留是可退的）。

**孤儿预留**：进程崩溃 / 客户端断连会留下 `held` 行。网关启动时 + 每分钟扫一次，把 `expires_at < now()` 的 `held` 置 `expired`。10 分钟是硬上限，超过它的长请求会被提前放开预留（接受这点风险，比永久漏额度好）。

**member quota** 走同一套：`credit_reservation.actor_id` 参与 quota 侧的 SUM。

**分期**：预留机制在 **Phase 2** 落地。Phase 0/1 网关**只记账不扣费**（写 `ai_usage_logs`，不动 balance），所以那两期没有超发风险 —— 因为根本没有强制。这一点必须在 Phase 0 上线前对运营讲清楚：**Phase 0/1 期间上限仍然只在上游 provider key 上**，和今天一样。

### 4.7 充值

FC `POST /v1/teams/:id/credits/top-up` → gateway `/internal/.../top-up` → `credit_ledger` + `team_credit_balance`。

**幂等**：请求必须带 `idempotency_key`；`credit_ledger` 上有唯一索引，重复提交返回原记录而不是二次入账。一期只做管理员 manual top-up，但幂等键从第一天就要有 —— 支付回调重放是 Phase 4 必踩的坑，表结构不能到时候再改。

**渠道：Stripe**（Phase 4，见 §4.9）。幂等键让表结构对渠道无感，所以 Phase 0–3 不受任何影响。

### 4.8 新团队赠送额度

**决定：每个团队创建时一次性 grant 10 元成本额度**（= 10,000,000 credits，按 §4.4.1 的单位；约 40 次典型 agent 会话）。

- 走正常的 `credit_ledger`，`kind='grant'`，`idempotency_key = 'signup_grant:' || team_id` —— 幂等键保证重试或补跑都不会重复发放。
- 不按成员人头发放：邀请是团队自己控制的，按人头等于可以靠拉人无限刷额度。
- 由 FC 在 `createTeam` 成功后调 `/internal/.../top-up` 发放；失败不阻塞建团队（幂等键让补发安全）。

#### 4.8.1 ⚠️ Phase 2 必须给存量团队补发

这是赠送额度带来的**硬性迁移动作**，容易漏：Phase 0/1 只记账不扣费，Phase 2 一旦打开强制，**所有余额为 0 的存量团队会在同一时刻全部 402**。

Phase 2 上线前必须先跑一次补发：

```sql
-- 给所有还没有余额行的团队补发起始额度（幂等键保证可重复执行）
-- 实际通过 gateway /internal 接口批量调用，此处示意口径
SELECT id FROM amux.teams t
 WHERE NOT EXISTS (SELECT 1 FROM amux.team_credit_balance b WHERE b.team_id = t.id);
```

顺序不能反：**先补发、再打开强制**。这条进 §11 Phase 2 的完成判据。

### 4.9 Stripe 充值（Phase 4）

#### 4.9.1 放 FC，不放 ai-gateway

沿用 §4.7 已经定下的边界：**ai-gateway 是 `credit_ledger` 的唯一写入者**，FC 只调它的 `/internal/teams/:teamId/credits/top-up`。Stripe 属于业务面（商品、税、发票、退款、客户档案），不该待在一个持有全部上游 provider key、刻意只有 5 个依赖的流式代理里。

单写者不变量在这里有个直接回报：**webhook 处理器在 FC 内不需要任何新权限**。它不碰数据库，验签之后拿 `AI_GATEWAY_SERVICE_TOKEN` 调网关即可 —— 否则就得给一条免鉴权路由配一个特权 repository。

#### 4.9.2 FC 侧的三个原语都是现成的

`services/fc/src/lib/hono-adapter.ts` 已经具备全部所需能力，不用改 adapter：

| 需要 | 已有 | 先例 |
|---|---|---|
| 免 bearer 鉴权的入站路由 | `{ auth: "none" }` | `routes/auth.ts`、`routes/invites.ts` 十余处 |
| 原始请求字节（验签必需） | `router.postRaw(...)` → `ctx.rawBody` 是 `Buffer`（adapter:59） | `routes/attachments.ts:15` |
| 公网可达 | Caddy 兜底 `handle { reverse_proxy fc:9000 }` | 无需新增规则 |

```js
// services/fc/src/lib/routes/stripe.ts
export function registerStripe(router) {
  // postRaw 把 { ...o, rawBody: true } 合进 options（见 adapter 末尾三行）
  router.postRaw("/v1/stripe/webhook", { auth: "none" }, async (ctx) => {
    // rawBody 模式下 ctx.json 被刻意置为 undefined，ctx.rawBody 是原始字节。
    const event = stripe.webhooks.constructEvent(
      ctx.rawBody,
      ctx.getHeader("stripe-signature"),
      process.env.STRIPE_WEBHOOK_SECRET,
    );
    ...
  });
}
```

⚠️ **必须用 `postRaw`。** Stripe 验签要的是原始字节，任何「先 `JSON.parse` 再重新序列化」的路径都会验签失败 —— 这是 Stripe 接入的头号 bug，而这条路 FC 已经为附件上传铺好了。

注册顺序无所谓：`/v1/stripe/*` 不在 `/v1/teams/:teamId/*` 的遮蔽范围内。

#### 4.9.3 换算表放 Stripe Price 的 metadata

在 Stripe Price 上挂 `metadata.credits`，webhook 直接读；**没有该 metadata 就拒绝入账并告警**，不猜（钱的路径 fail closed）。

三个好处：

1. 买到的额度锚死在下单那一刻的商品上，事后改价不会追溯改变在途订单。
2. 加价逻辑集中在 Stripe 后台一处，不散落在代码里 —— 与 §4.4.1「credits 锚成本、加价只发生在充值那一次换算」完全一致。
3. **币种变得无关**：credits 锚的是元的上游成本，Stripe 收什么币种都不影响这张映射表。

#### 4.9.4 幂等键用 Session id，不要用 event id

```
idempotency_key = 'stripe:cs:' + session.id      ← 对
idempotency_key = 'stripe:evt:' + event.id       ← 错，会重复入账
```

同一个 Checkout Session 可能触发 `checkout.session.completed` **和** `checkout.session.async_payment_succeeded` 两个事件，它们有不同的 `evt_` id。按 event id 做键会发两次额度；按 session id 只发一次，`credit_ledger` 的 `(team_id, idempotency_key)` 唯一索引直接兜住。

- 入账条件：`checkout.session.completed` 且 `payment_status === 'paid'`，外加 `checkout.session.async_payment_succeeded`。
- 退款：`charge.refunded` → `kind='refund'`，键用 `'stripe:re:' + refund.id`。
- `team_id` 走 Session 的 `metadata` + `client_reference_id`。Session 由服务端用已鉴权调用者的团队创建，所以可信；网关侧团队不存在直接 404，**不要静默忽略**。

#### 4.9.5 为什么 §5.2 的余额表没有非负约束

退款是这条约束站不住的原因，记在这里免得后人「顺手补上」。

一个直觉上很自然的 `CHECK (balance_credits >= 0)` 会在这条正常路径上炸掉：用户充值 → 花掉额度 → 申请退款，那笔负向 ledger 让约束失败，整个事务回滚，退款做不成。

**所以 §5.2 从一开始就不带这个约束。** 账本是真相，退款导致负余额是合法状态；花钱的闸门本来就在 §4.6 的 `balance - reserved >= hold`，余额为负时它自然拒绝。丢掉的那层安全网由 §5.3 的**负余额告警**补上（Phase 2 就位，早于 Stripe 接入）。

#### 4.9.6 ⚠️ 不要把发额度只挂在 webhook 一条路上

Stripe 从境外主动回调 `api.<domain>/v1/stripe/webhook`，而该域名解析到大陆机房。这条跨境链路的可靠性**必须实测**（本仓库已有跨境连通性受阻的先例：该机器访问 Google 被墙，靠境外代理绕行）。

兜底两层，都靠幂等键保证补跑安全：

1. Stripe 自身重试最多 3 天。
2. 一个定时对账任务扫 `stripe.checkout.sessions.list`，把已支付但本地无 ledger 条目的补进来。

#### 4.9.7 客户端

Tauri 内嵌 webview **不要**用来打开 Checkout（3DS 与钱包会出问题，用户也看不到地址栏），走系统浏览器。返回后不阻塞 UI 等 webhook —— 显示「处理中」，让余额自行刷新。

---

## 5. 数据模型

### 5.1 放哪个库：主库 `amux` schema

**决定：新表放主 Postgres（`postgres` 库）的 `amux` schema，走 `services/supabase/migrations/`。**

对比 LiteLLM 用独立 `_litellm` 库的理由（prisma 拥有 ~20 张表、名字通用、会和应用 schema 撞名），这里不成立：只有 4 张目的明确、带前缀的表。而放主库换来两件必需的事：

1. 网关要用 `(teamId, sub) → amux.actors` 做成员资格校验（§6.2），跨库做不到。
2. FC 的管理面（余额展示、quota CRUD）要 join `teams` / `actors` / `team_members`。

代价：网关多一个数据库连接到主库。用**独立 role** `ai_gateway` 限制权限，不共用 FC 的连接串。

**⚠️ 落地注意**：往 `amux` 加表/索引会撞 `services/supabase/tests/020_oss_sync_schema.sql` 里的 `indexes_are` **精确集合断言** —— 迁移是对的、红的是断言，必须在同一个 PR 里一起改。（参考本仓库 pgTAP 套件的既有约定。）

迁移文件命名沿用 `YYYYMMDDHHMMSS_<slug>.sql`，由 `deploy/self-host/init/apply-migrations.sh` 按字典序幂等应用、记账在 `_selfhost.schema_migrations`。

### 5.2 DDL 草案

```sql
-- 20260901000000_ai_gateway_credits.sql

-- 团队余额。一行一团队，物化余额而不是每次 SUM(ledger)：
-- 余额要被 SELECT ... FOR UPDATE 锁住做预留，ledger 聚合做不到这件事，
-- 而且 ledger 是只增表，几个月后聚合会变慢。
-- 不变量：balance_credits == SUM(credit_ledger.amount_credits)，由对账任务校验。
CREATE TABLE amux.team_credit_balance (
  team_id         uuid PRIMARY KEY REFERENCES amux.teams(id) ON DELETE CASCADE,
  balance_credits bigint      NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now()
  -- 刻意没有 CHECK (balance_credits >= 0)：退款可以合法地把余额打成负数
  -- （§4.9.5）。花钱的闸门在 §4.6 的 balance - reserved >= hold，余额为负时
  -- 它自然拒绝。丢掉的那层安全网由 §5.3 的「余额为负」对账告警补上。
);

-- 只增账本。充值/赠送/调整为正，用量为负。
CREATE TABLE amux.credit_ledger (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id         uuid NOT NULL REFERENCES amux.teams(id) ON DELETE CASCADE,
  -- 用量行记到 actor；充值行为 NULL。
  actor_id        uuid REFERENCES amux.actors(id) ON DELETE SET NULL,
  kind            text NOT NULL
                  CHECK (kind IN ('top_up','grant','adjustment','usage','refund')),
  amount_credits  bigint NOT NULL,        -- 有符号：usage 为负
  -- 幂等键。支付回调重放、FC 重试都靠它去重。手工 top-up 也必须带。
  idempotency_key text,
  usage_log_id    uuid,                   -- kind='usage' 时指向 ai_usage_logs
  note            text,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX credit_ledger_idem_uniq
  ON amux.credit_ledger (team_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;
CREATE INDEX credit_ledger_team_created_idx
  ON amux.credit_ledger (team_id, created_at DESC);

-- 在途预留（§4.6）。请求开始 held，结束 settled，超时 expired。
CREATE TABLE amux.credit_reservation (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id        uuid NOT NULL REFERENCES amux.teams(id) ON DELETE CASCADE,
  actor_id       uuid NOT NULL REFERENCES amux.actors(id) ON DELETE CASCADE,
  amount_credits bigint NOT NULL CHECK (amount_credits >= 0),
  state          text   NOT NULL DEFAULT 'held'
                 CHECK (state IN ('held','settled','expired')),
  created_at     timestamptz NOT NULL DEFAULT now(),
  expires_at     timestamptz NOT NULL
);
-- 预留求和是每个请求的热路径，只扫 held 行。
CREATE INDEX credit_reservation_held_idx
  ON amux.credit_reservation (team_id, actor_id)
  WHERE state = 'held';
CREATE INDEX credit_reservation_expiry_idx
  ON amux.credit_reservation (expires_at)
  WHERE state = 'held';

-- 成员周期限额。
-- 团队级的限额设置。period 放这里而不是放在每个成员行上：成员各用各的
-- 周期会让「本周期已用」不可比（§4.5）。default_limit_credits 是新成员的
-- 缺省值，null = 不限。
CREATE TABLE amux.team_credit_settings (
  team_id               uuid PRIMARY KEY REFERENCES amux.teams(id) ON DELETE CASCADE,
  period                text NOT NULL DEFAULT 'month' CHECK (period IN ('week','month')),
  default_limit_credits bigint CHECK (default_limit_credits IS NULL OR default_limit_credits >= 0),
  low_balance_credits   bigint,   -- 低水位告警阈值，null = 不告警
  updated_at            timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE amux.member_credit_quota (
  team_id       uuid NOT NULL REFERENCES amux.teams(id) ON DELETE CASCADE,
  actor_id      uuid NOT NULL REFERENCES amux.actors(id) ON DELETE CASCADE,
  limit_credits bigint CHECK (limit_credits IS NULL OR limit_credits >= 0),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (team_id, actor_id)
);

-- 每次请求一行。既是报表来源，也是 quota 周期累计的来源。
CREATE TABLE amux.ai_usage_logs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  team_id           uuid NOT NULL REFERENCES amux.teams(id) ON DELETE CASCADE,
  actor_id          uuid REFERENCES amux.actors(id) ON DELETE SET NULL,
  public_model_id   text NOT NULL,       -- 客户请求的
  backend_model_id  text NOT NULL,       -- 实际路由到的
  provider_id       text NOT NULL,
  -- 计费按 input+output 与该档单价（§4.4）。cached_input_tokens 只是
  -- 其中命中缓存的那部分，**不参与计费**，纯供毛利分析：实测命中率
  -- 99.4%、命中成本约为未命中的 1/30，这一列是成本变化的早期信号。
  input_tokens      bigint NOT NULL DEFAULT 0,
  cached_input_tokens bigint NOT NULL DEFAULT 0,  -- input_tokens 的子集，不计费
  output_tokens     bigint NOT NULL DEFAULT 0,
  credits           bigint NOT NULL DEFAULT 0,
  -- 'upstream' = 上游回了 usage；'estimated' = 按 max_tokens 保守扣（§4.4）
  -- DeepSeek 实测无条件回 usage，estimated 基本只在上游异常时出现
  usage_source      text NOT NULL DEFAULT 'upstream'
                    CHECK (usage_source IN ('upstream','estimated')),
  status_code       int,
  stream            boolean NOT NULL DEFAULT false,
  latency_ms        int,
  request_id        text,
  created_at        timestamptz NOT NULL DEFAULT now()
);
-- quota 周期累计：WHERE team_id=? AND actor_id=? AND created_at >= 周期起点
CREATE INDEX ai_usage_logs_team_actor_created_idx
  ON amux.ai_usage_logs (team_id, actor_id, created_at DESC);
CREATE INDEX ai_usage_logs_team_created_idx
  ON amux.ai_usage_logs (team_id, created_at DESC);

-- 网关专用 role：只有这 5 张表 + actors 只读。不走 RLS —— 网关自己做 authz，
-- 且它不持有终端用户 JWT 去 PostgREST，RLS 在这条路径上没有作用点。
GRANT USAGE ON SCHEMA amux TO ai_gateway;
GRANT SELECT, INSERT, UPDATE ON amux.team_credit_balance,
      amux.credit_reservation TO ai_gateway;
GRANT SELECT, INSERT ON amux.credit_ledger, amux.ai_usage_logs TO ai_gateway;
GRANT SELECT ON amux.member_credit_quota, amux.team_credit_settings,
      amux.actors, amux.teams, amux.team_workspace_config TO ai_gateway;
```

### 5.3 保留与对账

- `ai_usage_logs` 无限增长。**保留 13 个月**（够同比），超期由一个 FC cron 归档删除。Phase 2 一起做，不要留到表大了再补。
- **对账任务**（Phase 2）：每日校验 `team_credit_balance.balance_credits == SUM(credit_ledger.amount_credits)`，不一致告警。物化余额的代价就是要有这个任务。
- **负余额告警**（Phase 2）：`balance_credits < 0` 的团队一律告警。§5.2 刻意去掉了非负 CHECK（退款可合法致负，§4.9.5），这条告警是它的替代品 —— 结算逻辑的 bug 只能靠它兜住。
- **不做 BI 只读副本。** §5.2 的两个索引够撑报表查询；量大了先做月度 rollup 表，副本是再之后的事。
- ⚠️ **报表查询只能由网关（`ai_gateway` role）或 FC 服务端跑，不要暴露成 PostgREST 上 `authenticated` 角色的查询** —— 那个角色有 8 秒 statement_timeout，本仓库已经在会话列表上栽过一次同样的坑。

---

## 6. `services/ai-gateway/`

### 6.1 职责

OpenAI-compatible 代理、JWT 验证与成员资格校验、Credits/quota、账本、内网 admin API（FC 调用）。

### 6.2 鉴权：JWT → actor（同时即成员资格证明）

这是本设计的安全核心，必须写死：

```
Authorization: Bearer <access_token>
   │
   ├─ 1. 校验 token，拿到 sub。方式与 FC 一致，按 BACKEND_KIND 分两条路
   │      （见 §6.2.1）—— 网关不持有任何签名密钥。
   │
   ├─ 2. sub → actor。路径里的 :teamId 不可信，token 只证明「你是谁」。
   │      SELECT id, actor_type FROM amux.actors
   │       WHERE team_id = :teamId AND user_id = sub;
   │      查不到 → 403 not_a_team_member
   │
   └─ 3. actors 表上有 UNIQUE (team_id, user_id) WHERE user_id IS NOT NULL
          （services/fc/src/db/schema/teams.ts:52），所以这一条查询同时完成
          「解析 actor」和「证明该 user 属于该 team」两件事，无需第二次查询。
```

**为什么是 `actors` 而不是 `team_members`**：`actors` 是 team 域的（`team_id` 是它的列），而 `team_members` 走 `members`→`actors` 两跳。用 `actors` 一跳到位，且拿到的就是计费主体。

#### 6.2.1 token 校验：照抄 FC，不引入新密钥

**网关不需要持有任何签名密钥。** FC 已经有两条成熟路径，按 `BACKEND_KIND`（`services/fc/src/lib/backend-kind.ts`）分叉，网关原样照抄：

| `BACKEND_KIND` | 校验方式 | 依据 |
|---|---|---|
| `supabase`（**self-host 与线上默认**，`docker-compose.yml:274`） | 调 GoTrue `/auth/v1/user`（即 `supabase.auth.getUser(token)`），由 GoTrue 自己校验并返回 user | `services/fc/src/lib/supabase-repo.ts:405` 等十余处、`lib/sync-auth.ts:82` |
| `postgres` | `jose` + JWKS 本地验签（非对称，只需公钥） | `services/fc/src/auth/verify.ts` |

两条路径都**不需要对称密钥**。早期草案里写的「网关持有 `GOTRUE_JWT_SECRET` 做 HS256 验签」是错的 —— FC 从来没这么干过，网关也不该开这个先例。

**代价**：`supabase` 路径下每个请求多一次到 GoTrue 的 HTTP 往返。这在 LLM 请求（2–60 秒）面前是噪声，且是容器网络内调用。仍然要加一层 **按 token 哈希的 60 秒内存缓存**，避免一个 agent 会话里几十次 tool call 反复打 GoTrue；缓存只存 `sub`，不存 token 本身。

**注意**：缓存的是「token → sub」，**不是**「token → 有权访问 teamId」。第 2 步的 actor 查询每次都要真查，否则成员被移出团队后还能继续花钱到缓存过期。

#### 6.2.2 daemon / agent actor 的归属

daemon 用的是它自己的 hosted agent actor（见 `apps/daemon/src/runtime/managed_llm.rs` 的 member-key kick 逻辑、`cloud_api/mod.rs:754-757` 的注释）。它的 `actor_type` 是 `agent` 而不是 `member`。

**决定**：
- **余额**：agent actor 的消耗一样扣团队 balance —— 团队的钱就是团队的钱。
- **quota**：`member_credit_quota` 按 actor_id 建，所以 agent actor 也可以单独设限额，缺省不限。
- 定时任务触发的 agent 不受 quota 拦截（无人值守，卡住就跑不过）—— **`actor_type='agent'` 且无显式 quota 行时，跳过 §4.2 第 3 步**，只受团队余额约束。

### 6.3 对外路由（JWT）

| 方法 | 路径 | 说明 |
|------|------|------|
| `POST` | `/v1/teams/:teamId/chat/completions` | 主路径，支持 `stream: true` |
| `GET` | `/v1/teams/:teamId/models` | public 层 `{ id, name }` |
| `GET` | `/v1/teams/:teamId/credits/balance` | |
| `GET` | `/v1/teams/:teamId/credits/usage` | `range=day\|week\|month\|year`，口径同附录 A |
| `GET` | `/healthz` | 无鉴权，供 compose healthcheck 与 CI 等待 |

baseURL 契约：客户端拿到的 baseURL 是 `<gateway>/v1/teams/<teamId>`，`@ai-sdk/openai-compatible` 自动拼 `/chat/completions` 和 `/models`。

### 6.4 内网路由（FC service token）

`Authorization: Bearer <AI_GATEWAY_SERVICE_TOKEN>`，与 JWT 路径完全分开的中间件。

| 方法 | 路径 |
|------|------|
| `POST` | `/internal/teams/:teamId/credits/top-up`（带 `idempotencyKey`） |
| `GET` | `/internal/teams/:teamId/credits/summary` |
| `PUT` | `/internal/teams/:teamId/members/:actorId/quota` |
| `GET` | `/internal/models` |

**`/internal/models` 是必需的**，别漏：FC 的 `getWorkspaceConfig` 今天用 `LITELLM_MASTER_KEY` 去拉模型目录填 `availableModels`（`services/fc/src/lib/pg-repo/teams.ts:159-186`）。换成网关后 FC 没有终端用户 JWT，只能走内网 token 拿 catalog 的 public 层。

### 6.5 实现栈

**TypeScript / Node 20 + Hono**，独立 npm 包 `services/ai-gateway/`（自带 `package.json` + `package-lock.json` + Dockerfile）。依赖只有五个：`hono`、`@hono/node-server`、`postgres`、`jose`、`yaml`。`catalog.yaml` 只读挂载；转发用原生 `fetch`，零 AI SDK。

#### 为什么不是 Rust

仓库里有成熟的 Rust 服务端能力（amuxd 用 axum），所以这个选择需要理由：

1. **构建发生在生产机上。** `self-host-deploy.yml:261` 是 SSH 上去 `docker compose build fc`，没有 registry、没有预构建镜像。那台机器 4 核、根盘 40G 已用 79%（剩 ~8G）。Node 的 `npm ci` + `tsc` 是 1–2 分钟且 lockfile 不变时整层命中缓存；Rust 的 `COPY . .` 每次改源码都失效，冷编译 5–15 分钟并在只剩 8G 的盘上堆几 GB 中间产物。而这个 workflow 已经因为机器负载撞过 30 分钟 e2e 超时。要用 Rust，得先把部署改成「CI 构建 + 推 registry + 机器上只 pull」—— 那是一次独立的基础设施改动，不该由本模块顺带推动。
2. **要用的东西 FC 里全都有且已在这台机器上跑通**：`hono`/`postgres`/`jose` 已在依赖树里；`amux.actors` / `amux.teams` 的表定义已经写好（`services/fc/src/db/schema/teams.ts`）；token 校验的两条路径已经实现（§6.2.1）。
3. **负载画像是纯 I/O。** 每请求 = 一次身份校验 + 两个短事务 + 一次 2–60 秒的上游 fetch + SSE 转发。Rust 能赢的是常驻内存（~15MB vs ~80MB），在 15G 内存的机器上不构成理由；而唯一的 CPU 热点已被 §4.6 刻意避开（不引 tiktoken）。

#### 为什么不做成 FC 的第二个入口

同一个包、不同 `CMD` 能省一套依赖树，但：网关要持有**全部上游 provider key**，不该背上 FC 的 alicloud SDK / aws-sdk / mqtt 等 20 个依赖；且 FC 每次发布都会重启网关，掐断进行中的 LLM 流。

`services/*` 本来就在 pnpm workspace 之外、各自用 npm 管理（`pnpm-workspace.yaml` 只含 `apps/*` 和 `packages/*`），新增一个独立包是既有模式。

**共享代码的处理**：`auth/verify.ts` 和它需要的几张 drizzle 表定义**复制**过去，文件头注明来源。两个文件的重叠不值得提前抽 workspace 包 —— 但这是已知的漂移点，schema 变更时要记得两边都改。

### 6.6 请求改写

**「透明」是有限度的** —— 转发前后共有四处必做改写，写进文档避免实现时漏：

1. **`body.model`**：public id → 选中路由的 `upstream_model`。
2. **参数白名单**（替代 LiteLLM 的 `drop_params`，见 §1.3）：按 backend 的 `supported_params` 过滤 body 顶层键，未知键丢弃并记 debug 日志。catalog 里每个 provider 可声明一份，缺省用 OpenAI Chat Completions 的标准集。
3. **`stream_options.include_usage = true`**：流式请求必须注入，否则上游不回 usage，只能落到 §4.4 的 `estimated` 分支。同时要判断客户端**原本有没有**要这个字段 —— 没有的话，网关在转发下行 SSE 时要把那个只含 usage 的末尾 chunk **吃掉**，不能让 agent runtime 收到它预期外的帧。
4. **鉴权头替换**：入站 JWT 剥掉，出站换成 provider 的 `api_key`。

**SSE 处理**：下行必须逐 chunk 直通（不 buffer 整个响应），同时旁路解析出末尾的 `usage`。实现上是「一边 pipe 一边 tee 出最后一帧」，不是「收完再转」—— 后者会毁掉 agent 的流式体验。

**上游错误**：4xx/5xx 原样透传给客户端（agent runtime 依赖这些语义），但**不结算 credits**，预留直接置 `expired`。只有 `failover` 策略下才换下一条路由重试。

---

## 7. FC 职责

不 proxy LLM 字节流。负责：

- `workspace-config` 的 `llm` 段（enabled / models / baseUrl / availableModels）
- credits / quota 的读写管理面（转调网关 `/internal/*`）
- 充值下单入口
- 设置页数据聚合

### 7.1 端点变更

**新增**（Phase 2）：

| 方法 | 路径 |
|------|------|
| `GET` | `/v1/teams/:teamId/credits` — 余额 + 本周期用量 |
| `GET` | `/v1/teams/:teamId/credits/usage` — 报表，替代 `/litellm/usage` |
| `POST` | `/v1/teams/:teamId/credits/top-up` — owner only |
| `GET`/`PUT` | `/v1/teams/:teamId/members/:actorId/quota` — owner only |

**新增**（Phase 4，Stripe，见 §4.9）：

| 方法 | 路径 |
|------|------|
| `POST` | `/v1/teams/:teamId/credits/checkout-session` — 建 Stripe Checkout Session，owner only |
| `POST` | `/v1/stripe/webhook` — `{ auth: "none" }` + `postRaw`，由 `stripe-signature` 验签 |

Stripe 路由单独放 `services/fc/src/lib/routes/stripe.ts`（不混进 team-credits：一条是免鉴权入站回调，一条是普通业务端点，鉴权模型不同）。

新增路由文件 `services/fc/src/lib/routes/team-credits.ts`，在 `routes/index.ts` 里 **注册在 `registerWorkspaces` 之前**（和 `registerTeamShare` / `registerTeamSkills` 同理，否则被 workspaces 的宽匹配 `/v1/teams/:teamId/*` 遮蔽 —— 那个文件里已有三处注释在讲这件事）。

设置页对这些端点的具体消费方式见 §12。

**删除**（Phase 3，不是更早）：`routes/team-litellm.ts` 全部 5 条、`lib/litellm.ts`、`lib/litellm-usage.ts`，以及 repository contract 里对应的 `setupLiteLlm` / `ensureMemberKey` / `getLiteLlmUsage` / `listLiteLlmKeys` / `setLiteLlmBudget`。

---

## 8. 契约迁移（openapi）

CLAUDE.md 规定新增业务端点必须**先**写进 `docs/openapi/teamclu-api.v1.yaml`。这一节列出全部契约动作，因为其中有一条是 breaking change。

| 动作 | 位置 | 期 |
|------|------|-----|
| 新增 4 条 `/v1/teams/{teamId}/credits*` + quota | paths | Phase 2 |
| 新增 `GET /v1/teams/{teamId}/credits/ledger`（充值历史，§12.5） | paths | Phase 2 |
| `GET /v1/teams/{teamId}/credits/usage` 加 `groupBy` 参数 | paths | Phase 2 |
| 新增 `POST /v1/teams/{teamId}/credits/checkout-session` | paths | Phase 4 |
| `POST /v1/stripe/webhook` **不进 openapi** —— 它不是客户端契约，是 Stripe→FC 的入站回调，形状由 Stripe 定 | — | Phase 4 |
| 新增 `CreditsSummary` / `CreditUsageReport` / `MemberQuota` schema | components | Phase 2 |
| **`MergedWorkspaceConfig.required` 去掉 `litellmTeamId`** | `:6720` | Phase 2 |
| 删除 `/v1/teams/{teamId}/litellm/{setup,member-key,keys,budget}` | `:2607`/`:2637`/`:2669`/`:2698` | Phase 3 |
| 删除 `LiteLlmSetupResponse` / `LiteLlmMemberKeyResponse` | `:6730`/`:6738` | Phase 3 |
| `POST /v1/teams` 响应里的 `aiGatewayEndpoint` / `litellmKey` | `:141-158` | Phase 3 改为只留 `aiGatewayEndpoint` |

### 8.1 `litellmTeamId` 是 breaking change

`MergedWorkspaceConfig` 目前 `required: [syncMode, litellmTeamId]`。读它的客户端有：

- `packages/app/src/lib/backend/cloud-api/teams.ts`
- `apps/daemon/src/backend/cloud_api/mod.rs:686-740`（`managed_llm_config`）
- iOS `CloudAPIClient` / `CloudAPIRepositories`

**做法：先松后删。** Phase 2 把它从 `required` 挪到可选并保持**继续返回**（值可以是 null）；等所有客户端版本都不再读它之后，Phase 3 才从 response 里去掉。绝不能一步到位 —— 老版本 iOS / 桌面端不会一夜之间升完。

daemon 那侧 `base_url` 的解析优先级 `llm.baseUrl → llm.aiGatewayEndpoint`（`cloud_api/mod.rs:718-721`）保持不变，切换靠改 `llm_base_url` 的**数据**，不靠改代码。见 §11.2。

---

## 9. amuxd 本地代理

路由：`/v1/ai/teams/:teamId/*path` → `<AI_GATEWAY_PUBLIC_URL>/v1/teams/:teamId/*path`。

teamId 放在路径里而不是让 daemon 隐式推断 —— baseURL 本来就是 per-team 写进 `provider.team` 的，显式传递省掉一整类「切团队后打到旧团队账上」的 bug。

### 9.1 `apiKey` 字段填什么

**这不是可选项**：`@ai-sdk/openai-compatible` 一定会发 `Authorization: Bearer <apiKey>`，而 amuxd 的 HTTP 路由是按 handler 挂 scope 鉴权的（`apps/daemon/src/http/routes.rs`）。删掉 `tc_api_key` 之后必须有替代物。

**决定**：新增 daemon scope `ai:invoke`，`provider.team.options.apiKey` 写占位符 `${tc_gateway_token}`，在 spawn 时由现有的 secret 解析链路（`assemble_runtime_env` + `SecretResolveScope::FullConfig`）解析成一个只带 `ai:invoke` 的 daemon 会话令牌。

`crates/teamclu-runtime-env/src/team_provider.rs:118-129` 那段「保住已解析的 key、不要用占位符覆盖」的逻辑**原样保留**，只是把匹配的前缀从 `sk-tc-` 换成新令牌格式。

**受影响的 `sk-tc-` 派生点**（Scope 里必须都列上）：

| 文件 | 内容 |
|------|------|
| `crates/teamclu-runtime-env/src/merge.rs:11` | `format!("sk-tc-{suffix}")` 派生本体 |
| `crates/teamclu-runtime-env/src/team_provider.rs:118` | 跨 reconcile 保住已解析 key |
| `crates/teamclu-runtime-env/src/{env_catalog,personal_secrets,mcp_resolve}.rs` | `tc_api_key` 作为已知 secret 名 |
| `apps/desktop/src/commands/env_vars.rs:251` | **桌面侧另有一份同样的派生逻辑** |
| `packages/app/src/lib/team-provider.ts:11` | 注释里的契约描述 |

### 9.2 绑定地址不一定是 loopback

`apps/daemon/src/http/server.rs:74-96` 明确支持绑 `0.0.0.0` / `[::]`。所以**不能**用「跑在本地所以安全」来省鉴权：公网绑定下 `/v1/ai/*` 就是一个对外的 LLM 中继。`ai:invoke` scope 校验是硬要求，不是加固项。

### 9.3 三个全局中间件会挡路

`routes.rs:272-274` 上挂了全局的 body cap 和限流。默认值（`apps/daemon/src/config/daemon_config.rs`）对 LLM 流量都太紧：

| 限制 | 默认值 | 为什么会撞 |
|------|--------|-----------|
| `max_body_bytes` | **1 MiB** | `provider.team` 声明的 context limit 是 256k token（`team_provider.rs`），对应的 JSON 请求体轻松超过 1 MiB。**这条会直接 413。** |
| `rate_limit_rps` / `burst` | 20 / 60 | agent 的并行 tool call 会突刺 |
| `max_sse_per_token` | **8** | 每个流式补全占一条 SSE；8 条并发很容易打满 |

**要求**：`/v1/ai/*` 走独立配置 —— 新增 `http.ai_max_body_bytes`（默认 32 MiB）、独立的限流桶（或直接豁免），且 AI 流不计入 `max_sse_per_token`。这三条在 Phase 1 的实现清单里。

### 9.4 SSE 直通

daemon 侧同样必须逐 chunk 转发、不 buffer。已有的 `/v1/sessions/:id/stream` 是 daemon **自己产**的 SSE，这里是**转发上游**的 SSE，是新场景，要单独测（首字节延迟、断连传播、客户端取消能否传到上游）。

---

## 10. 部署

### 10.1 环境变量：命名与两个部署目标

已经存在一个 `AI_GATEWAY_ENDPOINT`（`services/fc/src/lib/team-provisioning.ts:15`），语义是**对外的、给客户端的、带 `/v1` 的** URL。再引入一个含义相反的 `AI_GATEWAY_URL`（FC→网关内网）几乎必然被搞混，所以：

| 变量 | 含义 | self-host 值 |
|------|------|-------------|
| `AI_GATEWAY_ENDPOINT` | **沿用原义**：对外、给客户端。指向新网关 | `https://api.<domain>/ai/v1` |
| `AI_GATEWAY_INTERNAL_URL` | FC → 网关，容器网络内 | `http://ai-gateway:4001` |
| `AI_GATEWAY_SERVICE_TOKEN` | FC ↔ 网关 `/internal/*` 鉴权 | 由 `bootstrap/gen-secrets.sh` 生成 |

**⚠️ 三个都必须同时声明在 `services/fc/s.yaml` 和 `deploy/self-host/docker-compose.yml` 的 `fc:` `environment:` 映射里。** compose 的 environment 是显式白名单，漏一个就在那个目标上静默丢失；而且 `services/fc/test/deploy-env-parity.test.ts` 和 `scripts/lib/env-manifest.test.js` 会红。

**Phase 4 追加（Stripe，见 §4.9）**：`STRIPE_SECRET_KEY`、`STRIPE_WEBHOOK_SECRET`、`STRIPE_PRICE_IDS`（允许的 Price 白名单）。同样是**两个目标都要声明**。

⚠️ 两个部署目标用的是**独立数据库**，所以要么两个 Stripe 账号，要么一个账号配两个 webhook endpoint —— 一笔支付绝不能记到另一套环境的团队头上。团队不存在时网关返回 404，FC 必须把它当失败告警，不能吞掉。

网关自己的 env：`DATABASE_URL`（`ai_gateway` role）、`AI_GATEWAY_SERVICE_TOKEN`、`BACKEND_KIND` + 对应的 token 校验配置（`supabase` 路径用 `SUPABASE_URL` / anon key，与 FC 同源，见 §6.2.1）、各 provider key（`DEEPSEEK_API_KEY` 等，从 litellm 服务移过来）。**没有签名密钥。** 同样要在 `.env.example` 里补文档。

### 10.2 compose

**Phase 0 只增不删**：加 `ai-gateway` 服务（build context `../../services/fc` 同级的 `../../services/ai-gateway`），healthcheck 打 `/healthz`，`depends_on: db healthy`。`litellm` / `litellm-init` 原样保留。

**Phase 3 才删**：`litellm`、`litellm-init` 两个服务，以及 `fc:` 环境里的 `LITELLM_URL` / `LITELLM_MASTER_KEY` / `LITELLM_DEFAULT_TEAM_MAX_BUDGET_USD` / `LITELLM_DB_NAME`。`_litellm` 数据库**保留到 Phase 3 之后至少一个月**再手工 drop —— 里面是历史用量数据，见 §11.4。

`docker-compose.podman.yml` 有同样的服务定义，两份都要改。

### 10.3 Caddy

`deploy/self-host/caddy/Caddyfile` 今天有三段 litellm 反代：`/litellm-asset-prefix/*`、`/ui/*`、`/llm/*`（:37-45）。

- **Phase 0**：新增 `handle_path /ai/* { reverse_proxy ai-gateway:4001 }`。三段旧的保留。
- **Phase 3**：删掉那三段。注意 `/ui/*` 挂的是 LiteLLM 的 admin UI，删掉即失去后台 —— 新网关**没有 admin UI**（catalog 是文件、余额管理在 TeamClu 设置页里），这是有意的，要在 Phase 3 的 checklist 里跟运营确认。

### 10.4 CI（`.github/workflows/self-host-deploy.yml`）

删 litellm 会连带炸部署流水线，逐条列出：

| 行 | 内容 | 动作 |
|----|------|------|
| :213 | `upsert_env LITELLM_URL "http://litellm:4000"` | Phase 0 旁边加三条 `upsert_env AI_GATEWAY_*`；Phase 3 删这条 |
| :263-276 | 拉 litellm 镜像（5 次重试） | Phase 3 删；`ai-gateway` 是本地 build，不需要对应逻辑 |
| :308-310 | `until docker compose ps litellm \| grep -q healthy` | Phase 0 旁边加 `ai-gateway` 的同款等待；Phase 3 删 litellm 那条 |
| :321-322 | `sh .../smoke/litellm-smoke.sh` | Phase 0 新增 `smoke/ai-gateway-smoke.sh` 并列跑；Phase 3 删旧的 |

新的 `deploy/self-host/smoke/ai-gateway-smoke.sh` 至少覆盖：`/healthz`、无 JWT → 401、错误 teamId 的 JWT → 403、`GET /models` 返回非空、一次非流式 `chat/completions` 打通并落一行 `ai_usage_logs`。

`tests/e2e/smoke-team-share-onboarding.test.ts` 也引用了 litellm 流程，Phase 3 一起改。

---

## 11. 分期实施

**核心原则：新旧并存，客户端灰度切完再删旧的。** 原方案里 Phase 0 就「compose 替换 litellm」而 Phase 1 才切客户端 —— 那会在 Phase 0 上线的瞬间打挂全部已安装桌面端（它们的 `provider.team.baseURL` 指向 LiteLLM），并且要等到 Phase 1 才恢复。

| Phase | 内容 | 完成判据（gate） |
|-------|------|-----------------|
| **0** | 网关 MVP：JWT + 成员校验 + catalog 路由 + SSE 直通 + `ai_usage_logs`（**只记账不扣费**）。compose/Caddy/CI **只增不删**。migration 建 5 张表 + 改 pgTAP 断言。 | smoke 全绿；LiteLLM 路径完全未受影响 |
| **1** | amuxd `/v1/ai/teams/:teamId/*` 代理（含 §9.3 的三项限制放宽）+ `${tc_gateway_token}`；桌面端/crate 侧 `sk-tc-` 清理。**按团队灰度**改 `llm_base_url`。 | 灰度团队正常出字；`ai_usage_logs` 有数据且 token 数与上游对得上 |
| **2** | Credits 闭环：预留 + 结算 + quota 强制；FC credits 端点；设置页；openapi 的 `litellmTeamId` 松绑；保留策略 + 对账任务。**打开强制之前先给存量团队补发起始额度（§4.8.1）。** 设置页：新建账单页 + 现有 Token 用量页迁移数据源（§12）。 | 存量团队补发完成且余额行齐全；并发压测不超发；对账连续 7 天零差异 |
| **3** | 全部团队切完 + **两个部署目标都切完** + 观察期 ≥ 2 周后：删 LiteLLM 容器 / FC 代码 / openapi 条目 / Caddy 三段 / CI 四处 / smoke。 | 见 §11.5 |
| **4** | **Stripe 充值**（§4.9）：FC 的 checkout-session + webhook 路由、Price metadata 换算表、`stripe.checkout.sessions.list` 补账任务、桌面端走系统浏览器。**不动任何表结构** —— 幂等键从 Phase 2 起就在表里，余额表也从 Phase 0 起就没有非负约束（§4.9.5）。 | 跨境 webhook 投递实测通过；断开 webhook 后补账任务能独立把额度发对；重复投递同一 Session 不重复入账；退款能把余额打成负数而不报错 |

### 11.1 Phase 1 的灰度开关

切换不需要新开关：daemon 读的是 `team_workspace_config.llm_base_url`（`cloud_api/mod.rs:718`），**按团队 UPDATE 这一列就是天然的灰度粒度**。回滚同样是一条 UPDATE。

⚠️ **客户端写死之后这条杠杆依然成立，但读它的人变了**：客户端的 baseURL 恒指向本地 amuxd（附录 B），由 **amuxd** 读 `llm_base_url` 决定把请求转发到新网关还是老 LiteLLM。灰度粒度、回滚方式都不变，只是解析点后移了一跳。这也是为什么 P1 的 amuxd 代理必须支持转发到**两种**上游，而不只是新网关。

### 11.2 数据迁移：`llm_base_url`

这是切换的真正动作，不是代码发布：

```sql
-- 灰度：单个团队
UPDATE amux.team_workspace_config
   SET llm_base_url = 'https://api.<domain>/ai/v1/teams/' || team_id::text
 WHERE team_id = '<uuid>';

-- 全量（Phase 1 末尾）
UPDATE amux.team_workspace_config
   SET llm_base_url = 'https://api.<domain>/ai/v1/teams/' || team_id::text
 WHERE llm_base_url IS NULL OR llm_base_url LIKE '%/llm/v1%';
```

同时 `AI_GATEWAY_ENDPOINT` 改指向新网关，这样**没有显式 `llm_base_url` 的团队**（走 fallback 分支）也自动切过去。

### 11.3 残留 `sk-tc-*` 的清洗

`team_provider.rs:118-129` 是**刻意**保住已解析 key 不被占位符覆盖的。这意味着切到 JWT 之后，老 key 会一直赖在设备的 `opencode.json` 里，`ensure_global_team_provider` 不会自己清掉它。

**要求**：Phase 1 的 reconcile 逻辑里加一条一次性清洗 —— 若 `options.apiKey` 匹配 `^sk-tc-`，视同「未解析」，用新占位符覆盖。没有这一步，老设备升级后会拿着一个作废的 key 打新网关，表现为持续 401，而且用户没有任何自愈手段。

### 11.4 历史用量数据

`/litellm/usage` 今天直连 `_litellm` 库聚合 `LiteLLM_SpendLogs`（`litellm-usage.ts`）。新的 `ai_usage_logs` 从 Phase 0 起才有数据。

**决定：不迁移历史数据。** 理由：口径不同（LiteLLM 记的是 USD spend，新表记的是 credits，两者没有确定的换算 —— credits 定价是 Phase 2 才定的），强行换算会造出假的历史账。

**做法**：Phase 2 的设置页在用量图表上标一条「统计起始日」分界；`_litellm` 库在 Phase 3 后保留至少一个月供人工查旧账，之后手工 drop。这条必须提前跟运营讲，别让人以为数据丢了。

### 11.5 Phase 3 的 gate

删任何东西之前，全部满足：

- [ ] 两个部署目标（self-host + `s.yaml` 那套）都已完成 Phase 1 全量切换
- [ ] 所有团队的 `llm_base_url` 都已指向新网关（`SELECT count(*) ... WHERE llm_base_url LIKE '%/llm/%'` 为 0）
- [ ] 观察期 ≥ 2 周，`ai_usage_logs` 有持续流量，LiteLLM 侧流量归零（查 `LiteLLM_SpendLogs` 最近 14 天无新行）
- [ ] 最低支持的桌面端 / iOS 版本已不读 `litellmTeamId`
- [ ] 运营已确认不再需要 LiteLLM admin UI（§10.3）

---

## 12. 设置页：账单与用量

### 12.1 两个页面，一份数据

| 页面 | 内容 | 状态 |
|---|---|---|
| **账单**（新增） | 余额、充值入口、积分↔token 换算、充值历史、本周期汇总 | Phase 2 新建 |
| **Token 用量**（现有） | 周期切换、总量三卡、成员排行榜、按档分组 | Phase 2 **迁移数据源** |

两页读同一批数据（`ai_usage_logs` + `credit_ledger`），周期口径统一走附录 A 的 CST 换算 —— 报表和 quota 用同一套，不要各写一份。

分工：**账单页给「还剩多少、怎么充」，用量页给「花在哪了」。** 账单页只放本周期汇总，明细留在用量页，避免两页各写一份聚合逻辑。

### 12.2 账单页布局

对照 Cursor 的 Billing & Invoices（产品参考）：

| Cursor | 本设计 | 说明 |
|---|---|---|
| Plan 卡（Pro / Annual / $16 per mo.） | **余额卡** | 我们不是订阅制，顶部卡片是钱包余额而非套餐 |
| Payment（Manage in Stripe） | **充值卡** | Phase 2 只有管理员手工充值；Phase 4 接 Stripe（§4.9） |
| Included Usage（按模型的 token + 占比） | **本周期用量** | 按三档 tier 分组，不暴露 upstream 名（§4.3） |
| —— | **充值历史** | Cursor 没有；我们是预付费钱包，必须有 |

余额卡要素：当前余额（积分）、本周期已消耗、低水位警示（§4.2 的硬停策略决定了这个提示必须显眼）、充值按钮。

### 12.3 「1 积分 = 多少 token」不是一个数

积分到 token 的换算**取决于用哪一档、以及输入还是输出**——不存在单一比值。UI 上写「1 积分 = N tokens」就是在撒谎。

好消息是自主定价（§4.4）让这张表变成**精确值而非估算**：三档各一个固定单价，落到哪个上游都不改变金额。按档的小表，输入/输出分列：

| 档位 | 1 积分 = 输入 token | 1 积分 = 输出 token |
|---|---|---|
| 标准 default | 10,000 | 2,500 |
| 高级 pro | 2,500 | 625 |
| 旗舰 max | 500 | 125 |

（按 `catalog.example.yaml` 的**占位价**算出来的示意；1 积分 = 10,000 credits。真实数字待定价决策，见附录 F。）

两条硬要求：

1. **数据来自 `GET /models` 的 `pricing` 字段**（§12.5），**不要在客户端硬编码价格** —— 那会在调价当天变成错误信息。
2. 不需要标注「估算」，但要说明**调价会影响后续消费、不追溯已发生的用量**。

### 12.4 现有 Token 用量页的迁移

现在这页读 `/v1/teams/:id/litellm/usage`，后者直连 `_litellm` 库聚合 `LiteLLM_SpendLogs`（`services/fc/src/lib/litellm-usage.ts`）。迁到 `ai_usage_logs` 后：

| 现状 | 迁移后 | 注意 |
|---|---|---|
| 总费用 `$0`（USD） | **消耗积分** | **语义变了，不是换个数字**——USD spend 与 credits 无确定换算（§11.4） |
| 总 Token 数 | `SUM(input_tokens + output_tokens)` | 建议拆成输入/输出两个数，上游计费本来就分开 |
| 请求数 | `COUNT(*)` | 直接对应 |
| 成员排行榜 | `GROUP BY actor_id` | §5.2 的 `ai_usage_logs_team_actor_created_idx` 正是为它建的 |
| 按模型分组 | `GROUP BY public_model_id` | **用 public 层**，不要暴露 `backend_model_id`（§4.3） |
| `maxBudget`（USD 封顶） | 删除 | 概念不存在了，换成余额（§4.1） |
| 错误码 `litellm_usage_unavailable` / `litellm_unavailable` | 退役 | `TokenUsageSection.tsx:64` 在判这两个码，要一起改 |

⚠️ **统计起始日断层**：`ai_usage_logs` 从 Phase 0 才开始有数据，历史用量不迁移（§11.4）。所以「当年」视图必然出现一条断层。要求：**周期早于起始日时显示说明文案，而不是显示 0** ——显示 0 会被读成「那段时间没人用」，是错误信息。

现有的 `summary` / `members` / `byModel` 三段响应结构可以原样保留，只换数据源和字段语义，前端改动面因此可控。

### 12.5 端点

在 §7.1 的基础上补两项：

| 方法 | 路径 | 用途 |
|------|------|------|
| `GET` | `/v1/teams/:teamId/credits/ledger` | 充值历史。**只返回 `kind IN (top_up, grant, adjustment, refund)`**，排除 `usage` 行（那是每请求一行，量级完全不同） |
| `GET` | `/v1/teams/:teamId/credits/usage` | 加 `groupBy=actor\|model` 参数，供排行榜与分档表复用同一端点 |

`GET /v1/teams/:teamId/models`（网关）响应加 `pricing: { inputPer1mCredits, outputPer1mCredits }`，直接来自该档的 `public_models.*.pricing`。仍然**不暴露 upstream 名**。

### 12.6 权限

| 内容 | 可见范围 | 理由 |
|---|---|---|
| 余额、低水位警示 | **全体成员** | 余额耗尽是硬停（§4.2），成员必须能自己看到为什么用不了 |
| 用量、成员排行榜 | 全体成员 | 现状即如此，不收紧 |
| 充值历史、充值按钮 | **仅 owner** | 涉及金额与支付 |

### 12.7 实现注意

- ⚠️ **设置页是模态 dialog，任何 Popover / Dropdown 必须显式传 `container`**，否则默认 portal 到 `body` 会永远打不开，而触发器看起来完全正常（判据：`body` 上有 `pointer-events: none`）。充值确认框、周期选择器都要注意。
- 新组件放 `packages/app/src/components/settings/BillingSection.tsx`，在 `section-registry.tsx` 注册（现有 `tokenUsage` / `leaderboard` 就在那里）。
- i18n：新 key 加进 `packages/app/src/locales/{en,zh-CN}.json` 两份，注意仓库有 i18n-parity 死键守卫。

---

## 13. 决策记录

| 决策 | 理由 |
|------|------|
| 独立 `ai-gateway` | 流式、Credits、限额与 FC 解耦；FC 的另一个部署目标是事件函数，不适合承载长连接流式 |
| 只做 OpenAI 兼容转发，零翻译层 | 今天全部上游已是 OpenAI 兼容（§1.2）。接原生协议上游是一次独立决策 |
| Credits + balance + quota | 充值余额；成员周期限额；替代 LiteLLM 的 USD budget |
| public / backend 双层 catalog | 对外包装名；1:n 路由；定价按实际上游 |
| 首版 catalog 必须是现有 public id 的超集 | 团队 `llm_models` 已存旧 id，换目录会让选中模型失效（§4.3.1） |
| JWT，无 user API key | 与登录态统一；离职即失效 |
| `(team_id, user_id)` 一次查询完成 actor 解析 + 成员校验 | `actors` 是 team 域表且有该唯一索引；避免路径 `:teamId` 被伪造 |
| 新表放主库 `amux` schema | 网关和 FC 都要 join `actors`/`teams`；LiteLLM 用独立库的理由（20 张 prisma 表）不适用 |
| 物化 balance + 只增 ledger + 对账任务 | 预留需要行锁，聚合做不到；代价是必须有对账 |
| 预留机制而非「查余额>0」 | agent 并发是常态，后者必然超发（§4.6） |
| Phase 0/1 只记账不扣费 | 先验证转发与计量正确，再上强制；这两期上限仍在上游 provider key |
| daemon 本地代理 | JWT 刷新；用户不填 key |
| 新旧并存 + 按 `llm_base_url` 灰度 | 不需要新开关，回滚是一条 UPDATE |
| 不迁移历史用量 | USD spend 与 credits 无确定换算，强转会造假账（§11.4） |
| 客户端 provider 写死为 default/pro/max 三档 | tier 是稳定名字，tier→backend 的映射在服务端；改后端/调价/换供应商都不需发客户端（§4.3.1） |
| 上游解析后移到 amuxd | 客户端写死的同时保留 §11.2 的一条 UPDATE 灰度与回滚（附录 B） |
| 未知 model id 一律 403，不静默回落 default | 静默回落会让发错 id 的客户端长期拿到错档位且无征兆（§4.3.2） |
| 账单与用量分两页，共用一批端点 | 账单答「还剩多少、怎么充」，用量答「花在哪了」；避免两处聚合逻辑（§12.1） |
| 积分↔token 按档分列展示，不给单一比值 | credits 锚成本，换算随档位与输入/输出而变，单一比值是错误信息（§12.3） |
| 换算价格由 `GET /models` 下发，不在客户端硬编码 | 调价当天硬编码就变成错误信息（§12.3） |
| 积分↔token 是精确值不是估算 | 自主定价后三档单价固定，落到哪个上游都不改金额（§4.4） |
| 周期早于统计起始日时显示说明而非 0 | 显示 0 会被读成「那段时间没人用」（§12.4） |
| credit 单位要细到一次请求 ≥ 数千 credits | 单位取粗会让 `ceil` 对小请求系统性高估；agent 全是小请求（§4.4.1） |
| 余额耗尽硬停 402，不降级不透支 | 静默降级让 agent 继续产出低质量结果且无人察觉，定时任务尤其危险；负余额需要整套追缴逻辑（§4.2） |
| 建团队一次性 grant 10 元额度，不按人头 | 去掉 onboarding 门槛同时封住上限；按人头可靠拉人无限刷（§4.8） |
| 不做 BI 只读副本 | 两个索引够用；下一步是月度 rollup 而非副本（§5.3） |
| **自主定价，挂在 default/pro/max 三档上** | 一举消掉峰谷价、缓存分段、混合路由单价不定、FX 四层复杂度（§4.4.0） |
| 计费简单、记录详细 | `cached_input_tokens` 与 `backend_model_id` 只进日志不进账单，供毛利分析（§4.4.0） |
| `usage_mode` 按 provider 声明 | DeepSeek 无条件回 usage，OpenAI 需 include_usage 且发独立帧（§4.4.0 ③） |
| `period` 提到团队级 | 成员各用各的周期会让「本周期已用」不可比（§4.5） |
| Stripe 放 FC，网关仍是账本唯一写入者 | 支付是业务面；单写者让 webhook 在 FC 内不需要任何新权限（§4.9.1） |
| 幂等键用 Checkout Session id 而非 event id | 同一 Session 的两个事件有不同 evt_ id，按 event 键会重复入账（§4.9.4） |
| credits 换算表放 Stripe Price metadata | 额度锚死在下单那一刻的商品上；加价集中一处；币种变得无关（§4.9.3） |
| 去掉余额非负 CHECK，改用负余额告警 | 退款可合法致负；花钱闸门本就在预留逻辑里（§4.9.5） |
| token 校验照抄 FC，网关不持签名密钥 | `supabase` 路径调 GoTrue `/auth/v1/user`、`postgres` 路径用 JWKS 公钥；两条都无对称密钥（§6.2.1） |
| TypeScript / Node 20 + Hono | 部署是在生产机上 `docker compose build`，Rust 冷编译撞 4 核 / 剩 8G 盘；依赖与 token 校验代码 FC 已备齐；负载纯 I/O（§6.5） |
| 独立 npm 包而非 FC 第二入口 | 网关持有全部 provider key，不该背 FC 的 20 个依赖；FC 发布不应掐断进行中的 LLM 流（§6.5） |

---

## 附录 A：quota 周期（CST）

`week` = 周一 00:00 CST；`month` = 当月 1 日 00:00 CST。

与今天 `services/fc/src/lib/litellm-usage.ts:21` 的口径一致（固定 UTC+8，不处理 DST），报表和 quota 用同一套换算，不要各写一份。

## 附录 B：客户端 baseURL 与「写死」的边界

| 客户端 | baseURL |
|--------|---------|
| Desktop（Phase 1 后） | `http://127.0.0.1:{amuxd_port}/v1/ai/teams/{teamId}` |
| iOS（远期） | 直连 `https://api.<domain>/ai/v1/teams/{teamId}` + JWT |

**写死的是什么、不是什么**（§4.3.1）：

| 项 | 来源 |
|---|---|
| provider 形状、三档 model id | **客户端写死** |
| baseURL | 运行时拼：本地 amuxd 端口 + teamId |
| `llm_enabled` | 云端 `workspace-config.llm.enabled` |
| **上游到底打新网关还是老 LiteLLM** | **云端 `llm_base_url`，由 amuxd 解析**（见 §11.2） |

最后一行是关键：解析上游的职责从客户端**往后移了一跳**到 amuxd。客户端写死的同时，§11.2 那个「一条 UPDATE 灰度、一条 UPDATE 回滚」的杠杆完整保留 —— 只是现在读 `llm_base_url` 的是 daemon 而不是客户端。daemon 侧优先级不变：`llm.baseUrl` → `llm.aiGatewayEndpoint`（`apps/daemon/src/backend/cloud_api/mod.rs:718-721`）。

## 附录 C：LiteLLM 对照

| LiteLLM | 本设计 |
|---------|--------|
| virtual key `sk-tc-*` | Supabase JWT（对网关）+ daemon `ai:invoke` 令牌（对本地代理） |
| `max_budget`（USD） | `team_credit_balance` + `member_credit_quota`（credits） |
| `model_name` | `public_models.id` |
| `litellm_params.model` | `backend_models.upstream_model` |
| `drop_params: true` | catalog 的 `supported_params` 白名单（§6.6） |
| `LiteLLM_SpendLogs` | `amux.ai_usage_logs` |
| admin UI `/ui` | 无（catalog 是文件；余额在设置页） |
| `_litellm` 独立库 | 主库 `amux` schema |

## 附录 D：单次请求解析流程

```
入站 JWT
  → 校验 token（GoTrue /auth/v1/user 或 JWKS，60s 缓存）→ sub
  → (teamId, sub) → amux.actors → actor_id       [403 not_a_team_member]
  → llm_enabled + model ∈ 团队白名单               [403 model_not_allowed]
  → estimate() → 预留 (FOR UPDATE + held 行)       [402 insufficient/quota]
  → body.model 改写 + 参数白名单 + include_usage 注入
  → 上游 POST
  → SSE 直通（旁路 tee 出末帧 usage）
  → settle: 扣 balance + 写 ledger + 写 ai_usage_logs + 预留置 settled
  （上游报错：原样透传，不结算，预留置 expired）
```

## 附录 E：pricing 就在 public model 上

三档 tier 是我们**自主定价**的单位。`max` 落到哪个 backend 不改变用户付多少 —— 那是成本波动，由毛利吸收。调价只改 `public_models.*.pricing` 一处；`backend_models` 只描述「怎么打到上游」，其 `cost` 字段可选且不参与扣费（§4.4.0）。

## 附录 F：已拍板与仍未决

### 已拍板（2026-08-28）

| 问题 | 结论 | 位置 |
|------|------|------|
| 定价是否锚定上游成本 | **否，自主定价**，挂三档 tier | §4.4 |
| UI 量纲 | 积分 = credits / 10,000；单价须满足 §4.4.1 的 ceil 约束 | §4.4.1 |
| 默认赠送额度 | 建团队一次性 grant 10 元额度（10,000,000 credits），不按人头 | §4.8 |
| 余额耗尽的行为 | 402 硬停；不降级、不透支；靠低水位告警兜 | §4.2 |
| 支付渠道 | **Stripe**（Phase 4）。幂等键让 Phase 0–3 完全不受影响 | §4.9 |
| BI 只读副本 | 不做；下一步是月度 rollup | §5.3 |

### 仍未决（不阻塞 Phase 0）

0. **三档的实际定价数值** —— 机制已定（`public_models.*.pricing`，§4.4），填多少是产品决策。唯一的工程约束见 §4.4.1。Phase 0/1 不扣费，真正需要它的时间点是 Phase 2。
1. **低水位告警的阈值与通道** —— 余额硬停既然是设计选择，告警就是它的配套。阈值（剩余额度 or 预计可用天数）和通道（设置页 / 企微 / 邮件）留到 Phase 2 做设置页时一并定。
2. **成员 quota 的默认值** —— 结构上已落位（`team_credit_settings.default_limit_credits`，见 §5.2），设成多少等有真实用量分布后再定，**改的是数据不是结构**，不阻塞任何一期。
