# App 卸载部署实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 提供可确认、可恢复的部署卸载操作，停止应用访问并清理运行资源，保留用户数据并支持重新部署。

**Architecture:** Cloud API 持久保存操作及清理结果，以数据库原子生命周期锁协调部署、卸载和删除。可恢复执行器从内部定时入口推进清理，Web/桌面和 Agent 只通过 Cloud API 操作与查询。

**Tech Stack:** TypeScript、Postgres/Supabase、现有 FC/OSS/GoTrue 适配器、React/Zustand、Rust/Tauri。

**Spec:** [已批准规格](2026-10-05-app-undeploy-design.md)

## Global Constraints

- 不归档或删除 App、仓库、会话、schema、上传文件、业务 secrets、权限配置及任务历史。
- `uninstalling`、`uninstall_failed`、`uninstalled` 与历史成功部署信息分开表达。
- 仅管理员可以操作；Agent 需要专用确认；202 不代表卸载完成。
- 新请求停止转发；已发送业务请求可能完成。不承诺清理失败后已停止计费。
- 仅供应商明确的不存在错误是幂等成功；不打印签名 URL、token 和 secret。
- SKILL.md 全英文；AGENTS.md 中文且不增加详细部署流程。
- 测试仅针对新建专用 App。生产部署、已有用户 App 卸载不在本计划授权内。
- live schema 必须通过已配置的 Supabase MCP；没有可用 MCP 时保留迁移并报告阻塞。

## Review Focus

1. 部署 start 已调用供应商但尚未写回时，卸载不能误删或遗漏新资源（任务 1）。
2. 供应商响应超时不等于操作未执行，恢复必须先读回资源且隔离新部署（任务 2）。
3. 网关缓存及自定义域名不能继续转发已卸载 App（任务 4）。
4. 手动触发任务与定时调度都必须拒绝离线 App，恢复上线不补跑漏掉的周期（任务 4）。
5. OAuth 客户端恢复失败不能显示重新部署登录正常（任务 5）。

## 文件与接口边界

- 新增 `services/fc/src/lib/app-lifecycle.ts`：状态、资源快照、操作结果类型及生命周期服务。
- 新增 `services/fc/src/lib/app-undeploy-runner.ts`：持久任务推进及执行租约。
- 新增 `services/fc/src/lib/provisioning/app-undeploy.ts`：仅运行资源清理，不包含仓库/数据删除。
- 修改 `services/fc/src/lib/supabase-repo.ts`、`repository-contract.ts`、`routes/apps.ts`：权限、存储及路由。
- 修改 `services/fc/src/lib/apps-vanity.ts`、`app-cron-runner.ts`：转发与调度门禁。
- 修改 `packages/app/src/lib/backend/cloud-api/apps.ts`、对应 backend 类型、`stores/apps-store.ts`、`components/apps/AppSettingsPanel.tsx`：客户端能力和操作界面。
- 修改 `apps/desktop/src/commands/introspect_api/apps.rs`、`confirm.rs`、`apps/desktop/crates/teamclu-introspect/src/apps.rs`：Agent 操作和确认。
- 修改 `packages/app/src/lib/skills/deploy-app/SKILL.md`：卸载契约。

统一对外类型：`AppUndeployOperation = { id, appId, status: 'pending' | 'running' | 'failed' | 'succeeded', startedAt, updatedAt, steps, error }`；`steps` 固定键 `httpTrigger`、`originDomain`、`function`、`artifact`、`oauthClient`，各项为 pending/succeeded/failed/skipped。资源快照仅存目标名称及必要引用，不保存明文 secret。

## 任务 1：持久操作与生命周期互斥

**Files:** 新增 `services/supabase/migrations/20261005000000_app_undeploy_lifecycle.sql`、`services/supabase/tests/app_undeploy_lifecycle.test.sql`、`services/fc/src/lib/app-lifecycle.ts`；修改 `supabase-repo.ts` 和现有部署状态转换模块。

**Interfaces:** `undeployApp(appId: string): Promise<{ app: App; operation: AppUndeployOperation } | null>`；生命周期存储提供原子 acquire/renew/release，并通过操作 ID 条件更新完成状态。

- [ ] 添加 pgTAP 和 `services/fc/test/app-lifecycle.test.ts`：两次抢占仅一次成功；部署/卸载/删除互斥；预检 token 撤销；非管理员零副作用；旧 finalize 拒绝。
- [ ] 运行新测试，确认缺少表/接口或旧并发行为导致失败。
- [ ] 创建 `app_lifecycle_operations` 表和原子 RPC，RLS 限制外部直接写入；扩展 App 映射以查询操作。部署 start 在第一次外部调用前占有操作，finalize 及删除贯穿外部调用持有同一操作。
- [ ] 租约恢复不能立即允许新部署：先进入恢复中的互斥状态，等待旧供应商调用的有限 deadline 结束并读回资源；无法确认时保持失败且锁住新部署，允许重试恢复。所有外部调用设置有界 timeout，并在每项副作用前验证操作所有权。
- [ ] 验证新测试通过，并验证原部署状态转换测试不退化；提交 `feat(apps): persist exclusive deployment lifecycle operations`。

## 任务 2：分项运行资源清理

**Files:** 新增 `provisioning/app-undeploy.ts`、`services/fc/test/provisioning/app-undeploy.test.ts`；修改现有 FC/OSS/GoTrue 适配器，保留 `app-delete.ts` 的既有删除语义。

**Interfaces:** `cleanupAppDeployment(deps: AppUndeployDeps, snapshot: AppDeploymentResourceSnapshot, completed: UndeploySteps): Promise<UndeploySteps>`。deps 仅包含删除 Trigger/源站映射/函数/产物、禁用 OAuth 和必要读回接口。

- [ ] 添加失败测试：一个资源失败仍处理其余项；不存在成功；403/timeout 失败；仅删除快照指定资源；重试跳过成功项；没有资源可跳过。
- [ ] 运行 `cd services/fc && node --import tsx --test test/provisioning/app-undeploy.test.ts`，确认 RED。
- [ ] 实现清理适配器和错误脱敏；明确错误分类，不能复用吞异常的完整 teardown。超时后读回，不确认成功就保留 failed；禁止调用仓库归档、schema 或上传目录删除。
- [ ] 同一命令确认 PASS；提交 `feat(apps): clean deployment resources with resumable results`。

## 任务 3：API、可恢复执行器与部署环境接线

**Files:** 修改 `docs/openapi/teamclu-api.v1.yaml`、`repository-contract.ts`、`routes/apps.ts`、`supabase-repo.ts`、`services/fc/src/index.ts`；新增 `app-undeploy-runner.ts`、`services/fc/test/app-undeploy-runner.test.ts`；扩展 `routes-apps.test.ts`、`repository-contract.test.ts`。更新 self-host 与 Belayo 内部定时入口配置。

**Interfaces:** `POST /v1/apps/:appId/undeploy` 返回 202 + `{app, operation}`，已成功幂等返回 200；GET App 包含 `undeployOperation`。`runAppUndeployTick(deps): Promise<{ processed: number }>` 推进 pending/可恢复操作。

- [ ] 写路由/runner 失败测试：404、409、重复提交返回同一操作、部分失败串行重试、进程中断后的租约恢复、客户端断开任务仍存在。
- [ ] 运行这些测试确认 RED。
- [ ] 先定义 OpenAPI，再实现 repository 和路由。内部 `POST /v1/internal/app-undeploy/tick` 复用 cron-tick 身份验证；两个部署环境每分钟调用，限制单次工作量、超时和租约续期；HTTP 202 后不能仅依靠未等待的进程内 promise。
- [ ] 每项结果持久写回且校验操作 ID；全部完成才设置 `uninstalled`，失败设置 `uninstall_failed`，始终保持不可转发。
- [ ] 测试 PASS，运行 `pnpm --dir services/fc typecheck`、`pnpm --dir services/fc openapi:lint`；提交 `feat(api): expose recoverable app undeployment`。

## 任务 4：网关离线与定时任务隔离

**Files:** 修改 `apps-vanity.ts`、App host repository 查询/缓存映射、`app-cron-runner.ts`；新增 `services/fc/test/app-undeploy-gateway.test.ts`，扩展 `app-cron-runner.test.ts`。

**Interfaces:** `assertAppServing(appId)` 在转发前查询权威生命周期状态；存储故障 fail closed，不使用缓存中的 live 标记放行。

- [ ] 失败测试覆盖已预热缓存、默认/自定义域名、JSON/页面请求，均返回 503 且上游调用计数为零；其他 App 正常；手动/周期任务均不执行离线应用。
- [ ] 运行目标测试确认 RED。
- [ ] 接入门禁和 cache invalidation，响应 `Cache-Control: no-store`，统一“应用尚未上线或已下线”；离线任务保留定义，推进 next run 至未来，不制造补跑队列。
- [ ] 确认 PASS，跑现有网关与 cron 相关测试；提交 `fix(apps): stop gateway and scheduled calls during undeployment`。

## 任务 5：重新部署与登录恢复

**Files:** 修改 `supabase-repo.ts`、`provisioning/app-deploy.ts`、OAuth 适配器和运行时信息映射；扩展 `services/fc/test/app-deploy.test.ts`、`services/fc/test/provisioning/app-deploy.test.ts`。

**Interfaces:** 未清理完成拒绝 deploy/preflight；完成后可重新部署。运行时信息明确区分 historical successful configuration 和 active deployment。

- [ ] 失败测试：卸载后部署成功并复用保留数据；新 OAuth 客户端/恢复引用一致；客户端恢复失败不进入 live；清理未完成返回 409；旧 token 无效。
- [ ] 确认 RED，实施最小变更：重新创建运行资源；恢复或重新创建有效 OAuth 并原子保存引用；保留历史启动配置及权限。
- [ ] 确认 PASS，运行部署和 runtime-info 回归；提交 `feat(apps): redeploy retained apps after undeployment`。

## 任务 6：桌面/Web 卸载界面

**Files:** 修改 client App 类型和 backend contract、`cloud-api/apps.ts`、`stores/apps-store.ts`、`AppSettingsPanel.tsx`、现有中英文 i18n；扩展对应 backend/store/组件测试。

**Interfaces:** `apps.undeployApp(appId): Promise<{ app, operation }>`；store action 只更新服务端结果，按设置面板现有刷新方式查询进度。

- [ ] 失败测试：管理员入口、非管理员无入口、未部署禁用、确认取消无请求、202 显示卸载中、成功不显示 Live、失败分项和重试、生命周期冲突禁用操作。
- [ ] 用 `pnpm --dir packages/app exec vitest run` 加上述具体测试文件运行，确认 RED。
- [ ] 实现独立“卸载部署”入口和确认：“线上应用将停止服务。代码、会话、数据库和上传文件会保留，之后可重新部署。”使用现有设计 token，不新增全局跨窗口同步。
- [ ] 测试 PASS，进行桌面实际 UI 检查；提交 `feat(apps): add deployment uninstall controls`。

## 任务 7：Agent 操作、专用审批与 skill

**Files:** 修改 `apps/desktop/src/commands/introspect_api/apps.rs`、`confirm.rs`、`apps/desktop/crates/teamclu-introspect/src/apps.rs`、`packages/app/src/lib/skills/deploy-app/SKILL.md`；扩展 Rust 操作/确认测试及 `scripts/lib` skill 契约测试。

**Interfaces:** `manage_app action: undeploy` 使用当前 App 绑定；审批通过后调用 Cloud API，回复含 operation 和明确 pending/completed/failed 状态；status 提供进度。

- [ ] 失败测试：错误 App 实例拒绝、Full Access 仍走专用确认、取消无 API 调用、202 不返回已完成、确认列明保留数据和停止服务地址。
- [ ] 使用仓库 `scripts/rust-cli.js` 对 desktop crate 运行目标测试，确认 RED。
- [ ] 接线 Rust client/action/confirmation；英文 skill 补充卸载、重试、重新部署契约，不写入 AGENTS.md 详细说明。
- [ ] 测试 PASS，Rust fmt 及 skill 契约测试通过；提交 `feat(agent): support confirmed app undeployment`。

## 任务 8：完整回归及 dev 专用 App 验收

**Files:** 新增 `docs/specs/2026-10-05-app-undeploy-acceptance.md`；可复用现有测试 harness，不写用户 fixture 业务代码。

- [ ] 运行 FC 全量 `pnpm --dir services/fc test`、typecheck/build、相关 Web 测试及 Rust 测试、OpenAPI lint、`git diff --check`；仅新变更/失败后补跑。
- [ ] 审查迁移、权限、生命周期恢复和数据保护；修复发现的问题并补测试，未确认供应商调用恢复边界不得宣称完成。
- [ ] live 迁移经 Supabase MCP 应用并读回验证；无可用 MCP 则报告这项阻塞，继续完成本地检查。
- [ ] PR 合并并获 dev 部署授权后部署；让 TeamClu 新建专用 App，写入记录/上传图片并验证登录，再执行卸载审批。
- [ ] 验证所有入口 503、供应商资源清理、数据/文件/仓库/会话仍存在；用隔离适配器失败注入测试验证重试，不能通过修改真实账号全局 RAM 权限制造失败。
- [ ] 重新部署验证记录/图片和平台登录恢复；验证另一个 App 不受影响。记录 commit、操作 ID、实际结果及待验收项目，不记录凭据。
- [ ] 提交验收报告；只有用户明确说“open PR”才推送/建 PR。

## 实施顺序与审批边界

依赖顺序：1 → 2 → 3 → 4 → 5；6 和 7 在 API 稳定后实施；8 最后完成。推荐在本会话顺序实施，共用接口较多，减少协调成本。若选择分代理，可在任务 3 完成后分别实施 6、7，并独立审查每项及整分支。

计划批准和执行方式选择后才开始产品代码。执行时使用 task worktree，保留当前 dev 运行进程和已有未提交改动；不得因切换测试停止开发版。
