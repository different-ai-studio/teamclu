# 图片生成 skill：经 Team AI Gateway 调 OpenAI 并计费

配套阅读：`docs/specs/2026-08-28-team-ai-gateway-design.md`（下称「网关设计」，本文的 §x.y 引用都指它）。

一句话：**链路已经通了四分之三，缺的是网关上的一个 `images/generations` 端点、一套「按张」的计价，和一个不会把 base64 吐回对话的 skill。**

---

## 1. 现状：这条链路今天走到哪儿断

agent 里的一段脚本要调到 OpenAI，要穿过三跳。逐跳核对结果：

| 跳 | 代码 | 状态 |
|---|---|---|
| skill 脚本 → daemon | `apps/daemon/src/http/ai.rs`：`ANY /v1/ai/teams/{team_id}/{*path}`，**任意 path 透传**，双向流式，剥掉调用方 Authorization 换成设备云令牌 | ✅ 不用改 |
| daemon → 团队网关 | `resolve_upstream()` 取团队的 `workspace-config.llm.baseUrl`；没配过的团队由 FC 兜底成本部署自己的网关（`services/fc/src/lib/team-llm-defaults.ts`） | ✅ 不用改 |
| 网关 → OpenAI | `services/ai-gateway/src/app.ts` **只有 `POST /v1/teams/:teamId/chat/completions`** | ❌ 打 `images/generations` 是 404 |

也就是说 daemon 那一跳是个通用反向代理，网关上新增一个路由，客户端侧**零改动**就能打到。这是本方案成立的前提。

凭证与计费同样是现成的：

- `authed()` 一次调用同时完成「你是谁」和「你能不能花这个团队的钱」（`resolveActor`，§6.2）。
- `reserve` / `settle` / `release` / `recordUsage` 的签名**与模型无关**，只吃一个 `credits` 数字。图片可以整套复用，不需要第二套账。

---

## 2. 设计决策

### 2.1 图片按「张」计费，不按 token

网关现有的 `computeCredits()` 是 `input×单价 + output×单价`。图片不该走它，理由三条：

1. **上游给不齐 token。** OpenAI 的图片模型里，新的会返回 `usage`、`dall-e-3` 什么都不返回，而经中继之后更不确定。按 token 计价意味着换个上游模型就要退化成 `estimated` 兜底扣费 —— 而 `estimated` 这个值在现有报表里是「上游出毛病了」的告警口径，被图片污染之后就废了。
2. **按张是确定性的。** 预留额 = 结算额，一分不差。不需要估算输入字节、不需要按 `max_tokens` 上限保守预留，§4.6 里那套「宁可高估」的复杂度在图片这条路上直接消失。
3. **和 §4.4「自主定价」是同一个立场。** 我们卖的是「一张图」，上游是 gpt-image-2 还是别的、峰谷价差多少、缓存命中多少，都是毛利波动，不是用户看到的价格波动。

**单价挂在 `(size, quality)` 上**，因为这是唯一会让上游成本差一个数量级的维度（1024² low 与 1536×1024 high 之间约 15 倍）。

**上游返回的 token 仍然照记。** 和 `cached_input_tokens` 完全同一个思路（§4.4.0）：**计费简单，记录详细**。哪天 gpt-image-2 涨价或者我们把 `image` 档重新指到别的后端，只有这两列能提前告诉我们毛利在掉。

#### 单价怎么定（量纲，不是最终定价）

绝对数值是产品定价决策（网关设计 附录 F 还挂着）。但可以先把**比例**定死，让工程侧不必等它：

| 参照 | credits | 积分（`credits / 10000`） |
|---|---|---|
| 一次典型 agent 请求（5,000 input token，`default` 档） | 5,000 | 0.5 |
| 一张 1024² 中等质量图（占位） | 300,000 | 30 |

即 **一张图 ≈ 60 次典型对话请求**。这个比例经得起推敲：gpt-image-2 中等质量单张的上游成本量级本来就在几分钱人民币，而一次 5k token 的 flash 请求是零点几分。

工程侧对定价的**唯一硬约束**：`per_image_credits` 必须是正整数。§4.4.1 那条「`ceil` 会吃掉小请求」的约束在这里天然满足 —— 按张计价是一次整数乘法，没有除法，没有 `ceil`。

> ⚠️ 上游价目（1024² low/medium/high ≈ $0.011 / $0.042 / $0.167，长边 1536 更贵）是**记忆中的量级，不是核实值**。定价前用真实 key 拉一次官方价目表复核，并按网关设计的规矩在 catalog 注释里写上核对日期。

### 2.2 catalog 里单开 `image_models:`，不要塞进 `public_models`

`public_models` 不只是一张配置表，它是**对外契约**：

- `GET /v1/teams/:id/models` 直接把它喂给客户端；
- `parseCatalog()` 强制 `default` / `pro` / `max` 三档必须存在（`REQUIRED_TIERS`），因为桌面端把这三个 id 写死了；
- 它的 `pricing` 形状是 per-1M-token。

把 `image` 塞进去会同时踩三个坑：桌面端的模型选择器里多出一个选了就报错的「模型」、`pricing` 字段语义分裂、`llm.models` 列表被污染。所以新开一节：

```yaml
# catalog.yaml —— 与 public_models 平级
image_models:
  # 对外只有一个稳定名。换上游、换供应商、加 failover 都在这儿改，
  # 客户端和 skill 都不动。
  image:
    name: 图片
    routing: priority
    pricing:
      # 键：<size>:<quality> → <size> → default，三级回退。
      # ⚠️ 写纯数字：YAML 1.2 把 300_000 读成字符串。
      per_image_credits:
        default: 300000
        "1024x1024:low": 100000
        "1024x1024:medium": 300000
        "1024x1024:high": 1200000
        "1536x1024:high": 1800000
        "1024x1536:high": 1800000
    routes:
      - backend: mx5-gpt-image-2

backend_models:
  mx5-gpt-image-2:
    provider: mx5              # 已在跑、已验证、不需要代理（§2.5）
    upstream_model: gpt-image-2
```

`providers` / `backend_models` / `routes` / `routing` 的语义**原样复用**，`pickRoute()` 也原样复用（它只认 `routes` + `routing`，把 map 传进去即可）。失败切换、加权、优先级全都白拿。

**启动校验要加三条**（`parseCatalog`，与现有风格一致：宁可开不起来，不要半可用）：

1. `image_models.*.routes[].backend` 必须存在于 `backend_models`；
2. `per_image_credits.default` 必须有，且所有值为正整数 —— **没有兜底价就等于免费送图**；
3. `image_models` 允许为空（本部署不开图片功能），但一旦非空，其 provider 的 key 必须在 env 里 —— 沿用现有 provider 校验即可。

**注意：打开 `openai` provider 意味着 `OPENAI_API_KEY` 必填。** catalog 现在把 openai 整段注释着，注释里已经写了原因：启动校验要求每个列出的 provider 都有 key，第一次把它带上生产时网关直接起不来。compose 的 `ai-gateway` 服务里 `OPENAI_API_KEY` 已经声明了，但值是空的。

（`services/fc/test/deploy-env-parity.test.ts` 只比对 **fc** 服务的 env 块，`ai-gateway` 不在它管辖范围内 —— 所以这条不会撞 parity 测试，也不需要动 `s.yaml`。）

### 2.3 端点：`POST /v1/teams/:teamId/images/generations`

对外保持 OpenAI 兼容，这样 skill 就是一个普通的 OpenAI 客户端，将来换成别的调用方也不用改。

```
POST /v1/teams/{teamId}/images/generations
{ "model": "image", "prompt": "...", "n": 1,
  "size": "1024x1024", "quality": "medium", "output_format": "png" }
```

处理顺序，与 chat 那条路径逐段对齐：

```
authed()                              ← 原样复用，一次查询同时证明身份和成员资格
model 查 image_models                  ← 未知 id → 403 model_not_allowed（绝不回退到默认档）
unit = 查 per_image_credits(size, quality)
  查不到 → 400 unpriced_image_variant  ← 见下，这条是新的
n = clamp(body.n ?? 1, 1, MAX_N)
hold = n × unit → reserve()           ← 原样复用
转发 → {api_base}/images/generations
  !ok  → release() + 原样透传上游错误   ← 与 chat 完全一致
  ok   → actual = 实际返回张数 × unit
         recordUsage(usage_source='fixed', image_count=张数)
         settle()
         原样透传上游 JSON
```

四个与 chat 不同的点，每个都有理由：

**① 参数白名单必须另起一份。** `filterBody()` 用的 `default_supported_params` 里**没有 `prompt`**，直接复用会把提示词整个丢掉，然后向上游发一个空请求。新增 `default_image_params`：

```yaml
default_image_params:
  - model
  - prompt
  - n
  - size
  - quality
  - background
  - output_format
  - output_compression
  - moderation
  - user
```

**② 未定价的组合返回 400，不是「按 default 收」。** 这是刻意的：`per_image_credits.default` 是给「catalog 没穷举到的合法组合」兜底的，而一个我们没定过价的 `size` 多半是新上游刚放出来的贵档位。宁可拒绝，也不要用最低价放行一张我们不知道成本的图。（同样的立场在网关代码里已有先例：top-up 对每个 kind 分别校验符号，「money paths should not quietly accept a sign they cannot mean」。）

**③ 必须有显式超时。** chat 那条路径只挂了客户端的 `c.req.raw.signal`，因为对话有流式首字节兜底。图片是一次性响应，高质量 1536 可能跑 60 秒以上，而一个挂死的上游会占着预留直到 10 分钟的 `expires_at`。加 `AI_IMAGE_TIMEOUT_MS`（默认 180000），与客户端 signal 用 `AbortSignal.any([...])` 合并。

**④ 按实际返回张数结算。** 上游可能在 `n=4` 时因内容审核只返回 3 张（`data.length < n`）。`settle()` 吃的是绝对金额，所以直接用 `data.length × unit` 结算、预留自动冲销差额即可 —— 不需要额外的退款路径。

**不做的：** `stream`（gpt-image-2 的 `partial_images` 流式）、`images/edits`、`images/variations`。edits 是 multipart，要在 proxy 里另开一条 body 处理路径，收益不匹配 —— 列进二期。

### 2.4 数据库：两处最小改动，不新建表

`ai_usage_logs` 已经能装下图片这行账，只差两处：

```sql
-- 迁移：services/supabase/migrations/2026xxxxxxxxxx_ai_usage_image.sql

-- ① 'fixed' = 按张定价，与 token 无关。
--    不复用 'upstream'：报表里必须能把图片从 token 计费里摘出来，
--    也不复用 'estimated' —— 那个值是「上游出毛病了」的告警口径。
alter table amux.ai_usage_logs drop constraint if exists ai_usage_logs_usage_source_check;
alter table amux.ai_usage_logs add constraint ai_usage_logs_usage_source_check
  check (usage_source in ('upstream','estimated','fixed'));

-- ② n=4 时一行 credits=4×unit，但看不出是 4 张。
--    ⚠️ 不能写 add column if not exists：self-host 用 postgres 角色跑迁移
--    （CI 用 supabase_admin），非 owner 下即使无事可做也会报错。
do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'amux' and table_name = 'ai_usage_logs'
       and column_name = 'image_count'
  ) then
    alter table amux.ai_usage_logs add column image_count int not null default 0;
  end if;
end
$$;
```

各列的填法：

| 列 | 图片行填什么 |
|---|---|
| `public_model_id` | `image` —— **计费依据** |
| `backend_model_id` | `gpt-image-2` —— 成本依据，不参与计费 |
| `input_tokens` / `output_tokens` | 上游 `usage` 有就记，没有就 0。**不参与计费** |
| `credits` | 张数 × 单价 |
| `usage_source` | `fixed` |
| `image_count` | 实际返回张数 |
| `stream` | `false` |

**grants 不用动** —— 现有授权是表级的。**pgTAP 也不用动** —— `services/supabase/tests/035_ai_gateway_credits.sql` 用的是 `has_column` 而不是 `columns_are`，加列不会撞精确集合断言（这一点是特意确认过的，因为该套件里的 `indexes_are` 是撞过的）。

报表侧 `report.ts` 的 `byModel` 会自动多出一行 `image`，不用改代码。

### 2.5 出网：已解决，用的是 mx5 中继（原本以为是阻塞项）

本文初稿把「深圳盒子直连不到 `api.openai.com`」列为阻塞项，并设计了一套 per-provider 代理。**该阻塞项已不存在** —— 因为我们本来就不打算走 `api.openai.com`。

2026-09-09 起，网关的 `pro` / `max` 已经指向自己新加坡盒子上的 OpenAI 兼容中继 `https://ai.mx5.cn/v1`（cli-proxy-api），并实测：

| 实测项 | 结果 |
|---|---|
| 深圳盒子 → `ai.mx5.cn` | HTTP 200，connect 0.25s —— **不需要任何代理** |
| 网关容器内用自己的 `OPENAI_API_KEY` 调用 | `gpt-5.6-terra` 3.0s / `gpt-5.6-sol` 4.9s，均 200，usage 齐全 |
| 该中继的模型列表 | 含 `gpt-image-2`、`grok-imagine-image` |

所以图片这条路直接复用已经在跑的 `mx5` provider：

```yaml
backend_models:
  mx5-gpt-image-2:
    provider: mx5              # 已存在，已验证，无需代理
    upstream_model: gpt-image-2

image_models:
  image:
    name: 图片
    routing: priority
    pricing:
      per_image_credits: { default: 300000, ... }
    routes:
      - backend: mx5-gpt-image-2
```

**因此不需要 `undici` 依赖、不需要 `proxy_env`、不需要动 compose。** 唯一残留的注意事项是：`ai.mx5.cn` 前置的是订阅账号池，可用性弱于一方 API，所以图片档如果将来要兜底，兜底目标得是另一个真能出图的后端 —— DeepSeek 出不了图，不能像 `pro`/`max` 那样拿它兜。一期不做兜底，失败就如实报错。

> **⚠️ 2026-09-09 实测：这条中继上的图片模型目前一个都调不通 —— 「列在 models 里」不等于「能出图」。**
>
> | 模型 | 结果 |
> |---|---|
> | `gpt-image-2` | `400 The 'gpt-5.4-mini' model is not supported when using Codex with a ChatGPT account.` —— 注意报错里的模型名**不是我们传的那个**：images 路径没有采纳 `model` 字段，而是派到了一个出不了图的 Codex/ChatGPT 账号上 |
> | `grok-imagine-image` / `-quality` | `403 personal-team-blocked:spending-limit` —— 账号池没额度 / 需要 Grok 订阅 |
>
> 这不是网关侧的问题，是中继账号池的问题，**必须先在中继上解决，Phase 1 才有可验收的对象**。在此之前 §2.5 里「复用 mx5 出图」只是路线成立、能力未就绪。出网确实不需要代理（那条结论不变），但可用的图片后端还没有。

## 3. Skill 设计

### 3.1 凭证和 baseUrl 从哪儿来（不需要新机制）

agent 进程的 spawn env 里已经有两样东西（`apps/daemon/src/runtime/env_assembly.rs`）：

```jsonc
// $TEAMCLU_TEAM_PROVIDER
{
  "name": "Team",
  "baseUrl": "http://127.0.0.1:<daemon port>/v1/ai/teams/<teamId>",
  "apiKeyEnv": "tc_gateway_token",   // 令牌在这个 env 变量里，不内嵌在 payload 中
  "models": [{ "id": "default", "name": "标准" }, ...]
}
```

`tc_gateway_token` 是一枚只带 `ai:invoke` scope 的 daemon 会话令牌 —— **不是云凭证**，daemon 在转发时会把它剥掉换成设备令牌。所以 skill 脚本读这两个变量就够了，不需要新增任何 env、scope 或握手。

teamId 已经在 baseUrl 里，skill 不用自己去查「当前团队」—— 这正是当初把 teamId 放进路径的原因（避免「切完团队记到旧团队账上」那一类 bug）。

> **上线前必须实测一条**：pi 的 bash 工具启的子进程是否原样继承宿主进程 env。理论上继承，但 `tc_gateway_token` 是个 secret 名，值得确认没有哪一层做了 env 清洗 —— 一行 `echo ${tc_gateway_token:+present}` 就能验。

### 3.2 落盘与显示：路径必须落在会话目录内

桌面端渲染 agent 回复里的 `![](...)` 时走 `resolveAgentImagePath(src, basePath)`（`packages/app/src/packages/ai/message.tsx`），其中 `basePath = session.directory`（会话的工作目录，也就是 agent 的 cwd）。规则：

- 相对路径按 `basePath` 解析，绝对路径直接用；
- **解析结果不在 `basePath` 之内 → 返回 `null`，整个 `<img>` 渲染成空**，没有报错、没有占位符、控制台也没有东西。

这是个静默失败，所以必须写死进 SKILL.md：**图片只能写进会话目录（agent 的 cwd），引用只能用相对路径。** 写到 `/tmp` 再引用，用户看到的就是一段没有图的文字。

落在目录内之后走 `LocalImage`，点击有大图预览和下载按钮 —— 不需要为图片做任何前端改动。

### 3.3 绝对不能把 base64 打回对话

`gpt-image-2` 预期只返回 `b64_json`（待实测）。一张 1024² PNG 的 base64 是 **1.5–3 MB**。

我们已经被这个模式打过一次：单条 8.5 MB 的工具结果会让**压缩调用自身也超限**，7 次 compaction 全部白烧，会话直接卡死。pi 自带的 `read` / `bash` 有 50KB 上限，但我们自己的桥没有。

所以脚本的契约是：

```
写文件 → stdout 只打印相对路径 + 尺寸 + 用量摘要
```

**stdout 里永远不出现 base64。** 这条要同时写进脚本注释和 SKILL.md —— 后者是防 agent 自作聪明去 `cat` 那个 PNG。

### 3.4 脚本形态

用 Node，不用 `curl`：Windows 上没有 curl 的保证，而托管 Node 是 onboarding 的既定组成部分（pi 就绪 = pi 版本 + node + MCP SDK 三个条件）。

```
image-gen/
  SKILL.md
  scripts/generate.mjs      # 零依赖，只用 node: 内置模块
```

`generate.mjs` 做五件事：

1. 解析 `$TEAMCLU_TEAM_PROVIDER` → `baseUrl`；读 `process.env[payload.apiKeyEnv]` → 令牌。任一缺失 → 打印一句人话（「当前团队没有启用 AI 网关」）并退出非零。
2. `POST ${baseUrl}/images/generations`，`{ model: "image", prompt, n, size, quality, output_format: "png" }`。
3. 按状态码翻译错误（见 §4），**不要把 JSON 原样甩给用户**。
4. `b64_json` → 写 `./<prompt slug>-<yyyymmdd-HHMMSS>-<i>.png`（cwd 就是会话目录）。
5. stdout 打印：相对路径、像素尺寸、文件大小、本次扣的积分。

CLI：`node scripts/generate.mjs --prompt "..." [--n 1] [--size 1024x1024] [--quality medium] [--out-dir .]`

### 3.5 SKILL.md 里必须写死的四条

frontmatter 沿用现有惯例（`name` + 触发词密集的 `description`，参考 `macos-control`）：

```yaml
---
name: image-gen
description: "生成图片/配图/插图/海报/头像/示意图。触发词：画一张、生成图片、配图、做个图、image、生图、AI 绘图。"
---
```

正文的四条硬约束：

1. **只调 `scripts/generate.mjs`**，不要自己拼 HTTP 请求，也不要去读 `$tc_gateway_token`。
2. **不要 `cat` / `base64` 那个 PNG**，也不要把文件内容读进上下文。
3. **回复里用相对路径引用**：`![描述](生成的相对路径)`，不要改写成绝对路径或 `file://`。
4. **报错就照实说**：积分不足、额度超限、团队没开网关，都是用户能自己解决的问题，翻译成一句话，不要重试。

### 3.6 放哪儿：先进市场，稳定后再转内置

两条路：

| | 内置（inherent） | 市场 / 注册表 |
|---|---|---|
| 分发 | `include_str!` 编进 daemon 二进制，自动铺进每个 workspace | 用户/团队按需装 |
| 改一句提示词 | 要发 daemon 版本 | 推一次包 |
| 能否删除 | 不能 | 能 |

**建议 v1 走市场。** 新 skill 的措辞一定要调 —— 什么时候触发、如何描述失败、要不要追问尺寸，这些都得看真实会话才知道。为改一个形容词发一次 daemon 版本不划算。等措辞稳定、且产品确认「人人都该有」时，再按 `create-role` / `macos-control` 那套加进 `INHERENT_SKILL_NAMES` + `inherent_skills()`，那是个纯机械的改动。

---

## 4. 错误语义

透传上游错误、不加工，是网关已有的立场（agent runtime 依赖这些状态码）。skill 负责把它们翻成人话：

| 状态 | 来源 | skill 该说什么 | 重试 |
|---|---|---|---|
| `402 insufficient_credits` | 网关，团队余额不够 | 「团队积分不足，需要充值」 | 否 |
| `402 quota_exceeded` | 网关，个人额度用完 | 「你的额度用完了，找管理员调」 | 否 |
| `403 model_not_allowed` | 网关，model id 不认识 | 配置问题，报出来 | 否 |
| `400 unpriced_image_variant` | 网关，尺寸/质量组合没定价 | 「这个尺寸暂不支持，试试 1024x1024」 | 否 |
| `404` | **daemon**，团队没配 managed LLM | 「当前团队没有启用 AI 网关」 | 否 |
| `400 moderation_blocked` 等 | OpenAI 原样透传 | 转述上游原因 | 否 |
| `5xx` / 超时 | 上游或代理 | 「上游暂时不可用」 | 至多 1 次 |

那两个 402 分开，是网关刻意设计的：一个靠充值解决、一个靠调额度解决，合成一条消息就会把人指向错误的补救办法。

---

## 5. 分期

**Phase 1 — 网关（可独立上线、可独立验收）**

- `catalog.ts`：`image_models` + `default_image_params` + 校验
- `proxy.ts`：`prepareImageUpstream()` + per-provider `ProxyAgent`
- `app.ts`：`POST /v1/teams/:teamId/images/generations`
- 迁移：`usage_source='fixed'` + `image_count`
- `catalog.example.yaml`：加 `mx5-gpt-image-2` backend + `image_models`（`mx5` provider 与 `OPENAI_API_KEY` 已于 2026-09-09 上线）

验收：`curl` 直接打网关（带一枚真实 JWT），拿到图；`ai_usage_logs` 多一行 `fixed`；余额按预期减少；预留表里不留 `held` 行。

**Phase 2 — skill**

- `SKILL.md` + `scripts/generate.mjs`
- 打包发到市场
- 端到端：在桌面端对 agent 说「画一只猫」，图片内联显示出来

**Phase 3 — 后续**

- `images/edits`（multipart）
- `partial_images` 流式（先出低清预览）
- 账单页把图片单独成栏（有了 `image_count`，「本月 N 张」是一个 SQL 聚合）
- 措辞稳定后转内置

---

## 6. 上线前必须实测的（不要照本文的记忆值下结论）

网关设计里 DeepSeek 那几条上游行为是拿真实 API 打出来的，图片这边也该同样对待：

1. `gpt-image-2`（经 mx5 中继）的 `usage` 字段到底有没有、字段名叫什么
2. 是不是**只**返回 `b64_json`、`response_format` 参数还认不认（中继会改写协议，不能照官方文档推断）
3. `n > 1` 时部分失败的实际形状（是少几个元素，还是整个 400）
4. 计价口径 —— 走中继意味着成本是订阅池而非按张计费，§2.1 那张按张成本表要重新对一次
5. 内容审核被拒时的状态码和 body 形状（决定 §4 那张表最后两行）
6. pi 的 bash 子进程是否继承 `tc_gateway_token`

---

## 7. 改动清单（文件级）

| 文件 | 改动 |
|---|---|
| `services/ai-gateway/src/catalog.ts` | `ImageModel` 类型、`image_models` 解析与校验、`default_image_params` |
| `services/ai-gateway/src/proxy.ts` | `prepareImageUpstream()`、`pricePerImage()` |
| `services/ai-gateway/src/app.ts` | `POST /v1/teams/:teamId/images/generations` |
| `services/ai-gateway/src/db.ts` | `UsageRow` 加 `imageCount`、`usageSource` 加 `'fixed'` |
| `services/ai-gateway/src/config.ts` | `imageTimeoutMs` |
| `services/ai-gateway/test/` | 定价查表 / 未定价 400 / hold==settle / 部分返回 / 上游错误 release / **`image` 不出现在 `GET /models`** |
| `services/supabase/migrations/2026xxxx_ai_usage_image.sql` | 上面那段 |
| `deploy/self-host/ai/catalog.example.yaml` | `mx5-gpt-image-2` backend + `image_models`（`mx5` provider 已在位） |
| skill 包（新） | `SKILL.md` + `scripts/generate.mjs` |

**不需要改**：daemon（透传路由已就绪）、FC（图片不进 `llm.models`）、桌面前端（`![](相对路径)` 已能渲染）、`s.yaml`（网关不在 FC 部署目标上）。

---

## 8. 决策记录

| # | 决策 | 理由 |
|---|---|---|
| 1 | 按张计费，不按 token | 上游给不齐 token；预留=结算，无超发；与 §4.4 自主定价一致 |
| 2 | `image_models` 与 `public_models` 平级 | `public_models` 是客户端契约，三档写死在桌面端；混进去会污染模型选择器 |
| 3 | 对外只有一个稳定 id `image` | 与三档同理：换上游不发版 |
| 4 | 未定价组合 400，不按 default 收 | 没定过价的多半是新出的贵档位；宁可拒绝 |
| 5 | 复用 `ai_usage_logs`，不新建表 | 一张表就够；报表、对账、清理全部白拿 |
| 6 | 新增 `usage_source='fixed'` | `estimated` 是告警口径，不能被图片污染 |
| 7 | 复用已在跑的 `mx5` 中继，不接 api.openai.com | 深圳盒子直连 `ai.mx5.cn` 250ms 通，且该中继就有 `gpt-image-2`；原设计里那套出网代理因此整个不需要了 |
| 8 | 显式超时 180s | 图片没有流式首字节兜底，挂死的上游会占满 10 分钟预留 |
| 9 | stdout 绝不出现 base64 | 单条 8.5MB 工具结果打垮过压缩，7 次全白烧 |
| 10 | v1 走市场而非内置 | 措辞要迭代，不值得为一个形容词发 daemon 版本 |
