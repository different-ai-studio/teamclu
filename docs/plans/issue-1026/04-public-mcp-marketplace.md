# [P2][#1026] 公共 MCP 市场：团队引入、版本审核与配置 Diff

父 Issue：#1026

依赖：子 Issue 3「MCP 按 Agent 管理」

## 背景

MCP 目前只有团队 catalog，没有公共 marketplace。Issue #1026 要求 MCP 与 Skills 一样
具备“公共 → 团队 → Agent”三层流转，但 MCP 配置可能改变本机执行命令、URL、参数和请求头，
不能照搬 Skills 的自动跟随更新。

## 目标

建设 FC 托管、第一方策展的公共 MCP catalog。公共条目只能先添加到团队，再由有权限的成员
安装给具体 Agent；公共新版必须经过团队 owner/admin 查看配置 diff 并人工确认，才能进入
团队 catalog。

## 范围

### 1. 第一方公共 catalog

- catalog 存放在 FC 管理的 Postgres 中，不接第三方 MCP Registry，不依赖 Git 仓库。
- 条目是声明式配置：名称、说明、transport、command/args 或 URL、env/header 占位符、
  平台/架构/runtime 兼容性、发布者和版本元数据。
- 公共条目不能包含 secret literal；secret-looking env/header 值必须使用 `${KEY}` 占位符，
  沿用并加强团队 MCP 现有校验。
- 写入口只开放给 marketplace admin，沿用现有 marketplace admin 的 fail-closed 共享密钥/
  发布 CLI 模式；普通团队成员只有读取与 adopt 权限。

### 2. 数据与版本模型

增加独立的公共 MCP 条目和追加式版本表。团队 MCP 记录增加来源与上游追踪字段，至少能表达：

- `origin = local | marketplace`
- 上游公共条目标识与当前采用的上游版本
- 是否仍关联上游、何时断开
- 团队当前配置快照

公共版本只前进，不原地覆写历史。公共下架不删除团队已经采用的配置快照；已采用团队仍可
查看和运行当前版本，但不能再从公共市场新 adopt。

### 3. 公共 → 团队

- 所有团队成员都能浏览公共 MCP，并把条目添加到团队。
- “添加到团队”只创建团队 catalog 条目，不给任何 Agent 安装。
- 已在团队中的公共条目标记“已在团队”，避免重复 adopt。
- 添加动作不受当前 Agent 兼容性限制，因为团队内其他 Agent 可能兼容。
- 团队条目创建者或团队 owner/admin 可以编辑/移除；编辑上游配置后自动断开公共关联。

### 4. 手动审核更新

公共 MCP 不自动跟随：

- 发布新版后，团队市场显示“有更新”。
- 详情必须提供结构化 diff，至少覆盖 command、args、URL、transport、env/header 键、权限/
  兼容性声明；secret 值不存在，因此也不得出现在 diff。
- 只有团队 owner/admin 能确认采用新版。
- 确认后更新团队配置快照；已安装的在线 Agent 自动刷新，必要时提示 runtime 重启。
- 离线 Agent 不阻塞团队确认，上线后按团队最新配置自动对账并标记版本滞后直到完成。
- 团队自行编辑过的 detached 条目不再提示上游更新，除非显式重新关联。

### 5. UI

在 MCP 第三列顶部启用“团队 / 公共”分段切换：

- 默认团队市场；保留两个页签各自的搜索/筛选状态。
- 公共条目展示发布者、版本、兼容性和是否已在团队。
- 团队条目展示来源、当前版本、是否有公共更新和当前 Agent 的安装/运行状态。
- 点击已安装条目仍进入详情；返回后恢复上次市场页签。
- 不兼容条目可查看但不能安装；公共 adopt 仍可执行。

### 6. Cloud API 顺序与测试

按仓库 Cloud API 边界实施：

1. 先更新 `docs/openapi/teamclu-api.v1.yaml`。
2. 更新 repository contract。
3. 实现 FC route。
4. 实现 pg-repo 与 Supabase passthrough。
5. 添加 migration、Drizzle schema 与 route/repository/contract 测试。
6. 最后接 desktop Cloud API provider 与 UI。

本任务只提交 migration 与测试，不自行对 live Supabase 执行变更；如需更新线上 schema，另按
AGENTS.md 要求使用配置好的 Supabase MCP 并在应用后读回验证。

## 不做

- 不接第三方 MCP Registry。
- 不允许公共条目携带密钥。
- 不在公共 adopt 后自动安装 Agent。
- 不让公共 MCP 自动跟随新版。
- 不让 Agent/retrospec 自主 adopt 或安装 MCP。
- 不做公共 MCP 的多团队批量管理后台。

## 验收

- [ ] 公共 MCP catalog 可浏览、搜索、查看版本；未配置 admin secret 时写 API fail closed。
- [ ] secret literal 被服务端拒绝，env/header 只接受安全占位符。
- [ ] 公共 adopt 只创建团队条目，不创建任何 Agent install row。
- [ ] 所有团队成员可 adopt；只有 owner/admin 能确认上游更新。
- [ ] 公共新版不会自动改变团队或 Agent 配置。
- [ ] 更新详情提供结构化配置 diff；确认后团队版本前进并触发在线 Agent 刷新。
- [ ] 离线 Agent 不阻塞团队更新，上线后完成对账并消除版本滞后。
- [ ] 团队编辑公共来源条目后自动 detached，不再静默跟随或提示更新。
- [ ] 公共下架不破坏已采用团队的历史配置。
- [ ] 团队/公共页签、详情返回和搜索状态符合统一导航规则。
- [ ] OpenAPI、repository contract、pg-repo/Supabase 实现及 route 测试保持一致。

## 主要落点

- `docs/openapi/teamclu-api.v1.yaml`
- `services/supabase/migrations/`
- `services/fc/src/db/schema/team-mcp.ts`
- `services/fc/src/db/schema/marketplace-mcp.ts`（新增，避免把 MCP 版本混入 Skills schema）
- `services/fc/src/lib/routes/marketplace-mcp.ts`
- `services/fc/src/lib/routes/team-mcp.ts`
- `services/fc/src/lib/pg-repo/marketplace-mcp.ts`
- `services/fc/src/lib/pg-repo/team-mcp.ts`
- `services/fc/test/`
- `packages/app/src/lib/backend/cloud-api/marketplace.ts`
- `packages/app/src/lib/backend/cloud-api/team-mcp.ts`
- `packages/app/src/components/teamshare/MarketplacePane.tsx`（落地时可拆成 Skills/MCP 共用壳）
