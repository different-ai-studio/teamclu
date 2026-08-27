# Apps 配置进仓 — 产品意图在 json，平台事实在表

- **Date**: 2026-08-27
- **Status**: Draft，待评审。由「配置放代码、让 Agent 改，而不是堆控制面表单」的讨论落定。
- **Branch**: `docs-apps-self-serve-gitea-fc`
- **Path**: `docs/specs/2026-08-27-apps-config-in-code-design.md`
- **Scope**: 规定每个 app 配置项落在哪一个入口（新建 / 控制面 / Agent）和哪一块存储（`amux.apps` / 仓内 `teamclu.app.json`）。把后续会膨胀的产品配置从控制面表单挪到仓内文件，由 Agent 对话修改，随 commit 发版。
- **Builds on**: `docs/specs/2026-08-27-apps-self-serve-gitea-fc-design.md`（下称「自助稿」）、`docs/specs/2026-08-27-apps-first-class-design.md`（下称「一等稿」）
- **Amends**:
  - 一等稿 §2.3 控制面「登录方式」：由 select 改为只读对照（期望 vs 线上）
  - 自助稿 §6 / 一等稿 §7.4：`auth_mode` 的**意图**改由仓内 json 表达；表仍记录**已生效**值；公开确认仍在控制面点部署时发生
  - 自助稿 Phase 2「环境变量面板 / 自定义域名 / 自定义 build 命令」：**不做 UI**；预留为 json 字段，本阶段不要求部署链路消费它们
- **Non-goals**: 自定义域名落地、env 注入落地、自定义 build 命令落地、`runtime=container`、给终端用户做应用内设置页、Agent 自己触发部署、把成员权限写进 json

> 沿用同系列规矩：**对现网行为的陈述带 `file:line`，实现以代码为准。**

---

## 1. 为什么要动

控制面已经有改名、登录方式、授权、移目录、数据浏览。自助稿 Phase 2 还列了 env 面板、自定义域名、build 命令。继续按「每个旋钮一张表单」做，会把 Apps 做成迷你 PaaS 设置页，而用户面前已经有一条更强的交互：跟 Agent 说话。

产品配置（这个站点怎么工作）跟代码是同一份变更，应当进仓、随 commit 发布。平台闸门（谁能看见、谁能部署、本机目录、公开上线确认）不能让 Agent 静默改掉。

---

## 2. 放置规则（唯一原则）

**表里只放平台事实；json 里只放会跟代码一起发版的产品意图。**

部署是两者的同步点：

```text
Agent 改 teamclu.app.json（及代码 / schema.sql）
  → commit + push
  → 用户在控制面点「部署」（公开站点须确认）
  → daemon 按该 commit 构建
  → finalize 读该 commit 里的 json，把意图写进表，并执行平台副作用
```

双写只允许「意图在 json、生效在表」这一类。本阶段只有 `auth.mode`。以后 `domain` 可以再成为第二个，不得把 `name` / `visibility` / 权限再做成两份真相。

第三处存储（本机 daemon 覆盖路径）继续只服务「本机目录」，不进表、不进 git。见一等稿 §3。

---

## 3. 三个入口

### 3.1 新建

人必须先选、此时还没有 Agent、也还没有仓。只留：

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | TeamClu 列表名；派生 `slug`（之后改名不改 slug / vanity） |
| `type` | 是 | `static_web` / `slides` / `data_app`；创建后冻结 |
| `gitRemoteUrl` | 否 | 有值则 clone、不写模板；无值则平台建 Gitea 仓并播种（含 `teamclu.app.json`） |

`visibility` 默认 `personal`，不占主路径（可折进高级选项）。`authMode` **不出现在新建**——模板 json 默认 `"auth": { "mode": "none" }`，第一次部署走控制面公开确认。

### 3.2 控制面

闸门、状态、本机。不再做产品配置表单。

**保留为动作 / 状态：** 部署、打开 URL、删除、授权、本机路径 / 移动目录、Reseed（仅初始化失败）、线上数据浏览、改名、以及「json 已改但未上线」的对照。

**拿掉：** 登录方式 select（一等稿 §2.3 那一行改为只读）。env / 域名 / 主题 / OAuth 细节表单永不做。

登录方式在控制面的展示：

- **期望**：本机 checkout 上**已 push 的 HEAD** 里 `teamclu.app.json` 的 `auth.mode`。工作树有未提交/未 push 的 json 改动时，另标「未推送，部署会被拒」——期望不以脏工作树为准（与现网 `ERR_DIRTY` 一致）。
- **线上**：`amux.apps.deployed_auth_mode`
- 两者不一致 → 「待重新部署」。即将按 `none` 上线 → 点部署时仍要显式确认（自助稿 §7）
- Web 或尚未 clone 时：只展示线上值，不猜期望（不为读一个文件给 Web 下发 git 凭证）

**不要**再用表上的 `auth_mode <> deployed_auth_mode` 推导 pending。停掉 PATCH 之后这两列只在 finalize 里一起写，会永远相等，用它们做徽章会让「json 已改未部署」彻底看不见。pending 只来自「已 push HEAD 的 json vs `deployed_auth_mode`」。

### 3.3 Agent 对话

改 `teamclu.app.json`、改 `db/schema.sql`、改页面代码。改完告诉用户去控制面部署。

**禁止：** 自己触发部署、改成员权限、删 app、移动本机目录、把密钥写进仓。

模板 `AGENTS.md` 里「登录在控制面设置」（例如 `templates/static-web/AGENTS.md` 现网第 37–39 行）改为「改 `teamclu.app.json` 的 `auth.mode`」。

---

## 4. 存储

### 4.1 `amux.apps`（及关联表）— 平台事实

身份、生命周期、授权、派生状态、密钥。控制面列表不依赖 checkout 就能读。

关联表：`amux.app_member_access`（权限）、`amux.app_secrets`（密文，客户端永不读）。

### 4.2 `teamclu.app.json` — 产品意图

每个 app 仓根目录一份。播种时由模板写入。导入已有仓时若缺失，部署按默认 `auth.mode=none` 处理，并在控制面提示「建议让 Agent 补上该文件」。

**文件名锁定为 `teamclu.app.json`。** 不用 yaml：Agent 改 json 更不容易在缩进上栽跟头；平台解析用标准 `JSON.parse`。

### 4.3 本机 daemon — 仅 workdir 覆盖

一等稿 §3.2。不进 `workspaces.path` 权威，不进 json。

---

## 5. 字段归属（全表）

### 5.1 现在就有、继续当配置的

| 字段 | 入口 | 存储 | 创建后 |
|------|------|------|--------|
| `name` | 新建必填；控制面可改；Agent 可代改（写表，不写 json） | **表** | 可改。列表名 ≠ 站点标题 |
| `type` | 新建 only | **表** | **冻结**。改类型等于换产品 |
| `visibility` | 新建默认 `personal`；控制面可改；Agent 禁止改 | **表** | 管 TeamClu 里谁看得见，不是线上谁打得开 |
| `gitRemoteUrl`（导入） | 新建可选 | **表** | 创建后不可改 |
| `auth.mode` 意图 | Agent 改 json | **json** | prompt 可改文件（有写 key）；**不能**上线，直到 admin 部署 |
| `auth_mode` / `deployed_auth_mode` / oauth id | 无表单；finalize 回写 | **表** | 生效值。`PATCH authMode` 作为产品路径停用 |
| 成员权限 | 控制面 only | **`app_member_access`** | 禁止进 json：prompt 能 push，进 json = 自己提权 |
| 本机目录 | 控制面 only | **daemon 本地** | 每台机器不同 |
| Reseed / 删除 / 部署 | 控制面 | 无配置项 | 动作。Agent 禁止部署（模板已写） |
| 线上数据 | 控制面看/改行；Agent 改 `db/schema.sql` | 行在 Postgres；DDL 在**代码** | 浏览器不是配置 |

### 5.2 表里有、但不是配置（只读状态）

只在表、控制面展示、不进 json、不成表单：

`id` · `slug` · `workspaceId` · `gitRemoteUrl`（平台 Gitea 仓）· `gitAuthKind` · `gitCommitSha` · `provisionStatus` · `fcStatus` · `publicUrl` / `fcEndpoint` · `fcFunctionName` / `fcRegion` · `oauthClientId` / `oauthAppId` · `org_id` · `deploy_*` · `createdAt` / `updatedAt`

`runtime` 继续表默认 `node`、创建不可选；真要容器时再进 json，由之后的规格打开。

密钥继续只在 `app_secrets`，永不进 json、不进 Agent 上下文。

### 5.3 现在没有 UI、预留给 json 的产品配置

控制面最多只读「已应用 / 待部署 / 尚未被平台消费」。本规格**不要求**部署链路消费这些键（YAGNI）；键先占位，避免以后再发明第二份文件。

| 键 | 含义 | 本阶段部署是否消费 |
|----|------|-------------------|
| `title` | 站点标题（与表里的 `name` 分开） | 否 |
| `env` | 非密钥公开环境变量 | 否 |
| `build.command` / `build.outdir` | 打破硬编码 `pnpm build` + `.output` | 否 |
| `domain` | 自定义域名**意图**；证书/DNS 状态仍将在表 | 否 |

未知键：不导致部署失败（前向兼容）。控制面可忽略它们。

---

## 6. `teamclu.app.json` 契约

播种时 `{{APP_NAME}}` 与 `AGENTS.md` 同一套占位符替换。默认（三种模板相同）：

```json
{
  "title": "{{APP_NAME}}",
  "auth": { "mode": "none" },
  "env": {},
  "build": { "command": "pnpm build", "outdir": ".output" },
  "domain": null
}
```

`auth.mode` 枚举与表一致：`none` | `platform` | `third`。

部署时（本阶段唯一消费点）：

1. daemon checkout 目标 sha 之后读取仓根 `teamclu.app.json`。缺失 → 视为 `auth.mode=none`。非法 json / 非法 `auth.mode` → **拒绝构建**，错误要点名文件和字段。
2. `third` → 拒绝部署，原因与现网一致（自助稿 §6.4）。
3. `none` → 桌面端公开确认（已有 `publicDeployConfirm` 形状）；确认文案仍要点明「任何拿到链接的人都能访问」。
4. `platform` → finalize 走现有 GoTrue 客户端 ensure + 注入 OAuth env（`buildPlatformOAuthEnv`）。`APPS_PUBLIC_DOMAIN` 为空时仍 409，不回退 `fc_endpoint`。
5. finalize **以该 commit 文件为准**写回 `apps.auth_mode`，成功后 `deployed_auth_mode` 与之对齐。桌面 / Agent **不上报**一个可覆盖文件的 `authMode` 字段——避免客户端伪造意图。

`PATCH /v1/apps/:id` 的 `authMode`：**400**，不再是产品路径。测试与 OpenAPI 同步删掉「控制面改登录方式」。OAuth 客户端的注册/禁用改挂在 finalize（读到 `platform` 则 ensure，读到 `none` 则禁用），不再挂在 PATCH。

`apps.auth_mode` 与 `deployed_auth_mode` 都只在 finalize 成功时写入，且写入同一值。`auth_mode` 保留是为了列表/API 不必读 git；它表示「上次成功部署消费的意图」，不是「用户刚选但还没上线的意图」。

权限含义（一等稿 §5.2 的补充）：`prompt` 能改 json（含把 `auth.mode` 改成 `none`），但那只是仓里的意图；**上线仍是 admin + 部署确认**。这比控制面 select 更干净——prompt 不能让站点立刻变公开。

---

## 7. 控制面与新建的具体改动

**新建对话框**（`CreateAppDialog.tsx`）：主路径只留名称、类型、可选仓库 URL。可见性默认 personal。删除登录相关控件（本来也没有）。提示一句：登录与站点行为在对话里改 `teamclu.app.json`。

**控制面**（`AppControlPanel.tsx`）：删除 authMode 的 Select + 保存。换成期望 / 线上两行 + 待重新部署徽章 + 「立即重新部署」。公开确认仍在 `deploy()` 路径，不在保存按钮上。

**期望值从哪读：** 桌面有 checkout 时问 daemon「已 push 的 HEAD 上这份 json」；没有 checkout（Web、尚未 clone）时只展示线上 `deployed_auth_mode`，并写「在本机打开此应用后可预览未部署的登录意图」。不要为了读一个文件去给 Web 下发 git 凭证。

---

## 8. 与既有规格的关系

- 自助稿的发布链路、Gitea、creator/admin 部署、产物 key 服务端推导、公开性确认、`third` 拒部署：**不变**。变的是 auth 意图的来源。
- 一等稿的信息架构、权限三档、按需 clone、删除回收、本机移目录：**不变**。变的是控制面不再编辑 `authMode`。
- 数据浏览器规格：**不变**。表结构继续由 Agent 改 `schema.sql`，不进 json。
- 自助稿 Non-goals 里的「环境变量面板 / 自定义域名」继续是 **UI Non-goal**；本规格把它们定义为 json 占位，另开规格再让部署消费。

---

## 9. 被否决的方案

| 方案 | 否决理由 |
|------|----------|
| 所有配置都进 json，含权限和 visibility | prompt 能 push；权限进仓 = 提权。visibility 是控制面可见性，与 commit 无关 |
| 所有配置都进表，Agent 调 PATCH | 产品配置不跟代码版本走；控制面仍会堆表单；与「跟 Agent 说话」重复 |
| json 镜像表（改 json 再同步进表） | 两份真相、竞态、authz 漏洞 |
| 新建时选 authMode | 此时没有 Agent，也还没部署；默认 none + 首次部署确认已经够 |
| 让 Agent 直接部署 | 与模板契约和一等稿「上线是闸」相反 |
| `auth.mode` 只在表、json 里不出现 | Agent 改登录还得走表单或专用工具，产品配置又裂成两条路 |
| 用 yaml / 多份 config 文件 | 多一套解析和失败模式；本阶段一个 json 足够 |

---

## 10. 验收标准

1. 三种模板播种后仓根有合法 `teamclu.app.json`，默认 `auth.mode=none`。
2. 新建对话框没有登录方式控件；主路径只有名称、类型、可选仓库。
3. 控制面没有登录方式 Select；能看出期望 vs 线上；不一致时出现待重新部署。
4. Agent 按 `AGENTS.md` 把 `auth.mode` 改成 `platform` 并 push 后：未部署前线上看起来仍是旧闸；admin 部署成功后 `deployed_auth_mode=platform` 且 OAuth env 注入（现有 platform 验收仍成立）。
5. json 为 `none` 的部署仍弹出公开确认；`third` 仍拒绝部署。
6. `PATCH authMode` 不再是产品路径；finalize 以 commit 内文件为准，请求体不能覆盖它。
7. `prompt` 成员能改 json 并 push，调用部署 API 仍被拒。
8. 成员权限、本机目录、visibility 均不出现在 json 里；改 json 不能提权。
9. 文件缺失按 `none` 部署（加提示）；非法 json 拒绝构建且错误点名。
10. `env` / `build` / `domain` 出现在文件里也不导致部署失败，且本阶段不改变构建命令与函数 env（除 auth 现有注入外）。

---

## 11. 实施顺序（本规格落地，不含 env/域名/build 消费）

1. 模板加入 `teamclu.app.json` + 改三份 `AGENTS.md`
2. daemon：checkout 后解析该文件；非法则 `ERR_APP_MANIFEST`
3. finalize：从该解析结果应用 `auth.mode`（副作用从 PATCH 挪过来）；OpenAPI / 客户端去掉控制面改 authMode
4. 控制面：Select → 对照；新建瘦身
5. 测试：播种含文件、非法 json、prompt 改文件但不能部署、none 确认、platform 两次部署登录仍可用

---

## 12. 构建如何把 json 交给 finalize

**锁定：** daemon 在 checkout 目标 sha 之后解析 `teamclu.app.json`，把 `auth.mode` 放进**这次构建**的结果里，桌面只原样带到 `finalize`（带上现有 `deployToken`）。服务端只接受「这个 token 对应的那次 startDeploy」附带的 mode，不接受客户端另写一个 `authMode`。

导入仓没有 Gitea、服务端也拉不到文件，所以不能改成「finalize 自己向 Gitea GET 文件」作为唯一路径。Gitea 反查留作以后的加固，不是本阶段的正确性条件。

Web 预览未部署意图：本阶段不做（§3.2 / §7）。
