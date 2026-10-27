# 微信（iPad 协议）渠道 `wechatpad`

用自部署的 iPad 协议服务端，把一个**个人微信小号**接成网关渠道。它和 iLink 的 `wechat` 渠道是两个独立的平台：线协议、配置、绑定 URI 都不共用，iLink 那边一行未动。

| | iLink `wechat` | iPad 协议 `wechatpad` |
|---|---|---|
| 来源 | 官方 ClawBot / iLink | 第三方逆向协议，闭源镜像 |
| 会话 | 只有私聊 | 私聊 + 群聊（@、/命令、引用 bot） |
| 风险 | 无 | **账号可能被限制**，只用小号 |
| 部署 | 无 | 服务端容器跑在 amuxd 同一台机器上 |

## 部署

1. 运行协议服务端（只绑定 loopback，自带独立网络）：

   ```bash
   REDIS_PASSWORD=$(openssl rand -hex 12) docker compose -f deploy/wechatpad/docker-compose.yml up -d
   ```

   `houhou/wechat-ipad:latest`（协议 8.0.59）没有付费授权码会直接 panic，要用 `wechat-ipad-8074`。镜像只有 amd64。
2. 登录小号：`python3 scripts/wechatpad-login.py`。它在本地生成二维码（**不用**服务端返回的 `QrUrl`，那个地址指向第三方站点，会把登录 uuid 发出去），扫码确认后打印 `account_wxid`、`login_at` 和 `device_id`。之后每次重新登录都要带上 `--device-id`，换设备 ID 会被风控当作新设备。
3. 设置 ▸ 渠道 ▸ 微信（iPad 协议）：填 wxid，把自己的 wxid 加进白名单，然后启用。

服务端和它的登录态比 amuxd 活得长：重启 daemon 或重载渠道不会让账号掉线。`start()` 只会接回服务端已经持有的会话（`GetContractProfile` → 必要时 `LoginTwiceAutoAuth` → `AutoHeartBeat`），从不弹二维码。

## 配置（`team.toml` 的 `[channels.wechatpad]`）

| 字段 | 默认 | 说明 |
|---|---|---|
| `server_url` | `http://127.0.0.1:3010` | 协议服务端 |
| `callback_port` | `9101` | 服务端推送到 `127.0.0.1:<port>`，要和 compose 的 `WECHAT_CLIENT_HOST` 一致 |
| `account_wxid` | — | 小号的 wxid；它自己的消息会被推回来，靠这个丢弃 |
| `login_at` | — | 上次扫码登录的 unix 秒；之后 48 小时内发送更保守 |
| `dm_policy` | `allowlist` | `allowlist` \| `open` |
| `allow_from` | `[]` | 允许与 agent 对话的 wxid（私聊和群里都用这份） |
| `group_policy` | `allowlist` | `allowlist` \| `open` \| `disabled` |
| `group_allow_from` | `[]` | 允许的 `…@chatroom`；`allowlist` 下为空表示任何群（发送人仍需在 `allow_from`） |

两个策略默认都是 `allowlist`，因为网关会话会自动批准工具调用：白名单是陌生人和 agent 之间唯一的一道闸。没有密钥字段，服务端只在 loopback 上可达。

## 行为

- **入站**：服务端每次同步都 POST 到回调端口。驱动的处理顺序：丢掉系统消息（51 / 9999 / 10000 / 10002）和文件上传占位（appmsg 74）→ 丢掉早于本次启动的消息（登录会重放历史）→ 丢掉账号自己发的 → 策略判断。去重键是 `NewMsgId`，服务端重推同一条时由核心去重。
- **群里的消息全部记录，只有 @ 才回复**：被允许的群（`group_policy` + `group_allow_from`）里，**所有成员**的文本、图片、文件都会写进这个群的 session。没有指向 bot 的消息不会启动 turn，而是放进静默队列；下一次被 @ 的 turn 会把它们作为 `[Context …]` 前缀读进去（和 app 会话里静默消息的格式一样），带的图片也一并交给 agent，最多 8 个，取最新的。
  - 什么算“对 bot 说话”：`<atuserlist>` 里有 bot、以 `/` 开头，或者引用了 bot 的消息。@ 前缀会被剥掉，按 U+2005 切分（微信在 @昵称 后面加的不是普通空格）。
  - 谁能触发回复，仍然看现有设置：`allowlist` 下只有 `allow_from` 里的人 @ 才会触发，`open` 下群里任何人都可以。其他人的消息照样记录，但不会触发 turn。
  - 实现分三层：驱动的 `ChannelDriver::records_unaddressed()` 返回 true（其他渠道默认是 false，行为不变）；核心的 `record_silent` 负责去重、确定身份、路由会话、写入（带附件），然后调用 `TurnRunner::queue_silent`；`AmuxdAgentHandle` 按会话保存静默队列（每个会话最多 200 条，不会因为 runtime 被回收而丢失，但 daemon 重启后会清空），在 `run_turn` 时取出作为前缀。推送按到达顺序逐条处理，所以“先发图、再 @ 问图”时图一定会先入队。
- **群成员用真名**：每个群第一次出现时调用 `Group/GetChatRoomMemberDetail` 拉成员列表（优先群昵称，没有就用微信昵称），同时调用 `Friend/GetContractDetail` 取群名。session 标题、消息发送人、agent 读到的上下文都会显示名字，不再是 `wxid_…`。成员列表缓存 30 分钟；如果有不认识的人发言会刷新，但每 60 秒最多刷新一次。私聊的名字仍然取自 `PushContent`。
- **拍一拍**：解析 10002 系统消息里的 `<sysmsg type="pat">`，其他系统消息（撤回、入群模板等）仍然丢弃。拍 bot 等同于 @ 它，会触发回复，正文写成“（亮亮 拍了拍你的脑袋）”，“的脑袋”就是对方设置的拍一拍后缀。谁拍了谁的其他组合只会记录下来，作为静默上下文。能不能触发回复，规则和 @ 一样。
- **群里回复会引用原消息**：入站消息的 `reply_context` 是一段 JSON `QuoteRef`，包含 svrid、发送人、显示名、原文前 200 字。在群里回复时，回复的第一段用 `SendApp type 57` 引用原消息发出，长回复后面的部分仍是普通文本。私聊不引用，因为只有两个人。拍一拍不是聊天消息，所以对它的回复不引用。
- **入站图片和文件**：图片通过 `CdnDownloadImage` 下载，文件通过 `DownloadFile` 下载（每片固定返回 64KB，按实际返回的字节数推进）。两者都是按需下载（`Deferred`），纯文本消息不需要等待。超过 25MB 的文件不下载。
- **引用**：引用的是一条文本消息时，原文作为 `quoted_text` 传给核心。
- **出站**：纯文本，每条最多 1500 字，按行切分。所有发送都经过 `SendPlanner`：

  | | 平时 | 登录后 48 小时 |
  |---|---|---|
  | 两次发送最小间隔 | 3s + 0–2s 随机 | 5s + 0–3s 随机 |
  | 每分钟 / 每小时 | 10 / 100 | 5 / 50 |
  | 主动通知合并窗口 | 30s | 60s |

  回复（入站消息带来的 `reply_context`，或者带 question 的消息）不合并、不丢弃，超过分钟配额就排队等待。主动通知（`reply_context = None`）在同一会话的窗口内合并成一条；超过小时配额就丢弃，下一条发出的消息会注明“已省略 N 条通知”。这些数字是保守估计，不是实测阈值，微信没有公布过。
- **出站附件**：agent 放进会话 outbox 的文件会跟在正文后面发出，同样经过节奏控制。png / jpg / gif / webp 用 `/Msg/UploadImg` 作为图片发送，其他文件先用 `UploadAppAttachStream` 分片上传（multipart，每片 200KB），再用 `SendApp type 6` 发出。单个文件超过 25MB，或者没有本地副本时，退化为在正文里写 `[附件: 文件名]`。
- **暂不支持**：入站语音 / 视频 / 表情、`dispatch_send`（cron / MCP 主动发送）、在设置页内扫码登录。

## 服务端接口要点（8074 实测）

- 成功只看 `Success == true`：`LoginGetQR` 成功时 `Code` 是 1，`SendTxt` 成功时是 0。
- 推送外壳是 `{Code, Success, Data: {AddMsgs: [...]}}`，**不是**服务端仓库 `message_callback.md` 里写的 GeWe 格式。推送可能是空 body；“当前未有新消息”的 `Data` 里没有 `AddMsgs`。
- 群消息的发送人是正文开头的 `"<wxid>:\n"`。群消息的 `PushContent` 不带正文（“X在群聊中@了你”）；私聊的 `PushContent` 是 `"昵称 : 正文"`，驱动从这里取显示名。
- `/Tools/DownloadFile` 每片固定返回 64KB，不管请求的长度是多少。分片下载要按实际返回的字节数推进 `StartPos`（以后做入站文件时要注意）。

代码：`crates/teamclu-gateway/src/wechatpad.rs`（解码、策略、发送节奏、服务端 API、回调监听、驱动）、`wechatpad_config.rs`；daemon 侧在 `apps/daemon/src/channels/manager.rs` 的 `start_wechatpad`；设置页是 `packages/app/src/components/settings/channels/Wechatpad.tsx`。
