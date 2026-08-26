# ESP32 语音终端收编为渠道驱动

> 承接 `2026-08-18-gateway-transport-architecture.md`。那份文档把渠道退回传输
> 驱动;这份把 ESP32 也退回去。

## 1. 现状:两条平行的流水线

内核只有一份实现(`apps/daemon/src/channels/core/mod.rs`):

```
dedup → addressed? → command? → identity → route → command? → write → turn → render
```

WeCom 与飞书已经收编(`crates/teamclu-gateway/src/{wecom,feishu}.rs` 各自
`impl ChannelDriver`)。**ESP32 没有**。它从 `voice/mic` 到 agent 自建了一条链路
(`apps/daemon/src/voice/`),把这七步要么重写了一遍、要么根本没有:

| 内核能力 | 渠道 | ESP32 今天 |
|---|---|---|
| 去重 | `DedupStore` | 无 |
| 会话路由 | `SessionRouter`(云端绑定) | `ChatSink` 自己的 `HashMap`,内存,重启即失忆 |
| 身份 | `IdentityMapper` | 无,消息挂在设备 actor 上 |
| slash 命令 | `CommandRunner` | 无 |
| 交互提问 | `InteractiveQuestion` | **无,而且被主动关掉了** |
| i18n | `Locale` | 无 |
| 排队 / 超时 | `session_queue` + caps | `SpkConfig::idle_timeout` 一个常量 |

这正是那份 spec 开篇批评的"每个渠道都是一份从零开始的实现"。

### 1.1 已经付过的学费

2026-08-25 的真机联调里,agent 调用 `question` 工具向用户提了一个带三个选项的
澄清问题。语音链路没有任何地方能承接它,turn 就此挂住不结束,会话保持
"正在处理",**后续每一轮都被 `SessionBusy` 拒绝**,设备连续显示"电脑没醒着"。

当时的处理是给语音会话打开 full access,让这类阻塞提问**一律自动取消**
(`PermissionPolicy::Full` → `auto-cancel full-access pi question`)。

那不是修复,那是把能力关掉。内核里 `InteractiveQuestion { question_id, prompt,
options }` 和 `pending_question.rs` 都是现成的 —— 如果 ESP32 是个渠道,那次会在
设备屏幕上渲染成一个菜单。**这份文档存在的直接原因就是这件事。**

## 2. 目标与非目标

**目标**:ESP32 成为一个 `ChannelDriver`,自动获得去重、云端会话、身份、命令、
交互提问、i18n、排队;语音编解码留在驱动内部。

**非目标**:
- 不把 Opus 帧推进内核。内核只看见文本。
- 不改语音传输协议(`voice/{mic,spk,ctl}` topic、Opus 16k/20ms/24kbps 保持不变)。
- 不动 `commands.rs` 已经收拢的命令层。

## 3. 接缝划在哪里

**唯一的核心决定**:驱动的边界是"**最终转写进,文本出**"。

```
voice/mic 帧 ─→ STT 流 ─→ 最终转写 ──→ InboundMessage { text }
                                            │
                                     Core::handle(七步)
                                            │
voice/spk ←─ Opus ←─ TTS ←─ 句子切分 ←──  deliver / update
```

流式 STT、NLS 协议、`SentenceChunker`、Opus 编解码、节拍发送 —— 全部留在
`Esp32Driver` 里,和企微加密、飞书 token 刷新留在各自驱动里是同一个理由:
**那是传输细节,不是能力**。

上行天然对得上:内核要的是完整文本,而 STT 的 final 事件正好产出完整文本。
下行靠 `streaming_edit` 对上,见 §4.3。

## 4. `Esp32Driver` 的形状

### 4.1 `caps()`

```rust
ChannelCaps {
    streaming_edit: true,   // 见 4.3:"编辑"= 接着往下播
    media_upload:   false,  // 设备没有文件系统可言
    interactive:    true,   // 屏幕能画菜单,表冠能选 —— 第 1 节那笔学费
    threading:      Threading::Inline,
    max_chars:      0,      // 不切分:朗读没有"消息长度"这个概念,见 4.4
    turn_timeout_secs: 60,  // 设备本地 8s 就放弃了,见 §7.2
}
```

`max_chars: 0` 需要内核支持"不切分"的含义,今天是硬上限。要么给 0 赋予这个语义,
要么设一个大到不会触发的值 —— 前者更诚实,是个小改动。

### 4.2 绑定与身份

```rust
fn binding(&self, c: &Conversation) -> String   // "esp32://{team_id}/{actor_id}"
fn sender_urn(&self, ..) -> String              // "esp32:{device_id}"
fn session_title(&self, ..) -> String           // "StopWatch {device_short}"
```

一台设备 = 一个 `Conversation`(`kind: Direct`),因为一台设备就是一个人在说话。

绑定串里放 `actor_id` 而不是设备 MAC:设备重刷固件后 MAC 不变但配对可能换团队,
而 `actor_id` 是配对这件事的产物,换团队就换绑定 —— 这正是我们想要的。

**这一条顺带修掉重启失忆**:`SessionRouter::resolve` 查的是云端会话绑定,不是
`ChatSink` 那张内存表。会话跨 daemon 重启存活,`ChatSink` 及其 `HashMap` 一起删除。

### 4.3 `deliver` / `update`:把"编辑"读成"接着播"

内核对流式渠道的调用序列是:`deliver` 一次,然后随着回复变长反复 `update(id,
全量文本, end)`。语音没法"编辑"已经播出去的话,但可以**只播新增的部分**:

```
deliver(text)          → 开 TTS 流,记住已播游标 = 0,播 text,游标 += len
update(id, text, None) → 播 text[游标..] 中已成句的部分,游标前移
update(id, text, Some(end)) → 播完剩余,收尾静音,发 spk_end ctl
```

`SentenceChunker`(今天在 `voice/spk.rs`)原样搬进驱动,它就是这个渲染策略。
`TurnEnd::NoAnswer` 对应"agent 什么都没说",设备该显示错误脸而不是静默 —— 今天
`frames=0` 时设备只能干等到本地超时。

### 4.4 `InteractiveQuestion` → 设备菜单

`OutboundMessage.question` 非空时,驱动不朗读选项列表(念三个选项既慢又记不住),
而是下发一条新的 ctl:

```json
{"type":"menu","question_id":"...","prompt":"...","options":["A","B","C"]}
```

设备渲染成列表,表冠滚动、A 键确认,选中后回一条
`{"type":"menu_reply","question_id":"...","index":1}`。驱动把它变成一条
`InboundMessage`(text = 选项文本),走 `pending_question.rs` 已有的应答路径。

**prompt 仍然朗读**,选项只上屏 —— 语音说"你是想 A、B 还是 C"是自然的,逐条念
选项不是。

## 5. 入站:谁把话送进内核

初稿只写了"最终转写进",没写**谁在进** —— 这是最大的缺口,因为
**`ChannelDriver` 是只出不进的**:

```rust
trait ChannelDriver { id, caps, binding, sender_urn, session_title, deliver, update }
```

入站是另一条路,由 gateway crate 定义、daemon 实现:

```rust
pub trait InboundSink { async fn accept(&self, msg: InboundMessage); }
```

`CoreSink`(`channels/core/sink.rs`)实现它,并且挂着一个 `SessionQueue`。
所以收编后的形状是:

```
voice/mic ─→ Esp32Listener ─→ STT ─→ InboundMessage ─→ CoreSink::accept
                  │                                          │
             (订阅、Opus 解码、                          SessionQueue
              流式转写、intent 分流)                          │
                                                       Core::handle
```

`Esp32Listener` 就是今天 `VoiceRouter` 的位置,职责收窄:**只负责把音频变成一条
消息**,不再做会话路由、不再管权限、不再直接调 runtime。它住在 daemon 侧
(需要 MQTT 与 STT 凭证,两者都是 daemon 的东西),驱动住在 gateway crate。

### 5.1 `InboundMessage` 逐字段

| 字段 | 取值 | 说明 |
|---|---|---|
| `conversation` | `{ channel: "esp32", bot_id: None, kind: Direct, id: actor_id }` | 一台设备一个会话 |
| `sender` | `{ external_id: device_id, display_name: 设备名, email: None }` | |
| `external_message_id` | 见 §5.2 | 去重键 |
| `text` | STT 最终转写 | |
| `attachments` | 空 | 设备不传文件 |
| `addressed_to_bot` | **恒 `true`** | 按下按钮就是在跟它说话,没有"@" 这个概念,和邮件同理 |
| `quoted_text` | `None` | |
| `reply_context` | `None` | 回复走 `voice/spk`,与入站请求无关 |

### 5.2 去重键:不能用 ctl 的 `seq`

去重是收编的头号收益,但键必须选对。**设备的 `seq` 不行** ——
`net/voice_ctl.h` 写得很清楚:

> Monotonic per-boot counter … **It resets across a reboot**: amuxd must not
> assume the sequence is globally unique.

重启后 seq 从 1 重来,会和上一次开机的消息撞。键定为:

```
esp32:{device_id}:{boot_id}:{seq}
```

`boot_id` 由设备开机时随机生成一次(4 字节十六进制足够),放进 `turn_start` ctl。
这是**固件要改的一处** —— 记在这里,免得迁移时才发现。

### 5.3 排队语义:设备不排队,第二次按键就是打断

`SessionQueue` 的默认行为是:turn 进行中来了新消息就**排队**,并且
`CoreSink` 会**向会话发一条通知**("排在第 N 位"、"队列满了"、"超时了")。
对聊天窗口这是对的;对语音设备,这些通知会被**朗读出来**,而用户只是想重新问一次。

**决定:ESP32 不排队。** 队列深度 1,turn 进行中的第二次按键**取消当前 turn**
并开始新的一轮 —— 这与 §7.1 的打断是同一个动作,只是触发方式不同(说话打断 vs
按键打断)。理由:PTT 设备只有一个用户,一个用户不会想排自己的队;他按第二次,
意思就是"不是这个,重来"。

代价:队列的三条通知文案(`MsgKey::QueueFull` / `QueueTimeout` /
`GatewayShuttingDown`)在这个渠道上永远不会触发。这是有意的,不是漏了。

### 5.4 中间态与错误:内核不管,驱动管

内核只给 `deliver` / `update`(纯文本)。而设备靠 ctl 切脸,今天有六种:
`error` / `thinking` / `spk_start` / `spk_end` / `session` / `note_saved`。
这些**不来自内核**,归属如下:

| ctl | 谁发 | 时机 |
|---|---|---|
| `thinking` | `Esp32Listener` | `accept()` 之后立刻发,不等内核 |
| `session` | 驱动 | 首次 `deliver` 时带上 `SessionRouter` 解析出的 id |
| `spk_start` / `spk_end` | 驱动 | TTS 流开始 / `TurnEnd` 到达 |
| `error` | 驱动 | `Core::handle` 返回 `Err`,按 §5.5 映射 |
| `note_saved` | `NoteSink` | 不经内核(§7.3) |

`thinking` 由 listener 而不是驱动发,是因为它必须**先于**内核的任何步骤 ——
用户松手就该看到 Thinking 脸,不该等云端写入和会话解析。

### 5.5 错误映射

`CoreError` 五个变体 → 设备 `ErrorKind` 四类:

| `CoreError` | 设备 | 屏幕文案 |
|---|---|---|
| `Route` / `Identity` / `Write` | `NoBroker` | 连不上服务器 |
| `Turn` | `NoAgent` | 电脑没醒着 |
| `Render` | `Upstream` | 它那边出错了 |

`Render` 归 `Upstream` 是因为在这个渠道里 render 就是 TTS,失败的是厂商那边。

### 5.6 部分转写留在 listener 内

流式 STT 的中间结果永远到不了内核(内核只接完整文本)。如果以后要在设备上边说
边上屏,那是 `Esp32Listener` 直接发 ctl 的事,与内核无关 —— 这个能力不会因为收编
而失去,但也不会因为收编而获得。

### 5.7 测试

内核已经有 `FakeDriver` + `channels/core/tests.rs`,驱动侧照做。listener 侧需要
一个不碰真硬件的注入点:今天 `VoiceRouter` 已经能接假的 `SttProvider` /
`TtsProvider`,那套沿用即可。

**验收测试至少要覆盖**:重复的 `external_message_id` 只跑一轮;turn 进行中的第二
次 `turn_start` 取消前一轮而不是排队;`Core::handle` 返回 `Err` 时设备收到对应
`error` ctl 而不是静默。

### 5.8 回滚

第 1 步(§8)把入站整条换掉,不是加法。保留 `VoiceRouter` 的旧路径一个版本,由
`[channels.esp32] use_core = true|false` 选择,默认 `false` 直到第 3 步验收通过。
两条路共用同一个 `Esp32Listener` 前半段(订阅 + STT),分叉点在"转写出来之后":
旧路径进 `ChatSink`,新路径进 `CoreSink::accept`。

分叉点选在这里,是因为它是两条路唯一真正不同的地方 —— 前面的音频处理没有理由
写两份。

## 6. 配对:ESP32 作为 channel 配置

今天设备靠**手工粘贴一个 JWT** 进配网页(`main/net/device_token.h` 里写明了这是
临时方案)。

**握手不用新设计** —— 计划 §8.1 已经定过,而且形状正是"生成一个码、设备填进去",
配网页那个输入框原地改用途即可:

```
1. amuxd 生成码           POST /v1/devices/pairing-codes   (amuxd 自己的 token)
                          { code, teamId, actorId, ttlSeconds: 600 }
                          桌面把码显示给用户
2. 设备配网页收 SSID + 密码 + 配对码  → NVS
3. 设备联网后向 FC 兑换   POST /v1/devices/redeem          (免鉴权,限流)
                          { code, deviceId, model, fw }
                          → 200 { deviceSecret, teamId, actorId },码即焚
4. 稳态                   POST /v1/devices/token { deviceSecret } → 短效 MQTT JWT
```

码由 **amuxd** 而不是 FC 生成:amuxd 已经持有后端 token,并且知道该绑到哪个
team / actor 上;FC 只负责兑换与限流。

**这对 channel 配置的影响是简化,不是增加。** 设备兑换后自己持有 `deviceSecret`
并自行换取短效 JWT,所以 team.toml 里**不需要存任何密钥**,只需要一份名册:

```toml
# teams/<id>/state/team.toml
[channels.esp32]
enabled = true

[[channels.esp32.devices]]
device_id  = "c19518"          # 设备自报,MAC 后六位
name       = "工位 StopWatch"
paired_at  = "2026-08-26T10:00:00Z"
```

没有 `token` 字段,也就不需要 `secrets.enc` 那条路 —— 比初稿少一个密钥要保管。
名册的用途是显示与管理(改名、解绑),不是鉴权;鉴权在 EMQX 那边靠 JWT。

**现状:一行都没实现。** FC 没有任何 `/v1/devices/*` 路由,计划 §8.1 原文写着
"FC has **no device-auth concept at all**"。这是第 4 步的全部工作量,不是接线。

## 7. 三个塞不进去的,以及怎么办

### 7.1 打断(barge-in)

驱动模型里没有"取消进行中的 turn"。设备的 `barge_in` ctl 需要两件事:
停掉本地 TTS 流(驱动内部,不关内核),以及取消 runtime 的 turn(需要一条路)。

**建议**:不给 `ChannelDriver` 加方法。驱动直接持有 `RuntimeAdapter::cancel` 的
句柄,和它持有 TTS 客户端一样 —— 打断是传输层对传输层的动作,内核不必知道。
代价是驱动多一个依赖;好处是内核不长出语音细节。

### 7.2 延迟预算 —— 已量,不成立

初稿把这条列为开工前的阻塞项。量完之后它不是。

**2026-08-26 实测**:

| 环节 | 实测 |
|---|---|
| Cloud API 热连接往返(daemon 用连接池,不逐次握手) | ~20 ms |
| `amux.messages` 真实 INSERT(事务内,回滚) | ~8 ms |
| **`write_inbound` 合计** | **约 30 ms** |

对照真机一轮的实际分解(设备侧毫秒):

```
turn_end ─── 658ms ──→ ctl session ─── 2633ms ──→ 首帧音频
                                                    合计 3291ms
```

30 ms 是 3291 ms 的 **0.9%**;即使对着计划 §9 的 600–1100ms 目标,也只有 3–5%。

真正的开销是那 2633 ms 的 **agent 思考 + TTS 首帧**,与本次收编无关,也不会因为
收编而变化。结论:**照内核的规矩把写放在 turn 之前,不要为语音开特例。**

留一条给将来:如果哪天首帧压到了几百毫秒,30 ms 才开始有讨论价值。到那时该谈的
也不是"跳过写入",而是给 caps 加一个延迟敏感维度 —— 但今天没有依据这么做。

### 7.3 笔记模式

`intent=note` 不是一次 turn,是一次存储。它**不该进 `Core::handle`**。驱动在入站
分流时就分开:`Chat` 走内核,`Note` 直接走 `NoteSink`(今天的实现原样保留)。

这不是妥协,是分类正确:内核处理的是"消息变成一轮对话",笔记不是对话。

## 8. 迁移顺序

0. **固件先行**:`turn_start` 带上 `boot_id`(§5.2)。这是整个迁移里唯一的固件
   改动,而且必须**先于**服务端 —— 去重键少了它就会在设备重启后撞。一行 JSON
   字段,但要重刷才生效,所以排在最前面。
1. **入站 + 驱动骨架**:`Esp32Listener`(由 `VoiceRouter` 收窄而来)构造
   `InboundMessage` 送进 `CoreSink::accept`;`Esp32Driver` 实现 `binding` /
   `sender_urn` / `session_title` / `deliver`。此时下行仍是一次性 `deliver`
   (不流式),验证会话、身份、去重、命令全部到位。
   由 `use_core` 开关控制,默认关(§5.8)。
   **验收**:`/help` 在设备上有回应;daemon 重启后上下文不丢;同一条
   `external_message_id` 重放只跑一轮。
2. **下行流式**:打开 `streaming_edit`,`SentenceChunker` 搬进驱动。
   **验收**:首句播放时刻不晚于今天。
3. **菜单**:`InteractiveQuestion` → `menu` ctl,设备端渲染 + 回选。
   **验收**:撤掉语音会话的 full access,agent 的 `question` 能正常收到答案。
4. **配对入配置**:`[channels.esp32]`,退掉手工粘 token。
5. **拆旧路**:`use_core` 默认改为开,一个版本后删掉开关与 `ChatSink`(§10)。

每步可独立上线。第 3 步完成时,第 1.1 节那笔学费才算真正还上。

## 9. 风险与未决问题

1. ~~**延迟**~~ —— 已于 2026-08-26 量清,不成立,见 §7.2。记在这里是因为它曾经是
   本文的阻塞项:`write_inbound` 约 30 ms,占首帧 3291 ms 的 0.9%。**开工不再被
   这一条挡住。**
2. **设备本地 8s 超时**(`AgentTimeoutMs`)与 caps 的 `turn_timeout_secs` 是两个
   独立的钟,今天已经打过架(agent 想事情超过 8 秒,设备就报"电脑没醒着")。应该
   由内核把有效超时下发给设备,而不是固件里写死。
3. **`max_chars: 0`** 需要内核赋予"不切分"的语义(§4.1)。
4. **ESP32 插队**。原 spec 的顺序是 WeCom → 飞书 → 邮件 → 其余,而 ESP32 是所有
   渠道里最不像 IM 的。它会最先撞上"内核的 IM 假设",这既是风险也是价值 ——
   但要清楚这是在替后面的渠道探路。
5. **稳定性前置**。语音链路 2026-08-25 才第一次跑通完整闭环。在未稳的东西上做
   架构迁移,失败时分不清是迁移引入的还是原有的。已知未修:会话闲置 30 分钟失效、
   设备 3 分钟进 lightsleep 掉线、"三次点击"链条(会话过期 → 错误屏 → 按键被
   消费)。**建议这几项先清掉。**

## 10. 迁移完成后可以删除

- `apps/daemon/src/voice/chat_sink.rs` 整个(含那张内存 `HashMap` 和 `forget()`)
- `voice/adapter.rs` 里的会话路由与 `FanOutSink` 分流(改由驱动分流)
- 语音会话的 `PermissionPolicy::Full` 特例 —— 有了菜单,`question` 不再需要被取消
- `CreateSessionParams.permission` 这个 `serde(skip)` 字段,如果没有别的调用方
