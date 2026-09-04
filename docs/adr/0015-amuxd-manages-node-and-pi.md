---
status: accepted
---

# amuxd 托管 Node.js 与 pi，不再探测用户机器上的任何一个

pi 运行时 = 钉版的 Node.js 发行包 + pi npm 包 + `@modelcontextprotocol/sdk`，三者
由 amuxd 自己装在自己的目录里，路径是常量：

```text
<amuxd cache>/node/<version>/            官方发行包原样解压（含 npm）
<amuxd cache>/pi/
  package.json  package-lock.json        从 apps/daemon/pi-runtime/ 物化
  node_modules/@earendil-works/pi-coding-agent/   ← package root
  node_modules/@modelcontextprotocol/sdk/
  extensions/teamclu.ts                  ← 裸 import 沿目录向上解析到上面的 node_modules
  host/host.mjs
```

安装 = 下载 Node 归档（校验 SHA-256）+ `node npm-cli.js ci`。不经 `npm.cmd`、
不经 cmd.exe、不读 PATH、不碰 `~/.pi` 与用户的全局 npm。开发者要换 Node 或 pi 用
`[agents.pi] node = / package_root =`——那是显式路径，不是搜索。

版本单一来源：`apps/daemon/pi-runtime/package.json` + `package-lock.json` 钉 pi 与
SDK，`pi.lock.json` 重复这两个值（给镜像 workflow 与 doctor 用）并钉 Node；一个单测
守住三者一致。

下载路线按实测吞吐选：官方 → npmmirror 公共镜像 → 自建 OSS
（`mirror-node-oss.yml`）。Windows 先试预打包的 `node + pi + sdk` 归档
（`mirror-pi-bundle-oss.yml`）：一次下载一次解压，不跑 npm。

## 为什么

每一个"pi 装了但起不来"最后都是**哪个 Node**：GUI 进程读不到 `~/.zshrc`，
nvm / fnm / n / volta 装的 Node 看不见；Windows 从不修复 PATH，装完 Node 要重启机器
才可见；一台机器三个 Node，终端说 24、app 说 20（#1049、#1232）；`npm` 在 Windows 是
`npm.cmd`，Rust 的 `Command::new("npm")` 永远找不到（#1046）。这些全是在猜用户的
Node。

opencode 是单二进制，所以首启向导"什么都不用你装"以前是真的；换成 pi 后，guided
路径遇到 Node 缺 / 旧就停下来让用户手装——托管 Node 是让"零手动"重新成立的唯一
办法，代价是每台机器多 ~100MB 磁盘、每次 Node 钉版多 6 个归档进 OSS。

## 后果

- `resolve_node` / `node_manager_dirs` 的 best-of-N 启发式、`resolve_pi_package_root`
  的符号链接回溯、`~/.pi/bin` 查找全部不再是 pi 的路径。
- 首启流程：Language → 登录 → daemon wizard（`start-daemon → install-runtime →
  mint-invite → …`）。runtime 在登录后、绑定后安装，daemon 的 doctor 是唯一真相，
  没有 `setup-ok` 缓存；老版本升级上来的机器在第一次 refresh 时补装。
- pi 上游抬 `engines.node` 时由我们的 lock 决定何时跟，pi 与 Node 一起发。
- 官方 Node 二进制要 glibc ≥ 2.28；老 CentOS / musl 上 doctor 直接报不满足。
