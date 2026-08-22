# [P1][#1026] MCP 按 Agent 管理：实际状态、远程安装与运行诊断

父 Issue：#1026

依赖：#1030「amuxd Agent 能力管理 RPC」

可与 #1031 的 Skills UI 并行，但必须复用同一个 Agent 选择器和布局状态。

## 背景

当前 MCP 页面安装团队条目时固定调用本机 daemon；Cloud API 的 MCP install 又明确是
caller self-only。因此桌面端无法把团队 MCP 安装到自己管理的远程 Agent，列表中的工具数
和运行状态也只代表当前电脑。

## 目标

让 MCP 页面以当前选中的 Agent 为上下文，通过目标 amuxd 的实际配置与运行状态完成远程
查看、安装、卸载和诊断。Agent 不需要暴露 HTTP；远程操作走子 Issue 1 的 MQTT RPC。

## 范围

### 1. 共用 Agent 上下文

- 复用 Skills 第二列底部的单选 Agent 选择器与 owner/admin 过滤。
- 只有一个可管理 Agent 时自动选中；多个时必须手动选择。
- 离线或 capability 不支持时允许查看已有团队信息，但所有 Agent 操作禁用。
- 只管理 Agent 全局 MCP；workspace-local MCP 继续留在具体 workspace 的现有入口。

### 2. 第二列：实际已安装 MCP

列表以目标 amuxd 盘点为权威，不再用当前电脑的 workspace map 或 Cloud install row 代替：

- 团队 MCP 显示“团队”标记。
- 内置 MCP 显示只读标记，不允许编辑或移除。
- 不展示 workspace-local MCP。
- 每条分别展示 installed/configured 与运行状态：connected、needs-auth、failed、unknown。
- 配置已落盘即算 installed；连接失败不抹掉安装，而是显示经过脱敏的错误与重试入口。
- `env`、headers 只显示键和“已配置/缺失”，不显示值。

Cloud 期望存在但目标 Agent 实际缺失时显示 drift/安装失败；不能报告成正常 installed。

### 3. 第三列与操作

- 进入 MCP 时默认打开团队市场。
- 点击已安装 MCP 后，第三列展示配置摘要、兼容性、运行状态、工具列表和脱敏错误。
- 返回后恢复上次团队市场的搜索状态。
- 团队市场“安装”只作用于当前 Agent；一次只允许一个 Agent。
- 安装由目标 amuxd 使用自己的 Actor 身份调用现有 self-only Cloud API，再立即刷新 daemon
  MCP cache 与 runtime 状态。
- 卸载文案为“从此 Agent 卸载”，只影响当前 Agent。
- 启动/认证失败时保留 Cloud install row，提供重试和卸载，不自动回滚用户意图。

不要为展示列表无条件重新 spawn 所有 MCP 进程。优先返回 daemon 已知运行状态；需要主动
probe 时由详情页或“重试”显式触发，并沿用现有 probe 的超时与进程清理规则。

### 4. 团队 catalog 权限与删除

- 所有团队成员可浏览并向团队 catalog 添加 MCP；添加不等于执行。
- 创建者或团队 owner/admin 可以编辑、从团队移除。
- “从团队移除”放在团队市场更多菜单，并在确认框展示受影响 Agent 数量。
- 团队移除级联删除 Cloud install rows；在线 Agent 立即刷新，离线 Agent 上线后自动清理。
- 公共 MCP 市场、版本和审核更新由子 Issue 4 实现；本任务完成后若公共 catalog 尚未上线，
  不显示空的“公共”页签。

### 5. 安全边界

- Agent 选择器只提供 UX；所有写请求仍须由目标 amuxd 验证 management grant。
- 不把用户 bearer、MCP secret、env/header 值放入 MQTT payload 或日志。
- Agent 自己的 retrospec MCP 工具不能调用本任务的 MCP install/uninstall 方法。
- 兼容性不满足时保留条目可见并解释原因，但禁止强制安装。

## 不做

- 不做公共 MCP 市场与版本表。
- 不做多 Agent 批量安装。
- 不管理 workspace-local MCP。
- 不让 Agent 自主安装 MCP Server。
- 不用桌面端直接写远程文件或远程 `opencode.json`。

## 验收

- [ ] 同一个 MCP 页面可切换本地与远程 Agent，列表分别反映目标 amuxd 的实际状态。
- [ ] 远程 Agent 不需要 HTTP 可达，安装/卸载经 MQTT RPC 完成。
- [ ] 离线、无权限和旧 capability 三种情况均 fail closed 且文案不同。
- [ ] MCP 配置落盘但连接失败时显示 installed + failed/needs-auth，而不是回滚或隐藏。
- [ ] 列表和详情不泄露 env/header 值，错误与日志经过脱敏。
- [ ] workspace-local MCP 不进入 Agent 全局列表，也不会被团队卸载误删。
- [ ] 单 Agent 卸载与团队 catalog 移除的权限、文案和影响范围明确区分。
- [ ] 团队 catalog 删除不被离线 Agent 阻塞；该 Agent 上线后完成清理。
- [ ] 兼容性不足时安装被禁用且不可绕过。
- [ ] 页面不会仅因打开列表就无条件 spawn 全部 MCP Server。

## 主要落点

- `packages/app/src/components/sidebar/TeamShareListColumn.tsx`
- `packages/app/src/components/teamshare/McpDetail.tsx`
- `packages/app/src/stores/team-share-browser.ts`
- `packages/app/src/lib/daemon-local-client.ts`
- `packages/app/src/lib/teamclu-rpc.ts`
- `packages/app/src/lib/backend/cloud-api/team-mcp.ts`
- `apps/daemon/src/http/team_sync.rs`
- `apps/daemon/src/runtime/team_cloud_config.rs`
- `apps/daemon/src/mcp_probe.rs`
