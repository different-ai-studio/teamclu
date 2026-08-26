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
| `obsidian_status(vaultPath)` | `{ installed, vaultInitialized }` |
| `obsidian_open_vault(vaultPath)` | 打开，或首次时只拉起应用 |

**装了才亮。** `installed` 决定按钮是 Obsidian 紫（`#7C3AED`）还是继承的 muted
灰 + disabled。检测按平台分开做，因为没有可移植的「这个 app 装没装」：

- **macOS**：`/Applications/Obsidian.app` 与 `~/Applications/Obsidian.app`，
  再用 Spotlight（`mdfind kMDItemCFBundleIdentifier == 'md.obsidian'`）兜底装在
  别处的情况。
- **Windows**：`%LOCALAPPDATA%` / `%ProgramFiles%` / `%ProgramFiles(x86)%` 下的
  `Obsidian\Obsidian.exe` 与 Squirrel 的 `Programs\Obsidian\Obsidian.exe`，
  再用注册表里的 `obsidian://` URI handler（`HKCU\Software\Classes\obsidian`）
  兜底绿色版/异常位置安装。
- **Linux**（顺带）：PATH 上的 `obsidian`，然后 Flatpak id。

探测在窗口重新获得焦点时重跑（`useObsidianStatus`）。理由很实际：安装 Obsidian、
把目录加成 vault，这两件事都发生在别的 app 里 —— 不重探的话，用户刚照我们说的做
完，按钮还是灰的，得重启应用才变亮。

**首次的处理。** `obsidian://open?path=` 只能解析 Obsidian 已知 vault 内的路径，
对一个它从没打开过的目录会弹错误框。所以用 `.obsidian/` 目录是否存在判断这个目录
有没有被当成 vault 打开过：

- 没有 → 只把 Obsidian 拉起来（macOS `open -a Obsidian`；Windows spawn 那个 exe），
  同时把 vault 路径写进剪贴板并 toast 一句「选择 Open folder as vault 并粘贴」。
  比让用户去一个隐藏目录里手抄一个 UUID 强。
- 有 → 走 URI。

路径必须 percent-encode：home 目录带空格很常见，团队里 CJK 文件夹名是常态。这条
有单测（`open_uri_percent_encodes_the_path` / `open_uri_encodes_non_ascii`）。

注意 `.obsidian/` 在**本地**是存在的，只是不上传（§3.2）—— 所以它作为「这个目录
是不是 vault」的判据依然成立。

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

# 我们自己的
*.conflict.*
```

`*.conflict.*` 目前是扫描器里的一句硬编码（`scanner.rs`），搬进清单让它显式化，
行为不变。

### 4.4 兜底护栏（比清单更重要）

清单永远列不全。真正的保险是两条与文件名无关的闸门：

| 闸门 | 默认值 | 行为 |
|---|---|---|
| 单文件大小上限 | 25 MB | 超过则跳过并在同步状态里报出来，**不静默** |
| 单次 tick 新增文件数上限 | 2000 | 超过则本次 tick 停止推送、置一个「需要确认」状态，让用户看到「你是不是把一个源码目录拖进来了」 |

第二条是「node_modules 被拖进来」这个具体场景的真正拦截点 —— 它在用户列出规则
**之前**就生效。UI 上必须能看见被跳过的东西，否则就是另一种静默失败。

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

解法（三选一，倾向 A）：

- **A. 忽略即「停止管理」，不删除。** 计算 tombstone 列表时先按 ignore 规则过滤
  一遍：被忽略的路径既不推、也不发删除，同时把它在 `state.files` 里的条目标记为
  `ignored`（而不是删除条目），这样将来规则放开还能续上。云端那份保持原样，直到
  有人显式删除。
- B. 一次性迁移：首次启用时把当前 `state` 里命中新规则的路径整批标记为 ignored，
  之后走 A 的逻辑。本质是 A 加一个迁移步骤。
- C. 让忽略等价于删除。**不要选这个** —— 一次客户端升级就会静默清空一批云端文件。

无论选哪个，`state.rs` 需要新增 `ignored` 状态，且 tombstone 计算必须显式跳过它。

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

- 约定附件目录为 `knowledge/attachments/`，并在文档里告诉用户把 Obsidian 的
  「Default location for new attachments」指过去。
- 我们的 Markdown 编辑器支持渲染 `![[file.png]]` 嵌入。
- 附件天然受 §4.4 的单文件大小闸门保护。

## 6. 实施顺序

| 刀 | 内容 | 依赖 |
|---|---|---|
| 1 | ignore 机制：三层规则来源 + 内置清单 + `state` 的 `ignored` 状态 + **tombstone 排除**（§4.6） | 无 |
| 2 | 兜底护栏：单文件大小 + 单 tick 文件数上限，含 UI 呈现 | 刀 1 |
| 3 | `.md` 后缀默认值与补全 | 无 |
| 4 | 文件监听触发即时同步 | 刀 1（必须复用 ignore） |
| 5 | ~~「在 Obsidian 中打开」入口~~ **已完成** + 用户文档 | 刀 3 |
| 6 | 服务端写入口拒绝 + 每 team 配额 | 刀 1（共用清单） |
| 7 | 冲突副本迁 `.conflicts/` | 独立 |
| 8 | 附件目录约定 + 编辑器渲染 `![[...]]` | 独立 |

刀 1 与刀 2 是「防止服务器被冲垮」的实质内容，优先级最高。刀 1 里的 §4.6 是**上
线前必须验证的一条**：拿一个历史上同步过 `.DS_Store` 的团队做回归，确认升级后云
端那份没有被删。

## 7. 验收

1. 在 `knowledge/` 里 `git clone` 一个带 `node_modules/` 的仓库，等一个 tick：
   同步状态显示被忽略/被闸门拦截，`sync_files` 表没有新增行，MinIO 没有新对象。
2. 用 Obsidian 打开 vault，改一篇笔记 → 2 秒内 tick 发出 → 另一台设备收到。
3. Obsidian 产生的 `.obsidian/workspace.json` 在任何设备上都不产生同步流量。
4. 在 app 里新建笔记 → Obsidian 里立刻可见可编辑（`.md` 后缀生效）。
5. 升级前同步过 `.DS_Store` 的团队，升级后云端那份仍在，本地不再推送它。
6. 一台故意不升级的旧客户端推 `node_modules/` → 服务端 422 拒绝，且不影响该团队
   其它文件的正常同步。

## 8. 未决问题

- 每 team 配额的具体阈值（文件数 / 总字节）。需要先看现有团队的分布。
- 冲突副本走 §5.2 的 A 还是 B。
- 附件目录叫 `attachments/` 还是别的；是否需要在 onboarding 时替用户写一次
  Obsidian 配置（等于承认我们在写 `.obsidian/`，与 §3.2 的立场有张力）。
- 被忽略的文件在 app 的文件树里如何呈现：灰显、隐藏、还是只在同步状态里汇总。
