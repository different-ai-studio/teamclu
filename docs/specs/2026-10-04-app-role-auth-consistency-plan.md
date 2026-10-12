# 应用组织角色鉴权一致性 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 统一平台权限编辑器、Agent 工具与网关的角色语义，保留旧规则的动态受众及继承关系。

**Architecture:** 保留已有 authScope/authAudience/authRules 存储与组织 RBAC。新增只读 Cloud API auth-info 聚合，Agent 与桌面均通过 Cloud API 获取组织事实；桌面编辑状态区分动态组织受众、指定角色及继承，保存只改写用户明确编辑的规则。网关沿用当前实时角色判断，通过回归测试确认一致性。

**Tech Stack:** TypeScript / Node test runner / Hono / Supabase repository；React / Zustand / Vitest；Rust / Tauri introspect；OpenAPI。

**Spec:** [已批准规格](2026-10-04-app-role-auth-consistency-design.md)

## Global Constraints

- 本次只修复平台。不得修改 james-test-app7 或其他测试应用的代码、环境变量、员工接口路径和线上权限；不得代替 TeamClu Agent 修复应用。
- 不重构现有组织与团队成员模型，不新增角色、不调整角色分配，不把组织角色改成 team 独立角色。
- 不增加创建者 ID 白名单，也不新增基于 User ID 的员工权限模型。
- 显式 roles（包括空数组）优先于每条规则的 audience，再优先于应用 authAudience。
- authRules 全量替换契约不变；无批量迁移、无数据库 schema/RLS 变更。发现需要变更时先更新规格。
- 所有客户端后端访问经 Cloud API。保留既有 app/组织读取检查、原生更新审批及 admin 写入检查。
- 分支内提交；用户明确要求打开 PR 前不得推送。平台上线需要当次授权，批准计划不等于批准上线。

## Review Focus

1. 同一规则同时带 roles 与 audience：roles 优先，未编辑时不得清理或改变原表示（任务 1、3）。
2. scope=all 无根规则，异常规则又继承默认：编辑其他路径不得注入根规则或改变默认（任务 3）。
3. 目录请求晚返回、app 切换或保存失败：不能覆盖草稿、混入另一组织或报告成功（任务 3）。
4. 保存后角色被停用/删除：仍显示原 code，不能静默删掉并产生开放规则（任务 3、4）。
5. app 可读但目录不可读或 org 未配置：不得借聚合接口越权，也不能返回空目录伪装成功（任务 1、2）。

## 文件结构与执行依赖

本问题是同一权限契约的跨端修复，四个任务共享契约，不拆成互不兼容的独立规格。每个任务独立提交和验证。

| 任务 | 主要文件与职责 | 依赖 |
| --- | --- | --- |
| 1 | OpenAPI；FC auth-info 聚合和有效受众解析；Cloud API 客户端类型 | 无 |
| 2 | desktop introspect 的 auth_info action、roles schema 和转发 | 1 |
| 3 | app-auth-access 编辑状态、AppAuthTabContent、组织角色文案 | 1；不依赖 2 的实现 |
| 4 | 网关兼容回归、deploy-app skill、完整验证与 dev 验收 | 1–3 |

任务 2、3 可在任务 1 的契约提交后独立实现；执行方法待用户选择。本轮不启动实施代理。

## Task 1: Cloud API 只读鉴权信息契约

**Files:**
- Modify: `docs/openapi/teamclu-api.v1.yaml`
- Create: `services/fc/src/lib/apps-auth-info.ts`（响应组装和有效受众解析）
- Modify: `services/fc/src/lib/routes/apps.ts`
- Modify: `services/fc/src/lib/supabase-repo.ts`
- Modify: `services/fc/test/repository-contract.test.ts`（现有 contractRepo 夹具）
- Modify: `services/fc/test/supabase-repo.test.ts`（实际 repository 权限/聚合测试）
- Modify: `services/fc/src/lib/repository-contract.ts`
- Modify: `services/fc/src/lib/apps-auth-paths.ts`（修正文档中 audience 仅兼容读取的过时描述；保留现有匹配算法）
- Modify: `packages/app/src/lib/backend/types.ts`
- Modify: `packages/app/src/lib/backend/cloud-api/apps.ts`
- Create: `services/fc/test/apps-auth-info.test.ts`
- Modify: `services/fc/test/routes-apps.test.ts`
- Modify: `packages/app/src/lib/backend/cloud-api/__tests__/apps.test.ts`

**Interfaces:**
- 新增 `GET /v1/apps/{appId}/auth-info`；FC repository 新增 `getAppAuthInfo(appId: string): Promise<AppAuthInfo>`。
- 客户端 `AppsBackend.getAppAuthInfo(appId: string): Promise<AppAuthInfo>`，不将 403/404/上游失败转换为空结果。
- HTTP/client 响应使用 camelCase；类型 `AppAuthInfo`：`appId: string`、`teamId: string`、`organization: {id: string; name: string} | null`、`roleScope: 'organization'`、`roles: Array<{id: string; code: string; name: string; status: string}>`、`authMode`、`authScope`、`authAudience`、`authRules`、`effectivePolicies: EffectiveAuthPolicy[]`、`organizationStatus: 'configured' | 'unconfigured'`。
- `EffectiveAuthPolicy`：`path: string`、`kind: 'public' | 'any_authenticated' | 'any_org_role' | 'org_roles'`、`roleCodes: string[] | null`、`inherited: boolean`、`source: 'auth_mode' | 'roles' | 'rule_audience' | 'app_audience' | 'scope_baseline'`。public/any_authenticated 为 []，any_org_role 为 null，org_roles 为固定列表。基准策略使用 path='/'；有根规则时反映该规则，否则反映 scope/mode/app 默认，不在原 authRules 中插入规则。
- FC helper `buildAppAuthInfo(input: AppAuthInfoInput): AppAuthInfo`；`AppAuthInfoInput` 定义为 `Pick<AppAuthInfo, 'appId' | 'teamId' | 'organization' | 'roles' | 'authMode' | 'authScope' | 'authAudience' | 'authRules'>`；输入为原始 app 配置、应用有效组织信息及已授权读取的有效目录。身份/权限查询在 repository 内完成，helper 不访问存储。
- 应用组织以网关使用的 app org 为准；只有既有兼容逻辑允许时才从 team 解析。不从当前客户端选中的 team/org 猜测。

- [ ] **Step 1: 定义 OpenAPI 资源与响应。** 明确 401、403、404 及上游不可用错误；org 未配置返回 organization=null、organizationStatus=unconfigured，禁止当作可配置目录。目录授权失败使整个请求失败；不返回部分成功的空目录。
- [ ] **Step 2: 写失败测试。** `auth_info_preserves_raw_rules_and_precedence`：输入 `{path:'/staff',auth:'required',roles:[],audience:'org'}`，断言原规则保留，kind=any_authenticated、source=roles；无 roles 的 org 规则断言 kind=any_org_role、roleCodes=null。`auth_info_checks_app_and_catalog_visibility`：app 可读但目录不可读，断言 403 且无目录泄漏。覆盖无组织、继承 any/org、authMode 非 platform、scope all/paths、固定角色及自定义 reviewer。
- [ ] **Step 3: 运行失败测试。** `cd services/fc && node --import tsx --test test/apps-auth-info.test.ts test/routes-apps.test.ts`，确认新增接口/断言失败，且失败不是环境或依赖错误。
- [ ] **Step 4: 实现接口和 repository。** 先调用现有 app 读取权限，再以应用 org 检查并读取目录，复用已有 `listOrgRoles` 的权限语义而非扩大 service-role 可见性。组装前筛选 active。现有 test contractRepo 夹具提供同样方法；repository contract 添加成功及错误契约，supabase-repo 测试模拟真实存储授权链。用现有 path policy 解析结果校验有效语义，避免另造匹配算法。
- [ ] **Step 5: 实现客户端类型和 GET。** 测试断言正确 URL、响应完整、403 原样抛出；实现 `createAppsModule().getAppAuthInfo`。API/client 类型与 OpenAPI 一致。
- [ ] **Step 6: 验证。** FC 上述测试，加 `test/repository-contract.test.ts`、`test/supabase-repo.test.ts` 通过；`pnpm --dir services/fc typecheck`、`pnpm --dir services/fc openapi:lint`、`pnpm --dir services/fc openapi:types` 通过。客户端 `pnpm --dir packages/app test:unit src/lib/backend/cloud-api/__tests__/apps.test.ts` 通过。
- [ ] **Step 7: 提交。** `feat(platform): expose read-only app organization auth info`。

## Task 2: Agent auth_info 与可写 roles 契约

**Files:**
- Modify: `apps/desktop/crates/teamclu-introspect/src/apps.rs`（schema、参数测试）
- Modify: `apps/desktop/src/commands/introspect_api/apps.rs`（action、Cloud API 调用、响应测试）

**Interfaces:**
- `manage_app {action:'auth_info', app_id?:string, app_name?:string}`，复用 status 的当前工作区解析和已认证 AppApi。
- 返回 `{action:'auth_info', ...}`，将任务 1 响应明确映射为 snake_case：app_id、team_id、organization、role_scope、roles、auth_mode、auth_scope、auth_audience、auth_rules、effective_policies、organization_status。nested role 字段 id/code/name/status 不变；effective_policies 的 roleCodes 映射 role_codes。
- 原 `update` 接口不增加角色写入功能，只正确描述 auth_rules.items.roles。支持 roles=[]、非空 code 列表及 audience=org 无 roles。

- [ ] **Step 1: 写失败测试。** schema action enum 含 auth_info；roles schema 是 string array。`update_patch_preserves_roles_and_legacy_audience` 测试三种规则、roles=[] 与 audience 共存均原样转发。auth_info 测试 app_id/app_name/当前工作区解析与 status 相同；403 和 organization_status=unconfigured 清晰返回，不伪装空成功。
- [ ] **Step 2: 运行失败测试。** 在仓库根运行 `node scripts/rust-cli.js test --manifest-path apps/desktop/crates/teamclu-introspect/Cargo.toml apps::tests -- --test-threads=1` 和 `node scripts/rust-cli.js test --manifest-path apps/desktop/Cargo.toml commands::introspect_api::apps::tests -- --test-threads=1`；记录新增失败原因。使用 repo 包装器，避免 bare cargo 的资源打包问题。
- [ ] **Step 3: 实现 action 和 schema。** action 调用任务 1 GET 并显式映射字段；status 原 auth_rules 保持不变。更新 update 说明：先 auth_info，真实 code，roles 优先，动态 org 不列举目录；更新后读回。auth_audience 是默认/回退。app-management access 与线上访问角色保持分离。
- [ ] **Step 4: 保持路径兼容。** `/api/staff` 是规范前缀。已有 FC 接受尾部 `/*` 并规范化，不在 introspect 新增不兼容拒绝；说明它不是 glob、内部 `*` 无效，读回规范化路径。不得改变现有审批调用和运行时调用者验证。
- [ ] **Step 5: 验证。** 两条 Rust 测试命令通过；`pnpm rust:check` 通过。错误响应不得附带 token/secret；auth_info 不显示审批，update 原生拒绝测试仍通过。
- [ ] **Step 6: 提交。** `feat(desktop): expose app auth discovery and role rule schema`。

## Task 3: 桌面权限编辑器无损受众状态

**Files:**
- Modify: `packages/app/src/lib/apps/app-auth-access.ts`
- Modify: `packages/app/src/lib/apps/__tests__/app-auth-access.test.ts`
- Modify: `packages/app/src/components/apps/AppAuthTabContent.tsx`
- Modify: `packages/app/src/components/apps/__tests__/AppAuthTabContent.test.tsx`
- Modify: `packages/app/src/stores/apps-store.ts`
- Modify: `packages/app/src/stores/apps-store.test.ts`
- Modify: `packages/app/src/components/settings/TeamRolesSection.tsx`
- Modify: `packages/app/src/components/settings/Settings.tsx`
- Modify: `packages/app/src/components/settings/__tests__/TeamRolesSection.test.tsx`
- Modify: `packages/app/src/components/settings/__tests__/SettingsNavigation.test.tsx`
- Modify: `packages/app/src/locales/en.json`, `packages/app/src/locales/zh-CN.json`

**Interfaces:**
- 扩展 `AppAuthRowState`：保留 path/requiresLogin；新增 `audienceMode: 'any_authenticated' | 'any_org_role' | 'org_roles' | 'inherit'`、`roleCodes: string[]`、`originalRule?: AppAuthRule`、`source: 'rule' | 'app_baseline'`。inherit 的有效结果只用于显示，不固定到 roleCodes。
- `ruleToRowState(rule: AppAuthRule, appAudience: AppAuthAudience): AppAuthRowState` 不再依赖 allRoleCodes；`rowStateToRule(row: AppAuthRowState): AppAuthRule` 无语义修改时返回 originalRule 副本。
- `baselineToRowState(app)`、`exceptionRulesToRowState(app)` 不依赖目录，保留 scope=all 没有根规则时的基准来源。
- `buildAuthPolicyPatch(baseline, exceptions, originalPolicy)` 返回已有 `{authAudience,authScope,authRules}`；originalPolicy 含原 authAudience/authScope/authRules。仅显式变更的受众规范化；目录排序/刷新不视为编辑。
- 原 `updateAuthPolicy` 成功/失败返回约定保留；UI 必须检查 false。成功读取任务 1 getAppAuthInfo 与 getApp，使用服务端配置建立新基准。重新读取失败显示“保存已成功，确认读取失败”，不能宣称原配置未修改。

- [ ] **Step 1: 写失败纯函数测试。** org 动态加载/保存仍是 audience:org 无 roles；roles=[] 覆盖 audience:org；roles 非空加 audience 共存未编辑原样保留；scope all 无根规则保存其他路径不新增根规则；修改显式受众才规范写出；继承 org/any 缺省保留。断言原输入未被修改。
- [ ] **Step 2: 运行失败测试。** `pnpm --dir packages/app test:unit src/lib/apps/__tests__/app-auth-access.test.ts`，确认原自动全选/固定化导致新增断言失败。
- [ ] **Step 3: 实现状态和序列化。** 比较 path、requiresLogin、audienceMode 和 roleCodes 是否与 originalRule 解析值一致；不靠数组引用或目录版本判断 dirty。明确改变 app 默认时，继承规则继续继承；UI 展示受影响规则并要求用户确认该默认变化。显式 org_roles 模式不能为空，空选择不能偷偷编码为 roles=[]；用户须切换到任意登录模式。
- [ ] **Step 4: 写失败组件/保存测试。** 旧 org 显示“组织内任意有效角色”、纯加载无写入且保存禁用；指定角色可选 reviewer；修改另一路径保持旧规则；目录失败保留规则并禁止指定角色变更。停用/缺失角色显示原 code，保留限制且提交失败可见。app 切换时晚返回旧请求丢弃；目录刷新不覆盖草稿。updateAuthPolicy=false 保留草稿；PATCH 成功而 GET 失败显示独立确认错误；正常成功以后服务端配置为基准。
- [ ] **Step 5: 运行新增失败测试。** `pnpm --dir packages/app test:unit src/components/apps/__tests__/AppAuthTabContent.test.tsx src/stores/apps-store.test.ts`。
- [ ] **Step 6: 实现 UI。** 通过 auth_info 获取组织名、目录和原规则；取消旧 allRoleCodes 自动初始化。受众用明确的三个选择，旧继承显示来源；仅指定角色模式显示角色选择器。阻止旧请求提交结果到新 app；保存依据明确结果，保留失败草稿；org 未配置禁止组织受众配置。调整相关摘要文案，动态受众不显示固定角色列表。
- [ ] **Step 7: 更新目录文案与测试。** 显示“组织角色 / Organization Roles”，保留内部 teamRoles key 和路由避免无关重构，说明同组织跨 team 共享。使用既有 token/i18n，不加入新组织管理功能。
- [ ] **Step 8: 验证。** 上述 app 测试，加 `src/components/settings/__tests__/TeamRolesSection.test.tsx`、`src/components/settings/__tests__/SettingsNavigation.test.tsx` 通过；`pnpm --dir packages/app typecheck` 通过。
- [ ] **Step 9: 提交。** `fix(app): preserve dynamic and inherited auth policies in editor`。

## Task 4: 网关契约回归、skill 指导及交付验证

**Files:**
- Modify: `services/fc/test/apps-auth-paths.test.ts`
- Modify: `services/fc/test/apps-auth-gate.test.ts`
- Modify: `services/fc/test/apps-vanity.test.ts`
- Modify: `services/fc/test/apps-org-role-identity.test.ts`
- Modify if regression proves necessary: `services/fc/src/lib/apps-auth-gate.ts`, `services/fc/src/lib/apps-vanity.ts`（仅修复本规格的决策一致性；发现直连绕过另立缺陷）
- Modify: `packages/app/src/lib/skills/deploy-app/SKILL.md`
- Modify: `scripts/lib/deploy-app-skill.test.js`
- Create: `docs/testing/2026-10-04-app-role-auth-consistency.md`（验证记录，不含密钥或真实成员清单）

**Interfaces:**
- 使用现有 `resolvePathPolicy`、`applyAuthGate`、`GateDeps.resolveVisitorRoles`；不创建新的员工授权机制。
- 使用任务 1 的 API、任务 2 的 auth_info、任务 3 的编辑器，模拟存储中完成 UI/工具 PATCH → GET auth-info → 网关请求验证。

- [ ] **Step 1: 写决策回归。** 同一登录 cookie：有效 reviewer + audience:org 允许；改为固定 roles:['admin'] 拒绝；加入匹配角色允许；撤销/停用角色后再次请求拒绝。创建者无匹配角色拒绝。包括 public、roles=[]、继承、最长前缀和异常/损坏规则不降为开放条件。
- [ ] **Step 2: 写边界/读回回归。** forged x-teamclu-user-id/email/org-id 被剥离，未认证请求无法获得可信身份；真实授权请求注入可信身份。模拟持久仓库中分别写动态/固定策略，读取 Task 1 结果并用同一存储驱动 gate，断言未来新增 reviewer 动态通过而固定不通过。权限拒绝的更新不改变原存储。
- [ ] **Step 3: 运行回归并处理结果。** `cd services/fc && node --import tsx --test test/apps-auth-paths.test.ts test/apps-auth-gate.test.ts test/apps-vanity.test.ts test/apps-org-role-identity.test.ts test/apps-auth-info.test.ts test/routes-apps.test.ts`。已有行为满足时只加测试；失败先确认根因，在规格内最小修复。直连绕过单独报告，不扩展本次代码范围。
- [ ] **Step 4: 更新平台 skill。** 指导使用 manage_app auth_info 查组织和 code；分别核对页面与真实数据端点的规则，公共与员工共享 Server Functions 不整体上锁；不额外生成 User ID 白名单，不要求固定 /api/staff。保持 session_prompt 通用、部署契约和原生批准流程原有要求。
- [ ] **Step 5: 验证 skill。** `node --test scripts/lib/deploy-app-skill.test.js` 通过，新增指导与现有部署门禁同时存在；不编辑个人安装副本，不改测试 app 的 AGENTS.md。
- [ ] **Step 6: 完整验证并记录。** `pnpm --dir services/fc test`、`pnpm --dir services/fc typecheck`、`pnpm --dir packages/app test:unit`、`pnpm --dir packages/app typecheck`、`pnpm rust:check` 和任务 2 Rust 测试通过；新修改触发新的失败时定位处理，既有无关环境失败分开记录。运行一次 OpenAPI lint/types。记录 commit、命令、实际结果及限制，不以计划中的预期结果宣称已通过。
- [ ] **Step 7: 本地 dev 隔离验收。** 构建启动 dev 桌面（保留使用 dev 配置，避免启动 prod）。模拟 Cloud API/组织目录夹具执行动态与固定编辑、工具读取、拒绝保存；未部署新 API 时 auth_info 明确显示不可用，不回退猜测。不修改 app6/app7 线上权限，不创建/发布测试应用。真实 dev Cloud API smoke 留到平台部署授权后。
- [ ] **Step 8: 审查和提交。** 逐项核对规格验收表、身份头边界、原生审批和最少权限；完成整个分支代码审查并修复 blocker。提交 `test(platform): verify live role semantics and update deploy guidance`。

## 合并、上线及回退（实施完成后另行授权）

- [ ] 用户要求打开 PR 后，推送任务分支并创建平台 PR；说明本次不会使 app7 应用内白名单自动恢复。
- [ ] 用户合并并授权 dev 平台上线后，先部署新 FC API；验证 auth-info 的权限、组织、原规则和有效策略。然后重启已更新 desktop/introspect，确认工具和编辑器相互读回一致。
- [ ] dev 的变更权限验收只使用独立临时夹具/账号；事先明确创建清理范围，禁止写 app6/app7 规则。使用同一 cookie 验证角色撤销。
- [ ] 服务与客户端按旧规则兼容上线，无 authRules 批量迁移。回退平台版本不重写权限；旧客户端仍可能有原自动固定化行为，回退后应停止用旧编辑器重新保存动态规则。

## 规格覆盖自检

| 规格内容 | 对应任务 |
| --- | --- |
| 三种受众、roles 优先、继承和旧规则无损 | 1、3、4 |
| 真实组织目录、工具 schema、只读查询和最少权限 | 1、2 |
| UI 文案、目录失败、失效角色、保存失败 | 3 |
| 当前角色查询、角色变更、创建者无绕过、身份头 | 4 |
| skill 指导、session_prompt 通用、应用修复排除 | 4、全局约束 |
| 回归、兼容上线、回退与授权边界 | 4、上线段落 |

本计划只描述待实施步骤。当前没有实现代码、测试通过或 dev 已上线的声明。
