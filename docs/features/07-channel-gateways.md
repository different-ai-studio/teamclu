# TeamClu 功能详解 · 第 7 篇：多通道网关（Channel Gateways）

> 版本基线：当前 `main`（`package.json` v0.4.1-beta.51）。
> 读者：要接手通道网关这块的工程师。
> 关联：`docs/specs/2026-08-18-gateway-transport-architecture.md`（本文的主要来源）、
> `crates/teamclu-gateway/`、`apps/daemon/src/channels/`、
> `packages/app/src/components/settings/channels/`、`docs/specs/2026-03-*` 的各渠道设计。

---

## 0. 一句话定位

通道网关让 agent 能被人**从外部 IM 里用到**：企业微信、飞书、Discord、KOOK、微信、SeaTalk、邮件。人在微信里给 bot 发一句话，这句话变成一次 agent turn，回复再发回微信。

这块的设计原则只有一句，但它决定了整个结构：

> **渠道只做传输，能力属于内核。**

这句话的反面是「每个渠道自己实现所有能力」，那正是这套设计要离开的状态。理解为什么，需要先看反面是什么样。

---

## 1. 现状之前：每个渠道都是一份从零开始的实现

`crates/teamclu-gateway` 曾经只共享两个 trait（`AgentHandle`、`ChannelStore`）、命令解析、一个本地 session JSON 映射（已删）、排队器和 i18n。**其余每个渠道各写一遍**：连接与重连、去重、白名单过滤、@ 规则、流式节流、附件、渲染、错误回复。

后果不是「代码重复」这么温和——是**功能能力按渠道随机分布**。实测三个渠道：

| 能力 | WeCom（3009 行） | 飞书（1597 行） | 邮件（2360 行） |
|---|---|---|---|
| 入站附件 | ✅ 下载解密 + 上传 + 入库 | ❌ 显式忽略图片 | ❌ 零处理 |
| 出站附件 | ✅ `upload_and_send_media` | ❌ | ❌ |
| 流式回复 | ✅ 卡片更新节流 | ❌ 阻塞 `send_prompt` | ❌ 阻塞 |
| 去重 | 内存标记 | 无 | UID 水位 + `email_db.rs` |
| 交互式提问 | ✅ 模板卡片 | ❌ | ❌ |
| 会话映射 | binding → acp → cloud session | 同左 | 同左 + `email:thread:` 索引 |

也就是说：**新接一个渠道 = 从零开始，且大概率停在「能收发文本」这一档。** 飞书和邮件就停在这一档。用户在企微能发图片、能看流式、能被追问，换到飞书同一个 session 就全没了——但那是同一个 session。

这是「能力属于渠道」的必然结果：能力不是一个可以在渠道之间移动的东西，而是每个渠道自己长出来的。要让飞书获得附件能力，就得在飞书代码里再写一遍 WeCom 已经写过的东西。

---

## 2. 目标与非目标

**目标**

1. 接一个新渠道 = 实现一个窄 trait（解析、发送、可选的媒体上传），**自动获得**附件、流式、去重、命令、i18n、排队、交互提问；
2. 一个渠道不支持某能力时，内核**降级**而不是消失（邮件不能流式 → 内核缓冲后一次发出，而不是「邮件没有流式」）；
3. 一个 session 在任何渠道看到的语义一致。

**非目标**：不改渠道的协议细节（企微加密、飞书 token 刷新、IMAP IDLE 这些留在驱动里）；不动已收拢的命令层。

第 2 条是最容易被忽略、也最重要的一条。它把「能力」从「有/没有」变成「以什么形式呈现」——邮件没有流式，不代表邮件用户看到的东西更少，只代表它是最后一刻一次性到达。这个转换是内核的责任，而内核只需要一份实现。

---

## 3. 核心抽象

### 3.1 入站：渠道把原生事件归一化

```rust
pub struct InboundMessage {
    pub channel: ChannelId,             // "wecom" / "feishu" / "email"
    pub bot_id: Option<String>,         // 一个渠道可跑多个 bot
    pub conversation: Conversation,
    pub sender: ExternalSender,         // 渠道用户 id + 显示名 + 可选邮箱
    pub external_message_id: String,    // 去重键，渠道内唯一
    pub text: String,
    pub attachments: Vec<InboundAttachment>,  // 惰性：拿到的是 fetch 闭包，不是字节
    pub addressed_to_bot: bool,         // 群里是否 @ 了 bot；邮件恒为 true
    pub reply_to: Option<String>,       // 渠道原生的"回复某条"
    pub received_at: DateTime<Utc>,
}
```

驱动负责把签名校验、解密、token 刷新、MIME 解析、IMAP fetch 全部消化掉，**内核只见 `InboundMessage`**。

两个设计细节值得单独说：

- **附件是惰性的。** `attachments` 拿到的是 fetch 闭包，不是字节。原因是让「纯文本消息立即开始 turn」不被附件下载拖慢——WeCom 现在就是立即开始的。代价是闭包的生命周期要跨过 turn，谁持有需要明确（列在风险里）。
- **`bot_id` 必须在 `Conversation` 的键里。** 企业微信已经是一个渠道多 bot，否则两个 bot 的同名群会撞。这是一个「现在只有一个 bot 所以不会出问题」的坑。

### 3.2 出站：内核给意图，驱动决定怎么渲染

```rust
pub struct OutboundMessage {
    pub text: String,
    pub attachments: Vec<SessionAttachment>,   // 已经入库的 session 附件
    pub question: Option<InteractiveQuestion>, // 需要用户选择时
}

pub struct ChannelCaps {
    pub streaming_edit: bool,   // 能否边生成边改同一条消息
    pub media_upload: bool,
    pub interactive: bool,      // 卡片/按钮
    pub threading: Threading,   // Inline | ReplyTo | MailThread
    pub max_chars: usize,
}
```

内核按 caps 降级：`streaming_edit=false` → 整轮缓冲后一次发出；`media_upload=false` → 附件转成可下载链接附在文末；`interactive=false` → 交互提问退化成「回复数字选择」。**降级规则写一次，所有渠道共享。**

这是抽象里最关键的一步：它把「渠道能力差异」从一个会让内核分支的条件，变成了一个数据（caps）。内核读 caps，不读渠道名字。

### 3.3 渠道驱动 trait

```rust
#[async_trait]
pub trait ChannelDriver: Send + Sync {
    fn id(&self) -> ChannelId;
    fn caps(&self) -> ChannelCaps;

    /// 连接并把归一化后的入站消息推进 sink；断线重连自理。
    async fn run(&self, sink: InboundSink, shutdown: ShutdownSignal) -> Result<(), DriverError>;

    /// 渲染一条出站消息。流式由内核按 caps 决定是否多次调用同一 handle。
    async fn deliver(&self, to: &Conversation, msg: &OutboundMessage) -> Result<DeliveryId, DriverError>;

    /// 仅 streaming_edit=true 的渠道实现。
    async fn update(&self, id: &DeliveryId, text: &str, finished: bool) -> Result<(), DriverError> { ... }
}
```

注意 `update` 有默认实现（返回未实现），所以不支持流式的渠道只需实现 `run` / `deliver`。/ `caps` 决定内核会不会调它，`update` 的默认实现是第二道保险。

### 3.4 会话模型：三个渠道差异最大的地方

这一层不能假设，必须逐个渠道定义 `Conversation`：

| | WeCom | 飞书 | 邮件 |
|---|---|---|---|
| 会话单元 | (bot, chat\|user) | chat_id | **线程**（`Message-ID` / `In-Reply-To` / `References` 链） |
| 谁能开新会话 | @bot 或私聊 | @bot 或私聊 | 任何发到该地址的邮件 |
| 身份可信度 | 平台鉴权，可信 | 平台鉴权，可信 | **From 可伪造** → 必须白名单 + 可选 DKIM/SPF 校验 |
| 一轮的边界 | 一条消息 | 一条消息 | 一封邮件（可能包含引用历史，需剥离） |
| 回复归位 | 直接发到 chat | reply API | **必须带 `In-Reply-To`**，否则线程断开、下一封归不到同一 session |
| 时延容忍 | 秒级 | 秒级 | 分钟级（IDLE 25 分钟续期 / 30 秒轮询） |

**邮件是压力测试用例。** 它没有流式、没有 @、身份不可信、时延以分钟计、附件是 MIME 部件。任何「内核假设渠道像 IM」的设计都会在邮件上崩。反过来，能容纳邮件的抽象，接微信/短信/工单系统时不用再改。

这也是为什么迁移顺序把邮件排第三：前两个（企微、飞书）证明抽象容得下「能力最丰富的」和「能力较少的」，邮件证明它容得下「根本不是 IM 的」。

---

## 4. 内核流水线（唯一实现）

```
驱动 → InboundMessage
        │
        ├─ 去重       (channel, external_message_id) —— 一个存储，替换掉三套各自的做法
        ├─ 路由       conversation → binding → session
        ├─ 身份       external user → external actor + 加入 participant
        ├─ 准入       白名单 / 群 @ 规则 / 命令识别
        ├─ 写入       ★ session 写入服务：入库 + 广播 + 附件，双向同一条路径
        ├─ 驱动 turn  走正常 session runtime 生命周期，而不是另起一条
        └─ 回送       OutboundMessage → 按 caps 降级 → driver.deliver / update
```

★ 这一层是 #933 抽出的「写入服务」。**两件事必须一起做**：只做写入服务，渠道仍各自解析各自渲染；只做本文的驱动抽象，写入仍是两套。

### 4.1 内核落在哪一侧

内核**不是** `AmuxdAgentHandle`。那是 daemon 侧实现 gateway `AgentHandle` trait 的适配器，职责单一：驱动一次 turn。它是内核的协作者，而且按 #933 的目标最终应该退化掉——turn 走 `apply_start_runtime` 的正常生命周期，而不是自己另起一条。把路由、去重、写入堆进一个本该只管「跑一轮」的东西里，是在重复今天的错误。

落点由**依赖方向**决定：

```
apps/daemon    ─┐
                ├──→ crates/teamclu-gateway   （叶子 crate，不依赖任何 amuxd 内部）
apps/desktop   ─┘
```

gateway crate 只认注入进来的两个 trait（`AgentHandle` / `ChannelStore`）。而内核要用的东西全在 daemon 侧：写入服务、live 发布、runtime 生命周期、backend client、external actor 映射。把流水线放进 crate，就得把这些反向暴露给它——依赖方向就反了，crate 也不再能独立测试。

| 放哪 | 放什么 |
|---|---|
| `crates/teamclu-gateway` | 归一化类型、`ChannelDriver` trait、**各渠道协议驱动** |
| `apps/daemon/src/channels/core/` | 流水线本体：去重、路由、身份、准入、写入+广播、turn、按 caps 降级渲染 |

`apps/daemon/src/channels/` 今天已经是 daemon 侧适配层（`agent_handle` / `backend_store` / `manager` / `live_notify` / `reply_token`），内核长在这里最自然：现有的 `AmuxdChannelStore` 基本被内核吸收，`manager.rs` 退成「启动/停止驱动」。

**这是一个可复用的架构判断方法**：当一个模块要横跨两个 crate 时，看它依赖什么。如果它依赖上层（daemon 的内部服务），它属于上层；如果它只依赖下层（协议类型），它属于下层。这个判断比「它逻辑上属于谁」更可靠，因为依赖方向是可验证的。

---

## 5. 出站有三条路，只有一条经过 session

设计只盯着网关自己的回复是不够的。今天一条消息发到企微，有三条互不相干的路径：

| 路径 | 入口 | 是否进 session |
|---|---|---|
| 网关回复 | 渠道驱动自己的 reply | ✅ 已入库并广播 |
| MCP `send` 工具 | `handle_mcp_send` → `ChannelManager::dispatch_send` | ⚠️ **先推渠道再补录**，顺序反了 |
| introspect MCP | desktop 的 `introspect_api.rs` → `teamclu_gateway::wecom::send_proactive_message` | ❌ **完全不进 session** |

第三条最隐蔽：`introspect_api.rs` 是 desktop 开在 `127.0.0.1:13144` 上给 `teamclu-introspect` MCP 二进制用的本地 HTTP API。agent 调这个工具 `POST /send-wecom`（含 `media_base64` 附件），desktop 直接调 gateway crate 的渠道函数——**绕开 daemon、绕开 session、绕开一切**。企微里有那条消息和那个文件，桌面端查无此物。

收编方式一致：三条都必须走第 4 节的内核流水线（先入库、再由驱动渲染）。desktop 那条额外要改依赖方向——它现在直接 link gateway crate 去发消息，应当改为经 daemon（desktop 已经有本地 daemon 客户端），否则「渠道驱动只被内核调用」这条约束在 desktop 侧就是空话。

**这条经验值得记住：** 一个「旁路」一旦存在，它就会成为最难排查的问题来源，因为它产生的结果在系统的其它部分不存在。排查时的第一反应是「消息发出去了吗」——发出去了，但系统里没有。所以治理方式是**让所有出站都必须经过同一个入口**，而不是在每条旁路上补记录。

---

## 6. 迁移顺序

1. **WeCom 先行**——它是唯一功能完整的渠道，把它拆成「驱动 + 内核」能证明抽象容得下最富的那个（媒体、流式卡片、交互提问、多 bot）。拆完 WeCom 的行为必须逐项不变，这是验收线。
2. **飞书第二**——证明「能力少的渠道自动获得能力」：接上内核后，入站附件和流式**不需要在飞书代码里写**就应该可用（飞书本身有文件下载 API 和消息更新 API，只是现在没接）。
3. **邮件第三**——证明非 IM 形态能被容纳：线程模型、不可信身份、无流式、分钟级时延。
4. 其余渠道（KOOK / SeaTalk / 微信 / Discord）按同样方式收编，每个应该只剩几百行驱动。

每步都能单独上线。但实测下来，这条路线没有完全走完：内核挂在 `TEAMCLU_GATEWAY_CORE` 开关之后与 inline 路径并存过一段时间，八个渠道最终都实现了 `ChannelDriver`，inline 实现全部删除——不再存在「两套并存」。

**一个必须记下的教训：** WeCom 与飞书的 inline 一度只是变成了 `inbound_sink` 分支之后的死代码，没被删，共约 950 行。Code review 揪出来了，那里面还留着一条**未净化的 bucket key**——正是本次修掉的 `Invalid key` bug 的同一份代码。**「两套并存」的代价不只是维护成本，还有「你以为删了但其实没删」的安全面。**

---

## 7. 各渠道的配置与状态

前端设置页的 channels section 按渠道拆组件：`Discord.tsx`、`Feishu.tsx`、`Email.tsx`、`Kook.tsx`、`Wechat.tsx`、`Wecom.tsx`、`Seatalk.tsx`。每个渠道有独立的 config 类型、默认值、状态查询与保存动作。

一个细节：**这个 section 的可见性来自远程功能开关。** `useFeatures().channels` 在每次 render 解析，因为这些 flag 现在从 Cloud API 来、可以在会话中途变化。所以它不能像以前那样在模块作用域解析一次。

状态映射在前端：`channels-store.ts` 把 daemon 返回的 channel status list 映射成每个渠道的 UI 状态（connected / connecting / disconnected / error）。`GatewayStatusCard` 是统一的展示，`TestCredentialsButton` 允许测试凭据，`GatewayStatusResponse` 等类型在 `channels-types.ts`。

daemon 侧每个渠道有自己的 config 模块：`wecom_config.rs` / `feishu_config.rs` / `email_config.rs` / `kook_config.rs` / `wechat_config.rs` / `seatalk_config.rs`。加一个渠道通常意味着：新建驱动 + config + 前端组件 + feature flag。

---

## 8. 身份、权限与无人值守

通道会话（gateway session）有一个特殊性质：**无人值守**。所以它的权限自动批准（`is_gateway` → daemon 直接应答 `confirmed=true`）。这条与第 2 篇的 cron 是同一个原理：等审批就等于不跑。

代价是安全面：一个通道 bot 可以执行工具，而没有人看着。所以：

- **白名单是必要的**（`check_dm_allowed` / `should_process_message` / `check_email_filter`），而且它**刻意留在渠道里**，没有跟着 inline 实现一起删。内核没有 policy 这一层，而 allowlist 规则是渠道自己的配置——一起删等于把机器人对所有人敞开。
- **邮件尤其危险**：`From` 可伪造，所以白名单是必要但不充分。是否要求 DKIM/SPF 通过才建 session、拒绝时是否回信（回信会给伪造者反馈），是产品决定。
- **统一的 policy 层是后续的事**，不在本文范围。

这里有一个与第 4 篇 MCP 的呼应：**任何「能让外部输入在某台机器上执行东西」的路径，都需要一个准入层。** 通道的准入是白名单，MCP 的准入是「只能自己装」。两者形态不同，但都是同一条原则。

---

## 9. 交互式提问：一个死掉的子系统

`pending_question.rs`（664 行）整套交互式提问是**死的**：全仓没有任何地方往 store 里 insert（`handle_question_event` 零调用方），所以 `/answer` 永远回「没有待回答的问题」，企微卡片按钮也永远找不到对应问题。

这是一个必须诚实记录的事实，因为它看起来像是「已实现的功能」。接上还是删掉需要先定。这也是文档写作的一条纪律：**代码存在不等于功能存在**，必须说清楚哪个是活的、哪个是死的。

---

## 10. 测试与验收

- 渠道驱动大量依赖真实平台，所以单元测试集中在归一化与内核流水线；
- WeCom 拆分时「行为逐项不变」是验收线；
- 邮件 FinalOnly（无流式）是压力用例；
- 风险里列出的「排队器超时对邮件不成立」需要真实测试。

---

## 11. 关键文件索引

```
crates/teamclu-gateway/src/
  lib.rs                  模块导出、http_client 等工具
  driver.rs               ChannelDriver trait 与内核类型
  agent.rs                AgentHandle trait、会话/参与者类型
  binding.rs              conversation → session 绑定
  channel_store.rs        ChannelStore trait、附件记录
  commands.rs             命令解析
  pending_question.rs     交互提问（死）
  i18n.rs                 渠道侧文案
  wecom.rs / wecom_config.rs / wecom_delivery.rs / wecom_outbox.rs
  feishu.rs / feishu_config.rs
  email.rs / email_config.rs / email_db.rs
  discord.rs / kook.rs / kook_config.rs
  wechat.rs / wechat_config.rs
  seatalk.rs / seatalk_config.rs
apps/daemon/src/channels/
  core/                   内核流水线（去重/路由/身份/准入/写入/turn/回送）
  agent_handle.rs         适配器
  backend_store.rs
  manager.rs              启动/停止驱动
  live_notify.rs
  reply_token.rs
packages/app/src/
  stores/channels-store.ts / channels-types.ts
  stores/channels/*.ts    每渠道动作
  components/settings/ChannelsSection.tsx
  components/settings/channels/*.tsx
```

---

## 12. 常见坑

1. **不要让渠道自己实现能力。** 新能力先问「内核能不能统一做」。
2. **能力差异用 caps 表达，不要用渠道名分支。**
3. **邮件是压力测试用例。** 改内核时先想它在邮件上成不成立。
4. **`bot_id` 要进 Conversation 键。** 多 bot 是现状。
5. **附件的生命周期要明确。** 惰性闭包跨 turn。
6. **出站必须只有一条路。** 旁路产生「系统里查无此物」的消息。
7. **白名单不能删。** 它不在内核里。
8. **gateway 会话自动批准权限是有前提的。**
9. **`pending_question` 是死的。** 不要以为它在工作。
10. **排队器超时是按 IM 定的。** 邮件一轮可能超过 180s / 300s。

---

## 13. 附录 A：七个渠道的协议要点

每个渠道的难点不一样，列出来可以看清「驱动到底要消化什么」：

### 13.1 企业微信 WeCom

- **加密通信**：回调需要验签 + AES 解密；发送需要 access_token，有有效期与刷新。
- **多 bot**：一个渠道可以跑多个 bot，所以 `bot_id` 是会话键的一部分。
- **流式卡片**：支持消息更新（`streaming_edit`），但有频率限制。
- **附件**：入站要下载解密，出站要上传媒体。
- **交互卡片**：支持按钮，也是 `pending_question` 原本的服务对象。
- **ownerId**：没有显式 target 时从 daemon 配置目录读 ownerId。

WeCom 是「能力最全的渠道」，所以它是第一个被拆分验证的。

### 13.2 飞书 Feishu

- **token 刷新**：tenant_access_token 有有效期，需要刷新。
- **事件订阅**：回调验证与解密。
- **回复 API**：可以用 reply 接口把回复挂到原消息上（threading 的一种）。
- **消息更新 API**：飞书其实支持消息更新，只是现在没接流式——这正是「能力少的渠道自动获得能力」的验证点。
- **附件**：飞书有文件下载 API，只是现在显式忽略图片。

### 13.3 邮件 Email

- **IMAP**：IDLE 25 分钟续期，或 30 秒轮询。
- **SMTP**：发信。
- **MIME 解析**：正文、附件、引用历史都要解析；引用历史要剥离，否则会把整封历史当成本次输入。
- **线程**：`Message-ID` / `In-Reply-To` / `References` 链。回复**必须**带 `In-Reply-To`，否则下一封归不到同一 session。
- **身份**：`From` 可伪造。
- **去重**：UID 水位 + `email_db.rs`。
- **时延**：分钟级。

邮件是唯一一个「不是 IM」的渠道，所以它验证抽象的上限。

### 13.4 Discord

- **Gateway 连接**：WebSocket，断线重连与 resume。
- **Guild 列表**：`connectedGuilds` 是 UI 的一个状态。
- **Slash 命令**：Discord 原生的交互方式。
- **流式**：可以编辑消息。

### 13.5 KOOK

- 频道型 IM，类似 Discord 的机器人模型。
- `kook_config.rs` 管 ticket / token。
- UI 有专门的 `KookDialogs.tsx`。

### 13.6 微信 WeChat

- 与 WeCom 不同，是个人的微信生态。
- 连接形态与风控更敏感。

### 13.7 SeaTalk

- SeaTalk 的 gateway 由 amuxd 拥有，携带自己的凭据，**不走 `read_teamclu_config`**。这是一个与多数渠道不同的取凭据方式。

### 13.8 一个共同点

这七个渠道的驱动代码各自不同，但它们**向上暴露的东西是相同的**：一个 `InboundMessage` 流、一个 `deliver` 能力、一组 `ChannelCaps`。差异被关在驱动内部。这正是抽象的目标：让差异存在，但不让它扩散。

---

## 14. 附录 B：去重与幂等

去重是渠道接入里最容易做错、后果最尴尬的一块。

### 14.1 为什么必须去重

IM 平台的投递语义是**至少一次**（at-least-once）：网络重试、平台重投、应用重启都可能让同一条消息到达两次。如果不去重，用户发一句话会得到两个 agent 回复，而且两个回复可能不一致（因为各自的上下文不同）。

### 14.2 现状之前：三套做法

| 渠道 | 做法 |
|---|---|
| WeCom | 内存 `mark_message_processed` |
| 飞书 | 无（依赖平台不重投） |
| 邮件 | UID 水位 + `email_db.rs` |

三套各自的做法带来三个问题：内存版重启就丢；无去重意味着平台一重投就双重回复；水位版只能处理「顺序投递」，不能处理乱序或重复 UID。

### 14.3 收敛后的做法

统一用 `(channel, external_message_id)` 做主键，存在一个共享的去重存储里。这是幂等性最自然的形状：**一个消息的唯一身份就是「哪个渠道的哪条消息」**。

### 14.4 去重与「一轮」的关系

一个相关但不同的问题：**去重是消息级，轮次是会话级。** 去重防止同一条消息被处理两次；排队器防止同一个会话同时跑两轮。两者解决不同的问题，不能互相替代。

一个具体的例子：用户快速发三条消息。去重不会合并它们（它们 id 不同），但排队器会把它们合成一轮（或依次跑）。这是有意的：用户连发三句通常是一个意图的三段，不该产生三个回复。

---

## 15. 附录 C：附件处理

附件是「能力属于内核」最典型的例子。

### 15.1 入站

驱动负责把平台的附件变成 `InboundAttachment`，但**不立即下载**——给的是 fetch 闭包。内核拿到闭包后，在写入 session 时调用它，把字节变成 session 附件。

为什么惰性？因为下载可能很慢（图片、大文件），而纯文本消息不应该等它。WeCom 现在的行为就是「立即开始 turn」，而这个行为在收敛后必须保持不变。

### 15.2 出站

内核给出的是 `SessionAttachment`（已经入库的），驱动按自己的 `media_upload` cap 决定怎么发：

- `media_upload=true`：上传媒体并附带；
- `media_upload=false`：转成可下载链接附在文末。

**这个降级规则只写一次。** 没有它，每个不支持媒体的渠道会各自选择一种行为（有的直接丢弃，有的报错），而用户在不同渠道拿到的东西不一致。

### 15.3 一个真实的风险

入站附件的惰性闭包**要跨过 turn**（下载发生在写入或 turn 阶段，而闭包在入站时创建）。谁持有它、什么时候释放，需要明确。这是设计文档里列出的未决项之一。

这个问题的典型症状是：纯文本消息正常，带附件的消息在 turn 开始时附件已经不可达（连接关了、临时 URL 过期了）。排查时看起来像「附件功能偶发失效」，但根因是生命周期。

---

## 16. 附录 D：内核流水线逐步细节

把第 4 节的八个方框展开。每一步都有它存在的理由，而且都是从一个真实问题长出来的。

### 16.1 去重

用 `(channel, external_message_id)` 做主键。为什么需要：IM 平台至少一次投递，不去的后果是双重回复。为什么用这个主键而不是内容哈希：内容相同不代表是同一条消息（用户可以发两次「好的」）。

### 16.2 路由

`conversation → binding → session`。这一步把外部世界的会话标识映射到 TeamClu 的 session。关键点是**绑定是持久化的**（`binding.rs`），不是每次重新算——因为一个群的 session 应该稳定，否则历史对话会散落。

一个曾经的问题是「本地 session JSON 映射」存在过：`session.rs` 里另有一份按 `feishu:<chat_id>` / `email:thread:<id>` 为键的本地 JSON。它后来被确认是**只写不读**的（所有 getter 全仓零调用，连落盘都没发生过），所以云端 session id 是唯一权威。

### 16.3 身份

`external user → external actor + 加入 participant`。这步把「微信里的张三」映射成一个 TeamClu actor。为什么需要：session 的参与者模型是人/agent 并列，而外部用户必须也有一个 actor 身份，否则消息无法归属。

### 16.4 准入

白名单 / 群 @ 规则 / 命令识别。这步是安全层，而且**刻意不在内核里统一**：不同的渠道有不同的准入形态（私聊 vs 群 vs 邮件发件人）。内核只调用渠道的 policy，不定义 policy。

一个值得注意的细节：**命令识别**（`commands.rs`）也在这里。比如 `/answer`、`/stop` 这类控制命令，在进入 turn 之前就被拦下。

### 16.5 写入

入库 + 广播 + 附件。这是 #933 抽出的写入服务，也是整个流水线里最关键的一步。

为什么它必须在 turn 之前？因为出站的另一条路（MCP `send` 工具）曾经是「先推渠道再补录」，顺序反了。后果是：如果补录失败，消息已经发出去了，系统里却没有。**先入库再发送**保证「系统里的消息」是超集——发出的消息一定在系统里，而不是反之。

### 16.6 驱动 turn

走正常 session runtime 生命周期，而不是另起一条。这是 #933 的目标：网关不应该自己实现一套「跑一轮」的逻辑。

### 16.7 回送

`OutboundMessage → 按 caps 降级 → driver.deliver / update`。流式时，内核多次调 `update`；非流式时，内核缓冲到 turn 结束再调一次 `deliver`。

---

## 17. 附录 E：排队器与超时

`session_queue.rs` 负责把同一会话的连续消息合成一轮。它的两个常量：

| 常量 | 值 | 含义 |
|---|---|---|
| `MESSAGE_TIMEOUT` | 180s | 等后续消息的最长时间 |
| `IDLE_TIMEOUT` | 300s | 空闲后多久算一轮结束 |

**这两个值是按 IM 定的，对邮件不成立。** 邮件一轮可能超过（用户写信很长、附件很大、SMTP 慢）。所以超时应随 caps 走，而不是全局常量。这是设计文档里列出的风险之一。

为什么需要排队器？因为用户在 IM 里经常连发多条消息（一句话被拆成三段）。如果不排队，每段都跑一轮，会得到三个回复。排队器把它们合成一个 turn，语义上更接近「一个人说完了一件事」。

一个与去重的区分：**去重管「同一条消息不要处理两次」，排队器管「同一个会话的消息要不要合成一轮」。** 前者是幂等，后者是体验。

---

## 18. 附录 F：流式节流属于驱动

内核管「文本又变长了」，驱动管「多久能更新一次」。

为什么这么分？因为频率限制是平台特性：企微卡片有更新频率上限，飞书消息更新也有，Discord 有 rate limit。如果把这些规则放进内核，内核就会长出渠道细节——而这正是抽象要避免的。

具体的做法：内核在 turn 过程中多次调 `update`，驱动自己决定是否真的要发（丢帧是允许的，因为流式是过程）。最后一条 `update(finished=true)` 是终帧，不能丢。

这里有一个与 MQTT/事件系统的呼应：**中间帧丢了无所谓，终帧丢了气泡永远收不了口。** 这是设计文档里特别指出的一个坑（撤 `checkout_turn_for_acp` 时会遇到）。它与第 3 篇的流式 reconcile 是同一个问题的两个尺度。

---

## 19. 附录 G：与写入服务的分工

这份设计的一半是渠道，另一半是 session 写入（#933）。两者的分工：

| | 写入服务（#933） | 本文 |
|---|---|---|
| 收敛什么 | session 写入（入库 / 广播 / 附件 / turn 生命周期） | 渠道（解析 / 路由 / 去重 / 渲染 / 能力降级） |
| 谁调谁 | 被网关和 cron 调用 | 调用写入服务 |
| 单独做的后果 | 渠道仍各写各的 | 写入仍是两套 |

建议合并成一个方向推进：先落写入服务接口，随即用 WeCom 拆分验证驱动抽象——WeCom 拆分本身就是写入服务的第一个真实调用方。

一个有趣的副产品：**cron 与 gateway 共用同一个写入服务。** 定时任务的回复与通道的回复，最终都是「一个 agent 的消息写进一个 session 并广播」，所以它们共享一条路径。这也是为什么两篇的设计文档会对同一个函数有依赖。

---

## 20. 附录 H：常见问题

**Q：新加一个渠道要写多少代码？**
A：理想情况下只剩几百行驱动：解析入站、实现 `deliver`、声明 `caps`。附件、流式、去重、命令、i18n、排队、交互提问都由内核提供。但如果内核还没完全收拢，就要看现状。

**Q：为什么邮件没有流式？**
A：因为 SMTP 不能编辑已发出的邮件。内核允许它 `streaming_edit=false`，并降级为「整轮缓冲后一次发出」——邮件用户看到的东西不一定更少，只是晚一点。

**Q：同一个群里的多个 bot 会冲突吗？**
A：不会，只要 `bot_id` 进了 Conversation 键。这是 WeCom 已经面对的现实。

**Q：通道会话的权限为什么自动批准？**
A：因为它无人值守。等审批就等于不跑。代价是安全面，所以白名单是必需的。

**Q：为什么白名单不放进内核？**
A：因为准入规则是渠道自己的配置（私聊/群/发件人），内核没有 policy 这一层。统一 policy 是后续的事。

**Q：一条消息发到企微，桌面端为什么看不到？**
A：可能是走了 introspect 旁路（`POST /send-wecom`）。那条路完全不进 session，所以系统里查无此物。这是要收编的三条路之一。

**Q：`pending_question` 能用吗？**
A：不能。它整套是死的，零调用方。接上还是删掉需要先定。

**Q：一个渠道可以跑多个 bot 吗？**
A：可以，WeCom 已经如此。所以 `bot_id` 必须在会话键里。

**Q：邮件怎么保证不重复建 session？**
A：靠 `In-Reply-To` / `References` 链归位到同一线程。回复不带 `In-Reply-To` 就会断线程。

**Q：消息去重和排队器是一回事吗？**
A：不是。去重是幂等（同一条不处理两次），排队器是体验（连发合成一轮）。

---

## 21. 附录 I：术语

| 术语 | 含义 |
|---|---|
| 驱动 / driver | 渠道协议实现（`ChannelDriver`） |
| 内核 / core | 唯一流水线（`apps/daemon/src/channels/core/`） |
| 归一化 / normalize | 把原生事件变成 `InboundMessage` |
| caps | 渠道能力声明 |
| 降级 | 无某能力时的替代呈现 |
| binding | conversation → session 的持久绑定 |
| 准入 | 白名单 / @ 规则 / 命令识别 |
| 写入服务 | 入库 + 广播 + 附件（#933） |
| FinalOnly | 非流式渠道的整轮缓冲发送 |
| 旁路 | 不经 session 的发送路径 |
| Multi-bot | 一个渠道多个 bot |
| IDLE | 邮件 IMAP 的空闲连接续期 |

---

## 22. 附录 J：与其它模块的关系

| 模块 | 交界 |
|---|---|
| 会话 | 通道消息创建/写入 session（共享写入服务） |
| Agent runtime | 通道 turn 走正常 runtime 生命周期 |
| 权限 | gateway 会话自动批准 |
| Cron | 共享写入服务；cron 的 delivery 复用渠道发送 |
| 团队 | 渠道配置按团队/工作区 |
| Remote tools | 不相关（那是 agent 驱动客户端的方向） |

一个值得记住的对称：**通道是「外部人 → agent」，remote tools 是「agent → 用户的浏览器」。** 两者都是跨越系统边界的桥，但方向相反。通道需要准入（防外部人乱用），remote tools 需要与会话参与者的 fail-closed 校验（防跨会话调用）。

---

## 23. 附录 K：加一个新渠道的实操

假设要接一个新的工单系统（Ticket）。按现有结构，要做七件事：

**一、在 `crates/teamclu-gateway` 写驱动。** 实现 `ChannelDriver`：`id`、`caps`、`run`（连接并把工单事件归一化成 `InboundMessage`）、`deliver`（把 `OutboundMessage` 发出）。如果需要媒体，加 `media_upload` 能力与上传实现。

**二、定义 Conversation。** 工单的会话单元是什么？一个问题 = 一个会话，还是「问题 + 后续回复」是一个会话？这决定了回复要不要带关联 id。**这是最重要的一步**——它决定了同一个人在工单系统里发两次会变成两个会话还是一个。

**三、写 config。** `ticket_config.rs`：API key、endpoint、轮询/Webhook 参数。凭据从哪读（workspace `teamclu.json` 还是 daemon 拥有）也是一个决定——WeCom/SeaTalk 是 daemon 拥有，其余多数读 workspace。

**四、声明 caps。** 工单系统能编辑消息吗？能发附件吗？有时延吗？这些决定了内核如何降级。

**五、加前端组件。** `components/settings/channels/Ticket.tsx` + `channels-types.ts` 的 config 类型与默认值 + `channels-store.ts` 的状态映射。

**六、加 feature flag。** `useFeatures().channels.ticket`，并确保在两个部署目标（self-host compose 与 `s.yaml`）都能配。

**七、加白名单。** 工单系统的准入规则是什么？谁可以开新会话？这在驱动/渠道侧，不在内核。

理想情况下，写完这七步，工单渠道就自动拥有附件、流式（如果 caps 允许）、去重、命令、i18n、排队。**如果一个能力需要写到驱动里才能生效，那说明它还没被内核收拢。**

---

## 24. 附录 L：排障手册

通道问题按这个顺序查：

**第一步：连上了吗？** 设置页的 `GatewayStatusCard` 说的是什么？connected / connecting / disconnected / error。

**第二步：消息进来了吗？** 如果是「发了但 agent 没反应」，区别在于：消息没进 daemon，还是进了但没触发 turn。看 daemon 日志里有没有入站记录。

**第三步：是不是被准入拦了？** 白名单、群 @ 规则、命令识别都可能把消息拦在 turn 之前。看起来像「没反应」。

**第四步：重复了吗？** 双重回复 → 去重失效。检查 `(channel, external_message_id)` 有没有稳定写入。

**第五步：回复去哪了？** 三种可能：

| 现象 | 可能原因 |
|---|---|
| 发出去了但系统里没有 | 走了旁路（introspect / MCP send） |
| 系统里有但没发出去 | 出站失败，看驱动错误 |
| 两者都有但不一致 | 写入与发送顺序反了 |

**第六步：流式断了吗？** 流式断但终帧到了，是正常降级；终帧丢了，气泡收不了口——那是事件泵的问题。

一个建议：报障时带上「渠道 + conversation id + external message id + run id」。这四个能把问题定位到具体一条消息、一轮、一个会话。

---

## 25. 附录 M：三条不变量

1. **所有出站必须经过 session。** 旁路产生「系统里查无此物」的消息，是最难排查的一类问题。
2. **能力差异用 caps 表达，降级规则写一次。** 不要在渠道里分支。
3. **准入留在渠道，不统一进内核。** 一起删等于把机器人对所有人敞开。

再加一条历史教训：**「两套并存」不只是维护成本。** WeCom/飞书的 inline 死代码里藏着一条未净化的 bucket key，那是一次真实 bug 的同一份代码。删干净比以为自己删干净重要得多。

---

## 26. 附录 N：为什么当初各写各的

这个结构不是一开始就这样设计的。理解它是怎么长出来的，能避免再犯同一个错。

**第一阶段：一个渠道。** 先接的是 WeCom，因为它功能最全。那时候没有「驱动」的概念，就只有「WeCom 接入」。代码写得很好——加密、重连、媒体、卡片、多 bot 全都做了。问题在第二阶段才显现。

**第二阶段：接第二个渠道。** 接飞书时，最自然的做法是「照着 WeCom 写一遍」。于是连接、去重、流式、附件的代码被复制了过去，但**只复制了当时需要的部分**——飞书只做了文本，因为「先上文本，其它以后再说」。那个「以后」没有来。

**第三阶段：能力随机分布。** 邮件接入时又写一遍，而邮件的情况与 IM 截然不同（线程、身份不可信、分钟级时延），于是又是一套新代码。到这一步，三个渠道已经三套实现，能力各不相同。表面上「都能收发消息」，实际上：

- 同一个人在不同渠道看到的东西不一样（同一个 session）；
- 新接渠道的人看到三份代码，不知道哪个是最佳实践；
- 修一个 bug（比如附件路径校验）要在三个地方各修一次，而且容易漏一个。

**第四阶段：抽象。** 现在这个设计。核心判断是：**「渠道差异」其实是有限的、可枚举的**——连接方式、消息格式、能力上限、准入规则。既然有限，就可以用一个窄接口把它关起来，而把剩下的（去重、写入、路由、降级）做成共享的。

教训：**当第二个实例出现时，就要问「这两个的差异是不是可枚举的」。** 如果可枚举，就现在抽象；等第三个出现，成本就已经付了三次。

这条与仓库里的其它历史是同一个模式：知识库的同步前缀从 6 个收敛到 2 个；runtime 从 4 个收敛到 1 个；会话写入从多套收敛到 1 个。每一次都是「先让它能跑，再让它只有一个」。

---

## 27. 附录 O：变更记录

| 变动 | 影响章节 |
|---|---|
| 新接一个渠道 | 7、23 |
| `pending_question` 接上或删除 | 9、20 |
| introspect 旁路收编 | 5、24 |
| 排队器超时改成随 caps | 17 |
| 邮件身份要求 DKIM/SPF | 8 |
| 统一 policy 层落地 | 8 |
| 附件生命周期确定 | 15 |
| 新能力加入内核 | 3、16 |

一条写作约定：渠道这块的文档最容易变成「我们支持哪些渠道」。要写成「渠道之间差异是什么、内核如何统一它们」——因为前一个问题用户自己就能看设置页知道，后一个问题才是接手的人真正需要的。

---

## 28. 附录 P：失败与重试

通道的失败模式比想象的多，每一种都有不同的处理方式：

| 失败 | 处理 |
|---|---|
| 平台 API 临时 5xx | 重试（指数退避） |
| token 过期 | 刷新后重试一次 |
| 频率限制 | 退避 + 丢中间帧（流式） |
| 网络断 | 驱动自己重连（`run` 负责） |
| 发送成功但入库失败 | **不能发生**——顺序保证了先入库 |
| 入库成功但发送失败 | 记录失败，可重试；system 里有痕迹 |

**「发送成功但入库失败」是不能接受的。** 这正是「先入库再发送」这条顺序存在的意义。反过来的顺序会让消息成为幽灵。

一个与 cron 共享的问题：**发送失败要重试吗？** 对于「主动推送」（cron 结果），重试可能导致重复发送；对于「回复用户」（通道），重复发送比不发好。这个差异需要按场景决定，不能全局统一。

---

## 29. 附录 Q：渠道配置的存储

渠道配置存在哪里，是一个容易被忽视但影响权限的决定：

| 存储位置 | 适用渠道 | 含义 |
|---|---|---|
| workspace `.teamclu/teamclu.json` | 多数 | 随工作区，成员自己配 |
| daemon 拥有 | WeCom、SeaTalk | 携带自己的凭据，不依赖 workspace |

第二种的原因：WeCom 与 SeaTalk 是 amuxd 拥有的，它们必须能够在一个**没有 `teamclu.json`** 的 workspace 上工作。如果走 `read_teamclu_config`，一个没有配置文件的 workspace 会让一个根本不需要它的发送失败。

有一个细节值得记：Cron 的 delivery 在发送时**每次重新读配置**（`teamclu.json`），所以改了频道设置不需要重启。这是一个小但重要的选择：配置改了立即生效，而不是需要重启 daemon。

---

## 30. 附录 R：与 Cloud API 的关系

渠道本身不直接调 Cloud API——它读写 session 是通过 daemon 的写入服务。但有两处交叉：

1. **feature flag**：`useFeatures().channels` 从 Cloud API 来，控制哪些渠道在 UI 里可见；
2. **凭据**：部分渠道的配置存在 Cloud API（团队级）。

一个容易混淆的边界：**渠道不是「另一种客户端」。** 它不登录、不持有用户 token，它是一个 daemon 侧的服务，用团队身份与 agent 身份工作。所以它不需要 Cloud API 的登录态，只需要团队绑定与 agent 绑定。

---

## 31. 附录 S：设计检查清单

改通道网关时，最少问这几个问题：

1. 新能力是放在内核还是驱动？如果每个渠道都要写一遍，说明它该进内核。
2. 能力差异用 caps 表达了吗？有没有出现 `if channel == "email"` 这种分支？
3. 降级规则写了一次还是每个渠道一次？
4. 出站只有一条路吗？有没有新的旁路？
5. 写入在 turn 之前吗？
6. 去重键稳定吗？（`channel + external_message_id`）
7. 白名单还在吗？删除它等于对所有人敞开。
8. 排队器超时对非 IM 渠道成立吗？
9. 新增的 Conversation 差异有没有进 `Conversation` 类型？
10. 新渠道的 feature flag 在两个部署目标都能配吗？

这份清单的每一项都对应一个曾经的真实问题。新增渠道时为了「快」跳过某一项，代价会在几周后以「某个渠道少了某个能力」的形式出现，而那时已经很难追溯是当初哪一步省的。

---

## 32. 一个总结：传输、内核、准入

把整篇压缩成三个词：

**传输。** 渠道只做传输。它把平台的差异（加密、token、MIME、IDLE）消化掉，向上只暴露一个归一化的 `InboundMessage` 和一个 `deliver`。

**内核。** 能力属于内核。去重、路由、身份、写入、turn、流式、附件、降级只写一次，所有渠道共享。渠道差异用 `caps` 表达，不用名字分支。

**准入。** 准入留在渠道。白名单、@ 规则、发件人校验形态不同，不能统一；一起删等于把机器人对所有人敞开。

这三个词对应三种不同的抽象边界。做对了，接新渠道是几百行；做错了，每个渠道都是一份从零开始的实现，能力随机分布。

这块历史留下的三条教训比抽象本身更值得记：**旁路最难查**（发出去但系统里没有）、**两套并存会藏 bug**（死代码里的未净化 key）、**代码存在不等于功能存在**（pending_question 是死的）。这三条在任何模块里都适用。

---

## 33. 附录：一个可以复用的判断

这篇的核心判断可以压缩成一句：**「这个差异是有限的还是无限的？」**

- 渠道差异是有限的：连接方式、消息格式、能力上限、准入规则。所以它可以被一个窄接口关起来。
- 会话语义差异是有限的：会话单元、身份可信度、一轮边界。所以它可以被一个 `Conversation` 类型表达。
- 能力差异是有限的：能不能流式、能不能发媒体、能不能交互。所以它可以被 `caps` 表达。

反过来说，任何看起来「无限」的差异，通常是因为它在同一个维度上被重复枚举了。比如「每个渠道自己写一遍附件逻辑」看起来是无限的，因为每接一个渠道就多一份；但一旦抽出「附件是输入、caps 是能力」，它就变成有限的了。

一个实用的方法：当发现自己在写 `if channel == ...` 时，停下来问「这个分支能不能变成一个字段」。绝大多数时候可以。

---

## 34. 附录：一句话总结

如果把整篇压成一句话：**渠道只做传输，能力属于内核，准入留在渠道。**

三句话分别对应三个抽象边界：驱动（协议）、内核（公共能力与降级）、policy（准入）。把驱动做窄，把内核做全，把准入留在最了解它的地方。

做对了，接新渠道是几百行；做错了，每个渠道都是一份从零开始的实现，能力随机分布。这块的历史正是从后者走到前者。

---

## 35. 附录：最后三条提醒

**一、不要用渠道名分支。** 用 `caps`。这是这块最容易退化的地方。

**二、不要新增旁路。** 所有出站经过同一个入口，否则会产生「系统里查无此物」的消息。

**三、删除要删干净。** 两套并存不只是维护成本，死代码里可能藏着真实的安全面。

三条都是这块历史付过代价的教训。

---

## 36. 附录：三句话的速记

1. 渠道只做传输。
2. 能力属于内核，用 caps 表达差异。
3. 准入留在渠道。

---

## 37. 附录：读完这篇应该能回答的问题

- 新接一个渠道最少要写什么？驱动 + config + 前端组件 + flag + 白名单。
- 为什么邮件没有流式？因为 SMTP 不能改已发出的邮件，内核降级为整轮缓冲。
- 为什么通道会话自动批准权限？因为无人值守。
- 为什么白名单不在内核里？因为准入形态不同，且一起删等于对外敞开。
- `pending_question` 能用吗？不能，它是死的。

---

## 38. 结语

通道网关切的是**抽象边界**：把「渠道差异」压缩成几个 caps 字段，把「会话语义」压缩成一个 `Conversation` 类型，把「出站」压缩成一条流水线。做对了，接新渠道是几百行；做错了，每个渠道都是一份从零开始的实现，能力随机分布。这块的历史正是从后者走到前者，而它留下的教训——旁路最难查、两套并存会藏 bug、死代码也是安全面——比抽象本身更值得记住。
