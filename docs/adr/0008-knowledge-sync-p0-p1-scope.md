---
status: accepted
date: 2026-08-26
---

# Knowledge 同步：P0/P1 范围与产品锁

本 ADR 冻结 2026-08-26 两轮 grill 的结论；第二轮逐条对照代码查证后修订了
第一轮的几处事实错误（延迟数字、`.md` 已落地、重连「风暴」已退避、prepare 已批
量）。实施细节见
[`docs/plans/2026-08-26-knowledge-sync-p0-p1.md`](../plans/2026-08-26-knowledge-sync-p0-p1.md)。
设计原文：

- [`docs/architecture/knowledge-sync-push-notify.md`](../architecture/knowledge-sync-push-notify.md)
- [`docs/architecture/obsidian-compatible-knowledge.md`](../architecture/obsidian-compatible-knowledge.md)

## 产品定位

Knowledge 同步是**团队 Markdown vault 的云副本**，不是通用网盘，也不是 Notion
式协作文档。

- 主写入面（战略）：**Obsidian** 直接打开
  `~/.amuxd[-<brand>]/teams/<id>/shared/knowledge`
- TeamClu：同步引擎 + Agent / RAG 消费同一棵树
- 成功标准围绕「笔记秒级到齐、Obsidian 不当垃圾场」，不围绕大文件块级或行级 merge

## 主痛点

跨成员延迟。今日只有两个触发源：app 里的手动 Sync Now，和 daemon 的 **300s**
定时器（`sync/timer.rs:21`）；app 内的本地编辑**不**触发 push
（`use-team-cloud-sync.ts` 只是手动按钮）。A 的定时器与 B 的定时器相互独立，
所以别人改完**最长约 10 分钟、平均约 5 分钟**才可见。

**两条腿缺一不可。** 只做 fs 监听（我的出去）或只做 MQTT（别人的进来），各自
只砍掉一半，平均降到 ~2.5 分钟，都到不了秒级。顺序只影响风险，不影响体感。

## 安全叙事（与实现对齐）

现行引擎对 knowledge **明文上传**：`apps/daemon/src/sync/oss/engine.rs`
`prepare_upload` 里 `cipher_hash == plain_hash`，字节原样上去。`crypto.rs` 只剩两个
用途：读切换前写入的 AES-GCM 旧 blob，和本地 `state/secrets.enc`。团队 secret 已不是
同步的前置条件（`dispatch.rs` `run_once`：fetched, not required）。

对内对外统一表述为：**服务端与对象存储可读的团队共享盘**；TLS 保护传输，不是端
到端加密。因此：

1. 残留的「加密 / E2E」表述已清掉：`obsidian-compatible-knowledge.md` §2.1、
   根 `CLAUDE.md`、前端 `cloudVersion.unreadable`、daemon `Stage 0` /
   `[oss_sync] prepare` 日志标签（见 `fix(sync): drop leftover knowledge-encryption wording`）。
2. MQTT sync hint **仍然禁止**携带路径、文件名、内容、内容哈希——路径本身敏感，
   broker 内可见。这是元数据最小化，不是假 E2E 洁癖。
3. 真 E2E（含密钥分发）单独立项，不与本路线图绑定。

## 本路线图范围

### 做（P0 — 协作体感）

顺序按**风险从低到高**，每一项可独立对外：

1. **`.conflicts/`**：冲突 sidecar 迁入 `knowledge/.conflicts/<镜像相对路径>`，
   文件名格式不变。扫描器与 pull 侧**硬排除**该目录——不走 ignore 规则，不可被团队
   `.amuxignore` 的 `!.conflicts/` 反向覆盖，与「`.amuxignore` 自身永不被忽略」同级。
   旧 sidecar 扫描时本地搬入（它们从未上云，扫描器一直硬跳过，所以无广播、无迁移
   风险）。前端剪掉该目录，并删除 `isConflictSidecarName` 的 `.includes('.conflict.')`
   判定——它与 daemon 的数字时间戳判定不一致，`merge.conflict.md` 被树隐藏却照常同步。
2. **Per-team 同步调度器 + knowledge 根 fs 监听**（daemon 内容根）。调度器两路
   输入：`Local`（fs 事件）与 `Remote { seq }`（MQTT hint）；固定 2s 窗口**不重置**
   （coalescing，不是 debounce）+ 从上一次 tick **结束**起算的地板：本地 5s、远端
   15s，硬编码，不设「先采一周数据」门槛。300s 定时器与手动 Sync Now **不走**调度器
   （定时器已有 in-flight 跳过；手动是用户意图，直接 force）。watcher 是 `sync/` 下
   独立模块，不复用 `refresh_watch` 的 classifier；2s reconcile 处理晚出现的根目录；
   创建失败或运行报错 warn 一次退回定时器，不重试；ignore 规则只过滤事件（管不了
   `notify` 的递归注册）；pull 写过的路径 3s 内的事件丢弃（按路径集合，不按时间窗
   全量压制，否则 pull 期间的真实编辑会被吞掉）。
3. **FC 广播**：每次成功的 `complete-batch` / `delete-batch` 各发一条 hint 到
   `amux/<team_id>/sync/knowledge`。**不做 500ms 合批定时器**——daemon 已按 200 一批
   调用，每 tick 最多 10 条（2000 闸门），已经是「个位数不是 200」；去掉定时器顺带
   解决 belayo（阿里云 FC 冻结实例 `setTimeout` 不触发）与多 origin 时 `originNodeId`
   的歧义。`await` publish，500ms 超时只 warn，响应照常 200。先只发不收。
4. **ACL**：`agent` 与 `member` 增加 `sub amux/<team>/sync/+`。**容错订阅是唯一
   硬要求**：现状订阅被拒会一路 `Err` 到 `request_rebuild_for_generation`、CONNACK
   后 restore 被拒会 `forced_rebuild`（#1073 之后是 5→30s 退避的 worker 重建循环，
   不再是 100 次/秒，但会拖着 RPC / session-live 一起断）。所以订阅要带 `optional`
   标记贯穿首次订阅与 restore：被拒只 warn 一次、不重建 worker、不影响其它订阅、
   下次重连再试。token 3600s 轮换、daemon 到期前 5 min 主动重建，≤1h 自愈——
   「先迁移、再发订阅端」降为**建议**，同批发布也可。注：Postgres/Better-Auth 后端
   不产 `acl` claim、all-in-one（NanoMQ）无 ACL，这条迁移只对 Supabase 后端有意义，
   别拿 all-in-one 验它。FC 自己的 service token 无 `acl` claim，发布端零改动。
5. **Daemon 收端**：上传填 `node_id = daemon_device_id()`（现在四处都传 `None`，
   字段连 wire 都不出现）；订阅 → 回声过滤（`originNodeId == self`）→ seq 比较 →
   调度器 `Remote`。
6. App **不**订阅 sync 主题；它已靠 Tauri `watch_directory` 的 `file-change` 事件
   刷新树与角标（`FileBrowser.tsx` / `TeamShareListColumn.tsx`），daemon 落盘即可见。
7. **不**改 300s 定时器间隔；它降级为兜底。

延迟目标：**安静 ≤10s 端到端**（Obsidian A 保存 → Obsidian B 可见，含 A 侧 2s
窗口 + push tick + hint + B 侧 2s 窗口 + pull tick + 两端 watcher）；繁忙 ≤ 地板
+ 一次 tick。

### 做（P1 — 防炸与成本）

1. 每 team **字节配额**：`SYNC_MAX_BYTES_PER_TEAM`，默认 **2 GiB**——self-host
   MinIO 在根盘、余量个位数 GB，8 GiB 比整盘余量还大等于没保护。按 live 逻辑字节
   算（CAS 去重后物理更小，偏严是安全方向）；422 `QuotaExceeded` + `kind: 'bytes'`，
   与文件数配额同一错误形状；**batch 内一次 sum + 逐 item 运行累加**，不能照抄文件数
   的 10s 缓存（一个 200 条 batch 最坏超出 200 × 25 MiB = 5 GiB，比配额还大）；
   不做跨请求 in-flight 计数。写入 compose / `s.yaml` / `.env.example` 三处
   （`deploy-env-parity.test.ts` 守着，且要求源码里真的读了它）。

   **运行累加只对新增路径计费，且只在该 item 成功之后计。** 这条是本 ADR 第一版漏
   写、代码照做之后被 review 抓出来的：一次编辑的旧字节**本来就在 sum 里**，再按全量
   size 计一遍等于把同一个文件数了两次——一个 50/100 的团队改三篇 30 字节的笔记就会
   在第 2 条上撞 422，而这三条全部写完总量根本没变；被拒的 item（`IgnoredPath`、CAS
   失败）更是从来不会变成字节，却把额度花掉、连累同一 batch 里后面所有合法笔记。
   判据用请求体里现成的 `parentVersion`：`0` = 新路径，计费；`> 0` = 编辑，计 0。
   代价是一个**有界的少算**——编辑让文件变大的那部分要等下一次调用重读 sum 才算得上，
   所以超收上限就是一个 batch（≤200 条）。对一道专防病态批量新增的闸门，这是正确的
   方向：**配额可以让一个 batch 冲过头，但绝不能误挡**（§4.7「配额不会误挡」）。
   **配额 ≠ 磁盘保护**：物理占用还含历史版本 blob，依赖 `oss_sync_gc_orphan_blobs`
   的 FC cron，而 cron 是 compose 独立 profile，self-host 未开。GC 启用单开 ops
   ticket，不进本路线图；ticket 关闭前对外不说「磁盘安全」。
2. ~~Prepare 按 team 限速~~ **砍掉**。prepare 已按 200 批，合法 tick 只有 1 次调用；
   旧客户端灌 `node_modules` 被文件数配额挡、字节被上一条挡，剩余动机只有 Postgres
   行插入风暴。而 429 在 daemon 侧是 tick 内指数退避 5 次（~24s 持 per-team 锁）后
   deferred 并**报红到 UI**，代价大于收益。

### 明确不做（freeze）

直到有用量或独立 RFC 之前：

- 块级 / CDC 同步
- 按需下载（Smart Sync）
- Markdown 行级 merge / OT / CRDT
- 「谁改了什么」活动流 UI（P0 只填 `nodeId` 供协议用）
- 移动端 knowledge 同步
- 文本压缩上传（明文路径需要新 wire；有流量证据再开）
- Prepare 限速（见 P1 #2）
- 重命名补 `.md`、无后缀旧文件的树上提示（单开 issue）
- 拉长 300s 定时器（另 PR，且仅在推送稳定后）

### 已解冻：目录级权限（Path ACL）

本 ADR 冻结时，knowledge 是团队级「全有或全无」，没有按目录分权。该限制已由
[`docs/specs/2026-08-31-knowledge-path-acl-design.md`](../specs/2026-08-31-knowledge-path-acl-design.md)
**纳入范围并解冻**——不要再按上面的 freeze 清单把它推回去。

两点与本 ADR 直接相关，改这块前必须知道：

1. 该设计**不改变**本 ADR 的安全叙事。knowledge 内容在服务端仍是明文，ACL 是
   团队内的访问控制，不防运维、不防我们自己。撤权只承诺「停止同步」，不承诺
   「收回已下发的副本」。两份文档的措辞必须保持一致。
2. 「按需下载（Smart Sync）」**仍然冻结**。ACL 的「无权限即不下发」与 Smart Sync
   看起来相邻，实则无关：前者按人过滤，后者按访问频率延迟拉取。不要因为做了
   前者就顺手开后者。

## 与既有实现的关系

已落地、本 ADR 不重做：ignore 三层规则、25 MiB 单文件闸、每 tick 2000 新文件闸、
服务端路径拒绝、每 team 文件数配额（默认 5 万）、**新建笔记默认 `.md`**
（`3d6e8fd3`，`withDefaultExtension` 覆盖根与树内两处入口）、app 侧 fs watcher
刷新、MQTT 认证被拒后的退避重建（#1073）。

## 后果

- 下个 session 不得把 P2/P3 悄悄拉回「同一波」。
- `.conflicts/` 必须在 fs 监听**之前或同批**对外：Obsidian 用户先看到干净的库，
  再看到快的库。
- optional 订阅未过验收（订阅被拒不重建 worker、RPC 不断）前，禁止拉长定时器。
- 字节配额上线不等于磁盘安全，GC ticket 关闭前不这么说。
- 地板 5s / 15s、窗口 2s 是起点；调整走独立 PR 并附 tick 频率数据。
