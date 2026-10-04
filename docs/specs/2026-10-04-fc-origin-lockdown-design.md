# FC 应用源站入口封闭规格

日期：2026-10-04。状态：用户已批准（排除已有应用修复）；本地实现和必要检查已完成，最终审阅待完成；未修改云端配置或已有应用，真实验收尚未执行。

## 目标与边界

平台发布的应用必须通过 TeamClu 网关访问。匿名用户仍可访问应用的公开页面；受保护页面及接口仍按现有组织/角色规则鉴权。攻击者不能通过 FC 默认 URL 或自定义源站 Host 绕过这些规则，也不能靠伪造 `X-Teamclu-*` 身份头冒充平台用户。

此次修改平台部署、网关源站转发及配置核对。不新增已有应用巡检、批量修复或迁移工具，也不主动修改已有应用；保护适用于后续首次部署及用户主动发起的正常重新部署。应用代码不增加用户 ID 白名单，不调整 app6/app7 的业务接口；应用自身漏配员工接口规则是另一项问题。保留应用 Authorization、Cookie、上传、流式响应及重定向语义。

## 已确认的根因

诊断应用 `james-role-auth-test-20261004`（`76af539e-5341-4e96-bda7-6c8dacf2b092`）实际 Trigger 配置为 `authType: anonymous`、`disableURLInternet: false`。直接访问默认 `fcapp.run` 地址并加入伪造身份头，员工诊断接口返回 200 且 `trustedPlatformIdentity: true`。

第二次独立复现：请求发往账号公网 FC HTTPS 入口，Host 指定该应用的 `fc-apps` 源站域名，同样返回 200 和可信身份。源站域名 DNS 指向内网不构成入口隔离。

证据位于 `/private/tmp/teamclu-new-app-origin-config.json`、`/private/tmp/teamclu-new-app-live-public-origin.json` 和 `/private/tmp/teamclu-origin-custom-host-probes.json`。前两条请求均没有平台登录 Cookie。仅测试新诊断应用，未操作既有业务数据。

当前 `fc-client.ts` 创建匿名 HTTP Trigger 和无鉴权的 HTTP 自定义域名；`app-deploy.ts` 总是保留默认 Trigger。`apps-vanity.ts` 只有在请求经过 TeamClu 网关时才清除并重建身份头，因此源站旁路使这个信任边界失效。

## 方案选择

选择：禁用默认公网 URL，同时在 FC 自定义域名入口验证网关专用 JWT，并强制 HTTPS。

仅设置 `disableURLInternet=true` 修改最小，但不覆盖已复现的自定义 Host 旁路。完全改用 VPC 私有入口可实现网络隔离，但需要改变不同托管模式的网络连接方式，并重新核实默认域名的重定向限制。本方案保留自定义域名的路由方式，使用提供商入口鉴权，不要求修改每个应用。

这里“封闭公网入口”表示不存在匿名直达应用的源站入口；自定义域名仍是可连接、需验证凭证的入口，不宣称已建立纯私网拓扑。

## 请求链与凭证

1. 用户请求进入现有 TeamClu 应用网关，现有公开/登录/组织/角色判断保持不变。
2. 网关移除客户端提供的所有平台身份头，以及专用 `X-Teamclu-Origin-Authorization` 头。仅在通过现有身份与权限判断后写入可信身份头。公开页面也经过同一网关转发流程。
3. 网关签发有效期不超过 60 秒的源站 JWT，在 `X-Teamclu-Origin-Authorization: Bearer <jwt>` 中发送；不得覆盖应用的 `Authorization`。所有重试重新生成凭证。
4. FC 自定义域名 JWT 配置只从该请求头读取，验证签名与有效期。缺失、无效或过期凭证必须在运行应用之前拒绝请求。不开启身份 claim 到应用头的映射，身份来源仍是 TeamClu 网关。
5. 网关以 HTTPS 请求受保护源站，不允许跳转后携带凭证访问其他域名；保留目前手动处理重定向的行为。

采用 HS256 和每应用独立的 256 位密钥。密钥由新的平台专用主密钥，通过带版本和应用 UUID 的 HMAC 派生；不复用用户登录 JWT 密钥。这样应用 A 收到自己的短期凭证也不能访问应用 B。JWT 包含 `iat`、`exp`、版本、应用 UUID 和目标源站标识；跨应用隔离依赖不同的验证密钥，不能仅假设 FC 会校验自定义 audience claim。

主密钥只存在于平台服务端配置，不注入应用函数、应用环境变量或 Agent 查询结果。派生验证密钥仅通过管理 API 配置到对应 FC 域名的 JWKS。FC 管理 API 返回的对称 JWKS 也视为秘密，禁止写日志、部署预览或 status。选择对称算法用于确定性应用隔离，避免新增应用私钥存储；密钥须由安全随机源生成至少 32 字节。

短期 JWT 不提供单次使用保证；本改动不新增 nonce 数据库。凭证只能走 HTTPS，不进入浏览器响应、查询字符串或日志。应用接收的同应用凭证泄漏属于残余风险，有效期限制其重放窗口；不能将该机制描述为端到端防重放。

## 部署与配置契约

- HTTP Trigger 保留，以支持自定义域名调用；创建和更新都显式设置 `disableURLInternet: true`。禁止删除 Trigger 后误以为自定义域名仍可调用。
- `ensureHttpTrigger` 不再要求或返回可用的 `urlInternet` 作为发布源站；返回结构化配置核对结果。未配置受保护自定义源站时，部署预检失败，不退回默认公网 URL。
- 自定义域名创建与更新都声明 JWT 配置、对应应用验证密钥、专用头、HTTPS-only 和有效证书。禁止 HTTP 回退。SDK 字段格式按当前 FC 3.0 模型实现并验证。
- 新增平台主密钥、源站 TLS 证书链及私钥配置。部署前核对缺失、证书覆盖域名及过期情况。私钥是服务端秘密。证书续期必须有明确的更新命令与到期告警说明，不假设 FC 自动更新上传的 PEM。
- 创建/更新后读取 Trigger 与自定义域名并核对实际配置；有差异、读回不可用或 JWT/HTTPS 不支持时发布失败，不标记 Live，也不输出匿名回退地址。
- status/预检只输出安全状态、验证类型、HTTPS 状态和配置差异，不输出密钥、JWT、私钥或完整 authConfig。本次部署的 app endpoint 仅在安全配置核对完成后写入 HTTPS；不批量更新已有记录。
- 服务器缺少安全配置时，不能默默沿用匿名模式。上线顺序必须先准备配置与证书；代码上线本身不代表旧应用已经完成修复。

主要代码边界：`provisioning/fc-client.ts` 管理入口配置与读回；`provisioning/app-deploy.ts` 编排发布；`apps-vanity.ts` 转发时清洗和注入网关凭证。密钥派生/签发放入独立平台源站认证模块。更新 self-host 和其他现有托管部署的服务端配置说明，不增加桌面端或应用端凭证。

## 上线顺序与已有应用边界

准备主密钥和 TLS → 部署具备签发能力的网关及安全部署流程 → 使用新测试应用首次部署 → 验收。未发起重新部署的已有应用保持现状，旧 HTTP endpoint 转发保持兼容，不发送源站凭证；不能据此宣称旧应用旁路已消除。

后续每次正常部署只配置当前目标应用。目标函数包含额外 HTTP Trigger，或存在同函数的未保护自定义域名别名时，部署报告入口差异并失败，不静默修改其他资源。新建受控入口和该目标的标准 `http` Trigger 必须读回通过，才能标记本次发布成功。不提供独立历史修复操作。

FC 配置更新与发布状态写入不是原子事务。当前应用重新部署时如更新失败，记录明确错误；重试必须幂等，不以重新开放匿名入口恢复可用性。没有证书或密钥配置时，既有应用正常访问保持原路径，但任何新的部署请求都失败。

回滚不得恢复匿名入口。保留关闭 URL 和源站鉴权，回滚到兼容网关，或暂时让受影响应用返回明确不可用。主密钥轮换需要先配置新旧验证 key，再切换签发 key，超过最大凭证有效期后移除旧 key；只能在服务器端执行并保留 key 版本，不能靠重启生成新随机 key。

## 回归与真实验收

| 场景 | 必须证明 |
| --- | --- |
| 新 Trigger / 已有匿名 Trigger / 幂等重跑 | 公网 URL 都禁用，方法列表保持，读回差异失败 |
| Trigger 没有 urlInternet | 仍可建立受保护自定义源站，不使用公网回退 |
| 新域名 / 已有 HTTP 无鉴权域名 | 更新为 HTTPS + JWT，实际配置核对正确 |
| 主密钥、证书缺失或无效 | 预检阻止发布，不改应用 Live revision |
| 公开页面、登录页与重定向 | 正常通过正式网关访问，匿名公开页面无需用户 JWT |
| 组织动态规则与指定角色规则 | 网关允许/拒绝结果不变，成员变化无需应用白名单 |
| 客户端伪造平台头和源站凭证头 | 网关移除后自行生成；匿名用户不能冒充身份 |
| 业务 Authorization、Cookie、POST、多图上传、流式响应 | 保持原应用协议；源站认证独立 |
| 源站缺失/伪造/过期 JWT | FC 拒绝，诊断应用未执行 |
| A 的有效 JWT 请求 B | 因验证 key 不同拒绝 |
| 公网 FC 地址 + 自定义 Host | 无凭证或伪造身份头被 FC 拒绝 |
| 本次部署目标的默认 URL、HTTP/HTTPS 源站、其他 Trigger/别名 | 无匿名旁路；额外不安全入口阻止部署 |
| 正常部署重跑、旧应用访问、无关函数 | 可重试，旧应用保持兼容，不修改未部署目标 |
| 错误、日志、status、部署预览 | 不包含认证秘密 |

单元测试以当前可复现配置写失败测试，再实施变更。SDK mock 测试不能替代实际 FC 入口行为：dev 诊断应用必须重复默认 URL 和公网账号入口 Host 旁路测试，并检验未进入应用（提供商响应结合诊断计数/日志）。经过正式网关的真实登录、角色拒绝、公开申请流程也必须复测。

dev 云端部署和新测试应用验收在代码审查及具体上线授权后执行。本规格阶段不修改云端或应用。

## 官方依据

- [HTTP Trigger 配置](https://www.alibabacloud.com/help/en/functioncompute/configure-an-http-trigger-for-a-function-and-invoke-the-function-by-using-http-requests)：禁用默认公网 URL 不影响自定义域名。
- [自定义域名](https://www.alibabacloud.com/help/en/functioncompute/configure-custom-domain-names)：域名调用仍需要 HTTP Trigger。
- [自定义域名 JWT](https://www.alibabacloud.com/help/en/functioncompute/configure-jwt-authentication-for-custom-domain-names)：支持专用请求头、JWKS、HS256 与有效期验证；凭证传输使用 HTTPS。
