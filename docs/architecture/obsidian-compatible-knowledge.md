# knowledge 目录兼容 Obsidian + 同步忽略规则

> 状态：**设计，未实现**。本文描述目标态。
>
> 相关：`docs/architecture/team-mcp-and-env-cloud.md`（同步为什么只剩
> `knowledge/`）、`docs/architecture/amuxd-home-layout-v2.md`（家目录布局）。

## 1. 目标与非目标

**目标**

1. 团队的 `knowledge/` 目录可以被 Obsidian 直接「Open folder as vault」打开，
   双向编辑，不需要插件、不需要额外同步工具。
2. 引入一套类 `.gitignore` 的同步忽略机制，让 `node_modules/`、`target/` 这类
   海量小文件目录永远不会进入同步链路 —— **既保护服务端，也保护本地扫描性能**。

**非目标**（本轮不做，见 §8）

- Obsidian 移动端。那需要插件方案（vault 可在任意位置 + 我们的同步协议用 TS
  重写 + 团队 E2E 密钥交给第三方 app），代价与收益不成比例。
- 把 `knowledge/` 软链进用户已有的个人 vault。Obsidian 官方不支持 vault 内部的
  软链，其 watcher 可能收不到软链子树的外部写入，队友同步来的新笔记要重启才可
  见。可以作为文档里的逃生通道，不作为支持的形态。
- 我们自己的 Markdown 编辑器全面对齐 Obsidian 语法（callout、properties、
  backlinks 面板）。这是「我们像 Obsidian」，与「Obsidian 能打开我们的目录」正交，
  可以后续增量做。

## 2. 现状

### 2.1 同步链路（事实）

| 事实 | 位置 |
|---|---|
| 同步前缀只剩 `knowledge/` | `apps/daemon/src/sync/oss/path_validator.rs:8`、`services/fc/src/lib/sync-path.ts:11` |
| 内容根是 `~/.amuxd[-<brand>]/teams/<id>/shared/`，vault 候选是其下的 `knowledge/` | `apps/daemon/src/config/global_team_store.rs` |
| 也可从 `<workspace>/team-knowledge` 软链进入 | `apps/daemon/src/config/workspace_link.rs:200` |
| **磁盘上是明文**，加密只发生在上传 | `apps/daemon/src/sync/oss/crypto.rs`，扫描器算的是 `local_plain_hash` |
| 扫描器全量 walk，**只跳过 `*.conflict.*`**，点开头的目录照收 | `apps/daemon/src/sync/oss/scanner.rs:33` |
| 任意文件类型都同步（字节走 blob） | `apps/daemon/src/sync/oss/engine.rs` |
| 触发：app 内手动 + 300 秒定时器 | `apps/daemon/src/sync/timer.rs:21` |
| 删除靠 tombstone：`state` 里有、`scan` 里没有 → 广播删除 | `apps/daemon/src/sync/oss/engine.rs:1358` |

### 2.2 已经具备的 Obsidian 特性

- wiki link `[[target#heading|alias]]` 的解析、点击跳转、点不存在的目标就新建
  （`packages/app/src/lib/wiki-link-utils.ts`、`wiki-link-resolver.ts`）。
- 链接解析用「文件名 + 最短路径优先」（`packages/app/src/lib/wiki-link-index.ts`
  的 `buildFileMap`），这正是 Obsidian 的默认
  *shortest path when possible*。两边解析同一份 `[[...]]` 结果一致。
- 文件树上 knowledge 目录已经画了 Obsidian 图标
  （`packages/app/src/components/workspace/FileTreeNode.tsx:423`）。

### 2.3 服务端目前没有任何防线（两个关键事实）

**其一，`/v1/sync/*` 完全豁免限流。** `services/fc/src/app.ts:143-157` 明确把
`/sync/` 排除在 per-IP 限流之外，理由是一次 sync tick 会发多个请求、同一 NAT 后
的队友会互相饿死。这个理由成立，但结果是**同步数据平面上没有任何速率或容量约
束**。

**其二，字节是 presigned 直传，不经过 FC。** `services/fc/src/lib/sync-handlers.ts:350`
下发预签名 PUT，客户端直接写对象存储。所以「冲垮」有两个互相独立的维度：

- **FC / Postgres**：每个文件一行 `sync_files` + 每版本一行，加上
  manifest 分页与 batch 请求数（一次最多 200 条，`MAX_SYNC_BATCH`）。
- **对象存储磁盘**：self-host 走本机 MinIO，单桶按前缀分区，而那块盘的余量是个
  位数 GB 级别。一个 `node_modules/` 就能吃掉它。

结论：**客户端 ignore 是主防线，但不能是唯一防线**（旧版本客户端不认新规则）。
服务端要有第二道，见 §4.7。

### 2.4 缺口清单

| # | 缺口 | 后果 |
|---|---|---|
| 1 | 新建笔记默认名是 `untitled`，无 `.md` 后缀（`packages/app/src/components/workspace/FileTree.tsx:1121`） | Obsidian 打不开、默认不显示。真实团队的同步状态里已经有 `knowledge/untitled` |
| 2 | 没有忽略机制，点开头目录照收 | `.obsidian/`、`.trash/`、`.DS_Store` 全同步；`node_modules/` 一旦被放进来就是灾难 |
| 3 | 冲突副本是 `.md`，就躺在原文件旁边（`apps/daemon/src/sync/oss/conflict.rs:38`，形如 `foo.conflict.1748332800.abc123de.md`） | 在 Obsidian 里是正经笔记：出现在文件树、关系图、搜索、链接补全 |
| 4 | 外部改动最多 5 分钟才发出去 | 在 Obsidian 里改完关掉，队友要等一个定时器周期 |
| 5 | 编辑器不渲染 `![[附件]]` 嵌入，附件目录无约定 | 两边对附件放哪没有共识 |

## 3. 决策：vault 就是 knowledge 目录

### 3.1 vault 根

```
~/.amuxd[-<brand>]/teams/<team-id>/shared/knowledge
```

用户执行一次「Open folder as vault」。**不做镜像、不做二次副本** —— 多一份副本
就多一层冲突面。

已知代价：路径是隐藏目录下的一个 UUID，难看；重新 onboard 会换目录，用户要重新
指一次 vault。接受，换来的是「两边编辑同一份字节」这个最重要的性质。

### 3.2 `.obsidian/` 完全不同步（已决策）

Obsidian 会在 vault 根下建 `.obsidian/`，其中 `workspace.json` 记录当前打开的
面板布局 —— **每挪动一次面板就写一次盘**。同步它意味着：版本号持续增长、跨设备
永久冲突、每个人的界面被别人的布局覆盖。

社区插件同步则更糟：等于用团队同步链路分发可执行代码。

因此：`.obsidian/` **整个目录进内置忽略清单**，不提供开关。团队级的 Obsidian
配置（模板、外观）如果将来有需求，另开一个显式的、只含白名单文件的机制，不要
从「同步整个 `.obsidian/`」这条路进去。

同批进内置清单的还有 `.trash/`（Obsidian 自己的回收站）和 `.DS_Store`。

### 3.3 入口（已实现）

Knowledge 列 header 上原本是一个「刷新并同步」按钮，它是多余的：同一列的底部栏
（`KnowledgeSyncFooter`）既报告同步状态，也能触发同步 —— 没有列表时整条 bar 就是
同步按钮，有列表时 popover 里有 `Sync now`。那个 slot 改成「在 Obsidian 中打开」。

**只在 knowledge section 替换**。其它 section（skills / mcp / env）没有底部同步
栏，刷新按钮仍然是它们唯一的手动刷新入口，原样保留。

后端 `apps/desktop/src/commands/obsidian.rs` 提供两个命令：

| 命令 | 作用 |
|---|---|
| `obsidian_status(vaultPath)` | `{ installed, vaultRegistered }` |
| `obsidian_open_vault(vaultPath)` | 打开；首次会先把目录注册成 vault |

#### Obsidian 认 vault 的机制（实测，非推断）

对着本机 Obsidian 1.13.7 (macOS) 实测得到，这几条决定了实现形状：

1. **vault 列表在 `<config dir>/obsidian/obsidian.json`**，形如
   `{"vaults": {"<id>": {"path": …, "ts": …, "open": bool}}}`。
   `dirs::config_dir()` 在三个平台正好都对：`~/Library/Application Support`、
   `%APPDATA%`、`~/.config`。
2. **那个 id 不是路径 hash。** 拿真实条目试过 md5/sha1/sha256（含带尾斜杠、
   `file://` 前缀、小写等变体）全不匹配 —— 它是个不透明值，只用来做字典 key 和
   `<id>.json` 窗口状态文件名。所以任何唯一值都行；我们用 `sha256(path)[..8]`，
   好处是同一目录重复注册会覆盖自己那条，天然幂等。
3. **`obsidian://open?path=` 只解析注册表里的 vault。** 未注册的路径发过去会被
   接受然后什么也不做。
4. **`.obsidian/` 是 Obsidian 打开目录时创建的**，是注册的结果而不是原因。所以
   「`.obsidian/` 存在」**不能**用来判断「这是不是 vault」—— 注册表才是唯一诚实的
   来源。（第一版实现用错了这个判据，实测才发现。）
5. **Obsidian 只在启动时读一次注册表。** 在它运行期间注册的新 vault，URI 打不开 ——
   实测：URI 被接受、静默无事发生。

#### 首次打开的流程

第 5 条决定了必须分支，所以 `obsidian_open_vault` 返回一个 outcome 而不是
`()`：

```
点击
 ├─ 已注册 → 发 URI → Opened
 └─ 未注册
     ├─ seed `.obsidian/app.json`（见下）
     ├─ 注册进 obsidian.json（原子写，open: false）
     ├─ Obsidian 未运行 → 发 URI → Opened          ← 绝大多数情况，一步到位
     └─ Obsidian 运行中 → RegisteredNeedsRestart   ← 提示重启一次，不发 URI
```

注册时 `open` 写 `false` 是刻意的：`true` 会让 Obsidian 下次启动时打开我们的库而
不是用户原来那个，一个叫「在 Obsidian 中打开」的按钮没有权力劫持这个。

写注册表用临时文件 + rename 原子替换 —— Obsidian 随时可能读它，半个文件会让用户
丢掉所有 vault。读不动或解析不了时按空处理而不是报错：Obsidian 会整体重写这个
文件，为一个我们只是没看懂的文件让按钮永久失效不划算。

#### 预置的 vault 配置

首次注册时写 `.obsidian/app.json`（**已存在就不碰**，那是用户的文件）：

| 设置 | 为什么 |
|---|---|
| `attachmentFolderPath: "attachments"` | 落地 §5.4 的附件约定，Obsidian 里粘贴的图片和 app 里加的附件落到同一处 |
| `showUnsupportedFiles: true` | 知识树里有无 `.md` 后缀的文件（§5.1 缺口 1），不开这个 Obsidian 会把它们藏起来，看着像被删了 |
| `alwaysUpdateLinks: true` | 重命名笔记时自动改写指向它的 `[[链接]]`。共享树上不开这个，一个人重命名就会静默打断所有人的链接 |

注意这和 §3.2「`.obsidian/` 完全不同步」不矛盾：**本地创建、不上传**。所以这是每台
设备各自的初始化，不是共享配置 —— 每台设备第一次点按钮时都会 seed 一次，行为一致。

#### 装了才亮

`installed` 决定按钮是 Obsidian 紫（`#7C3AED`）还是继承的 muted 灰 + disabled。
检测按平台分开做，因为没有可移植的「这个 app 装没装」：

- **macOS**：`/Applications/Obsidian.app` 与 `~/Applications/Obsidian.app`，再用
  Spotlight（`mdfind kMDItemCFBundleIdentifier == 'md.obsidian'`）兜底装在别处的。
- **Windows**：`%LOCALAPPDATA%` / `%ProgramFiles%` / `%ProgramFiles(x86)%` 下的
  `Obsidian\Obsidian.exe` 与 Squirrel 的 `Programs\Obsidian\Obsidian.exe`，再用
  注册表里的 `obsidian://` handler（`HKCU\Software\Classes\obsidian`）兜底绿色版。
- **Linux**（顺带）：PATH 上的 `obsidian`，然后 Flatpak id。

探测在窗口重新获得焦点时重跑（`useObsidianStatus`）。安装 Obsidian、以及首次注册后
重启它，都发生在别的 app 里 —— 不重探的话，用户刚照提示做完，按钮状态还是旧的。

路径必须 percent-encode：home 目录带空格很常见，团队里 CJK 文件夹名是常态。这条有
单测。

## 4. 忽略机制

### 4.1 规则来源（三层，后者覆盖前者）

```
1. 内置默认      编译进 daemon，见 §4.3
2. 团队规则      knowledge/.amuxignore     ← 自身参与同步，全团队一致
3. 本机规则      shared/.syncignore.local  ← 不在 knowledge/ 下，故不同步
```

第 2 层放在 `knowledge/` **内部**是刻意的：它得跟着团队走，一个人加了规则全队
生效。代价是它自己是一个同步文件，所以有一条硬规则：

> **`.amuxignore` 自身永不被忽略**，任何规则都不能匹配掉它。

第 3 层给「我这台机器上这个目录很特殊」的情况，不污染团队。

### 4.2 语法

采用 `.gitignore` 语法的**子集**，用 `ignore` crate（ripgrep 的实现，桌面端
`apps/desktop/Cargo.toml:107` 已经在用 `ignore = "0.4"`，daemon 侧新增依赖）。
支持：

- `#` 注释、空行
- `node_modules/` 目录匹配（尾斜杠 = 只匹配目录）
- `*.log`、`**/build` 通配
- `/` 开头锚定到 vault 根
- `!` 否定（`ignore` crate 自带，不额外实现）

**大小写不敏感**：macOS 与 Windows 的文件系统默认如此，规则若大小写敏感会在
跨平台团队里表现不一致。

### 4.3 内置默认清单

```gitignore
# 版本控制与系统垃圾
.git/
.svn/
.hg/
.DS_Store
._*
.Spotlight-V100/
.Trashes/
Thumbs.db
desktop.ini
$RECYCLE.BIN/

# 编辑器 / 笔记工具自身状态
.obsidian/
.trash/
.vscode/
.idea/
*.swp
*~

# Node
node_modules/
.pnpm-store/
.yarn/
.npm/
dist/
build/
.next/
.nuxt/
.turbo/
coverage/

# Rust
target/
.cargo-target/

# Python
__pycache__/
*.pyc
.venv/
venv/
.mypy_cache/
.pytest_cache/
.ruff_cache/

# JVM / iOS
.gradle/
DerivedData/
Pods/
*.xcuserstate

```

**冲突副本刻意不在这份清单里。** 直觉上该加一条 `*.conflict.*`，但那个 glob 会
连 `merge.conflict.md` 一起吞掉 —— 那是别人写的一篇笔记。后果
`scanner::has_conflict_infix` 的注释已经记着：同步会静默拒绝上传它，而冲突端点会
把它列成一个永远做不了的决策。冲突副本继续由扫描器用更严格的
`<stem>.conflict.<unix_ts>.<hash>` 形状判断。

### 4.4 兜底护栏（比清单更重要，已落地）

清单永远列不全。真正的保险是两条与文件名无关的闸门，都在
`engine::plan_push`（拆成纯函数就是为了能脱离 FC 客户端直接测）：

| 闸门 | 值 | 行为 |
|---|---|---|
| `MAX_FILE_BYTES` | 25 MiB | 跳过该文件，其余照推，把路径报进 `TickResult.oversize` |
| `MAX_NEW_FILES_PER_TICK` | 2000 | **整次 push 全部不发**，把数量报进 `TickResult.blocked_new_files`，等人确认 |

第二条是「node_modules 被拖进来」的真正拦截点 —— 它只数数、不读名字，所以在任何人
（包括我们）写出规则**之前**就生效，对一个谁都没听说过的构建工具同样管用。25 MiB
和桌面端判断「文件大到打不开」用的是同一个数（`MAX_WORKSPACE_FILE_BYTES`），让「大
到不能编辑」和「大到不能同步」保持一致。

三个刻意的选择：

**超限时一个都不推，不是推前 2000 个。** 团队云端躺着半棵源码树比一个都没有更糟，
而且用户应该做一个决定，而不是眼看着一个自己没要求过的上传完成大半。

**「确认」只能由人给出。** `TickOptions.allow_bulk_add` 从 UI 一路传到引擎，定时器
和任何重试都传 `false`。任何地方默认成 `true`，这道闸门就退化成「延迟一个 tick」。
前端的 store 测试专门断言这个参数是显式的 `false` 而不是省略。

**算的是「新文件」，不是「有改动的文件」。** 手工编辑 2000 篇已有文档不是洪水，
`git clone` 一秒钟就能落下十倍的量。所以只数 scan 里有、state 里没有的那些。

UI 在 `KnowledgeSyncFooter`：被拦下时整条 bar 变成一句「一次新增 N 个文件 —— 已
拦下，点击发送」，点它就带上确认重跑；超大文件报「N 个文件太大，已跳过」。**被跳过
的东西必须看得见** —— 静默跳过是另一种失败模式，用户会以为它同步了。

### 4.5 生效点

| 阶段 | 是否应用 ignore | 说明 |
|---|---|---|
| scan（`scanner.rs`） | ✅ | 不 walk 进被忽略目录，顺带修掉本地扫描性能 |
| push | ✅ | scan 的自然结果 |
| **delete / tombstone**（`engine.rs:1358`） | ⚠️ **必须显式排除**，见 §4.6 | |
| pull（`engine.rs:539`） | ✅ 跳过，但**不报错** | 旧客户端已经推上去的东西，本地不落盘 |

pull 侧「跳过而不报错」是有先例的教训：`path_validator.rs` 里 `RETIRED_PREFIXES`
的那段注释写得很清楚 —— 在 pull 循环里对着一条历史遗留记录硬 `?` 失败，会让**整
个 manifest apply 在第一行就中止**，把还该同步的东西一起拖下水，而且
`InvalidPath` 被归类为非瞬时错误，永远不会自愈。ignore 在 pull 侧必须是
`continue`，不能是 `return Err`。

### 4.6 ⚠️ 迁移陷阱：新规则会广播删除

这是本设计里最危险的一处，实现时必须先解决。

`locally_deleted_paths`（`engine.rs:1358`）判定「本地删除」的依据是：

> 在 `state.files` 里有（`synced_version > 0`），但不在本次 `scan` 结果里。

而加 ignore 之后，一个**历史上已经同步过**的文件（比如某个团队之前真的同步了
`.obsidian/appearance.json`）会从 scan 结果里消失。于是引擎会认为它被本地删除，
**发出 tombstone，删掉全团队每台设备上的这份文件**。

**已落地，走的是 A 的简化版**：`locally_deleted_paths` 计算 tombstone 列表时用
`IgnoreRules::is_ignored_with_ancestors` 过滤一遍 —— 被忽略的路径既不推、也不发
删除。

原方案里的「给 `state.files` 加一个 `ignored` 标记」**不需要**：条目本来就留在
state 里，只是不再出现在 scan 结果中。规则将来放宽，文件重新被 scan 到，就会自己
接着同步。少一个状态字段，少一处可能不同步的真相。

`/v1/team/changed` 里那段镜像 `locally_deleted_paths` 的代码也补了同样的排除 ——
否则 UI 会把被忽略的文件显示成「待删除」，而那个删除永远不会发生。

**另一个必须知道的 API 细节**：`ignore` crate 的匹配只看条目本身，不做父目录传递
（对 walker 是对的 —— 它边走边剪，子项根本不会出现）。但 tombstone 拿到的是一条
裸路径，没有 walk 可剪，`node_modules/` 这条规则匹配不到
`node_modules/a/b.js`。所以有两个形式：`is_ignored`（平的，给 walker）和
`is_ignored_with_ancestors`（逐级往上，给 tombstone 和 pull）。测试里有一条专门
断言平的那个**不能**看祖先，因为 walker 依赖它只回答自己。

### 4.7 服务端一侧

客户端 ignore 挡不住旧版本客户端。服务端补两道，但**位置要选对**：

1. **写入口拒绝**（`/sync/upload/init` 等 push 路径）：对同一份内置清单做路径
   匹配，命中则 422 `IgnoredPath`。只在**写**路径上拒绝 —— 按 §4.5 的教训，
   绝不能加进 `validateSyncPath` 的通用校验里，那会连带炸掉 pull。
2. **每 team 配额**：文件总数与总字节数上限，超限返回明确错误码而不是 500。
   阈值待定（§8）。

限流本身维持现状（`/v1/sync/*` 仍豁免 per-IP 限流，理由见 §2.3），配额是按 team
而不是按 IP 的，不会有 NAT 互相饿死的问题。

## 5. 其余四个缺口

### 5.1 `.md` 后缀（缺口 1）

- 新建文件默认名改为 `untitled.md`。
- knowledge 树下新建 / 重命名时，若用户没写扩展名则补 `.md`；若写了别的扩展名，
  尊重用户（附件、图片是合法内容）。
- 已存在的无后缀文件：不自动改名（会打断队友的链接），但在文件树上给一个提示。

§3.3 预置的 `showUnsupportedFiles: true` 让这些文件在 Obsidian 里至少**可见**，
但它们仍然打不开、也不是笔记 —— 那只是止血，这一刀还是要做。

### 5.2 冲突副本（缺口 3）

两个选项：

- **A（倾向）**：保持文件名格式不变，但落到 `.conflicts/` 这个点目录下的镜像路
  径。Obsidian 默认忽略点目录，副本对它完全隐形；我们自己的冲突 UI 改成从这个
  目录读。需要同步改 `original_from_conflict` / `conflict_timestamp` 的路径推导
  （`conflict.rs:70-110`）。
- B：维持现状，文档里告诉用户在 Obsidian 的 Excluded files 里加 `*.conflict.*`。
  成本为零，但 Obsidian 的排除只降权、不隐藏，关系图里还是看得见。

### 5.3 即时同步（缺口 4）

给 knowledge 根挂一个带 debounce 的文件监听，事件落地后触发一次 sync tick。

- 桌面端已有现成的 `watch_directory`（`apps/desktop/src/commands/filewatcher.rs:46`，
  基于 `notify-debouncer-mini`），但它只在 app 开着时有效。
- daemon 侧已有 `notify` 依赖与 `refresh_watch.rs` 的模式，headless 场景应该走
  这条。
- debounce 建议 2 秒；Obsidian 保存频繁，太短会把一次编辑打成多次 tick。
- 监听必须复用同一套 ignore 规则，否则一个 `node_modules/` 的写入风暴会把 tick
  触发到爆。

### 5.4 附件（缺口 5）

- ~~约定附件目录为 `knowledge/attachments/`，并在文档里告诉用户把 Obsidian 的
  「Default location for new attachments」指过去。~~ **已完成**：§3.3 首次注册
  vault 时就把 `attachmentFolderPath` 预置好了，用户不用自己配。
- 我们的 Markdown 编辑器支持渲染 `![[file.png]]` 嵌入。
- 附件天然受 §4.4 的单文件大小闸门保护。

## 6. 实施顺序

| 刀 | 内容 | 依赖 |
|---|---|---|
| 1 | ~~ignore 机制：三层规则来源 + 内置清单 + **tombstone 排除**（§4.6）~~ **已完成** | 无 |
| 2 | ~~兜底护栏：单文件大小 + 单 tick 文件数上限，含 UI 呈现~~ **已完成** | 刀 1 |
| 3 | `.md` 后缀默认值与补全 | 无 |
| 4 | 文件监听触发即时同步 | 刀 1（必须复用 ignore） |
| 5 | ~~「在 Obsidian 中打开」入口~~ **已完成** + 用户文档 | 刀 3 |
| 6 | 服务端写入口拒绝 + 每 team 配额 | 刀 1（共用清单） |
| 7 | 冲突副本迁 `.conflicts/` | 独立 |
| 8 | ~~附件目录约定~~ **已完成**（§3.3 预置 `attachmentFolderPath`）+ 编辑器渲染 `![[...]]` | 独立 |

刀 1 与刀 2 是「防止服务器被冲垮」的实质内容，优先级最高。刀 1 里的 §4.6 是**上
线前必须验证的一条**：拿一个历史上同步过 `.DS_Store` 的团队做回归，确认升级后云
端那份没有被删。

## 7. 验收

1. 在 `knowledge/` 里 `git clone` 一个带 `node_modules/` 的仓库，等一个 tick：
   同步状态显示被忽略/被闸门拦截，`sync_files` 表没有新增行，MinIO 没有新对象。
2. 用 Obsidian 打开 vault，改一篇笔记 → 2 秒内 tick 发出 → 另一台设备收到。
3. Obsidian 产生的 `.obsidian/workspace.json` 在任何设备上都不产生同步流量。
4. 在 app 里新建笔记 → Obsidian 里立刻可见可编辑（`.md` 后缀生效）。
4b. 一台从没打开过这个目录的机器：Obsidian 没在运行时点按钮 → 直接进 vault，无需
   任何手工步骤；Obsidian 正在运行时点按钮 → 提示重启，重启后再点直接进。
5. 升级前同步过 `.DS_Store` 的团队，升级后云端那份仍在，本地不再推送它。
6. 一台故意不升级的旧客户端推 `node_modules/` → 服务端 422 拒绝，且不影响该团队
   其它文件的正常同步。

## 8. 未决问题

- 每 team 配额的具体阈值（文件数 / 总字节）。需要先看现有团队的分布。
- 冲突副本走 §5.2 的 A 还是 B。
- 附件目录叫 `attachments/` 还是别的；是否需要在 onboarding 时替用户写一次
  Obsidian 配置（等于承认我们在写 `.obsidian/`，与 §3.2 的立场有张力）。
- ~~被忽略的文件在 app 的文件树里如何呈现~~ **已定**，见 §5.5。
