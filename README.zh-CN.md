# TeamClu

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/different-ai-studio/teamclu/actions/workflows/ci.yml/badge.svg)](https://github.com/different-ai-studio/teamclu/actions)
[![Contributors](https://img.shields.io/github/contributors/different-ai-studio/teamclu.svg)](https://github.com/different-ai-studio/teamclu/graphs/contributors)

本地智能体，你的 AI 搭档

> **你的搭档，并肩同行。**

- **👥 为团队而生** — 通过 Git 或 S3/OSS 同步，在整个团队内共享技能、知识库与 MCP 配置；每位成员仍保留自己的私有上下文
- **🎭 技能 × 角色** — 可组合的角色库，让同一个智能体适配销售、客服、运营、研发，或团队所需的任何岗位
- **🔋 开箱即用** — 内置团队知识库、Auto UI 视觉识别、语音转文字，以及六大渠道网关（企业微信、飞书、Discord、Kook、微信、邮件），无需胶水代码
- **🧑‍💻 从个人开发者到中小企业** — 本地优先、默认私有；可从单人使用扩展到小型公司

[English](README.md) | 简体中文 | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Bahasa Indonesia](README.id.md)

## 界面截图

| 主页 | 渠道 |
|---|---|
| ![TeamClu Home](images/home.png) | ![TeamClu Channels](images/channel.png) |

## 功能特性

- **三栏工作区** — 侧边栏、聊天区与详情面板
- **本地智能体运行时** — 智能体在你自己的机器上运行，由 `amuxd` 守护进程托管
- **渠道网关** — 从 Discord、飞书、邮件、Kook、企业微信和微信触达你的智能体
- **自动化** — 通过 cron 执行定时任务
- **团队协作** — 通过 OSS 或 Git 共享团队盘（`teamclu-team/`）；详见[团队协作](#团队协作)
- **MCP 支持** — 通过 Model Context Protocol 将智能体接入企业系统
- **技能 / 插件** — 使用工作区级与全局技能源扩展智能体
- **知识库** — 全团队同步的 Markdown 知识库，支持路径级 ACL 与版本历史
- **内置编辑器** — Markdown 与 HTML（Tiptap）、代码（CodeMirror 6），以及智能体优先的 diff 审查器
- **本地文件操作** — 带逐操作权限管理

## 工作原理

TeamClu 分为客户端层、智能体宿主与云端后端三部分：

```
  Desktop (Tauri)     iOS      Mobile (Expo)     Chrome extension
        │              │            │                  │
        └──────────────┴─────┬──────┴──────────────────┘
                             │
              ┌──────────────┴───────────────┐
              │      TeamClu Cloud API      │   identity, teams,
              │            (/v1)             │   sessions, messages
              └──────────────┬───────────────┘
                             │
                    ┌────────┴────────┐
                    │   amux daemon   │  agent host + channel gateways
                    │    (amuxd)      │  + team sync (git / OSS)
                    └────────┬────────┘
                             │ HTTP / RPC
                    ┌────────┴────────┐
                    │ local agents    │  opencode (default), …
                    └─────────────────┘
```

- **客户端**负责 UI 与本地文件。安装 TeamClu 桌面端时会一并安装 `amuxd` 守护进程，因此你的机器开箱即是一个智能体宿主。
- **amuxd** 托管本地智能体后端、运行渠道网关，并负责团队同步。它也可以在服务器上独立安装，无需 GUI。
- **Cloud API**（`/v1`）是客户端唯一对接的后端。接口契约见 [`docs/openapi/teamclu-api.v1.yaml`](docs/openapi/teamclu-api.v1.yaml)，完整架构见 [`docs/architecture/v2.md`](docs/architecture/v2.md)。

## 客户端

| 客户端 | 路径 | 状态 |
|---|---|---|
| **桌面端**（macOS / Windows / Linux） | `apps/desktop/` + `packages/app/` | 主力客户端 |
| **iOS** | `apps/ios/` | 原生 SwiftUI，通过 TestFlight 发布 |
| **移动端**（iOS / Android） | `apps/expo/` | Expo；引导流程与会话 |
| **Chrome 扩展** | `apps/extension/` | MV3 |

## 安装

从 [GitHub Releases](https://github.com/different-ai-studio/teamclu/releases) 下载对应平台的安装包 — macOS 为 `.dmg`，Windows 为 `.exe`。

### macOS 提示「已损毁」时

若 macOS 提示应用**「已损毁」**或**「无法打开，因为无法验证开发者」**，这是 Gatekeeper 对未签名下载文件的反应。清除隔离属性即可：

```bash
xattr -cr /Applications/TeamClu.app
```

使用 Apple 开发者证书签名并公证的构建无需此步骤。

## 快速开始（开发）

**前置要求：** Node.js >= 20、pnpm >= 10、Rust >= 1.70

```bash
pnpm install
pnpm tauri:dev
```

启动后，在 TeamClu 界面中选择一个工作区目录。

在开发过程中跳过首次运行向导：

```bash
pnpm tauri:dev -- --skip-setup --skip-daemon-onboarding
```

若只需运行前端（不构建 Rust），执行 `pnpm dev`。构建命令、共享 Rust 构建缓存、测试套件以及仓库结构，详见[贡献指南](CONTRIBUTING.md)。

## 团队协作

团队共享的是专用**团队盘**（`teamclu-team/`），而非整个工作区。引导流程中由所有者选定一种**共享模式**，之后在服务端锁定：

| 模式 | 作用 |
|---|---|
| `oss` | 通过 S3 兼容对象存储同步（阿里云 OSS / WebDAV） |
| `managed_git` | 通过为你自动开通的 Git 仓库同步 |
| `custom_git` | 通过你自行托管的 Git 仓库同步 |

同步由 `amuxd` 守护进程负责：每个团队在 `~/.amuxd/teams/<team_id>/` 下保留一份全局副本，每个已链接的工作区通过 `teamclu-team` 软链接指向该副本。

### 共享内容

只有共享层会同步 — 白名单 `.gitignore` 让其余内容保持本地：

- `skills/` — 共享的智能体技能
- `.mcp/` — MCP 服务器配置
- `knowledge/` — 团队知识库文档

个人文件和工作区其余内容保持本地。

### 注意事项

- Git 模式需要可用的 Git 认证（SSH key 或 HTTPS token）。
- OSS 同步可能出现冲突，可在团队共享文件界面中解决。
- 同步在应用启动时运行，也可在 **Settings → Team** 中手动触发。

## 配置

构建期配置位于仓库根目录的 `build.config.*.json`，按以下顺序合并：

```
build.config.json → build.config.${BUILD_ENV}.json → build.config.local.json
```

复制示例文件即可开始：

```bash
cp build.config.example.json build.config.local.json
```

关键配置项是 `cloudApiUrl`，它将应用指向某个 TeamClu Cloud API 部署：

```json
{
  "cloudApiUrl": "https://api.teamclu-dev.ucar.cc",
  "features": {
    "channels": { "discord": true, "feishu": true, "email": true }
  }
}
```

`build.config.local.json` 已被 git 忽略。本地开发时，你也可以在 `packages/app/.env.local` 中用 `VITE_CLOUD_API_URL` 覆盖该端点。修改后需重新构建才会生效。

Cloud API 的实现位于 `services/fc/`（Node.js 20），由 Supabase 提供支撑，并可选接入 LiteLLM 代理以进行共享 AI 预算管理。

## 文档

- [架构](docs/architecture/v2.md) — 组件、拓扑与数据模型
- [API 契约](docs/openapi/teamclu-api.v1.yaml) — TeamClu Cloud API `/v1`
- [上下文地图](CONTEXT-MAP.md) — 仓库如何划分为限界上下文
- [贡献指南](CONTRIBUTING.md) — 开发环境、测试、仓库结构
- [安全策略](SECURITY.md)

## 参与贡献

我们欢迎各种贡献！详见[贡献指南](CONTRIBUTING.md)。

- 📝 [文档与翻译](CONTRIBUTING.md#-documentation--translation-easiest) — 无需开发环境
- 🐛 [Bug 反馈](CONTRIBUTING.md#-bug-reports)
- ✨ [功能建议](CONTRIBUTING.md#-feature-suggestions)
- 🔧 [前端开发](CONTRIBUTING.md#-frontend-development)
- ⚙️ [Rust 开发](CONTRIBUTING.md#-rust-development)

## 技术栈

- **桌面端**：Tauri 2.0 (Rust)
- **守护进程**：Rust (`amuxd`)，本地智能体后端（opencode HTTP 等）
- **前端**：React 19 + TypeScript、Tailwind CSS 4、Zustand
- **iOS**：SwiftUI + SwiftPM (`AMUXCore`)
- **编辑器**：Tiptap（Markdown / HTML）、CodeMirror 6（代码）、Shiki（语法高亮）

## License

MIT
