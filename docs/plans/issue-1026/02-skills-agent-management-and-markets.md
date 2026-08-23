# [P1][#1026] Skills 三层管理：按 Agent 查看/安装与 retrospec 自助

父 Issue：#1026

依赖：#1030「amuxd Agent 能力管理 RPC」

## 背景

当前 Skills 第二列按 Team Available / Team Installed / Personal 分组，并把本机文件与团队
registry 拼成列表；公共市场又会在“引入团队”后自动给调用者安装。这个模型既不能表达远程
Agent，也绕过了“公共 → 团队 → Agent”的三层边界。

## 目标

将 Skills 页面改造成“管理一个 Agent 的实际全局 Skills”：第二列只显示当前 Agent 实际
已安装的内容，第三列提供团队市场与公共市场。公共条目必须先进入团队，再由有权限的成员
安装到具体 Agent。

## 范围

### 1. Agent 选择器

在 Skills/MCP 共用的第二列底部增加单选 Agent 下拉：

- 只列当前成员拥有，或 `permission_level = admin` 的有效 Agent。
- Issue 原文中的 manager 在现有权限模型中映射为 `admin`，不新增第四种权限角色。
- `prompt` / `view`、人类 Actor、external Actor 和已归档 Agent 不出现。
- 只有一个可选 Agent 时自动选中；有多个时不猜测，用户必须选择。
- Skills 与 MCP 共享当前选择；Env/Knowledge 不显示选择器，也不受选择影响。
- 离线 Agent 仍可选中和查看已有信息，但所有安装、卸载、重试、移除操作禁用。
- capability 不支持时展示“需要升级 Agent”，不回退到直接读写文件。

### 2. 第二列：实际已安装 Skills

列表来自子 Issue 1 的 amuxd 实际盘点，不用 Cloud install row 冒充已落盘：

- 不再用 Team Available / Team Installed / Personal 大类分组。
- 混排当前 Agent 的全局已安装 Skills；团队条目单独显示“团队”标记。
- 内置条目标记只读；个人条目在线时可查看元数据并“从 Agent 移除”。
- 不展示 workspace-local Skills。
- Cloud 期望存在但实际缺失时显示“安装失败/需要修复”，不算正常已安装。
- Agent 切换后清空旧详情并重新盘点，不能借用当前电脑的文件推断远程状态。

个人 Skill 一期不支持远程编辑，也不支持从远程 Agent 直接发布到团队。移除是破坏性操作，
必须二次确认；请求使用稳定 ID，不能让客户端提交任意文件路径。

### 3. 第三列：团队市场 / 公共市场

- 进入 Skills 时默认“团队市场”。
- 顶部用“团队 / 公共”分段切换，并保留各自搜索条件。
- 点击第二列已安装条目时显示详情；返回后恢复上次市场页签和搜索状态。
- 团队市场展示团队 registry 的全部条目及当前 Agent 的兼容性/安装状态。
- 公共市场展示 FC 第一方 Skills marketplace。
- 不兼容条目保留可见并解释原因，但禁用安装；“添加到团队”不受当前 Agent 兼容性限制。

严格执行两步流转：

1. 公共市场“添加到团队”只 adopt，不自动安装。
2. 团队市场“安装”只作用于当前选中的 Agent；未选 Agent 时禁用并提示先选择。

一次只操作一个 Agent，不做批量安装。

### 4. 安装、卸载与团队移除

- 安装/卸载通过目标 Agent 的 amuxd 管理 RPC 执行；目标 daemon 用自己的 Actor token
  写 Cloud 期望并立即 reconcile。
- Skill 下载、校验、落盘全部成功后才显示 installed。
- 失败时保留 Cloud 期望，显示稳定错误、重试和卸载操作。
- 第二列主操作文案为“从此 Agent 卸载”，只影响当前 Agent。
- “从团队移除”只放在团队市场更多菜单，由条目创建者或团队 owner/admin 执行；确认框
  显示受影响 Agent 数量。
- 团队条目更新或移除不因某台 Agent 离线而阻塞；离线 Agent 上线后按团队最新 catalog
  自动对账。这属于团队配置同步，不是一次离线 Agent 操作队列。

所有团队成员都能浏览市场并把公共 Skill 添加到团队；编辑/移除团队条目仍沿用创建者或
团队 owner/admin 权限。安装到某 Agent 则必须拥有该 Agent 或具备 admin access。

### 5. retrospec 自助工具

在 retrospec 暴露给 Agent 的 MCP server 中增加自助工具：

- 查看团队 Skills catalog。
- 给“自己这个 Agent Actor”安装团队 Skill。
- 从自己卸载团队 Skill。

工具不能接收任意 `actorId`，也不能安装 MCP Server、编辑团队 Skill、从公共市场 adopt，
或代表其他 Agent 执行操作。返回值复用 amuxd 管理 service 的稳定状态/错误模型。

## 不做

- 不做多 Agent 批量安装。
- 不做 workspace-local Skills 管理。
- 不远程编辑/发布个人 Skill。
- 不让公共市场 adopt 自动触发安装。
- 不让 retrospec 自主安装 MCP Server。

## 验收

- [ ] 只有一个可管理 Agent 时自动选中；多个时必须手动选择且为单选。
- [ ] 切换 Agent 后列表来自目标 amuxd 的实际全局库存，旧详情被清空。
- [ ] 列表不再按团队/个人分组，团队来源以轻量标记表达。
- [ ] 公共 Skill adopt 后仅进入团队市场，没有任何 Agent install row 被创建。
- [ ] 团队市场安装只影响当前 Agent；离线/旧 capability 时按钮禁用。
- [ ] Cloud 期望与实际落盘不一致时显示失败与重试，不误报成功。
- [ ] 个人 Skill 只能查看元数据和移除；正文不会经 MQTT 返回。
- [ ] 团队移除和单 Agent 卸载在文案、权限和确认范围上明确分开。
- [ ] 不兼容条目仍可查看；安装被禁止且原因可读。
- [ ] retrospec 只能给自身安装/卸载团队 Skill，无法指定其他 Actor 或安装 MCP。
- [ ] Skills/MCP 共享 Agent 选择；Env/Knowledge 不受影响。

## 主要落点

- `packages/app/src/components/sidebar/TeamShareListColumn.tsx`
- `packages/app/src/components/teamshare/MarketplacePane.tsx`
- `packages/app/src/components/teamshare/SkillDetail.tsx`
- `packages/app/src/stores/team-share-browser.ts`
- `packages/app/src/lib/backend/cloud-api/team-skills.ts`
- `packages/app/src/lib/backend/cloud-api/marketplace.ts`
- `packages/app/src/lib/teamclu-rpc.ts`
- retrospec MCP server 的实际实现位置（落地前先在当前主线定位，禁止新建平行服务）
