# 知识同步的推送通知（MQTT）

> 状态：**设计，未实现**。范围与分期已由
> [`docs/adr/0008-knowledge-sync-p0-p1-scope.md`](../adr/0008-knowledge-sync-p0-p1-scope.md)
> 冻结；任务拆解见
> [`docs/plans/2026-08-26-knowledge-sync-p0-p1.md`](../plans/2026-08-26-knowledge-sync-p0-p1.md)。
>
> 相关：`docs/architecture/obsidian-compatible-knowledge.md`（同一条同步链路上
> 的另一批改动，其中「刀 4 文件监听」与本文互补，见 §2）。

## 1. 要解决的问题

`knowledge/` 的同步目前有两个触发源：app 里的手动按钮，和 daemon 的 300 秒定时
器（`apps/daemon/src/sync/timer.rs:21`）。app 内的本地编辑**不**触发 push
（`use-team-cloud-sync.ts` 只是一个手动按钮）。A 的定时器和 B 的定时器互相独立，
也就是说：

> A 在自己机器上写完一篇笔记，B 最长要等约 10 分钟、平均约 5 分钟才看得见。

对一个「团队知识库」来说，这个延迟决定了它是不是一个能一起工作的东西。

**文件监听只解决一半，本文也只解决一半。** Obsidian 那份设计里的刀 4（给
knowledge 根挂 fs 监听）解决的是「我改的东西快点发出去」；本文解决的是「别人改的
东西快点到我这」。两条腿各占一个 300 秒定时器：只做任何一条，平均延迟从 ~5 分钟
降到 ~2.5 分钟，都到不了秒级。两件事互补，都要做；**顺序按风险排**——fs 监听是
纯 daemon 内代码、零 ACL 零 token 依赖，先上；本文这条要迁移 + 容错订阅，后上
（ADR-0008）。

## 2. 为什么是 MQTT

不是新引入一个机制，而是**用上一个已经在跑但同步链路完全没碰过的通道**：

- 每台设备本来就挂着到 EMQX 的长连接，presence、RPC、session live 都在上面跑。
- **FC 已经在发 MQTT**：`services/fc/src/lib/push-dispatch.ts` 往 `inbox/<uid>`
  发未读信号，用的是 `services/fc/src/lib/mqtt-client.ts` 那个单例 publisher
  （懒连接、QoS-1、自动重连）。服务端广播这条路已经在生产上验证过了。
- 不需要新组件、新端口、新运维。

我在 `apps/daemon/src/mqtt/` 下 grep 过：**没有任何一行与 sync 有关**。这是一条
现成的、闲置的通道。

## 3. 谁来发：FC，不是推送方 daemon

两个选择：

| | 谁广播 | 问题 |
|---|---|---|
| a | 推送方 daemon 在 push 成功后自己广播 | 依赖推送方在线（它可能推完就合盖走人）；每个写入端都要自己实现一遍 |
| b | **FC 在写入成功后广播** | — |

选 **b**，理由：

1. FC 是唯一知道权威 `change_seq` 的地方 —— 那是 `amuxc_files` 表里的东西，客户端
   只有自己那次写入的返回值。
2. 不依赖推送方在线。
3. 将来任何写入端（web 编辑、网关、agent 直接写）自动获得同样的通知，不用每加一个
   客户端就补一遍广播逻辑。

## 4. 主题

```
amux/<team_id>/sync/<resource>
```

知识库这条就是 `amux/<team_id>/sync/knowledge`。

**资源段放最后，不是放中间。** 直觉上会写成 `amux/<team>/knowledge/sync`，但那样
每加一种资源（skills 注册表、团队 MCP 配置）都要改一次 ACL 规则 —— 而按 §7，改
ACL 意味着一次迁移、等设备 token 轮换、并承担订阅被拒触发 worker 重建循环的风险。
资源段放最后，ACL 一条 `amux/%s/sync/+` 就永久覆盖，以后加资源**零迁移**。

这条理由值得写下来，因为两种写法读起来一样自然，代价却差一个数量级。

**与现有主题的碰撞检查**（`crates/teamclu-types/src/mqtt.rs`）：

| 现有主题 | 段数 | 会不会撞 |
|---|---|---|
| `amux/<team>/<actor>/notify` | 4 | 不撞：第 4 段是 `notify`，我们是 `<resource>` |
| `amux/<team>/<actor>/state` | 4 | 不撞：同上 |
| `amux/<team>/session/<sid>/live` | 5 | 段数不同 |
| member 的通配订阅 `amux/<team>/+/state` | — | 匹配不到我们（第 4 段不是 `state`） |
| agent 的通配订阅 `amux/<team>/<actor>/runtime/+/commands` | — | 段数不同 |

`sync` 这一段也不会和 actor_id 撞：actor_id 是 UUID。

**常量定义在一处，镜像两处。** 主题是 rendezvous point —— 两端独立升级，谁都没法
替对方改。`MQTT_FALLBACK_TEAM_ID` 那条注释已经吃过这个亏。所以：

- 权威定义：`crates/teamclu-types/src/mqtt.rs`，加 `Topics::sync(resource)` 与自由
  函数 `sync_topic(team_id, resource)`。
- FC 侧 TS 一份镜像（FC 不依赖 Rust crate）。
- 将来 iOS 一份 Swift 镜像。

三处必须一致，且都要有断言主题字面量的测试 —— 现有 `shared_topic_functions_match_wire_paths`
就是这个用途，照抄即可。

## 5. 报文

```json
{
  "v": 1,
  "changeSeq": 12345,
  "originNodeId": "mac-9f3c…",
  "at": "2026-08-26T07:12:00Z"
}
```

| 字段 | 类型 | 必填 | 含义 |
|---|---|---|---|
| `v` | int | 是 | 报文版本。收到不认识的 `v` **整条丢弃**，不要尝试解析 |
| `changeSeq` | int64 | 是 | 触发这条 hint 的那次 batch 调用推进到的最大 `change_seq`。收端拿它和本地 high-water 比 |
| `originNodeId` | string \| null | 否 | 触发这次变更的设备（该次调用 body 里的 `nodeId`；一次调用只有一个来源，没有歧义）。收端用它丢掉自己的回声（§6） |
| `at` | ISO-8601 string | 否 | 服务端时间。**仅用于日志**，不参与任何判断 |

**报文里没有、且永远不能有的东西：文件路径、文件名、内容、内容哈希。**

Knowledge 现行上传是**明文**（FC 与对象存储可见正文；见 ADR-0008）。即便如此，
**路径本身就是敏感元数据**：`knowledge/2026-裁员名单.md` 泄露的东西不比正文少。
MQTT 到 broker 是 TLS 传输、broker 内部是明文，运维能看见，日志会记下来。所以
hint 里仍然禁止路径——这不是「假 E2E 洁癖」，是元数据最小化；将来若做真端到端
加密，这条约束只会更硬，不会更松。

**也没有 `count`（本次变了几个文件）。** 它诱使收端做增量假设，而经过 §7 的合批之后
这个数字的语义本就模糊（是窗口内的总数还是最后一次的？）。收端唯一该做的事是「拉一次
manifest」，不需要知道要拉几个。

**`changeSeq` 的精度。** 服务端是 `bigint`，JSON number 在 JS 里是 double，超过 2^53
会失精。自增序列实际到不了那个量级，但 FC 侧序列化时不要走任何会做数值转换的中间层，
Rust 侧用 `i64` 解析。

**`originNodeId` 有个前置条件：daemon 现在根本不传 nodeId。** `fc_client.rs` 的
prepare / delete 请求体都有 `node_id`，但 `engine.rs` 四处调用（`:837` 批量 prepare、
`:1186` 批量 delete、`:1316` 单条 prepare、`:1409` 单条 delete）全传 `None`，而且字段
是 `skip_serializing_if = "Option::is_none"`，wire 上根本不出现。所以要先让 daemon
填上 —— 现成的稳定标识是 `daemon_device_id()`（`apps/daemon/src/device_id.rs:47`）。
这一步可以独立先做，与推送无关，做完 `amuxc_files` 的 `created_by_node_id` 也终于
有值了。实现时顺手确认 daemon 是否会用自己 `complete-batch` 响应里的 seq 更新
high-water：如果只在 manifest 拉取时更新，那这层回声过滤就不只是省一次空转，而是
每次自己 push 之后必然多跑一次 tick 的唯一防线。

**报文的定位：hint，不是命令，不是数据。**

> 收端完全忽略这条消息，系统仍然正确 —— 只是慢回 300 秒。

这句话是所有容错策略的依据：可丢、可重复、可乱序、可延迟。任何让「收不到这条消息」
变成正确性问题的设计，都是走错了方向。

**版本演进**：加字段不升 `v`（收端忽略未知字段）；改字段语义或删字段才升 `v`。收端见到
未知 `v` 丢弃整条并 `warn!` 一次（不是每条都 warn，否则一次不兼容发布会刷爆日志）。

**QoS 1，不 retain。**

- 不 retain：retained 消息会让每个新上线的设备收到一条陈旧 seq 并无谓拉一次，而它启动
  时本来就会同步一遍。
- QoS 1：丢一条不致命（定时器兜底），但 at-least-once 几乎不要钱。
- **没有消息过期时间**：`rumqttc 0.24` 走的是 MQTT 3.1.1，没有 v5 的 Message Expiry
  Interval。所以一条陈旧消息可能在客户端重连后才送达 —— 这正是收端必须做 seq 比较
  （§6）而不能「收到就同步」的原因。

## 6. 收：daemon 侧

`apps/daemon/src/mqtt/subscriber.rs` 是按主题形状路由的（例如 session live 那条是
「5 段 + parts[2]=='session' + parts[4]=='live'」）。加一条同样形状的分支即可：
4 段 + `parts[2] == "sync"`，`parts[3]` 就是资源名。**按资源名分派，不认识的资源
直接忽略** —— 这样一个跑着旧版本的 daemon 收到将来的 `sync/skills` 不会报错刷屏。

收到之后**不要立刻同步**，三个过滤依次生效：

1. **丢掉自己的回声。** A 推完，FC 广播，A 也收到 —— 不过滤就会再空转一次同步。
   `originNodeId` 等于 `daemon_device_id()` 就丢弃。**前提是 daemon 先开始传
   nodeId**，见 §5 —— 现在两处上传都传的 `None`。在那之前这一层过滤是空的，
   只能靠下面的 seq 比较兜底（够用，只是会多一次空转）。
2. **丢掉不新的 seq。** 与本地 high-water 比较，不高于就丢弃。
3. **进 per-team 同步调度器**（合并窗口 + 最小间隔地板），再落到已有的
   `dispatch.sync_team`。这个调度器与刀 4 的 fs 监听**共用**：两路输入 `Local`（fs
   事件）与 `Remote { seq }`（本文的 hint）。`sync_team` 自带 per-team 互斥锁，不会
   和定时器打架 —— 正在跑就跳过，这条已有逻辑不用改。第 3 条比前两条复杂，单独
   展开在 §7。

## 7. 收端限流：活跃团队不能把自己拉垮

前两层过滤挡的是**无效**的广播（回声、陈旧 seq）。这一层挡的是**有效但过量**的：
一个 10 人团队正常干活，就能把同步频率推高两个数量级。

### 7.1 数量级

10 个人，每人每 30 秒保存一次：

```
每分钟 20 次写入 → 每人收到 18 条广播（扣掉自己的）
朴素实现 = 18 次 tick/分钟
现状     = 0.2 次 tick/分钟（300 秒一次）      ← 90 倍
```

一次 tick 不是「拉那一个文件」那么轻：manifest 分页查询（打 Postgres）、
`apply_scan` 全树 walk 加 mtime/size 检查，然后才是可能的下载。90 倍是实打实的。

### 7.2 不要用 debounce

直觉会写 debounce（每来一条重置计时器）。**在持续高频写入下它永远不会触发** ——
计时器被无限刷新，最后退化回 300 秒定时器兜底。安静时好用、繁忙时失效，正好和需求
相反。

要的是 **coalescing window**：第一条到达就起一个固定窗口（2 秒），期间来的全部合并，
到点执行一次，**不重置**。

同一个陷阱在发端也存在：Obsidian 自动保存约 2 秒一次，只给 fs 监听配 debounce 的
话，一个人连续打字 = 每 2 秒一个完整 tick（全树 scan + prepare + complete + 一条
hint），10 人团队就是 300 tick/分钟，把每个队友的收端地板顶满。所以窗口和地板是
**一个 per-team 调度器**，两路输入共用（§6 第 3 条）。300 秒定时器和手动 Sync Now
**不走**调度器：定时器已有 in-flight 跳过，手动是用户意图，直接 `force`。

### 7.3 为什么可以这么简单：合并是无损的

关键性质：**拉取的语义是「拉到最新」，不是「拉某个文件」**。manifest 按 `afterSeq`
增量分页，一次拉就把落后的全部补齐。

所以 A 收到 B、C、D 三条广播，合并成一次拉取，拿到的东西和拉三次**完全一样**。不是
「够用的近似」，是等价。

这也回过头解释了 §5 为什么报文里只放一个 seq：如果带了路径列表，合并就得做集合并
集，还要考虑乱序和丢失，反而复杂。一个单调数字自带幂等和可合并性。

### 7.4 硬地板

合并窗口之上再加一条**最小 tick 间隔**：两次同步之间至少隔 N 秒，收到广播时若不足
N 秒，就排到点上执行一次（而不是丢弃 —— 丢弃会让最后一次变更传不到）。

```
安静时：一条广播 → 窗口 2 秒 → 拉一次        这一段延迟 ≈ 2 秒
繁忙时：无论几条广播 → 每 N 秒最多拉一次
```

N 取 **15 秒**（远端 hint）/ **5 秒**（本地 fs 事件），硬编码，**不设「先采一周数据
再定」的门槛**——两个值是起点，调整走独立 PR 并附 §12 第 7、8 条的 tick 频率数据。
两路都 pending 时取小的那个。远端 15 秒意味着：最差延迟从 300 秒降到 15 秒（快 20
倍），tick 频率从 0.2 次/分钟涨到最多 4 次/分钟（20 倍）。20 倍资源换 20 倍实时性，
比例是线性的。朴素实现那 90 倍里的大部分是白花的 —— 合并掉之后结果一模一样。

「延迟 ≈ 2 秒」只是 hint 这一段。端到端（Obsidian A 保存 → Obsidian B 可见）还要加
A 侧 2 秒窗口 + push tick + B 侧 pull tick + 两端 watcher，安静时在 6–10 秒量级；
ADR-0008 定的目标是**安静 ≤10 秒、繁忙 ≤ 地板 + 一次 tick**。

**地板从上一次 tick 结束算，不是开始。** 否则一个慢 tick 会让下一次紧接着排上，在
大知识库上叠成连续跑。

### 7.5 成本在收端，不在发端

反直觉但重要：EMQX 每分钟收 20 条 publish 什么都不是，真正贵的是每个 daemon 那次
manifest 查询加全树扫描。所以限流**加在订阅端**。加在 FC 的发布端没有意义,反而会
让最后一次变更传不到。

## 8. 合批：一次 tick 不能变成 200 条广播

担心的是：`push_phase` 一次最多推 200 个文件（`MAX_SYNC_BATCH`），逐文件广播 =
一次同步 200 条消息。

**但 daemon 已经按 200 一批调 HTTP**：`engine.rs:816` 按 `MAX_BATCH = 200` 切块，
每块一次 `upload_complete_batch`（`/v1/sync/upload/complete-batch`），删除同理走
`delete-batch`。逐文件的 `upload_complete` 只在 FC 返回 404 `BatchUnsupported` 时
才走，现役 FC 不会。

所以做法是：**每次成功的 `complete-batch` / `delete-batch` 调用发一条**，seq 取该次
调用里成功项的最大 `changeSeq`。一次 tick 最多 2000 个新文件（客户端闸门）= 最多
10 条 hint，已经是「个位数不是 200」。**不做 500ms 合批定时器**，两个理由：

1. belayo 跑在阿里云 FC 上，响应返回后实例可能被冻结，`setTimeout` 不保证触发。
2. 定时器窗口里落进多个来源时 `originNodeId` 填谁没有好答案；按调用发，一次调用
   一个来源。

发送 `await` publish，**500ms 超时**：超时只 `warn!`，HTTP 响应照常 200——hint 是
best-effort，定时器兜底。self-host 上 broker 在本机，亚毫秒，不感知。

多实例重复广播无害：收端有 §5 的 seq 去重。

## 9. ⚠️ ACL：这一步最容易把线上打挂

EMQX 的授权规则由 `amux_acl_rules_for(team, actor, type)` 生成
（`services/supabase/migrations/20260706120000_member_sub_own_rpc_req.sql`），由
GoTrue 的 `amux_access_token_hook` 在签发时展开成 `acl` claim **烘进 access token**。
EMQX 侧只配了 JWT 认证（`deploy/self-host/emqx/emqx.conf`），没有 authorization
块，也没有 Postgres authz 源——ACL 完全跟着 token 走。

看当前规则表：`member` 有一条通配的 `('sub', 'amux/<team>/+/state')`，但
**`agent` 没有任何可复用的通配 sub** —— 而 daemon 就是 agent 类型。所以没有「零迁移
方案」，必须加规则：

```sql
('sub', format('amux/%s/sync/+', p_team))   -- agent 与 member 都加
```

用通配 `sync/+` 而不是逐个资源列出，是 §4 那个「资源段放最后」的兑现点：这条规则
上一次之后，将来加 skills、mcp 的推送就不用再动 ACL 了。

三个顺带的事实：

- FC 自己的 publisher 用的是 `MQTT_SERVICE_TOKEN`，手工签的 JWT，**没有** `acl`
  claim；没有 authz 源时 EMQX 走 `no_match` 默认放行。所以**发布端零 ACL 改动**，
  只有订阅端（daemon / app）需要这条迁移。
- Postgres / Better-Auth 后端签的 token **不产 `acl` claim**，all-in-one 镜像跑的是
  NanoMQ、无 ACL。这条迁移只对 Supabase 后端有意义；**别拿 all-in-one 验它**。
- token 只活 3600s（`JWT_EXPIRY`），daemon 到期前 60s 续、到期前 **5 分钟主动重建
  MQTT 连接**（`backend/mod.rs` `PROACTIVE_CREDENTIAL_BUFFER`）并逐条重订阅。所以
  迁移之后**最长 1 小时**，每台 daemon 都拿到了带新规则的 token。

**上线顺序是建议，不是门槛**：先上迁移、后发 daemon 最省事；但只要订阅容错（下
面），同一发布里带上两者也没事——最长 1 小时内自愈。

**为什么容错是硬要求。** 现状订阅被拒的路径：`mqtt_resubscribe_after_connack`
（`apps/daemon/src/daemon/server.rs:886-915`）`return Err` → 调用方
`request_rebuild_for_generation` → `schedule_restart`；CONNACK 后的 restore 路径
（`supervisor.rs:1717-1746`）被拒直接 `forced_rebuild`。#1073 之后这已经不是「100 次
/秒不退避」的风暴——重建按 5→30s 指数退避、generation 会前进——但仍然是一个
**worker 重建循环**：每 5–30 秒断一次连接，RPC、session live、presence 全跟着断，
直到 token 轮换、订阅成功为止，最长 1 小时。

所以：

> **这条新订阅必须是「可选订阅」。** `MqttCommand::Subscribe` 带 `optional` 标记，
> tracked subscriptions 也带；首次订阅和 CONNACK 后的 restore 都适用：被拒只 `warn!`
> 一次，**不** `forced_rebuild`，**不** `return Err`，不影响其它订阅，下次重连再试
> （token 轮换保证 1 小时内有一次）。拿不到就退回定时器同步。

这一条比迁移顺序更重要 —— 顺序会被人搞错，容错不会。

## 10. 定时器不能删

MQTT 会丢：设备离线期间的广播不补发（不 retain，QoS 1 只保证在线链路上的送达）。
300 秒定时器从「主要机制」退化为「兜底」，但必须留着。

拉长它（比如到 15 分钟）以省掉无谓流量是合理的**第二步**，等推送稳定工作、有数据
之后再做，不要和本次改动一起上 —— 否则推送一旦不工作，退化后的兜底会把延迟从 5
分钟变成 15 分钟，比现在更差。

## 11. 分阶段

按 ADR-0008 的全局顺序（风险从低到高），本文覆盖的是其中的 C / D / E：

| 阶段 | 内容 | 可独立验证 |
|---|---|---|
| A | `.conflicts/`（obsidian 文档刀 7） | Obsidian 里副本消失 |
| B | per-team 调度器 + fs 监听（刀 4） | Obsidian 保存后 2 秒窗口内 push |
| C | FC 侧按调用广播（§8） | 没人订阅，先让消息流起来，用 `mosquitto_sub amux/+/sync/knowledge` 看 |
| D | ACL 迁移（§9） | 1 小时后用一个测试客户端订阅得上 |
| E | daemon nodeId + 可选订阅 + 三个过滤 → 调度器 `Remote` | 联调验收 §12 |
| — | 观察后再考虑拉长定时器 | 另 PR |

C 完全无风险（发到一个没人听的主题），可以任何时候先上；它顺带采到真实写入分布，
但**不作为定地板的门槛**——15s / 5s 硬编码上线，调整走独立 PR。D 与 E 可以同一发布
（§9）。

## 12. 验收

1. A 在 Obsidian 保存一篇笔记 → B 在 Obsidian 里 **≤10 秒**看到（端到端，A/B 都
   跑着 B + C + D + E；不是 5 分钟，也不是 hint 那一段的 2 秒）。
2. A 一次推 2000 个文件 → 广播条数 ≤10，不是 2000。
3. A 自己不会因为自己的推送而多跑一次同步（`originNodeId` 过滤生效）。
4. 掐掉 EMQX → 同步仍然工作，只是退回 300 秒节奏；日志有 warn；worker 重建只按
   既有的 5→30s 退避，EMQX 回来后 RPC 自行恢复。
5. 用一个**拿着迁移前 token** 的 daemon 连上去 → `sync/+` 被拒，只 warn 一次，
   **worker 不重建**，RPC / session live 不断；token 轮换后（≤1h）订阅成功。这条是
   §9 的回归测试，必须真的做，而且要有单测：可选订阅被拒不 `schedule_restart`，
   必选订阅被拒仍然会。
6. 抓包/看 broker：消息里没有任何文件路径。
7. **活跃团队不把自己拉垮**：10 个人同时密集编辑一小时，每台设备由远端 hint 触发的
   tick 次数不超过 `3600 / 15`。这是 §7 存在的理由，不验就等于没做。
8. **持续高频不会饿死**：A 在 Obsidian 里连续打字 10 分钟不停，A 的 tick ≤ `600 / 5`，
   期间 B 持续收到更新 —— 这条专门盯 §7.2 那个陷阱，用 debounce 写会在这里挂掉
   （计时器被无限刷新，一次都不触发）。
9. **pull 不自触发**：B 收 hint 拉下 50 个文件，落盘产生的 fs 事件不会让 B 再排一次
   本地 tick（路径集合压制生效）；但 pull 期间 B 自己改的另一篇笔记照常排。

## 13. 未决

- ~~app（member 身份）要不要也订阅、直接刷新 UI？~~ **已定：不订阅。** daemon 拉完
  不会通知 app（`sync/` 下没有任何 emit，app 只能轮询 `/v1/team/sync/status`），但
  app 打开 knowledge 列时对内容根挂了 Tauri `watch_directory`（`workspace.ts`
  `openExternalRoot` → `filewatcher.rs` → `file-change` 事件），`FileBrowser.tsx` 与
  `TeamShareListColumn.tsx` 都在听它刷新树、角标与冲突列表。daemon 落盘即可见。
- iOS 将来如果有知识库（目前完全没有），同一条主题可以直接复用。
- ~~§7.4 地板取值 15 秒是估的~~ **已定：15s / 5s 硬编码上线，不设采数门槛**；调整走
  独立 PR 并附 §12 第 7、8 条的 tick 频率数据（阶段 C 的广播频率就是写入频率）。
- 要不要把 skills 注册表的更新也走 `amux/<team>/sync/skills`？同样的问题、同样的
  解法，而且按 §4 的主题形状它**不需要再改 ACL**。但不要在本次一起做。
