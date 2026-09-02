# Hosted skill 对账：失败必须关死，不能当成空集或半次安装

> 目标落位：`docs/architecture/hosted-skill-reconcile-fail-closed.md`
> 状态：**P0-1 + P0-2 已落地。** P1-3（zip `contentHash` 校验）顺手做了，装在同一条安装管线上。
> 相关：`docs/architecture/team-skills-registry.md` §8.1 / §8.2
>
> 明确不做：MQTT 加速、Caddy / NanoMQ / Supabase schema、refresh-token 轮转、改 `services/fc`。

共享 agent 的 skill 集由 daemon 对账（`apps/daemon/src/runtime/team_skills.rs`）。对账读服务端期望集，多的装、少的卸、版本不符的换。这条路径无人值守，所以「失败」和「团队清空了」必须分得开，「装到一半」必须能退回上一版。本文件修的就是这两处把失败读成成功的洞。

## 1. P0-1：列表 404 不是空期望集

### 1.1 现状（已核实）

`apps/daemon/src/backend/cloud_api/mod.rs` 的 `team_skills()` 把 `GET /v1/teams/:id/skills` 的 `NotFound` 映射成 `Ok(vec![])`，注释写的是「和 team MCP 的 404 一样，没注册表不算错」。

`runtime/team_skills.rs::reconcile_now` 只在 `Err` 时 fail-close：打一条 warn，**不**改 `last_fetch`，磁盘原样保留。`Ok([])` 会走进 `apply()`，把每一个非 dirty 的 hosted pack 删掉。

401 走 `BackendError::Auth`，本来就会 keep。洞只在 404：代理误路由、打到错的 team、网关把「找不到这条路径」答成 404，都会被读成「团队卸光了」。

FC 的空列表是 **HTTP 200 + `{ items: [] }`**（`services/fc/src/lib/routes/team-skills.ts`：`return { body: { items } }`）。注册表存在、这个 actor 一件都没装，走的是这条。404 不是这条。

MCP / env 的 404→空是另一类资源：从没开过团队 MCP，空配置就是事实。Skills 对账会**删除**磁盘上的包，404 不能借用那条语义。本文件不改 MCP / env。

### 1.2 规则

`GET /v1/teams/:id/skills` 只有这一种东西算期望集：

| 响应 | 对账 |
|---|---|
| HTTP 200，body 是对象，带 `items` 数组（可空） | 这就是期望集。`[]` 表示卸光非 dirty pack |
| HTTP 401 / 403 | `Err`（Auth / Provider）→ keep |
| HTTP 404 | `Err`（NotFound）→ keep |
| HTTP 5xx | `Err`（Provider）→ keep |
| 200 但 JSON 解不出、缺 `items`、`items` 不是数组 | `Err`（Serde）→ keep |
| 网络失败 | `Err` → keep |

`#[serde(default)]` 从 `items` 上拿掉：缺字段必须解失败，不能静默变成 `[]`。

默认 `Backend::team_skills` 已经是 `Err(NotFound)`，不是 `Ok([])`。cloud_api 之前把这条护栏在 HTTP 层拆掉了。

### 1.3 测试

cloud_api 客户端：401 / 404 / 5xx / 200 缺 `items` 都是 `Err`；200 `{ items: [] }` 是 `Ok([])`；200 带行是 `Ok(rows)`。

对账（真实 `CloudApiBackend` + 临时 `AMUXD_HOME`）：

- 401 → 已装 pack 还在，`removed = 0`
- 404 → 同上
- 200 `{ items: [] }` → 非 dirty pack 被卸掉
- 200 带 `installed: true` 的行 → pack 被装上，origin 版本和文件一致

## 2. P0-2：原子安装或回滚

### 2.1 现状（已核实）

`install()` 的顺序是：解压到 staging → **`swap_managed_files` 把文件拷进活目录** → 回写 frontmatter → 算 manifest → **最后 `write_origin`**。

`swap_managed_files` 不碰 `.clawhub/`（manifest 排除了这本书）。origin 只能另写。若 origin 写失败：

- 磁盘上的 `SKILL.md` 等已经是 vN
- `.clawhub/origin.json` 仍是 vN-1（或没有）
- `inspect()` 拿旧 baseline 比新文件 → **Dirty**
- `apply()` 见 Dirty 就跳过升级，这个 pack **从此钉死**，自动跟随再也不会碰它
- 没有把 swap 撤回去的路径

进程在 swap 和 origin 之间崩溃是同一类窗口；origin 写失败是它的可复现形态。

### 2.2 修复

在 `crates/teamclu-skillpack` 加 `commit_staged_pack`。安装管线改成：

```
下载 zip
校验 contentHash（有才校，见 §3）
解压到 staging
在 staging 上回写 frontmatter
在 staging 上写 origin.json（此时 staging 已是完整的新树：文件 + 匹配的 origin）
commit_staged_pack(target, staging)
  → 给 target 整树做快照（含用户自己的文件）
  → swap_managed_files（只动包声明的文件）
  → 把 staging 的 origin.json 拷进 target
  → 任一步失败：用快照把 target 恢复成进入 commit 之前的样子
```

成功之后：origin 的 `installedVersion` 和磁盘文件是同一版，`inspect` 为 Clean。失败之后：要么仍是旧版且 Clean，要么（全新安装）target 不存在。不会留下「文件 vN / origin vN-1」。

origin 必须在 staging 上先写好，`commit` 发现 staging 没有 `origin.json` 就拒绝动手——这是「先写 origin 再让新树活」那条备选的可执行形态。活目录上的 origin 仍然最后落地，因为先改活 origin 再换文件会留下另一种 Dirty（origin vN / 文件 vN-1）。

快照走 `tempfile`，不放在 skills 根下。放成根下的兄弟目录会被 `installed_versions` 扫成又一个 pack。

### 2.3 测试

skillpack：

- origin 写入失败 → target 回到旧版，`inspect` 不是 Dirty，origin 版本和文件一致
- 成功 commit → origin 版本和文件一致
- 全新安装 origin 失败 → target 不残留半棵树

desktop 下载安装走同一条 `commit_staged_pack`（同一个洞，改动量就是换调用顺序）。`team_skill_install_from_dir` 可能 staging ≡ target，本轮不动。

## 3. P1-3（顺手）：换文件之前校验 zip `contentHash`

`GET .../download` 已经带 `contentHash`（zip 的 sha256 hex）和 `size`。下载后、解压前：

- `contentHash` 非空且和字节对不上 → `Err`，磁盘不动
- `size > 0` 且和字节长度对不上 → 同上
- `contentHash` 为空 → 不校，不挡安装（旧服务端 / 缺字段）。缺哈希不是「校验失败」

哈希在 `teamclu-skillpack::sha256_hex`，和文件 manifest 用同一套 sha256 hex。

## 4. 明确不做

- MQTT `actor_notify()` 把下一次对账提前到现在
- 改 MCP / env 的 404→空（那些资源空配置就是事实）
- 改 Caddy、NanoMQ、Supabase schema、refresh-token 轮转
- 重置 daemon identity
- 动 `services/fc`
- 进程在 swap 与 origin rename 之间被杀的极窄窗口：失败路径会回滚，崩溃不会。pack 很小，接受；真要封死得上目录级 rename + 非托管文件合并，本轮不做

## 5. 落地位置

| 文件 | 改动 |
|---|---|
| `crates/teamclu-skillpack/src/commit.rs` | `commit_staged_pack` + 失败回滚 |
| `crates/teamclu-skillpack/src/manifest.rs` | `sha256_hex` |
| `apps/daemon/src/backend/cloud_api/mod.rs` | `team_skills()` 不再把 404 变成 `[]`；`items` 不再 default |
| `apps/daemon/src/runtime/team_skills.rs` | staging 上写完 origin 再 commit；下载后校 hash |
| `apps/desktop/src/commands/team_skills.rs` | 下载安装改走 `commit_staged_pack` |
