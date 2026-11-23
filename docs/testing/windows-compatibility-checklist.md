# Windows 兼容性测试清单

每个 beta 发到 Windows 之前跑一遍。目标是发现「CI runner 上没问题，真实用户机器上起不来」这一类问题。CI 的 `windows-latest` 装了 VS、各种运行库和开发工具，环境比用户机器全得多，下面这些问题它大多测不出来。

功能层面的用例（登录、会话、流式回复）见 `2026-06-02-desktop-beta-testcases.md` 的 W 套件。本清单只管**平台差异**和**已经踩过的坑**。

## 1. 测试环境

### 虚拟机快照（主力）

Apple Silicon Mac 上用 UTM 或 Parallels 跑 Windows 11 ARM。x64 安装包会走微软的 x64 模拟层，安装、DLL 依赖、路径、代理这类问题都能暴露。

装完系统后**什么都别装**，直接拍快照。尤其不要装 Visual C++ 运行库、VS、Node、Git。每轮测试从快照恢复，测完丢弃。

| 快照 | 用途 |
|---|---|
| `win11-clean` | Windows 11 简体中文，本地账户，用户名纯英文。每次必跑 |
| `win11-cn-user` | 用户名带中文和空格（如 `张 三`），覆盖 `C:\Users\张 三\...` 路径 |
| `win11-standard-user` | 非管理员账户安装、运行 |
| `win10-22h2` | Windows 10 最后一个版本，覆盖老 WebView2 / 老系统组件 |
| `win11-proxy` | 系统设置里配置 HTTP 代理或 PAC 脚本，**不设** `HTTPS_PROXY` 环境变量 |
| `win11-av` | 装火绒或 360，默认策略 |

每个 beta 至少跑 `win11-clean`。改到安装器、路径、网络、进程启动时，再加跑对应的快照。

### 补充

- **阿里云 ECS 按量 Windows 实例**：x64 原生、国内网络，测完释放。适合测下载镜像、OSS 自动更新。
- **真机**：找一两台同事或用户的旧电脑，杀软、驱动、组策略这些虚拟机模拟不出来。

## 2. 每个 beta 的冒烟流程（`win11-clean`）

从 OSS 或 GitHub Release 下载 `TeamClu_<ver>_x64-setup.exe`。

- [ ] 双击安装，没有 SmartScreen 以外的报错；安装目录里有 `teamclu.exe`、`amuxd.exe`、`teamclu-introspect.exe`
- [ ] 首次启动没有系统弹窗，尤其是「找不到 xxx.dll」
- [ ] 窗口标题、开始菜单、托盘里的中文品牌名正常，不是乱码
- [ ] 登录（邮箱验证码）→ 进入三栏界面，无白屏
- [ ] 首次向导：pi 运行时安装完成，没有反复重装、卡在某一步
- [ ] 设置 → daemon 显示已连接；任务管理器里能看到 `amuxd.exe`
- [ ] 新建会话，发一条消息，收到流式回复
- [ ] 让 agent 执行一个工具（读文件、跑命令），审批弹窗能用，结果正常
- [ ] 知识库 / 资料库目录树有内容，根目录显示中文名而不是 `documents/`、`knowledge/`
- [ ] 文件面板打开会话的工作目录；新建、重命名、拖入文件都落在正确位置
- [ ] 终端面板能起 shell，输入输出正常
- [ ] 退出 → 重新打开，会话和登录状态都还在
- [ ] 从上一个 beta 覆盖升级（自动更新或手动装新包）：升级成功，没有残留的旧 `amuxd.exe` 进程，新版 daemon 版本号正确

## 3. 已知坑回归

每一条都在真实用户那里出过问题，改到相关代码时必须复测。

| 坑 | 怎么测 | 判据 | 相关代码 / 记录 |
|---|---|---|---|
| sidecar 依赖 VC++ 运行库 | `win11-clean` 上全新安装并启动 | 不弹「找不到 VCRUNTIME140.dll」；daemon 能起来 | `static_vcruntime`（#1905）；CI `daemon-windows` 导入表检查 |
| Rust 侧不认系统代理 / PAC | `win11-proxy`，不设环境变量 | 登录、更新检查、快捷登录窗口都能用；如果只有页面能打开，就是这个问题 | reqwest 只读 `HTTP(S)_PROXY`；WebView2 走 WinINET |
| 路径分隔符只认 `/` | 打开知识库、资料库、文件树；在子目录里重命名、拖入 | 目录树不为空，操作落在正确目录 | 前端路径前缀判断要兼容 `\` |
| 中文用户名 / 空格路径 | `win11-cn-user` 跑完整冒烟 | pi 安装、workspace、日志路径都能用 | — |
| 发版脚本中文乱码 | 看窗口标题和开始菜单名 | 品牌中文名正确 | runner 默认 cp1252，发版脚本要设 `PYTHONUTF8=1` |
| 覆盖安装时 sidecar 被占用 | 运行中直接装新包；或强退后再装 | 安装不报文件占用，旧 sidecar 被替换 | `apps/desktop/windows/installer-hooks.nsh` |
| 老系统 / 32 位 | Win7、Win8.1 或 32 位系统上运行安装包 | 安装器直接提示需要 64 位 Windows 10/11 并退出 | `installer-hooks.nsh` 版本检查 |
| 下载镜像域名 | 国内网络全新安装 | 运行时和依赖能下载，模型列表能拉到 | beta.20 镜像域名写错过 |
| 杀软拦截 | `win11-av` 全新安装并启动 | sidecar 没被隔离；如果被拦，记录杀软名称和提示 | — |

## 4. 出问题时收集什么

- **截图**：完整弹窗，包括标题栏（标题栏里会写是哪个 exe 报的错）
- **桌面端日志**：`%LOCALAPPDATA%\com.teamclu.app\logs\`
- **daemon 日志**：`%USERPROFILE%\.amuxd\logs\amuxd.log`
- **系统信息**：`winver` 的版本号；是不是管理员账户；装了什么杀软
- **代理情况**（网络问题时）：
  ```powershell
  Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' | Select ProxyEnable, ProxyServer, AutoConfigURL
  Get-ChildItem Env: | Where-Object Name -match proxy
  ```
- **DLL 依赖**（启动失败时）：在 Mac 上 `7zz x <setup.exe>` 解包，再用 `objdump -p <exe> | grep "DLL Name"` 看导入了哪些 DLL

## 5. 新坑怎么办

在真实机器上发现新的平台问题：

1. 能在 CI 里自动检查的（像 DLL 依赖），加进 `ci.yml` 的 `daemon-windows` / `desktop-windows`
2. 只能人工测的，加一行到第 3 节的表里，写清怎么测和判据
