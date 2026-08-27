# Apps 提升为一等公民 — 信息架构、权限分级与协作

- **Date**: 2026-08-27
- **Status**: Draft，待评审。由一次结构化质询（Q1–Q30）逐条落定，问答记录见本文 §11。
- **Branch**: `docs-apps-self-serve-gitea-fc`
- **Path**: `docs/specs/2026-08-27-apps-first-class-design.md`
- **Scope**: 把 app 从"侧栏里的一个列表"提升为产品的一等对象：第一列常驻、多会话、独立控制面、per-member 权限分级、多人协作同一个 repo，以及删除的资源回收。
- **Builds on**: `docs/specs/2026-08-27-apps-self-serve-gitea-fc-design.md`（下称"前稿"）
- **Amends**: 前稿 §5.6「谁能发版：creator-only」、§1.2 已锁定决策表中的「谁能发版」一行。前稿 §4.1「单一 Gitea org / 不做 per-team org」**保持不变**，见 §5.3。
- **Non-goals**: 用户的 Gitea 账号与 SSO、commit signing（不可抵赖）、session 级别的并发互斥、部署历史与回滚、自定义域名、环境变量面板、per-team Gitea org

> 沿用前稿的规矩：**文中所有对现网行为的陈述都带 `file:line`，实现时以代码为准，不以本文为准。**
>
> 本稿有两处**推翻了质询过程中我自己先给出的建议**，理由写在原地（§4.2 的 `prompt` 档位、§2.1 的折叠交互）。保留这两段是有意的——它们是这份设计里最容易被重新提起的地方。

---

## 1. 背景

### 1.1 为什么现在做

前稿交付的是"能把 app 发布出去"。它落地之后暴露出的问题不是发布链路，而是**app 在产品里没有位置**：

- 一个 app 只能有一个 session（`packages/app/src/lib/app-session.ts:4` —— "An app has exactly one session for now"）。
- 除了创建者，团队里没有第二个人能动它：凭证 `pg-repo/apps.ts:473`、部署 `:337`、finalize `:393` 三处都是 creator-only。
- 它的 8 个操作全挤在侧栏一行的下拉菜单里，其中「删除」和「本地预览」是 `comingSoon` 空壳。
- 删除没有后端，每个 app 都在往外漏资源。

### 1.2 一个必须先说的前提

**Gitea 目前没有部署。** `deploy/self-host/docker-compose.yml:345` 只透传三个默认为空的 `GITEA_URL/TOKEN/OWNER`，**compose 里没有 gitea 服务**。所以前稿那一整套在线上是暗的——建 app 会 503 `gitea_unavailable`。

这决定了本稿的实施顺序（§8）：**先把 Gitea 部署起来，再做信息架构**。

---

## 2. 信息架构

### 2.1 第一列：Apps 常驻并可展开

- Apps 在第一列内联展开应用列表；「新建」放在标题行后面。
- **只有 Apps 可展开**，会话 / 知识库 / 技能等不展开。判据：Apps 的子项有独立身份（每个是一个 workspace + 一个部署目标），而其他模块的子项就是第二列本身——把第二列搬进第一列只是白白挤掉空间。
- **展开 ≠ 选中**：点标题行切换第二列，点三角展开/收起。
- 折叠状态存 `localStorage`，**per-device 不同步**（它是"我这块屏幕多宽"的偏好，不是账号偏好）。
- 选中的 app 变化时**自动展开并滚动到它**；用户手动收起后保持收起，直到下一次选中变化。

> **这里推翻了一个初始建议。** 最初我按 `TeamShareNavSection` 的先例建议"常展开固定子行"。但那个先例能成立是因为它只有 4 个固定 section；Apps 数量无上限，而 §2.2 又把应用列表的唯一去处收敛到了第一列——它必须装得下全部，不能"只显示最近 N 个 + 查看全部"，因为没有"全部"可去。所以需要折叠 + 展开区自身限高滚动，这也是 NavRail 的**第一个折叠交互**（现网没有先例：`NavRail.tsx:222` 一带全是扁平行）。

### 2.2 第二列：当前 app 的 session 列表

- `AppsListColumn` **删除**。`SidebarSecondColumn.tsx:17` 的 `apps` 分支改为渲染该 app 的 session 列表。
- 理由：保留它会让第二列有两个形态、两套空状态，而第一列已经完整呈现了应用列表——同一份数据在两列里各画一遍。

### 2.3 操作分层

| 位置 | 操作 | 判据 |
|---|---|---|
| 第一列行内（悬停/右键） | 部署、打开部署地址、在 Finder 打开 | 看着行上的状态点就能决定，不需要更多上下文 |
| 控制面 | 重命名、Reseed、移动目录、登录方式、权限、删除 | 需要看当前状态和后果才能决定 |

### 2.4 控制面是独立 surface

- **不进 `RightPanel`**。`RightPanel.tsx:16` 现有的 5 个 tab（`diff / session / shortcuts / files / actors`）全是**会话尺度**的；app 设置是**应用尺度**的，混进去会产生"切到别的 session 这个 tab 还在不在"的问题。
- 右上角新增 icon，与 `RightPanel` **互斥显示**，共用同一侧宽度。
- 判定：**「第一列当前选中的 app」`??`「当前 session 的 `appId`」**。
  - **不按 workspace 路径判定**——那会让任何碰巧打开了该目录的人看到应用设置。
  - 允许"第一列选中"是因为存在一个必然出现的中间态：点开 app → 第二列列出 session → 用户还没进任何一个，而这恰恰是最想看设置的时刻（刚建完）。

---

## 3. App 与目录

### 3.1 目录仍由 daemon 派生，不做创建时选目录

`app-session.ts:20-27` 记录了这条规矩的来历：桌面端曾自己算 `~/.amuxd/apps/<id>`，daemon 的根一挪，两边算出不同目录，**agent 在改 A、deploy 在打包 B，线上站点一直是没动过的模板，全程无报错**。现在的解法是"只有 daemon 知道路径，其他人问它"。

**创建时让用户选目录会把"路径有两个来源"重新引进来**，此外还有三处具体冲突：seed 要把模板写进该目录；`app_clone` 拒绝往非空目录 clone；build 要在那里跑 `pnpm install`。

### 3.2 取而代之：控制面提供「移动到…」

- **真搬整个目录**（含 `.git` 与 `node_modules`）：同盘 `rename`，跨盘 `copy + verify + delete`；**失败保留原目录且不改指针**。
- 只改指针不搬文件是不行的：旧目录仍在磁盘上，agent 的历史上下文指向老路径，`node_modules` 要重装。
- 路径覆盖存 **daemon 本地** `config::layout::team_state_dir(team_id)`（`apps/daemon/src/config/layout.rs:103`）下的一个小 json；`resolve_workdir` 先查它再走派生——"单一来源"仍然成立，只是那个来源多了一层本机覆盖。

### 3.3 `workspaces.path` 的定位要降级

`workspaces.path` 是**全局一列**，而同一个 app 在两台机器上的目录本来就不同（`AMUXD_HOME`、brand 都会变）。今天没出事，是因为运行时**从不信这一列**，永远问 daemon。

- 云端该列**降级为"最近一次某设备报告的路径"**，不是权威。
- UI 上明确标注 **"本机路径" + 设备名**。
- 这样"移动"天然是每台机器各自的事，不必给 `workspaces` 加 per-device 结构。

---

## 4. 会话、并发与权限

### 4.1 一个 app 多个 session

- 废除 "exactly one session"，**第 N 个由用户显式创建**（不自动开）。
- **不做运行态互斥**（明确决定：太复杂）。

### 4.2 唯一的并发防线：部署前确认

取消互斥意味着两个 agent 可以同时写同一个目录，而那个目录随时会被 `pnpm build` 打包上线——打出来的是两份改动的任意中间态，且**全程没有任何报错**。

- 在**点部署那一刻**查一次该 workspace 有没有活跃 turn。`workspace_has_active_turn(workspace_path, workspace_id)` 已存在（`apps/daemon/src/runtime/supervisor.rs:1161`），但今天只用于推迟 runtime 刷新，**不拒绝任何请求**。
- 有活跃 turn 则弹确认（复用 `publicDeployConfirm` 的形状），**只确认不硬拦**。
- 这是一个检查点，不是并发模型。

---

## 5. 权限模型

### 5.1 授权主体是 member，不是 session participant

这张表**已经存在**（`services/supabase/migrations/20260601000000_baseline.sql:4138`）：

```sql
CREATE TABLE amux.app_member_access (
    app_id uuid NOT NULL, member_id uuid NOT NULL,
    permission_level text CHECK (permission_level IN ('view','prompt','admin')),
    granted_by_member_id uuid, ...);
```

`listApps` 已经在读它（`pg-repo/apps.ts` 的 `EXISTS (SELECT 1 FROM app_member_access ...)`）。

**不用 session participant 作主体**，两条理由：

1. `session_participants.actor_id`（`baseline.sql:4372`）指向 actors，而 actor 包含 `member` / `agent` / `external`。一个从企业微信进到会话里的人拿"repo 写权限"没有落点——他没有机器、没有 daemon、没有 git 客户端。
2. 一个 app 可以有多个 session（§4.1），权限跟着 session 走就意味着**"把人拉进一个会话 = 授予 repo 权限"**。拉人进会话是个很轻的动作，把它变成授权路径太容易误触。

**分工**：`visibility` 管**可见性**；`app_member_access` 管**可写性**。这同时修正了前稿 §5.6 的 creator-only。

### 5.2 三档如何映射到 git

| 档位 | 凭证 | 能做 | 不能做 |
|---|---|---|---|
| `view` | 不发 | 看 | 拿代码 |
| `prompt` | **写** deploy key | clone、让 agent 改、commit、push | 部署、授权 |
| `admin` | **写** deploy key | 以上全部 + 部署 + 授权 + 改 authMode | — |

> **这里推翻了另一个初始建议。** 我最初建议 `prompt → 只读 key`（"agent 干活要读代码"）。把它和 §5.4 的按需 clone 拼起来会造出一条死路：**agent 改完代码，人推不上去**——那份工作永远留在他的磁盘上，远端看不到、owner 看不到，他自己下次想部署还会被 `ERR_DIRTY` 拦住。这不是一个能解释给用户听的权限。
>
> 正确的切法是把闸移到**上线**：改代码和把它送上线本来就是两个动作，真正不可逆、对外的是后者。这也让 `prompt` 这个名字重新说得通。

不新增 git 维度、不造第二套权限模型——否则控制面里要同时展示两组开关，用户得自己想明白它们的交集。

### 5.3 owner 是 TeamClu 层的概念

- "我建的 app、我决定谁能改"由 `apps.created_by_actor_id` + `app_member_access` 表达。
- **仓库仍归单一 bot org，不给用户开 Gitea 账号**（前稿 §4.1 保持不变）。
- 用户在那个 Gitea 上没有账号，他对仓库的唯一通路是我们按权限发的 deploy key。这是特性不是缺陷：不需要记第二套账号密码。
- 真要 Gitea 账号（用户想不经过 TeamClu 自己 clone / 浏览），等这个诉求被真实提出来再单独立项——它牵涉 Gitea 接 GoTrue、org 生命周期跟着 team 走、离职回收，是独立工程。

### 5.4 第二个人的代码从哪来：按需 clone

app 的 workdir 是本机路径，**只有创建者那台机器上有 checkout**。B 拿到权限后他的 daemon 会算出一个路径，但那个目录是空的。

- **B 第一次打开该 app 时按需 clone**。`clone_app_repo` 已存在（`apps/daemon/src/http/apps.rs:313`，导入外部仓库那条路在用），凭证按 §5.2 的档位发。
- 每人一份本地 checkout，各自 commit / push。
- B 本地有未推送改动时，复用现有的 `ERR_DIRTY` 闸，不新造。

---

## 6. 身份与归属

### 6.1 现状：两层都是空的

- **commit 作者写死**：`apps/daemon/src/sync/app_git.rs:17-18` 是 `TeamClu <apps@teamclu.local>`，且用 `-c` **只作用于 seed 那一次 commit**。之后 agent 或用户在 workdir 里提交，用的是**那台机器的全局 git config**——可能是本人、可能是同事借的机器、也可能压根没配。所以 `git log` 里现在是：第一条 "TeamClu"，后面若干条身份完全不受管。
- **push 匿名**：`jitDeployKeyTitle`（`services/fc/src/lib/provisioning/deploy-key.ts:149`）只有 `jit-<ts>-<nonce>`，不带调用者信息。
- 但**服务端在发凭证那一刻已经知道是谁**：`pg-repo/apps.ts:473` 一带已经解析出 `callerActorId`，只是没拿它命名 key。

### 6.2 两层都补，都不需要 Gitea 账号

1. **commit 身份**：seed 时把 `user.name` / `user.email` 写进该仓库的 **repo-local `.git/config`**（取当前 TeamClu 用户）。此后 agent 和用户的每一次 commit 自动带上——这正是今天用 `-c` 做不到的。
2. **push 身份**：key 标题从 `jit-<ts>-<nonce>` 改为带 `actorId`。Gitea 的仓库审计能看出是谁的 key 推的，也给 §6.3 的撤销提供抓手。

### 6.3 撤权即撤 key

撤掉 `app_member_access` 那一行只能挡住**下一次**发凭证；对方手上那把私钥对应的公钥还挂在仓库上，照样能推。今天 `expiresAt` 的 15 分钟纯粹是文案，实际清理只发生在"下一次有人给这个 app 要凭证"的 sweep 里——没有下一次就永远不清。

- **撤权时立刻按 `actorId` 删掉他在该仓库的所有 key**（`listDeployKeys` 过滤前缀 + `deleteDeployKey`，都是现成的），不等 TTL。
- 保留过期 sweep 作兜底。
- **UI 必须写明**：对方本地那份 clone 撤不回来。撤权只能阻止他继续推送和拿到新代码，**已经在他磁盘上的代码就是在他磁盘上了**。授权对话框要说这句话，否则 owner 会以为"撤权 = 代码收回"。

---

## 7. 生命周期

### 7.1 删除：数据库层已有主张

| 对象 | 现有约束 | 位置 |
|---|---|---|
| `sessions.app_id` | `ON DELETE SET NULL` — 会话保留，只是脱钩 | `baseline.sql:6392` |
| `app_member_access.app_id` | `CASCADE` | `baseline.sql:6112` |
| `app_secrets.app_id` | `CASCADE` | `0021_apps_self_serve_gitea.sql:29` |
| `apps.workspace_id` | `ON DELETE SET NULL` — **删 app 不删 workspace，会留下孤儿** | `db/schema/apps.ts:14` |

### 7.2 外部资源：删什么、留什么

**真删**（是我们替用户开的，删 app 就该收回）：FC 函数 + HTTP 触发器、OSS 上的 `code.zip`、GoTrue OAuth client。

**保留**：

- **Postgres schema 与角色** —— 里面是用户自己的业务数据，删了不可逆而我们没有备份。
- **本机目录** —— 是用户的工作副本；删别人磁盘上的东西要单独勾选同意。
- **Gitea 仓库** —— 但要**撤掉该仓库上所有人的 key** 并 **archive 成只读**（`PATCH repo { archived: true }`）。留着任何一把活的写 key 都是无主的口子；archive 让"保留"变成一份不可写的代码快照。改名加 `deleted-` 前缀，仓库地址记进那行被归档的 workspace，否则运维面对一堆 `tc-app-<uuid>` 无从下手。

**顺手归档那行会变孤儿的 workspace**。

### 7.3 删除对话框的措辞

**不要写"代码已为你保留"**——用户没有 Gitea 账号，会以为自己能拿到。写：

> 代码不会被删除，但删除后你将无法从 TeamClu 访问它；需要找回请联系管理员。

同时说清楚"站点会立刻下线、数据库保留"。

### 7.4 authMode 改动不立即生效

OAuth 的 env 是在 `finalizeDeploy` 里由 `buildPlatformOAuthEnv` 注入函数的。所以把一个**已上线**的 app 从"无登录"改成"平台登录"，云端行改了，**线上函数仍是旧 env，站点依然全公开**——直到下一次重新部署。

- 改完立刻把该 app 标为**「待重新部署」**，并在保存按钮旁给**「立即重新部署」**。
- **这条不能静默**：用户刚点完"需要登录"，会认为站点此刻已受保护，而实际没有。这是安全预期落空，比功能不生效严重。

### 7.5 `features.apps` 关闭的语义

关掉只是**没有入口**（`NavRail.tsx:222`、`SidebarSecondColumn.tsx:17`），数据照常可用：session 还在、workspace 还在、已部署的站点还活着。这条要写进 flag 的注释，否则下一个人会以为"关掉 = 数据不可达"。

---

## 8. 实施顺序

**先部署 Gitea，再做信息架构。**

理由：控制面里有好几块的行为**只有在真能建 app 时才验证得了**——移动目录、删除时撤 key、authMode 改完要重新部署，全都依赖一个活的仓库和一次真实部署。拿现存那几个更早路径建出来的 app 去验，验的是空壳。而且 Gitea 一部署，前稿修过的 SSH remote / OpenSSH 密钥格式 / 分支 checkout 立刻就有真实回归——现在它们只有单元测试撑着。

五块可独立交付：

1. **Gitea 部署**（前置，含 §9.4 的 SSH 可达性）
2. **权限分级**（`app_member_access` → 凭证档位；放开 creator-only）
3. **信息架构重构**（§2）
4. **删除后端**（§7）
5. **authMode 入口**（后端已就绪，前端是一个 select + §7.4 的文案）

---

## 9. 明确接受、未解决的风险

1. **并发写入**：取消互斥后，两个 agent 同时写同一目录仍可能打包出中间态。只有 §4.2 的部署前确认挡着，且它不硬拦。
2. **撤权撤不回已 clone 的代码**（§6.3）。这是物理事实，只能靠 UI 说清楚。
3. **归属是 attribution，不是不可抵赖**：git author 是纯文本，谁都能设成别人；deploy key 是 per-repo 写权限，拿得到该 app 的人都能领一把。要追责得上 commit signing，那和有没有 Gitea 账号无关。
4. **Gitea 的 SSH 端口必须对用户的笔记本可达**。前稿实施时已把 app remote 从 HTTPS `clone_url` 改为 `ssh_url`（deploy key 是 SSH 密钥，在 HTTPS 上认证不了任何东西）。**这条至今没有被验证过，因为没有 Gitea 可验**——它是 §8 第 1 步的验收项，不是可以留到后面的细节。

---

## 10. 与既有规格的关系

- **前稿 §5.6 / §1.2「谁能发版：creator-only」被本稿 §5 取代**：改为 `app_member_access` 的 `admin` 档位。`prompt` 可改代码但不可部署。
- **前稿 §4.1「单一 Gitea org、不做 per-team org」保持不变**（§5.3）。用户的 Gitea 账号仍在 Non-goals 里。
- 前稿 Non-goals 中的「部署历史/回滚」「自定义域名」「环境变量面板」**继续保持** Non-goal。
- 前稿 §7「公开性必须显式确认」不变；本稿 §7.4 补上了它的一个漏洞（改 authMode 不重新部署时确认过的公开性会失真）。

---

## 11. 被否决的方案与理由

留档，避免下次重新提起时再推一遍：

| 方案 | 否决理由 |
|---|---|
| 第一列所有模块都可展开 | 第一列会长到需要自己滚动，底部的设备卡片和设置被顶出视野 |
| 第二列保留应用列表、选中后再切 session | 两个形态、两套空状态；同一份数据在两列各画一遍 |
| app 设置做成 `RightPanel` 的第 6 个 tab | 现有 5 个 tab 全是会话尺度，混入应用尺度会产生"切 session 后 tab 去留"的问题 |
| 按 workspace 路径判定"是否在 app 里" | 任何碰巧打开了该目录的人都会看到应用设置 |
| 创建 app 时让用户选目录 | 重新引入"路径两个来源"，正是 `app-session.ts:20` 那个静默事故的成因 |
| session 级别的运行态互斥 | 复杂度过高（用户判断），改为部署前的单点确认 |
| 授权主体用 session participant | participant 含 agent 与外部渠道 actor；且拉人进会话会变成授权路径 |
| `prompt` 发只读 key | 造出死路：agent 改完推不上去，工作留在本地且下次部署被 `ERR_DIRTY` 拦 |
| 给用户开 Gitea 账号 / per-team org | 需要 Gitea 接 GoTrue、org 生命周期、离职回收；当前诉求（别弄丢代码）由"仓库不删"即可满足 |
| 删除时把仓库也删掉 | 用户明确要求保留 |
| 删除时导出一把长期只读 key 给用户 | 又是一个没人管的凭证，把 §6.3 刚堵上的洞重新打开 |
| 删除时连 Postgres schema 一起删 | 用户业务数据，不可逆且无备份 |

---

## 12. 验收标准

1. Gitea 部署完成，且**从一台普通用户笔记本**能用发下来的 deploy key 完成 `git clone` / `push`（验证 §9.4）。
2. 团队成员 B 被授予 `prompt` 后：能在自己机器上按需 clone、让 agent 改代码、commit、push 成功；**部署被拒**。
3. B 被撤权后：他在该仓库上的 key 立即消失，`push` 失败；且 UI 已告知他本地那份 clone 仍然存在。
4. `git log` 里能看出每条 commit 是谁提的（不再是清一色 `TeamClu`）。
5. 删除一个已上线的 app：站点立刻不可达、FC 函数/OSS 对象/GoTrue client 消失、Gitea 仓库仍在且为 archived 且无任何 deploy key、Postgres schema 仍在、会话仍可查看历史、没有留下孤儿 workspace 行。
6. 把一个已上线 app 的 authMode 从 `none` 改为 `platform`：行立刻显示「待重新部署」，且**在重新部署之前站点仍然是公开的**这一事实对用户可见。
7. 关闭 `features.apps`：入口消失，但既有 app 的会话仍可打开、站点仍在线。
