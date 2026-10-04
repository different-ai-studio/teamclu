# FC 应用源站入口封闭 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [x]`) syntax for tracking.

**Goal:** 让后续部署的应用只能通过 TeamClu 网关访问，封闭默认 URL 和自定义 Host 两条匿名旁路。

**Architecture:** 网关在现有角色鉴权后签发每应用独立密钥的短期 JWT；FC 自定义源站校验该 JWT，并只接受 HTTPS。默认 HTTP Trigger 保留但关闭公网 URL。部署配置读回成功后才写入 Live；已有应用不批量修复。

**Tech Stack:** TypeScript、Node.js crypto/X509Certificate、现有 jose 5、FC 3.0 SDK、Hono、node:test/tsx；不新增依赖或数据库表。

**Spec:** [已批准规格](../specs/2026-10-04-fc-origin-lockdown-design.md)

## Global Constraints

- 不新增已有应用巡检、批量修复或迁移工具，也不主动修改已有应用；保护适用于后续首次部署及用户主动发起的正常重新部署。
- 使用 HS256、每应用独立的 256 位派生密钥，JWT 有效期不超过 60 秒。
- `X-Teamclu-Origin-Authorization: Bearer <jwt>` 是独立源站凭证头，不覆盖应用 `Authorization`。
- HTTPS-only；`disableURLInternet: true`；无匿名或 HTTP 回退。
- 不向应用环境、Agent、status、预检、日志或浏览器暴露主密钥、验证密钥、JWT 和私钥。
- 保留现有组织/角色规则与业务请求、响应语义，不修改应用业务代码或使用用户 ID 白名单。
- 工作目录 `.worktrees/fc-origin-lockdown`，分支 `fix/fc-origin-lockdown`；未获提 PR 指令前不推送。
- dev 上线与真实 FC 变更另待具体上线授权；本计划实施阶段首先完成代码与本地测试。

## Review Focus

1. 主密钥或 TLS 配置改变后，已批准预检不能沿用失效配置：任务 4 在 deploy/finalize 重新校验。
2. endpoint 含 userinfo、端口、错误 Host 或非预期路径时，不向它签发或发送源站凭证：任务 3 拒绝异常目标。
3. FC 列表分页中藏有额外 Trigger/域名别名时，不误判入口已安全：任务 2 穷尽分页并阻止发布。
4. 证书尚未生效、私钥不匹配、仅 SAN 不匹配或过期时，不开始云端部署：任务 1 检验证书与密钥。
5. 已有应用仍用 HTTP endpoint 时，保持访问兼容，但不发送源站 JWT、不声称已安全：任务 3 和任务 4 验证。

---

## 文件和接口边界

新增 `services/fc/src/lib/apps-origin-auth.ts`：配置、密钥派生、JWT 签发及安全摘要。FC 提供商映射仍在 `provisioning/fc-client.ts`；不将 SDK 类型传播到网关。

共同类型放在该新模块：

```ts
type OriginKey = { version: string; masterKey: Uint8Array };
type OriginAuthConfig = {
  activeKey: OriginKey; previousKey?: OriginKey;
  routeDomain: string; certName: string; certificate: string; privateKey: string;
};
type OriginTarget = { appId: string; slug: string };
type OriginSecuritySummary = {
  status: "protected" | "legacy_unverified" | "drift" | "unavailable";
  internetUrlDisabled: boolean | null;
  customDomainAuth: "jwt" | "none" | "unknown";
  httpsOnly: boolean | null; driftFields: string[];
};
```

JWT key 的 `kid` 使用显式版本；环境变量使用 JSON keyring（active/previous），不能在启动时生成新随机密钥。摘要不得引用包含秘密的配置对象。

### Task 1: 配置与每应用源站凭证

**Files:** Create `services/fc/src/lib/apps-origin-auth.ts`; Create `services/fc/test/apps-origin-auth.test.ts`。

**Interfaces:**
- `readAppsOriginAuthConfig(env: NodeJS.ProcessEnv): OriginAuthConfig`，缺失/无效配置抛出不含秘密的配置错误。
- `assertOriginCertificate(config: OriginAuthConfig, hostname: string, now?: Date): void`。
- `originJwks(config: OriginAuthConfig, appId: string): { keys: Array<{ kty: "oct"; alg: "HS256"; use: "sig"; kid: string; k: string }> }`，仅供 FC 管理配置使用。
- `signOriginToken(config: OriginAuthConfig, target: OriginTarget, hostname: string, now?: Date): Promise<string>`，返回原始 JWT。

- [x] 写失败测试：同 app/version 派生稳定；不同 UUID 或版本生成不同 key；`jwtVerify` 验证 HS256、`exp-iat===60`、应用/Host claims；过期及 A 的 JWT 用 B key 验证失败；active/previous keyring 可验证两版本，签发只使用 active。

  核心断言使用固定时钟和两个不同 UUID 的测试 fixture：
  ```ts
  const token = await signOriginToken(config, targetA, hostA, now);
  const { payload } = await jwtVerify(token, keyA, { currentDate: now });
  assert.equal(payload.exp! - payload.iat!, 60);
  assert.equal(payload.appId, targetA.appId);
  assert.equal(payload.originHost, hostA);
  await assert.rejects(jwtVerify(token, keyB, { currentDate: now }));
  await assert.rejects(jwtVerify(token, keyA, {
    currentDate: new Date(now.getTime() + 60_000),
  }));
  ```
- [x] 写失败测试：非法 UUID、重复版本、短于 32 字节或非法 base64url 主密钥被拒绝；无主密钥/证书/私钥被拒绝；证书不匹配 Host、过期、尚未有效、私钥不匹配均被拒绝；错误文本不包含输入秘密。
- [x] 运行 `cd services/fc && node --import tsx --test test/apps-origin-auth.test.ts`，确认失败源于缺失实现或错误行为。
- [x] 实现上述接口。固定派生输入为 `teamclu:fc-origin:<version>:<lowercase-app-uuid>`，用主密钥 HMAC-SHA256 得到 32 字节 key。用 jose SignJWT 签名，用 X509Certificate 检查有效期、Host 和公私钥匹配。
- [x] 配置变量固定为 `APPS_FC_ORIGIN_KEYRING`（`{"active":{"version":"v1","key":"<base64url>"},"previous":...}`）、`APPS_FC_ORIGIN_TLS_CERT_NAME`、`APPS_FC_ORIGIN_TLS_CERT_PEM`、`APPS_FC_ORIGIN_TLS_KEY_PEM`，沿用 `APPS_FC_ROUTE_DOMAIN`。JSON 仅一层 previous，禁止无限历史 key。
- [x] 同一测试命令必须全通过；提交 `feat: add per-app FC origin credentials`。

### Task 2: FC 入口配置及提供商读回

**Files:** Modify `services/fc/src/lib/provisioning/fc-client.ts`; Modify `services/fc/test/provisioning/fc-client.test.ts`。

**Interfaces:**
- `FcOpsConfig.originAuth?: OriginAuthConfig`，仅入口操作要求配置；函数删除等操作不受缺失证书影响。
- `ensureHttpTrigger(functionName: string): Promise<{ internetUrlDisabled: true }>`。
- `ensureCustomDomain(functionName: string, domainName: string, target: OriginTarget): Promise<string>`，仅返回通过核对的 HTTPS endpoint。
- `readOriginSecurity(functionName: string, domainName: string, target: OriginTarget): Promise<OriginSecuritySummary>`，只读；对错误返回安全摘要。

- [x] 扩充 mock 的 `getTrigger`/`getCustomDomain`/列表响应。写失败测试：创建及更新标准 Trigger 显式 `disableURLInternet:true`，没有 urlInternet 也可成功；读回 false、字段缺失或不可读均失败；保留全部七种现有方法。

  对当前 `fakeClient` 的调用断言保持具体：
  ```ts
  const result = await ops.ensureHttpTrigger(functionName);
  const body = calls.find(call => call[0] === "createTrigger")[2].body;
  assert.equal(JSON.parse(body.triggerConfig).disableURLInternet, true);
  assert.deepEqual(result, { internetUrlDisabled: true });
  ```
- [x] 写失败测试：域名 create/update 都是 HTTPS-only，证书和 JWT tokenLookup 对应专用头，JWKS 对应当前 app；读回协议、路由函数、JWT key/tokenLookup、证书不一致均失败。比较按语义规范化，不依赖 JSON 字段顺序或服务端补充默认值。
- [x] 写失败测试：目标函数额外匿名 HTTP Trigger，或列表第二页中的未保护域名别名，导致发布失败；非目标函数不得更新。受保护别名需验证相同应用 key 与头，不能仅检查 authType 名称。
- [x] 运行 `cd services/fc && node --import tsx --test test/provisioning/fc-client.test.ts`，确认新增断言失败。
- [x] 按当前已安装 SDK 模型核实 authConfig、jwtConfig、certConfig 和分页字段，然后实现入口创建、幂等更新、分页核对及读回。仅更新当前目标标准 Trigger 和受控域名；其他不安全入口报告差异，禁止批量修复。保留现有 TriggerNotFound 重试。
- [x] 认证配置差异使用字段名列表，提供商错误仅保留安全错误码与操作名，不输出原始 request/authConfig。补测试证明秘密没有进入错误。
- [x] 同一测试命令必须全通过；提交 `fix: disable anonymous FC origin entrypoints on deploy`。

### Task 3: 网关签发与旧 endpoint 兼容

**Files:** Modify `services/fc/src/lib/apps-vanity.ts`; Modify `services/fc/src/app.ts`; Modify `services/fc/test/apps-vanity.test.ts`; Modify `services/fc/src/lib/apps-origin-auth.ts`。

**Interfaces:**
- 给 `proxyToApp(request, endpoint, fetchImpl, identity, origin?)` 新增第五参数 `origin?: { target: OriginTarget; config: OriginAuthConfig }`，前四参数兼容现有测试。
- `classifyOriginEndpoint(endpoint: string, target: OriginTarget, routeDomain: string): "protected" | "legacy"`：只接受精确受控源站 Host，无 userinfo、非默认端口、额外 path/query/fragment；符合旧路径的 HTTP endpoint 为 legacy，HTTPS 为 protected。异常目标拒绝。
- `app.ts` 从已查到的目标记录传入完整 UUID 和 slug，不能从客户端头或 id8 推断 appId。

- [x] 写失败测试：公开请求和可信登录请求都会对 protected endpoint 签发 JWT；客户端混合大小写伪造源站头被替换，伪造身份头被清除；用户的业务 Authorization 与 Cookie 原样保留。
- [x] 写失败测试：Body 流、多部分上传、HEAD、OPTIONS、手动 302、SSE 都保留原有语义；302 不携带 JWT 再请求外部地址；JWT 不进入浏览器响应或由平台生成的错误文本。
- [x] 写失败测试：异常目标地址不调用 fetch；protected endpoint 缺失配置时明确不可用，不能回退 HTTP；legacy HTTP 请求不签发、不发送 JWT，保持当前响应；旧默认 FC URL 也仅可按既有路由兼容转发，不获得源站凭证。
- [x] 运行 `cd services/fc && node --import tsx --test test/apps-vanity.test.ts`，确认新增断言失败。
- [x] 实现精确目标检查、无条件删除专用凭证头、按目标签发和 app.ts 接线。既有的其他 legacy endpoint 仅以显式 legacy 分支保留，不自动改写或认证；对新 HTTPS 受控 endpoint 绝不降级。保持 fetch `redirect:"manual"` 和 `duplex:"half"`。
- [x] 用 app.ts 集成测试证明 gate.response 拒绝时 fetch/签发均未发生；公开请求无用户 JWT 也正常转发；原组织/角色断言保持。
- [x] 同一测试命令必须全通过；提交 `fix: authenticate gateway requests to protected app origins`。

### Task 4: 部署预检、发布状态与安全摘要

**Files:** Modify `services/fc/src/index.ts`; Modify `services/fc/src/lib/provisioning/app-deploy.ts`; Modify `services/fc/src/lib/supabase-repo.ts`; Modify `services/fc/src/lib/provisioning/app-runtime-info.ts`; Modify `services/fc/src/lib/provisioning/app-deploy-preflight.ts`; Modify `docs/openapi/teamclu-api.v1.yaml`; Modify `services/fc/src/lib/repository-contract.ts` as required by the response contract.

**Tests:** `services/fc/test/provisioning/app-deploy.test.ts`, `services/fc/test/provisioning/app-deploy-preflight.test.ts`, `services/fc/test/provisioning/app-runtime-info.test.ts`，以及 `services/fc/test/app-deploy.test.ts`。

**Interfaces:** 将 finalize 的 `fcOps` 更新为任务 2 接口；自定义域名调用传 `{appId,slug}`。预检/status 对外只增加 `originSecurity: OriginSecuritySummary`；preflight preview 增加相同摘要。不新增写操作 API 或数据库列，不改变应用 build/start 声明。

- [x] 写失败测试：缺失 routeDomain、主密钥、证书或目标 Host 验证失败时，preflight 不预留 deploy_token；deploy/finalize 也重新校验，预检后删配置不能继续发布。
- [x] 写失败测试：入口读回漂移/提供商失败不写 Live revision 或新 endpoint；成功只返回 HTTPS endpoint；任何 route 缺失均不返回 fcapp.run；保留 runtime、layer、数据库环境、应用权限规则。
- [x] 写失败测试：status 对未重新部署的旧应用返回 `legacy_unverified`，查询本身不写任何 FC 或数据库配置；安全摘要及错误不包含 JWT/key/JWKS/私钥。额外入口影响安全摘要，不改变旧应用访问路径。
- [x] 运行 `cd services/fc && node --import tsx --test test/provisioning/app-deploy.test.ts test/provisioning/app-deploy-preflight.test.ts test/provisioning/app-runtime-info.test.ts test/app-deploy.test.ts`，确认新增断言失败。
- [x] 先更新 OpenAPI 响应与仓库接口，再接线 index.ts 的正常部署依赖及只读核对依赖。配置缺失使用 `503 origin_security_unavailable`，实际入口漂移使用 `409 origin_security_drift`，消息只含安全字段名。入口配置只在需要部署/签发时严格读取，不因缺失新配置导致整个 API 启动失败。删除 finalize 的 triggerUrl fallback；函数入口核对必须先于成功状态提交。
- [x] 将确认的配置安全摘要返回给现有 status/runtime_info/preflight 消费方；只做兼容的响应新增字段，避免桌面/daemon 无关改造。所有返回摘要由白名单字段构造。
- [x] 同一测试命令全部通过；运行 FC `pnpm typecheck`、`pnpm build`、`pnpm openapi:lint`；提交 `fix: require verified origin security before app publish`。

### Task 5: 部署配置、运行手册和验收记录

**Files:** Modify `deploy/self-host/.env.example`; Modify `deploy/self-host/docker-compose.yml`; Modify `deploy/belayo/README.md`; Modify `deploy/belayo/cloud-api.env.keys`; Modify `services/fc/README.md`; Create `docs/testing/2026-10-04-fc-origin-lockdown.md`; Create `services/fc/test/apps-origin-config-wiring.test.ts`; Extend `services/fc/test/deploy-env-parity.test.ts` for the required configuration-reader access shape。

**Interfaces:** 文档和 compose 使用任务 1 的同一组环境变量；不生成历史迁移脚本，不新增生产自动执行步骤。

- [x] 写配置接线回归测试：compose 将四项源站变量原样传给 FC；样例只含占位值；运行手册说明新部署失败条件、旧应用未修复，以及内网 DNS 不能替代 JWT 校验。
- [x] 运行 `cd services/fc && node --import tsx --test test/apps-origin-config-wiring.test.ts`，确认新增断言失败。
- [x] 更新配置与说明：主密钥离线生成、PEM 安全注入、TLS Host/有效期检查、证书更新通过后续明确发起的正常部署生效；到期前 30 天开始监控提醒。手册包含服务器配置更新后 `docker compose up -d fc` 的具体命令及再通过 TeamClu 发起目标应用部署的步骤；不得把服务器重启描述成已更新 FC 证书。轮换保留 previous/active 两版本；切换签发版本前，所有使用该 keyring 的受保护目标都须在另行授权的正常部署中先准备两版本 JWKS。确认全部兼容并等待超过 60 秒后才能移除旧 key；不得暗中更新其他应用。说明 JWT 同应用 60 秒重放残余风险及禁止匿名回滚。
- [x] 写真实验收步骤，保持初始状态“尚未执行”：使用新测试应用，分别验证默认 fcapp.run、HTTP 源站、HTTPS 源站和公网 FC Host 覆写请求；缺失/伪造/过期凭证均拒绝，应用诊断计数不增长。两份新 fixture 可验证 A→B 凭证拒绝，凭证只在受控测试进程中使用，不写报告。
- [x] 验收还需覆盖正式网关公开申请、真实 TeamClu 登录、组织/角色允许与拒绝、多图上传和业务 Authorization；应用代码交给 TeamClu Agent 完成。不得为方便验收改变真实组织角色或放宽规则。
- [x] 跑接线测试及完整 FC `pnpm test`、`pnpm typecheck`、`pnpm build`、`pnpm openapi:lint`；按仓库 CI 所用格式检查命令核对所有变更文件。记录实际命令/结果，不用 SDK mock 通过代替云端验收。
- [x] 本地提交 `docs: document protected FC origin rollout and acceptance`；未推送。
- [ ] 控制代理完成最终代码审查后报告分支与测试结果；等待明确提 PR 指令。dev 实际变更另待上线授权。

## 执行依赖与交付界限

任务 1 → 任务 2、3 → 任务 4 → 任务 5。任务 2 和 3 的实现可分代理处理，但进入集成前必须使用同一组已审阅的接口；用户已批准本地实施并采用任务代理执行；任务 1–4 已完成并审阅，任务 5 已完成本地配置、文档和检查，最终审阅由控制代理继续执行。dev 云端部署、已有应用操作及提 PR 仍未授权。

本地代码完成标准：全部针对性和 FC 必要检查通过，无旧应用修复工具，无无关资源修改。安全漏洞修复的真实验收标准：新部署测试应用的两条旁路在 FC 入口被拒绝，正常网关功能通过。既有未重新部署的应用不在此次修复范围，也不算作已安全。

## 本地完成记录（2026-10-04）

任务 1–5 的实现与本地交付已完成，任务 5 最终审阅仍待控制代理进行。
配置接线测试先 RED（0/3，通过预期的缺失配置断言失败），再 GREEN；
接线与部署白名单合计 7/7。白名单读取扫描补充 `required(env, "NAME")`，
不把实际读取的四项配置误报为未消费变量。Compose 测试解析真实 YAML 映射，
用受控合成 keyring/多行 PEM 测试变量替换及 FC 配置解析；未安装依赖，
未运行 Docker/云端操作，未用人类说明文字断言代替配置测试。

最终实际执行（在 `services/fc`，pnpm 带 `--config.verify-deps-before-run=false`）：

- `node --import tsx --test test/apps-origin-config-wiring.test.ts test/deploy-env-parity.test.ts`：7 pass / 0 fail。
- `pnpm test`：1,796 tests，1,783 pass / 0 fail / 13 skip；13 项为已有外部/live 环境集成跳过（包括本地 Supabase 不可达），未新增 skip。
- `pnpm typecheck`、`pnpm build`：各 exit 0。
- `pnpm openapi:lint`：exit 0，11 项已有警告（7 ambiguous paths、3 missing 4xx、1 missing 2xx）。
- 根目录 `pnpm --config.verify-deps-before-run=false lint`：exit 1，`eslint: command not found`；本工作树没有前端 `node_modules`。CI 此命令只覆盖 `packages/app`，不覆盖本次 FC/Markdown/YAML 文件；不为此安装依赖或修改其他工作树。
- `git diff --check`：通过。CI 无适用于 FC/Markdown/YAML 的格式化命令；仅前端 ESLint 和未修改的 Rust `cargo fmt`。实际 YAML 解析和部署清单检查已由接线/白名单测试通过，文档逐条人工复核。

本地状态不代表安全漏洞已经在云端修复。真实验收记录仍为“尚未执行”；
任何新测试应用部署、正式网关登录/组织/角色/多图业务验收均需后续具体上线授权。
所有旧应用保持原状，未修复且不计为已安全。
