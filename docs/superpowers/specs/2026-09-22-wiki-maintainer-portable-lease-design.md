# Wiki Maintainer 跨设备接管设计

- **Date**: 2026-09-22
- **Status**: ACCEPTED
- **Scope**: 任意已登录 Desktop 可接管 Wiki 编译；团队级单写租约；跨设备 checkpoint；崩溃恢复
- **Builds on**: `docs/specs/2026-09-20-llm-wiki-maintainer-p0-design.md`
- **Supersedes**: 原设计 D14 的“固定专用机”约束，以及配置中的 `maintainerNodeId`

## 1. 目标

当前 Wiki Maintainer 把增量状态、Git 工作树、raw 缓存、发布基线和未完成发布标记都保存在一台 Desktop 上。即使移除 `maintainerNodeId` 检查，另一台机器也无法安全继续运行。

本设计把“唯一维护设备”改成“团队级唯一写者”：

1. 任意 owner/admin 登录的 Desktop 都可以启动维护。
2. 同一团队任意时刻只有一个有效写者。
3. 原机器异常离线后，另一台机器能在租约超时后自动接管。
4. 接管机恢复已完成来源和待发布结果，不重复调用已经完成的 LLM 工作。
5. 旧机器恢复后不能覆盖新机器的 checkpoint 或发布结果。
6. Cloud 端不保存原始资料、模型凭据、Pi transcript 或详细运行日志。

不在本设计范围内：

- 多台设备并行编译同一团队并自动合并。
- 把编译迁移到服务端或 headless daemon。
- 改变 `documents/`、`knowledge/wiki/` 的内容格式或现有同步协议。
- 为本机模型自动选择替代模型。

## 2. 总体架构

Cloud API 是协调面，只保存：

- 团队 Wiki Maintainer 配置；
- 当前租约及 fencing epoch；
- 当前运行和发布阶段；
- checkpoint 元数据与当前 generation 指针。

对象存储保存不可变 checkpoint 包。Desktop 继续执行资料下载、抽取、Pi 编译、确定性校验、Git 提交和本地发布。`documents/` 与 `knowledge/wiki/` 继续通过现有团队同步传播。

本地工作目录仍可缓存恢复后的 Git 仓库和 raw 文件，但不再是唯一真相。删除本地目录后，可以用最新 checkpoint 加团队资料重新恢复。

## 3. 租约与 fencing

每个团队最多有一个未过期租约：

| 字段 | 含义 |
| --- | --- |
| `teamId` | 团队 ID |
| `holderNodeId` | 当前 Desktop/daemon 节点 ID |
| `leaseId` | 本次持有实例的随机 ID |
| `epoch` | 每次成功接管后递增的 fencing token |
| `expiresAt` | 服务端计算的租约到期时间 |
| `checkpointGeneration` | acquire 时观察到的 checkpoint generation |

默认租期为 90 秒，持有者每 30 秒续租。正常退出主动释放；进程崩溃或设备离线后，其他设备在租约到期后可以 acquire 并获得更高 epoch。

以下写操作都必须携带 `leaseId + epoch`：

- renew/release；
- checkpoint prepare/complete；
- publish begin/complete/recover。

服务端使用条件更新验证租约仍有效、epoch 匹配。旧 epoch 永远不能再次生效。客户端时间不参与租约有效性判断。

编译期间暂时断网时：

1. 不再开启下一份来源。
2. 当前来源可以完成本地提交或回滚。
3. 恢复网络并成功续租前，不得上传 checkpoint 或发布。
4. 如果续租返回 epoch 已失效，客户端立即转为只读并丢弃尚未上传的本地结果。

只有 team owner/admin 可以 acquire、接管和发布。普通成员只能读取维护状态和结果摘要。

## 4. Checkpoint 契约

checkpoint 是不可变压缩包：

```text
manifest.json
state.json
wiki.bundle
prepared-run.json
```

`manifest.json` 至少包含：

- checkpoint schema version；
- team ID、generation、父 generation；
- 创建时使用的 lease epoch 和 node ID；
- Wiki HEAD、published commit、目标 tree hash；
- 配置版本和 `_schema.md` hash；
- source 状态摘要；
- compiler `provider/model`；
- 包内文件的大小和 SHA-256。

`state.json` 保留现有增量语义，包括 source hash、extractor cache key、affected pages、last imported commit 和 published commit。

`wiki.bundle` 必须足以恢复 `publishedCommit` 到当前 HEAD 的提交和 refs。发布成功后创建新的压缩基线，避免历史无限增长。服务端保留最近 3 个发布基线，以及最新基线之后的当前运行链；未被 generation 指针引用的上传对象保留 24 小时后清理。

`prepared-run.json` 保存可发布候选、校验结果摘要、配置版本和目标 tree hash。没有待发布批次时该文件为空对象。

checkpoint 禁止包含：

- raw 原文和抽取缓存；
- 模型密钥或其他凭据；
- Pi session/transcript；
- 详细失败日志；
- 本机绝对路径。

raw 在接管机按需从 `documents/` 重新下载和抽取。checkpoint 指定 extractor 名称与版本；相同版本不可用时，该来源暂停，不能静默换解析器。

## 5. Checkpoint 提交协议

上传使用两阶段协议：

1. Desktop 调用 prepare，提交预期大小、SHA-256、父 generation、当前 config version 和 lease fencing 信息。
2. Cloud API 返回短期预签名上传地址。
3. Desktop 上传不可变压缩包。
4. Desktop 调用 complete。
5. 服务端校验对象大小和 SHA-256，再以 `expectedGeneration` 做 CAS。
6. CAS 成功后，团队当前 checkpoint 指针原子推进。

如果租约失效或 CAS 冲突，checkpoint 指针不移动。已上传但未引用的对象由后台清理。

每份来源通过校验并完成本地 Git 提交后，立即创建 checkpoint。因此接管最多重做正在处理、尚未成功 checkpoint 的一份来源。

## 6. 发布协议与崩溃恢复

发布不再只依赖本机的 `publish-incomplete.json`。

### 6.1 开始发布

`publish/begin` 验证：

- 当前租约与 epoch；
- 当前 checkpoint generation；
- prepared run 的 config version；
- 待发布 commit 和 tree hash；
- 当前知识库发布基线。

成功后，团队状态原子进入 `publishing`，记录 generation、目标 commit、目标 tree hash、epoch 和发布基线。此后不能开始新的编译。

### 6.2 完成发布

Desktop 按现有顺序幂等写入 `knowledge/wiki/`：

1. 写入或更新正文页；
2. 原子更新 index；
3. 删除目标树中不存在的旧页；
4. 校验最终 tree hash；
5. 触发现有团队同步；
6. 调用 `publish/complete`。

complete 推进 published commit、保存同步状态、创建发布后 checkpoint，并清除 `publishing` 状态。

### 6.3 接管未完成发布

新持有者发现团队状态为 `publishing` 时，必须先进入恢复流程：

- 本地知识库 tree hash 已等于目标：补记发布成功；
- tree 是可解释的部分写入：从 checkpoint 幂等重放目标树；
- tree 与记录的基线和目标都不一致：停止并要求人工处理，禁止覆盖。

恢复完成前不得开始新的编译。

## 7. Cloud API 与数据模型

新增以下 `/v1` 接口：

- `GET /v1/teams/:id/wiki-maintainer`
- `PUT /v1/teams/:id/wiki-maintainer/config`
- `POST /v1/teams/:id/wiki-maintainer/lease/acquire`
- `POST /v1/teams/:id/wiki-maintainer/lease/renew`
- `POST /v1/teams/:id/wiki-maintainer/lease/release`
- `POST /v1/teams/:id/wiki-maintainer/checkpoints/prepare`
- `POST /v1/teams/:id/wiki-maintainer/checkpoints/complete`
- `GET /v1/teams/:id/wiki-maintainer/checkpoints/latest/download`
- `POST /v1/teams/:id/wiki-maintainer/publish/begin`
- `POST /v1/teams/:id/wiki-maintainer/publish/complete`
- `POST /v1/teams/:id/wiki-maintainer/publish/recover`

配置更新使用版本前置条件，避免两个管理员互相覆盖。checkpoint 下载只允许 owner/admin，因为包内包含来源路径和未发布 Wiki。

数据库采用 expand-only 变更，新增：

1. 团队维护配置记录；
2. 当前租约、运行和发布协调记录；
3. checkpoint 历史及对象元数据。

不修改现有 API 字段、同步表或 daemon 请求语义。旧 Desktop 和旧 daemon 不调用新接口，行为不受影响。

Cloud API 实现必须遵守仓库现有业务端点顺序：先更新 OpenAPI，再更新 repository contract、route、Supabase repository 和测试。self-host 与 Belayo 的对象存储环境契约必须同时支持 checkpoint。

## 8. 模型可用性

模型属于一次运行，checkpoint 记录准确的 `provider/model`。

接管机缺少原模型时：

- 可以恢复、查看并发布已经完成的 prepared run；
- 不能继续编译剩余来源；
- UI 进入 `waiting_for_model`；
- owner/admin 明确选择新模型后，创建新的 run revision，再继续剩余队列。

系统不静默 fallback 到团队模型。这样允许继续使用本机模型，同时避免接管时在用户不知情的情况下改变模型。

## 9. Desktop 状态机

团队维护状态包括：

- `idle`
- `acquiring_lease`
- `restoring_checkpoint`
- `waiting_for_model`
- `compiling`
- `ready_to_publish`
- `publishing`
- `sync_pending`
- `needs_attention`

任意 Desktop 打开维护面板时先读取团队状态：

- 有有效租约时，显示持有设备和最近心跳，不提供普通启动按钮；
- 租约过期后，owner/admin 可以接管；
- `ready_to_publish` 可以在接管机直接发布，不重新调用模型；
- 取消运行会回滚当前未完成来源、保留最后成功 checkpoint 并释放租约；
- 配置变化会递增 config version，既有 prepared run 不自动套用新配置；
- 正常进程退出释放租约，关闭单个窗口不释放。

## 10. 失败处理

| 失败 | 行为 |
| --- | --- |
| checkpoint 下载或 hash 校验失败 | 重试；仍失败则回退上一 generation |
| 单来源编译失败 | 回滚该来源，保持上一个成功 checkpoint |
| renew 暂时失败 | 暂停开启新来源和发布 |
| epoch 失效 | 转只读，丢弃未上传结果 |
| checkpoint CAS 冲突 | 不推进指针，重新读取团队状态 |
| checkpoint schema 过新 | 提示升级 Desktop，不做降级写入 |
| 接管机缺少模型 | 进入 `waiting_for_model` |
| 接管机缺少 extractor 版本 | 暂停对应来源，不静默换版本 |
| 发布目标部分写入 | 按目标 checkpoint 幂等重放 |
| 知识库出现不可解释修改 | 停止并要求人工处理 |

## 11. 迁移

该功能尚未进入 `main`，首个正式版本直接使用团队租约方案，不保留本机模式与云端模式双轨。

首次启动：

- 云端无 checkpoint、本机有有效状态：取得租约后上传 generation 1；
- 云端和本机都无状态：从空基线开始；
- 云端无 checkpoint，但 `knowledge/wiki/` 已有内容：使用显式“接管现有 Wiki”，校验页面来源后建立初始 checkpoint。

移除配置中的 `maintainerNodeId`。原规格 D14 被本设计的团队租约替代；Agent 工具监狱、ACL 预检、来源追踪、确定性校验和发布边界保持不变。

## 12. 测试

### 12.1 单元测试

- acquire 竞争、续租、到期、释放和 epoch 递增；
- 服务端时间决定租约有效性；
- checkpoint generation CAS；
- checkpoint manifest/hash 校验；
- stale epoch 拒绝 checkpoint 和 publish；
- 状态机合法转换；
- checkpoint 内容敏感项扫描。

### 12.2 集成测试

- 两台 Desktop 同时 acquire，只有一台成功；
- 原持有者离线，另一台超时接管；
- 旧持有者恢复后不能续租、上传或发布；
- 每份来源完成后崩溃，接管机不重复调用已完成来源；
- `ready_to_publish` 换机后直接发布；
- 页面写入、index 写入和同步前分别崩溃后均可恢复；
- 最新 checkpoint 损坏时回退上一 generation；
- 缺少原模型时暂停，明确选择新模型后继续；
- macOS 与 Windows 恢复同一 bundle 后 tree hash 一致；
- 旧 daemon 对新增 API 和表无感。

### 12.3 验收标准

- 原机器异常离线后，另一台在租约超时后的 2 分钟内可以接管；
- 已 checkpoint 的来源不会重复调用 LLM；
- 未发布候选可以跨机器直接发布；
- 任意时刻最多一个 epoch 能推进 checkpoint 或发布；
- 旧机器无法覆盖新机器结果；
- 换机不需要人工复制配置、Git 目录或 state 文件；
- Cloud checkpoint 不包含 raw、模型凭据、transcript 或本机绝对路径。

## 13. 被否决的方案

### 13.1 状态放进团队同步目录

把 Git/state 放入 `knowledge/.wiki-maintainer/` 或 `documents/` 虽然少建接口，但现有同步不是事务锁，无法可靠 fencing。它还会污染知识同步、搜索、bulk gate 和用户文件树，因此否决。

### 13.2 从已发布 Wiki 无状态重建

可以从 frontmatter 推导部分 source 状态，但无法恢复待发布结果、精确 Git 基线和未发布 affected-pages 历史。换机后需要大量重算，也不满足无缝接管，因此只保留为人工灾难恢复手段。

### 13.3 多写者自动合并

多个模型会同时修改 index 和主题页，Git 文本合并不能解决语义冲突或来源撤回冲突。P0/P1 继续采用单写者，不建设自动合并。
