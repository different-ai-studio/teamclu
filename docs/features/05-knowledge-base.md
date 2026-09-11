# TeamClu 功能详解 · 第 5 篇：知识库与文档

> 版本基线：当前 `main`（`package.json` v0.4.1-beta.51）。
> 读者：要接手知识库/同步这块的工程师。
> 关联：ADR-0008、`docs/architecture/obsidian-compatible-knowledge.md`、
> `docs/architecture/knowledge-sync-push-notify.md`、
> `docs/specs/2026-08-31-knowledge-path-acl-design.md`、
> `docs/specs/2026-09-01-team-sync-two-roots-design.md`、
> `docs/specs/2026-09-01-lazy-documents-design.md`、
> `docs/plans/2026-08-31-team-knowledge-base-program.md`。

---

## 0. 一句话定位

知识库是**每个团队一份、Obsidian 可直接打开的 Markdown vault**，由 amuxd 负责在团队成员之间做云同步，由 TeamClu 负责 AI 消费、权限边界和冲突治理。

它**不是**：

- 不是 Notion 式协作文档——不做行级 merge、不做 OT/CRDT，冲突走人工决策；
- 不是通用网盘——大二进制走对象存储引用，不进 vault；
- 不是聊天记录归档——聊天是过程，知识库是结论。

这个定位决定了后面几乎所有取舍。最典型的一条：**「不做行级合并」不是没做，是明确不做**，因为 Markdown 的 diff 语义在中文、表格、frontmatter 上极难做对，而人工决策的成本远低于一个会错的自动合并。

---

## 1. 为什么需要它

### 1.1 跨成员延迟（主痛点）

在此之前，`knowledge/` 的同步只有两个触发源：app 里的手动 Sync Now，和 daemon 每 **300 秒**的定时器。而 app 内部的本地编辑**不触发 push**。A 的定时器与 B 的定时器相互独立，于是：**A 写完一篇笔记，B 最长要等约 10 分钟、平均约 5 分钟才看得见。**

对一个「团队知识库」来说，这个延迟决定了它是不是一个能一起工作的东西。ADR-0008 把这条定为产品级主痛点，并明确：**只做 fs 监听（我的出去）或只做 MQTT（别人的进来），各自只砍掉一半**，平均降到约 2.5 分钟，都到不了秒级。两条腿缺一不可。

### 1.2 服务端没有任何防线

- `/v1/sync/*` **完全豁免** per-IP 限流，理由是「一次 sync tick 会发多个请求、同一 NAT 后的队友会互相饿死」——理由成立，但结果是同步数据平面上没有任何速率或容量约束。
- 字节是 **presigned 直传**，不经过 FC。所以「冲垮」有两个独立维度：FC/Postgres 的行数，以及对象存储的磁盘（自托管走本机 MinIO，单桶，余量个位数 GB）。

结论：**客户端忽略规则是主防线，但不能是唯一防线**——旧版本客户端不认新规则。

### 1.3 团队级「全有或全无」

同步链路上唯一的鉴权判据是「你是不是这个团队的成员」。`team_members.role` 存在，但整条同步链路一次都没读过它。于是「HR 目录只有 HR 能看」无法表达——这是 Path ACL 要解决的。

### 1.4 规模现实

设计前查过线上库：最大的真实知识库 **11 个 live 文件**，多人团队最大 **7 个 member**，agent 数量普遍是 member 的 **3–5 倍**。前两个数字用来定容量上限（64 条规则、5 万文件、2 GiB 字节），第三个推翻了「agent 级权限」这个看起来合理的设计。

---

## 2. 心智模型：两个根、三类内容、三层来源

### 2.1 两个固定根

```
~/.amuxd[-<brand>]/teams/<team_id>/shared/team-sync/
├── documents/     ← 资料库：有归属的文件（合同、HR、财务），可设权限
└── knowledge/     ← 知识库：沉淀下来的共识，全员一致，不设权限
```

代码落点：daemon 的 `sync_content_root()` 与 `SHARED_PREFIXES`；桌面端 `globalTeamSyncShareRoot()` / `globalTeamKnowledgeShareDir()`；FC 的 `ALLOWED_PREFIXES`；daemon 的 `path_validator.rs`。

**三处白名单必须一致**，且加前缀是一次**硬升级**：`engine::tick` 对 manifest 行用硬 `?` 调用 `validate()`，一个不认识新前缀的 daemon 会中止整个 apply，而 `InvalidPath` 是非瞬时错误，永不自愈。一个旧 build 会在别人创建新前缀文件的那一刻**静默停止同步**。

下移到 `team-sync/` 白捡三个好处：`teamclu-team/`、`state/cloud`、以及那两个 workspace 符号链接都自动落在同步树外，不再依赖「别放进去」的纪律。

### 2.2 两类内容的区别：编辑方针

- **documents（资料库）**：有归属的文件，谁能看是业务问题；
- **knowledge（知识库）**：团队共有，不切分。

评审时明确否掉了「因为 agent 要保持一致所以 knowledge 不能分权」这个理由——那会导出一套硬规则。选定的是编辑方针，所以数据库 CHECK 从 `LIKE 'knowledge/%'` 放宽到同时接受两个前缀，只在 UI 层不给 knowledge 设权限入口。**编辑方针不该用数据库约束来执行。**

### 2.3 三层内容模型（产品视角）

```
L3 公司级发现层  知识目录 / 搜索门户 / 精选集合（跨团队，只读聚合）
L2 团队 vault    每个团队的 knowledge/（写作、评审、发布的唯一场所）
L1 个人草稿层    会话记录 / 临时笔记 / AI 对话（低门槛捕获，定期打捞）
```

核心规则：**知识只能向上流动。** L1 → L2 靠「打捞」，L2 → L3 靠 manifest 声明。不存在跨团队直接编辑别人 vault 的情况。

### 2.4 磁盘布局与符号链接

workspace 里由 daemon 建两个符号链接：`team-knowledge` → `shared/team-sync/knowledge`，`team-documents` → `shared/team-sync/documents`。它们给 agent 和 workspace 文件面板用。

`ensure_workspace_link` 在 Unix/macOS 用 symlink，Windows 先试目录 junction，再退到「没有链接，直接读全局目录」。它**永不返回错误**：打开 workspace 不应该因为链接权限失败而报错。代价是调用方需要处理 `Fallback`。

一个守卫：**绝不处理「workspace 本身就是团队 `shared/` 目录」的情况。** 这种假 workspace 的 `teamclu-team` 就是全局存储目录本身，把同步根链接进去会把 `shared/team-knowledge` 种进同步内容根——扫描器会走进去。代码直接 `Fallback` 并 warn。

`teamclu-team` 这个第三个链接已不再创建，旧 symlink 会被移除；同名真实目录则原样保留。

---

## 3. 架构全景与数据流

```
桌面端（Knowledge 列 / 文件树 / 编辑器 / 冲突视图）
        │ Tauri IPC
~/.amuxd/teams/<id>/shared/team-sync/{knowledge,documents}
        │
amuxd daemon：scan → push → pull → tombstone；fs 监听；per-team 调度器
        │ HTTPS（presigned 直传 + manifest）
Cloud API /v1/sync/*：manifest / prepare / complete / download + sync-acl + 配额
        │
Postgres（amuxc_files…） + 对象存储（CAS blob）
```

实时信号另走一条：FC 在写入成功后往 `amux/<team_id>/sync/knowledge` 发一条**不含路径**的 MQTT 报文，daemon 订阅后触发一次合并窗口内的 tick。

安静时目标链路（≤10 秒）：A 改文件 → fs 监听（2 秒合并窗口）→ push → FC bump change_seq + 广播 → B 收 hint → 回声过滤/seq 比较 → 调度器（2 秒窗口）→ pull → 落盘 → Tauri watch 刷新树。

---

## 4. 同步引擎：scan → push → pull → tombstone

关键常量（`engine.rs`）：

| 常量 | 值 | 含义 |
|---|---|---|
| `MAX_BATCH` | 200 | 一次 HTTP 调用的条数 |
| `MAX_FILE_BYTES` | 25 MiB | 单文件大小上限 |
| `MAX_NEW_FILES_PER_TICK` | 2000 | 单 tick 新增文件闸门 |
| `MAX_DELETES_PER_TICK` | 200 | 单 tick 删除数 |
| `RECONCILE_INTERVAL_SECS` | 30 分钟 | 全量 drain 对账窗口 |

**scan**：只遍历白名单目录，忽略规则在这里生效（不 walk 进被忽略目录），顺带修掉本地扫描性能。

**push**：`plan_push` 是纯函数，两道与文件名无关的闸门。单文件 >25 MiB 跳过该文件，其余照推。单 tick 新增 >2000 **整次全部不发**，等人确认。第二条只数数、不读名字，所以在任何人写出规则之前就生效。三个刻意选择：超限时一个都不推；「确认」只能由人给出（`allow_bulk_add` 从 UI 一路传到引擎）；算的是「新文件」而不是「有改动的文件」。

**pull**：`needs_download = local.is_none() || item.version > local.synced_version`。

**tombstone**：`locally_deleted_paths` 的判据是「在 `state.files` 里（`synced_version > 0`），但不在本次 scan 结果里」。

---

## 5. 忽略机制：三层规则 + 两道闸门

### 5.1 规则来源（后者覆盖前者）

```
1. 内置默认      编译进 daemon
2. 团队规则      knowledge/.amuxignore     ← 自身参与同步，全团队一致
3. 本机规则      shared/.syncignore.local  ← 不在 knowledge/ 下，故不同步
```

第 2 层放在 `knowledge/` **内部**是刻意的：它得跟着团队走。代价是它自己是一个同步文件，所以有一条硬规则：**`.amuxignore` 自身永不被忽略**。

内置清单覆盖版本控制、编辑器状态（`.obsidian/`、`.trash/`）、Node（`node_modules/`、`dist/`）、Rust（`target/`）、Python、JVM/iOS。

**冲突副本刻意不在清单里。** 直觉上该加 `*.conflict.*`，但那个 glob 会连 `merge.conflict.md` 一起吞掉——那是别人写的一篇正经笔记。冲突副本用更严格的形状判断。

语法用 `.gitignore` 子集，**大小写不敏感**：macOS 与 Windows 的文件系统默认如此，规则若大小写敏感会在跨平台团队里表现不一致。

### 5.2 服务端第二道

只挂在写路径 `handleSyncUploadPrepare`（单条和 batch 都走它，是唯一写入口）。**绝不能加进 `validateSyncPath`**——那个 pull 侧也会走。

**服务端清单比客户端短得多，这是刻意的。** 误挡一次的代价是永久且无法解释的：文档永远传不上去，客户端一直重试，用户只看到 422。客户端的清单可以激进，因为人能改 `.amuxignore` 把文件要回来——**服务端这份谁都改不了**。所以 `target/`、`build/`、`dist/`、`coverage/` 不在服务端清单里：中文团队完全可能拿 `target/` 存 OKR。

**配额承担主要职责**：`SYNC_MAX_FILES_PER_TEAM` 默认 50000，字节配额默认 2 GiB（P1）。计数用 `head: true` 的 COUNT 并缓存 10 秒。**数不出来就放行**——因一次数据库抖动让用户传不上文件，是他完全无能为力的失败。

字节配额有一条被 review 抓出来的细节：**运行累加只对新增路径（`parentVersion === 0`）计费，且只在该 item 成功之后计。** 一次编辑的旧字节本来就在 sum 里，再按全量 size 计一遍就是把同一个文件数了两次。方向是「配额可以让一个 batch 冲过头，但绝不能误挡」。

---

## 6. Obsidian 兼容

### 6.1 vault 就是 knowledge 目录

用户执行一次「Open folder as vault」。**不做镜像、不做二次副本**——多一份副本就多一层冲突面。已知代价是路径难看、重新 onboard 会换目录，接受，换来「两边编辑同一份字节」。

### 6.2 `.obsidian/` 完全不同步（已决策）

Obsidian 会在 vault 根下建 `.obsidian/`，其中 `workspace.json` 记录面板布局——**每挪动一次面板就写一次盘**。同步它意味着版本号持续增长、跨设备永久冲突、每个人的界面被别人的布局覆盖。社区插件同步则更糟：等于用团队同步链路分发可执行代码。因此整个目录进内置忽略清单，**不提供开关**。

### 6.3 首次打开的流程（实测得来）

1. vault 列表在 `<config dir>/obsidian/obsidian.json`；
2. 那个 id **不是路径 hash**，是不透明值；我们用 `sha256(path)[..8]`，天然幂等；
3. `obsidian://open?path=` **只解析注册表里的 vault**；
4. `.obsidian/` 是注册的**结果**而不是原因，不能用来判断「这是不是 vault」；
5. **Obsidian 只在启动时读一次注册表**——运行期间注册的新 vault，URI 打不开。

第 5 条决定了必须分支，所以 `obsidian_open_vault` 返回 outcome：已注册 → 发 URI；未注册 → seed 配置、原子写注册表（`open: false`）、Obsidian 未运行则发 URI，运行中则提示重启。

注册时 `open: false` 是刻意的：`true` 会让 Obsidian 下次启动时打开我们的库而不是用户原来那个，一个叫「在 Obsidian 中打开」的按钮没有权力劫持这个。写注册表用临时文件 + rename 原子替换——半个文件会让用户丢掉所有 vault。

### 6.4 预置的 vault 配置

首次注册时写 `.obsidian/app.json`（已存在就不碰）：`attachmentFolderPath: "attachments"`、`showUnsupportedFiles: true`、`alwaysUpdateLinks: true`。三条都是**本地创建、不上传**，所以每台设备各自 seed 一次。

### 6.5 wiki link

- `wiki-link-utils.ts`：解析 `[[target#heading|alias]]`，`createWikiLinkRegex()` 每次返回新 RegExp，避免 `lastIndex` 状态泄漏。
- `wiki-link-index.ts`：`buildFileMap` 只收 `.md`，名字冲突时保留最短路径——这正是 Obsidian 的默认行为。
- `wiki-link-resolver.ts`：按绝对 root 建 map，带 **5 秒 TTL 缓存**和 `MAX_DEPTH = 12`。点不存在的目标就新建，但新建前必须确认 root 存在——否则会把 daemon 要拥有的目录物化出来，`team-knowledge` 链接会被永久遮蔽。写入前还要 `exists` 检查，避免用空 frontmatter 覆盖真实笔记。

Markdown 编辑器用 CodeMirror `MatchDecorator` 给 `[[...]]` 加装饰，点击时**在文档所属的知识树内解析**，避免同一文件在两个路径下各开一个 tab。

---

## 7. 实时性：三条腿

### 7.1 fs 监听

独立模块 `sync/watch.rs`，不复用 `runtime/refresh_watch.rs` 的 classifier——那是 runtime refresh 的输入，塞一个 Knowledge kind 进去会把两个消费者搅在一起。监听父目录以扛住原子保存，丢 `Access` 事件，2 秒 reconcile 处理晚出现的根目录。

### 7.2 不是 debounce，是 coalescing window + 地板

固定 2 秒窗口不重置；地板本地 5 秒、远端 15 秒，从上次 tick **结束**起算。原因：debounce 在持续高频写入下永远不会触发（计时器被无限刷新），最后退化回 300 秒定时器兜底——安静时好用、繁忙时失效，正好和需求相反。

同一个陷阱在发端也存在：Obsidian 自动保存约 2 秒一次，只配 debounce 的话，一个人连续打字 = 每 2 秒一个完整 tick。所以窗口和地板是**一个 per-team 调度器**，两路输入共用：`Local`（fs 事件，地板 5 秒）与 `Remote { seq }`（MQTT hint，地板 15 秒）。300 秒定时器和手动 Sync Now 不走调度器。

### 7.3 MQTT hint

主题 `amux/<team_id>/sync/<resource>`。**资源段放最后**是刻意的：直觉会写成 `amux/<team>/knowledge/sync`，但那样每加一种资源都要改一次 ACL 规则，而改 ACL 意味着一次迁移、等 token 轮换、承担订阅被拒触发 worker 重建循环的风险。资源段放最后，ACL 一条 `amux/%s/sync/+` 就永久覆盖。

报文：`{ "v": 1, "changeSeq": 12345, "originNodeId": "mac-9f3c…", "at": "..." }`。**没有、且永远不能有：文件路径、文件名、内容、内容哈希。** 路径本身就是敏感元数据：`knowledge/2026-裁员名单.md` 泄露的东西不比正文少。

报文定位是 **hint，不是命令，不是数据**：收端完全忽略它，系统仍然正确，只是慢回 300 秒。可丢、可重复、可乱序、可延迟。

### 7.4 收端三个过滤

丢自己的回声（`originNodeId == daemon_device_id()`）→ 丢不新的 seq（与本地 high-water 比）→ 进调度器。

### 7.5 为什么合并是无损的

关键性质：**拉取的语义是「拉到最新」，不是「拉某个文件」**。manifest 按 `afterSeq` 增量分页，一次拉就把落后的全部补齐。所以 A 收到 B、C、D 三条广播，合并成一次拉取，拿到的东西和拉三次**完全一样**。

### 7.6 ACL 与容错订阅

EMQX 的授权规则在 GoTrue 签发 token 时展开成 `acl` claim 烘进 access token。当前 `agent` 没有可复用的通配 sub，必须加 `('sub', format('amux/%s/sync/+', p_team))`。

**容错订阅是唯一硬要求。** 现状订阅被拒会一路 `Err` 到 `request_rebuild_for_generation`，CONNACK 后 restore 被拒会 `forced_rebuild`——会拖着 RPC、session-live 一起断。所以新订阅必须是「可选订阅」：被拒只 warn 一次，不重建 worker，不影响其它订阅，下次重连再试。token 只活 3600s，daemon 到期前 5 分钟主动重建，所以迁移后最长 1 小时自愈。

---

## 8. 冲突治理

### 8.1 `.conflicts/` 目录

冲突发生时，引擎把**本地字节**停放在 `.conflicts/` 下，让**远端版本**覆盖文档本身。所以 `path` 是用户认识的那篇文档（装着远端文本），`sidecar` 是用户自己的文本去的地方。

Obsidian 默认忽略点目录，副本对它完全隐形。三条约束：扫描器与 pull 侧**硬排除**（不走 ignore 规则，否则团队一条 `!.conflicts/` 就能把副本推上云）；旧 sidecar 走 move-on-scan（从未上云，纯本地 rename）；前端判定改为剪 `.conflicts/` 目录，删掉 `.includes('.conflict.')`（它与 daemon 的数字时间戳判定不一致，导致 `merge.conflict.md` 被树隐藏却照常同步）。

### 8.2 决策与视图

`KnowledgeConflictResolver.tsx` 读本地两份文件（sidecar = 我的，文档 = 云端的），提供 `keepLocal` / `keepRemote`。**不涉及网络**，所以瞬间打开。选 `keepLocal` 后会立刻踢一次 sync——恢复的副本在推送上去之前只在这块盘上。

云版本视图打开的是只读视图，**不是 diff**：它回答的是「队友看到的是什么」。

---

## 9. UI 表面

- **Knowledge 列**：header 上是「在 Obsidian 中打开」；没装时 disabled + muted。
- **底部同步栏**：不是 header 刷新按钮的复制品（那个重读本地列表，这个关于云）。信息优先级：冲突 > 大批新增被拦下 > 超大文件跳过 > 失败 > 进行中 > ↑N ↓M。传输中要活过 300ms 才显示；被拦下时整条 bar 变成可点；有列表时 popover 按「需要决策 / 无法同步 / 等待上传 / 等待下载」分组。
- **文件树**：根层显示「资料库」/「知识库」（磁盘上是 ASCII）。`.obsidian` 与 `knowledge/.conflicts` 被剪掉，但**按 sync key 而不是按名字**匹配 `.conflicts`。被忽略的文件灰显；冲突行标红并给进入决策的入口。

---

## 10. 目录级权限（Path ACL）

### 10.1 安全叙事

**Knowledge 内容在服务端是明文的。** Path ACL 不改变这一点。它提供团队内的访问控制，不防运维、不防我们自己，不是端到端加密。**撤权只承诺「停止同步」，不承诺「收回已下发的副本」。** 对外措辞禁止使用「撤回」「收回」「吊销访问」。我们真正能交付的是**可追溯**。

### 10.2 数据模型

三张表：`amuxc_path_acl`（前缀 + 创建人，CHECK 钉死「必须在同步根下 + 以 `/` 结尾」）、`amuxc_path_acl_grants`（谁能看，拆两张表因为授权是审计对象）、`amuxc_access_log`（拒绝也记）。

### 10.3 判据收敛在一个模块

`services/fc/src/lib/sync-acl.ts`：`deniedPrefixesFor`（10s TTL）、`isDenied`、`matchingPrefixFor`。**性能红线：返回空数组时，所有下游查询必须与今天逐字相同。**

五个挂载点：manifest（追加 `NOT LIKE`）、upload/prepare、delete、versions、download。**download 需要额外的可达性检查**，因为它的入参是 `contentHash`——只过滤 manifest 是「藏起来」，不是「挡住」。

### 10.4 授权后如何让文件重新出现

解法是**授权时抬水位，零客户端改动**：`oss_change_seq + 1`，并把这些行的 `change_seq` 更新为新值。新获权的人本地 state 里没有这些路径 → `needs_download` 走 `None => true` → 下载；其他所有人 version 没变 → 空转跳过。

### 10.5 撤权的三步顺序

engine 判断「文件被本地删除」的依据是「在 state 里、不在扫描结果里」。所以清理顺序必须是：**先把前缀加入本地 ignore 判据 → 再删本地文件 → 再删 state 条目。** 顺序反了就是一次团队级数据丢失。

撤权的探测用**每 30 分钟把 manifest 窗口从增量放宽到全量**（从 seq 0 drain）。**`apply_revocations` 必须只在完整 drain 之后调用**，拿一页增量结果喂给它等于把「不在这一页里」判成「不再有权限」——那会删掉整个知识库。

### 10.6 403 自学

`PathForbidden` 不走 `record_item_error`（那会让文件保持 dirty、每 tick 重试、UI 一直红），而是写进 `forbidden`，进入本地 ignore 判据，不计错误。每 24 小时或重启后重试一次。刻意不做「通知你被授权了」的推送——那本身就会泄露目录存在。

---

## 11. 资料库惰性下载（documents）

`documents/` 默认不下载，manifest 里有就在树里显示，点了才取。`knowledge/` 不变，仍然全量。

关键决策：**D1 未下载的文件在磁盘上「什么都没有」**（否掉零字节占位，因为引擎靠内容哈希判断变更，而清空的文件与未下载的文件在磁盘上一模一样）；**D2 未下载的路径不进 `state.files`，新开 `known` 表**（这是最重要的一条：判断本地删除的依据正是「在 `files` 里、不在扫描结果里」，给 `FileState` 加 `materialized` 标志被否掉，因为总有人忘了检查）；**D3 反向操作只有手动释放**；**D4 释放三条红线**（dirty 绝不释放、不走墓碑路径、只动 `documents/`）；**D5 agent 只看到已下载的**（后果：同一个问题在不同人机器上答案不同）；**D7 离线直接报错，不排队**。

---

## 12. 安全叙事的统一口径

对内对外统一表述为：**服务端与对象存储可读的团队共享盘**；TLS 保护传输，**不是端到端加密**。因此：残留的「加密 / E2E」表述已清掉；MQTT hint 禁止携带路径；真 E2E 单独立项；ACL 的措辞与 ADR-0008 一致。

---

## 13. 运维与容量

| 项 | 值 | 状态 |
|---|---|---|
| 单文件大小 | 25 MiB | 已落地 |
| 单 tick 新增文件 | 2000 | 已落地 |
| 每 team 文件数 | 50000 | 已落地 |
| 每 team 字节 | 2 GiB | P1 |
| ACL 规则条数 | 64 | 已落地 |
| 审计留存 | 180 天 | 依赖未启用的 cron profile，第一版手工 |

**配额 ≠ 磁盘保护。** 物理占用还含历史版本 blob，回收靠 FC cron 的 `oss_sync_gc_orphan_blobs()`，而 cron 是 compose 的独立 profile，self-host 没开。ticket 关闭前对外不说「磁盘安全」。

---

## 14. 三个会删别人文件的陷阱

### 14.1 忽略规则迁移的 tombstone 广播

加 ignore 后，一个历史上已同步的文件会从 scan 结果里消失，于是引擎认为它被本地删除，**发 tombstone，删掉全团队每台设备上的这份文件**。解法是用 `is_ignored_with_ancestors` 过滤 tombstone 候选。

**上线前必须验证**：拿一个历史上同步过 `.DS_Store` 的团队做回归。

### 14.2 惰性下载与 `state.files`

未下载的路径**不进 `state.files`**。给 `FileState` 加标志会造出两种语义混在同一张表里，而这张表被十几处代码读。

### 14.3 撤权的本地清理顺序

见第 10.5 节。三步顺序不能拆。

### 14.4 三条教训的共同点

**一个路径从一个集合消失，到底是「本机没有」还是「已被删除」，必须由数据的形状而不是调用方的记忆来决定。** 所以解法都是「换一个容器」或「加一条硬排除」。

---

## 15. 关键文件索引

```
packages/app/src/lib/knowledge/       wiki-link / ignore / 文件名 / 剪枝 / obsidian
packages/app/src/components/teamshare/KnowledgeSyncFooter.tsx / KnowledgeConflictResolver.tsx
                                    / KnowledgeVersionHistory.tsx / KnowledgeAclDialog.tsx
packages/app/src/components/settings/KnowledgeAclSection.tsx
packages/app/src/lib/backend/cloud-api/knowledge-acl.ts
packages/app/src/lib/tabs/knowledge-tabs.ts
apps/desktop/src/commands/obsidian.rs
apps/daemon/src/sync/oss/{scanner,engine,ignore_rules,conflict,state,path_validator}.rs
apps/daemon/src/config/global_team_store.rs
services/fc/src/lib/{sync-handlers,sync-acl,sync-guards,sync-path}.ts
services/fc/src/lib/pg-repo/oss-sync.ts
```

---

## 16. 常见坑

1. `apply_revocations` 只能吃完整 drain 的结果。
2. 撤权清理的三步顺序不能拆。
3. 新状态字段一律 `#[serde(default)]`，且不提升 `SCHEMA_VERSION`。
4. pull 侧遇到不认识的路径必须 `continue`，不能 `return Err`。
5. 服务端淘汰清单不能加进 `validateSyncPath`。
6. `is_ignored` 与 `is_ignored_with_ancestors` 不能混用。
7. `.conflicts/` 与 `.amuxignore` 自身是硬规则。
8. `deniedPrefixesFor` 为空时下游 SQL 必须逐字不变。
9. 别把 agent 当成独立权限主体。
10. 别承诺「撤回」。

---

## 17. 未来路线

**P2 — 团队内可用**：`scaffold` 命令 + 三套模板（MOC/ADR/runbook）；聊天「存到知识库」右键；freshness 字段解析与 UI 标记。

**P3 — 跨团队发现**：`knowledge.manifest.yaml` schema + FC catalog 端点；客户端「发现」页；跨 vault 链接解析。

**P4 — 运营闭环**：健康度统计 + 设置页 dashboard；RAG 引用埋点。

**仍然冻结**：块级/CDC 同步、Markdown 行级 merge/OT/CRDT、活动流 UI、移动端 knowledge 同步、文本压缩上传、拉长 300s 定时器。**部分解冻**：按需下载仅限 `documents/`；`knowledge/` 的按需下载**不是「还没做」，是不该做**。

---

## 18. 附录 A：为什么选 Obsidian 作为主写入面

这是一个战略选择，不是技术选择，值得讲清楚。

### 18.1 为什么不自己做编辑器

TeamClu 已经有 Markdown 编辑器，为什么还要把外部工具当主写入面？

因为**笔记工具的用户体验不是一天能追上的**。Obsidian 有双向链接、关系图、搜索、插件生态、移动端、多年的细节打磨。用我们自己的编辑器去追，是一个永远追不上的比赛，而追的过程会不断占用 agent 相关功能的资源。

更关键的是：**知识库的价值在「写」而不是在「我们的编辑器」**。用户愿意用 Obsidian 写，就让他们用 Obsidian 写。我们只需要保证那份字节在团队成员之间同步、可被 agent 消费。

### 18.2 为什么不自己发明同步协议

反过来，为什么不让 Obsidian 的同步插件来做？因为它不满足两个需求：**团队范围**与**服务端可读**。Obsidian Sync 是个人级、端到端加密的；而我们需要的是团队共享、服务端可见（因为 agent 要读）。

所以分工是清楚的：**Obsidian 负责写，amuxd 负责同步，两者编辑同一份字节。**

### 18.3 代价

这个选择有三条代价，都被明确接受：

1. **路径难看。** vault 在 `~/.amuxd/teams/<uuid>/shared/team-sync/knowledge`，用户要手动「Open folder as vault」一次。
2. **重新 onboard 会换目录。** 团队换了或者本地状态重置了，用户要重新指一次 vault。
3. **不能是个人 vault 的子目录。** Obsidian 官方不支持 vault 内部的软链，watcher 可能收不到软链子树的外部写入。

三条换来的是「两边编辑同一份字节」这个最重要的性质。如果做镜像（把团队目录复制到用户 vault），每多一份副本就多一层冲突面，而冲突在 Markdown 上是最贵的。

### 18.4 一个更深的理由

这个选择还顺带解决了一个组织问题：**知识库不能是「又一个我们要求大家用的工具」。** 团队知识库失败的最常见原因不是技术，是「没人写」。如果写笔记需要打开 TeamClu、学一套新界面，那它注定只有少数人用。而如果只需要打开他们本来就在用的 Obsidian，写这个动作的门槛就降到最低。

这也是产品文档里「如何让大家愿意写」那一节的前提：工具层不能是障碍。

---

## 19. 附录 B：`team-sync` 布局迁移

内容根从 `shared/` 下移到 `shared/team-sync/` 是一次真实迁移，它有几个必须做对的点。

### 19.1 为什么要下移

因为它把三件靠纪律维持的事情变成了结构保证：`teamclu-team/` 自动在树外、`state/cloud` 自动在树外、workspace 符号链接不会种进同步根。原来靠「别放进去」的注释来维持，现在靠目录层级。

### 19.2 迁移的风险

迁移代码在 `global_team_store.rs`。几个关键点：

- **幂等。** 重复跑不能出错，因为可能中途失败。
- **两份同时存在要报错，不能猜。** 如果 legacy 与 team-sync 两份目录都存在，说明状态不明，必须停下来而不是选一个。
- **manifest 路径不变。** `documents/` 与 `knowledge/` 这两个前缀没有变，变的是它们在磁盘上的父目录。所以云端不需要任何迁移——这是这个设计最幸运的地方。

### 19.3 测试为什么重要

`global_team_store.rs` 的测试验证的就是上面三点：迁移能搬到新位置、幂等、两份同时存在时报错。这种「迁移一次且只一次」的测试在同步里非常关键，因为一次错误的迁移就是一次团队级事故。

### 19.4 一个可复用的原则

**让磁盘布局的变更不影响 wire 协议。** 如果这次迁移同时改了 manifest 路径，它就会变成一次需要两端同时升级的硬切——而硬切在客户端版本不一致时必然出问题。把变更限制在「本地布局」这一层，是这类迁移能安全做的前提。

---

## 20. 附录 C：Path ACL 的完整决策

把 ACL 的决策逐条列出来，方便改这块时对照。

| 编号 | 决策 | 结论 |
|---|---|---|
| D1 | 威胁模型 | 防团队内主动翻看 |
| D2 | 权限主体 | `actor_id`，v1 只写 member 的 actor |
| D3 | 权限轴 | 存权限位 `a:m:d`，v1 只实现「不可见」 |
| D4 | 粒度 | 任意深度前缀，强制 `/` 结尾，按分段边界匹配 |
| D5 | 合并语义 | 白名单 + 交集 |
| D6 | 撤权 | 停止分发 + 尽力删除，措辞降级 |
| D7 | 不下发受限前缀 | 拒绝时只带 `PathForbidden` |
| D8 | 对非空目录建规则 | 必须显式确认，返回影响 N/M |
| D9 | 审计落库 | `amuxc_access_log`，只记受限前缀相关 |
| D10 | 管理面 | owner/admin 限定 |

几条值得展开：

**D2：agent 继承召唤它的人。** 评审过「agent 作为独立主体」（比如「财务 agent 能读 `finance/`，人不能」），但这个语义在当前架构下做不出来。agent 拿到 knowledge 的方式是一个符号链接，**一台设备上只有一棵树，跑在这台设备上的所有 agent 看到的东西完全一样**。推论：控制设备主人的权限，就等于控制了他的所有 agent。

**D5：为什么不是黑名单。** 白名单的失败模式是「有人看不到该看的」——会被立刻投诉然后修好；黑名单的失败模式是「忘了加规则」——要等到泄漏才发现。在 D1 的威胁模型下，默认必须是「关」。直接推论：**新加入团队的成员，在管理员显式授权前看不到任何受限目录。这是正确行为，不是 bug。**

**D7：为什么不下发受限前缀。** 早期草案让服务端在 manifest 响应里回 `deniedPrefixes`，客户端喂进 ignore 层。在 D1 确定之后，这条变成了**主动把「有一个叫 `knowledge/hr/salary/` 的目录」告诉不该知道的人**——目录名本身经常就是敏感信息。改为拒绝时只带 `PathForbidden`，daemon 收到就记进本地「别再试」集合。

**D8：为什么必须显式确认。** 白名单语义下，管理员在已有内容的 `knowledge/hr/` 上建一条只给 alice 的规则，意味着团队里其他所有人**立刻失去**已经躺在他们磁盘上的那些文件。这是本功能最危险的操作。

---

## 21. 附录 D：一次撤权的完整时序

把撤权从服务端到两台客户端的行为展开，能看到顺序为什么不能错。

**第一步，服务端。** 管理员删规则或把人从授权列表移除。`deniedPrefixesFor` 下次（最多 10 秒缓存）就把它算进去。manifest 不再下发这些路径，download 可达性检查开始拒绝。

**第二步，被拒客户端 pull。** 下一次 tick（最长 30 分钟的全量 drain）中，本地 state 里有、全量清单里没有的路径，就是被撤权的。清理按三步：

1. 先把前缀加入本地 ignore 判据；
2. 再删本地文件；
3. 再删 state 条目。

**第三步，其他有权限的客户端。** 它们不受影响——它们的 manifest 仍然包含这些路径。**这是验收时必须真跑双端的那条**：撤权后被拒成员本地文件消失，且有权限的成员本地文件完好。

**第四步，如果该成员再次尝试写这些路径。** 403 `PathForbidden`，写进 `forbidden`，不再重试、不报红，24 小时后重试一次。

### 21.1 为什么不是「立刻」

从删规则到文件从对方磁盘上消失，最长可能是 30 分钟。这个延迟是有意接受的：

- D6 已经承认「撤权不保证收回已下发的内容」；
- 缩短窗口买到的真实保护很有限；
- 每个 tick 都做全量 drain 会让最热的查询永久正比于整个知识库。

如果管理员需要立刻生效，可以让对方重启客户端——但这不在产品承诺里。

### 21.2 一个容易忽略的后果

撤权后，被拒成员**不会再看到那些目录存在**。这是 D7 的直接效果，也是与「显示一个锁」相比更安全的选择：一个有锁的目录会告诉所有人「这里有个敏感目录」，而一个不存在的目录什么也不说。

代价是：被拒成员如果需要那些内容，他连「去申请权限」都无从下手——因为他不知道它存在。这是一个明知的取舍。

---

## 22. 附录 E：常见问题

**Q：为什么知识库不能选择性同步某个子目录？**
A：可以——用 `.amuxignore`。但那是自愿的、客户端的；要强制不可见用 Path ACL。两者不是一回事。

**Q：为什么用 Obsidian 而不是自己的编辑器？**
A：因为笔记工具的用户体验不是一天能追上的，而知识库的价值在「写」而不是「我们的编辑器」。

**Q：知识库能设权限吗？**
A：能，但只限 documents（资料库）。knowledge 的定位是「团队共识、全员一致」，所以 UI 不给它设权限的入口。

**Q：撤权后对方还能看到吗？**
A：服务端立刻不再下发（最多 10 秒缓存延迟），对方本地最多 30 分钟后清掉。**已拷走的副本收不回**。

**Q：同步是加密的吗？**
A：传输是 TLS，存储是明文。不是端到端加密。防的是外部，不是运维。

**Q：为什么冲突副本在 `.conflicts/` 而不是原文件旁边？**
A：因为放在旁边的话，它在 Obsidian 里就是一篇正经笔记（出现在文件树、关系图、搜索、链接补全）。

**Q：为什么删除一个文件会在别人的机器上也删掉？**
A：因为同步是双向的。不想删就把它从同步里排除（ignore 或 ACL），而不是删。

**Q：为什么新建的 2000 个文件被拦下了？**
A：因为那是防洪闸门，只数数不读名字。确认后点一下就能发。

**Q：为什么有些文件不会同步？**
A：可能被 ignore、超过 25 MiB、被服务端拒绝（422）、或被 ACL 限制。底部栏会告诉你是哪一种。

**Q：怎么在 Obsidian 里打开？**
A：Knowledge 列 header 上的按钮。没装 Obsidian 时它是灰的。如果 Obsidian 正在运行，首次注册需要重启一次。

---

## 23. 附录 F：验收清单

改这块时最少跑这几条：

1. 在 `knowledge/` 里 clone 一个带 `node_modules/` 的仓库：状态显示被忽略/被拦截，`amuxc_files` 没有新增行。
2. Obsidian 改一篇 → 另一台设备 ≤10 秒看到。
3. Obsidian 连续打字 10 分钟 → 本机 tick ≤ 120，且期间每次 tick 都有内容发出。
4. 冲突副本只出现在 `.conflicts/`；`merge.conflict.md` 照常同步。
5. 升级前同步过 `.DS_Store` 的团队，升级后云端那份仍在。
6. 无 ACL 规则的团队，manifest SQL 与改动前逐字相同。
7. 被拒成员：manifest 不含受限路径；download / versions / prepare / delete 均被拒。
8. 撤权后被拒成员本地文件消失，**且有权限的成员本地文件完好**。
9. 资源库全部释放后，下一次 tick 不产生任何墓碑。
10. `PathForbidden` 不产生重试、不报红，24 小时后重试一次。
11. 服务端审计只记受限前缀相关访问，无关流量不产生审计行。
12. 新 env 变量同时进了 compose 与 s.yaml。

---

## 24. 附录 G：术语

| 术语 | 含义 |
|---|---|
| 内容根 | `shared/team-sync/` |
| 同步根 | `documents/` 与 `knowledge/` |
| sync key | `knowledge/<rel>` / `documents/<rel>` |
| ALLOWED_PREFIXES | 三处镜像的白名单 |
| RETIRED_PREFIXES | 退役但仍被 wire 接受的前缀 |
| tombstone | 本地删除广播 |
| 水位 | `oss_change_seq` |
| hint | MQTT 的同步信号（不含路径） |
| coalescing window | 不重置的合并窗口 |
| 地板 | 两次 tick 的最小间隔 |
| `.conflicts/` | 冲突副本目录 |
| Path ACL | 目录级权限 |
| 完整 drain | 从 seq 0 拉全量 manifest |
| `known` 表 | 已知但未下载的路径 |
| 释放 | 未下载化（不是删除） |

---

## 25. 附录 H：知识库的运营层

技术只是基础。`team-knowledge-base-program.md` 里有一大块讲「怎么让大家愿意写」，值得在这里记一下要点，因为它解释了为什么有些功能不是技术选择而是运营选择。

### 25.1 三层模型

L1（个人草稿）/ L2（团队 vault）/ L3（公司发现）。关键规则是**知识只能向上流动**，而向上需要两个动作：L1 → L2 的「打捞」，L2 → L3 的「发布」。

为什么需要「打捞」这个动作？因为最容易产生知识的地方是聊天，而聊天是过程。如果不主动把结论挖出来，知识库永远不会被填满。所以产品上要有「把这段对话存到知识库」的入口。

### 25.2 标准目录结构

数字前缀（`00-home.md`、`10-onboarding/`、`20-domains/`、`30-decisions/`、`40-runbooks/`、`50-glossary.md`、`90-archive/`）。为什么用数字前缀？因为 Obsidian 的文件管理器按名称排序，数字前缀让结构在**原生文件树**里也是自解释的，不依赖任何插件。

这是一个很好的例子：一个看似审美的选择，实际上是为了「不依赖工具的特殊支持」。

### 25.3 三种页面类型

- 域索引页（MOC）：回答「这个域有什么」；
- 决策记录（ADR）：回答「当时为什么这么做」；
- 运行手册（runbook）：回答「出事了怎么办」，必须有 `last-verified` 字段。

三种类型对应三种「知识形状」：导航、历史、执行。分出它们是因为「一篇笔记该长什么样」是写作者最大的障碍之一，而给三种模板就能消除这个障碍。

### 25.4 健康度指标

覆盖度、新鲜度、使用度、打捞率。其中「新鲜度」最有用：`last-verified` 超期的 runbook 会标黄，让腐烂可见。

一个运营上的原则：**指标不排名、不考核，只用于自我诊断。** 一旦排名，写作者就会为了指标而写，而不为了内容。

---

## 26. 附录 I：一个可以复用的判断

这篇里反复出现同一个问题：**「这个东西不在本地，到底是本机没有，还是已被删除？」**

- tombstone 判据：在 state 里、不在 scan 里 → 认为是删除；
- 惰性下载：在 manifest 里、不在磁盘上 → 认为是未下载；
- 撤权：在 state 里、不在全量清单里 → 认为是撤权。

三种情况形状相同，但含义完全不同。三次事故/设计都来自于**把它们混起来**，而三次修法都是同一个：**给每一种「不在」一个独立的容器或一条硬排除。**

- tombstone 用 `is_ignored_with_ancestors` 排除被忽略的；
- 惰性下载用 `known` 表与 `files` 表分开；
- 撤权用完整 drain 才能判定。

这条判断可以推广到任何「同步/镜像」系统：**「缺失」是多义的，而系统必须能区分它们。** 一个只能回答「有/没有」的系统，在双向同步里一定会出错。

---

## 27. 附录 J：维护约定与一页纸摘要

### 27.1 与哪些文档强耦合

本文与以下内容同步，变动时要一起改：

- **新的同步根**：第 2.1、5、13 节；
- **忽略规则变更**：第 5 节；
- **ACL 决策变更**：第 10、20 节；
- **冲突目录变更**：第 8 节；
- **实时推送机制变更**：第 7 节；
- **惰性下载范围变更**：第 11 节；
- **安全叙事变更**：第 10.1、12 节。

一条写作约定：这篇的每一个决策后面都跟着「为什么不是另一个选项」。保留那部分，因为**取舍的理由比结论更容易丢失**，而丢掉理由之后，下一个人会重新提出那个被否掉的选项。

### 27.2 一页纸摘要

> 知识库是每团队一份、Obsidian 可直接打开的 Markdown vault。同步归 daemon，走 OSS + 内容寻址 blob + 增量 manifest + tombstone，不调用 git。
>
> 两个固定根：`documents/`（有归属的文件，可设权限）与 `knowledge/`（团队共识，不设权限）。三处白名单镜像，加前缀是硬升级。
>
> 实时性靠三条腿：fs 监听（本地）、MQTT hint（远端）、300 秒定时器（兜底）。调度器用 coalescing window + 地板，不是 debounce。
>
> 冲突走 `.conflicts/` 人工决策，不做行级 merge。
>
> 权限是目录级白名单，只在不设规则时对全员开放；撤权只承诺停止同步，不承诺收回已下发的副本。
>
> 服务端存储是明文，不是端到端加密。

这段话里每一句都对应至少一个常量或一个结构。把它记住，再读代码就有一个骨架。

### 27.3 最后一条

知识库是 TeamClu 里第一个面对「团队级数据丢失」风险的功能，而它积累的教训（缺失的多义性、完整 drain 才能判定、容器分离而不是标志位）在整个仓库里反复出现。如果只从本文带走一件事，就带这句：**在双向同步里，「没有」不是一个可以单独回答的问题。**

---

## 28. 附录 K：六种常见误用

**一、拿 knowledge 存大文件。** 它不是网盘，大二进制应该走对象存储引用。同步引擎虽然不论类型，但 25 MiB 闸门与团队配额不会因为你想存就放宽。

**二、把整个个人 vault 链进团队目录。** Obsidian 官方不支持 vault 内部软链，watcher 可能收不到外部写入，队友同步来的新笔记要重启才可见。

**三、同步 `.obsidian/`。** 会让版本号持续增长、跨设备永久冲突、每个人的界面被别人的布局覆盖。

**四、把 `node_modules/` 放进 knowledge。** 客户端 ignore 是第一道防线，单 tick 2000 新文件闸门是第二道，服务端清单是第三道，配额是第四道。四道都在，但不要故意去试探。

**五、把 ACL 当保密工具。** 它控制的是团队内谁能收到，不防运维、不防我们自己、不能收回已下发的副本。真正的敏感信息不应放在这里。

**六、用「删除」来「不想要」。** 删除是团队动作，会在所有人机器上删。不想要就用 ignore（自己看不见）或 ACL（别人看不见）。

这六条的共同点：**它们都把知识库当成它不是的东西。** 它不是网盘、不是个人笔记、不是保密工具、不是只有你的磁盘。每一条误用都对应一个产品文档里的边界。

---

## 29. 附录 L：三句话的速记

**一、两个根、两种性质。** `documents/` 有归属、可设权限；`knowledge/` 是共识、不切分。

**二、「没有」是多义的。** 本机没有、未下载、被撤权、被忽略——四个不同的意思，必须由不同的容器区分，不能靠调用方记得检查一个标志。

**三、同步归 daemon。** 关掉 app 不停同步；权限与配额在服务端，客户端只是第一道。

三句分别对应信息架构、正确性、所有权。如果只记一句，记第二句——它是本文所有事故的共同根因。

---

## 30. 附录 M：两个对比

**对比一：为什么知识库不做行级合并，而应用代码用 git？**

因为两者的冲突形态不同。知识库的冲突是「两个人在同一篇笔记上各自写了不同的东西」，且它是异步的（可能隔了几小时）；而代码的冲突是结构化的，有行号、有函数边界、有测试可以验证。给笔记做三路合并会在中文、表格、frontmatter 上出错，而一个会错的自动合并比人工决策更危险。

**对比二：为什么知识库同步不用 git，而 app 用？**

因为知识库的写入面是 Obsidian（图形界面、自动保存、不用 commit），而 app 的写入面是代码编辑与 agent。前者需要「无感」，后者需要「历史与分支」。同一个团队里两个工具用两套机制，不是冗余，而是因为它们的用户行为不同。

两个对比共同说明一件事：**技术选型要跟着使用场景走，而不是跟着「统一」走。**

---

## 31. 结语

知识库是 TeamClu 里第一个面对「团队级数据丢失」风险的功能，而它积累的教训在整个仓库里反复出现：缺失的多义性、必须完整 drain 才能判定、用容器分离而不是标志位、硬排除而不是可覆盖的规则、措辞不能承诺做不到的事。这些东西都不是「更好的工程实践」，而是对具体事故的直接回应。

功能本身的目标很朴素：让一个团队的 Markdown 笔记，快、一致、安全地待在每个人的机器上，同时 Obsidian 能直接打开。所有复杂性都是为了这个朴素目标不崩。而它能在不崩的前提下保持「用 Obsidian 写」这个前提，正是这个功能最难也最值得的部分。换句话说，它的成功标准不是「我们做了一个知识库」，而是「团队真的在用 Obsidian 往里面写东西」。

知识库这块的设计密度远高于它的代码量，因为**它踩的每一个坑都指向一次团队级数据丢失**：tombstone 判据、撤权清理顺序、`known` 表与 `files` 表的分离、服务端清单的误挡、`apply_revocations` 的入参形状。这些地方的共同点是——**正确性不能依赖调用方记得检查某个标志**。代码里反复出现的手法（拆纯函数、用类型分离、硬排除而不是规则、只在完整 drain 后调用）都是同一个答案。

功能本身的目标很朴素：让一个团队的 Markdown 笔记，快、一致、安全地待在每个人的机器上，同时 Obsidian 能直接打开。所有复杂性都是为了这个朴素目标不崩。
