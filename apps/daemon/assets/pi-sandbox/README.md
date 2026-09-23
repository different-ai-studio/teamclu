# pi agent host 沙箱 profile

`pi-host.sb` 是给 pi agent host 用的 macOS Seatbelt profile。**目前没有接线**
——它先进仓库，是因为里面两条放行规则花了 14 轮盲试才找到，而失败现场
没有任何线索指向它们。设计与排期见 issue #1571。

## 怎么接

在 `apps/daemon/src/runtime/pi_rpc/process.rs` 的 spawn 前加前缀。**同一个
match 里有两处**：`LaunchMode::Host`（主路径）和 `LaunchMode::LegacyRpc`
（回退路径）。只包前者，回退路径就是绕过通道。

包在这一层，host 拉起的一切都继承——工具、子进程、MCP sidecar 都在内。

## 两条极难查的规则

缺任意一条，node 都会在动态链接阶段 **SIGABRT(134)**，而且：

- **stderr 完全是空的**
- `(trace "...")` 指令在 macOS 26 上**不生成文件**
- `log show` 里**查不到**对应的 deny 记录

也就是说没有任何定位手段。

| 规则 | 为什么会漏 |
|---|---|
| `(literal "/")` | `(subpath "/usr")` 授权的是 `/usr` **里面**的内容，不含读 `/` 这个目录本身。node 启动时要 stat 根目录 |
| `(subpath "/dev")` | `/dev/urandom` 等。只写 `(literal "/dev/urandom")` 不够 |

另有一条虽然会自报家门、但同样容易漏：`process-exec`。缺了它连 node 都起不来，
报的是 `sandbox-exec: execvp() of '<node>' failed: Operation not permitted`
——至少这条有明确错误信息。

排除过的错误假设（省得再试一遍）：`file-map-executable` 缺失、APFS firmlink
（`/System/Volumes/Data`）、dyld 共享缓存、`/System/Volumes/Preboot/Cryptexes`、
`~/.amuxd` 是符号链接。**都不是。**

**定位方法**：`(subpath "/")` 能跑而逐条枚举全部顶层目录不能跑 → 差的是根目录
自身；再从最小集逐个加顶层目录 → 只有 `/dev` 能让它通过。

## 传参必须是真实路径

`-D` 传进去的路径要先 `realpath`。沙箱按解析后的路径匹配，所以传
`/var/folders/...`（`/var` 是指向 `private/var` 的符号链接）会导致规则不生效、
工作区被拒。同理 `/tmp` → `/private/tmp`。

这个失败长得和「漏了放行规则」一模一样（EPERM），但原因完全不同。

## 实测（macOS 26.3 / node 24.20.0）

最小集下的行为：

| 操作 | 结果 |
|---|---|
| 工作区读 / 写 | 放行 |
| `~/.ssh` | EPERM |
| 家目录列举 | EPERM |
| `/etc/passwd` | EPERM |

默认拒绝，所以漏配的后果是功能坏掉，而不是边界敞开——这是它比黑名单式
强的地方。

## 未决

- **`~/.ssh`**：push 和部署都要它，它也是机器上最该远离 agent 的东西。出路是
  SSH agent 转发（放行 socket、拒绝私钥文件），属独立改造。在那之前，沙箱里的
  agent 推不了代码——这是有意为之，不是遗漏。
- **构建缓存例外**：cargo target（本仓库共享的那个约 152 GB）、pnpm store、
  `~/.cargo`、sccache 都在工作区之外。这些路径本来就来自配置，实现时应当生成
  进 profile，而不是像现在这样硬编码在注释里。
- **`amuxd` 本体不包**：它是 UI / 频道 / cron / 应用部署的宿主，例外清单会长到
  沙箱失去意义。
