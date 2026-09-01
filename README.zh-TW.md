# TeamClu

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/different-ai-studio/teamclu/actions/workflows/ci.yml/badge.svg)](https://github.com/different-ai-studio/teamclu/actions)
[![Contributors](https://img.shields.io/github/contributors/different-ai-studio/teamclu.svg)](https://github.com/different-ai-studio/teamclu/graphs/contributors)

本地智慧體 — 你在每個職位上的 AI 搭檔

> **你的搭檔，並肩同行。**

- **👥 為團隊而生** — 在整個團隊間共享 Skills、知識庫與 MCP 設定；同時保留每位成員的私有上下文
- **🎭 Skills × 角色** — 可組合的角色庫，讓同一個智慧體適配銷售、客服、營運、研發，或任何團隊需要的職位
- **🔋 開箱即用** — 內建團隊知識庫、Auto UI 視覺理解、語音轉文字，以及六大通道閘道（企業微信、飛書、Discord、Kook、微信、Email），無需膠水程式碼
- **🧑‍💻 個人開發者到中小企業** — 本地優先、預設私有；從單人使用擴展到小型公司

[English](README.md) | [简体中文](README.zh-CN.md) | 繁體中文 | [日本語](README.ja.md) | [한국어](README.ko.md) | [Bahasa Indonesia](README.id.md)

## 介面截圖

| 首頁 | 頻道 |
|---|---|
| ![TeamClu Home](images/home.png) | ![TeamClu Channels](images/channel.png) |

## 功能特性

- **三欄式工作區** — 側邊欄、聊天區與詳情面板
- **本地智慧體執行時** — 智慧體在你自己的機器上執行，由 `amuxd` 常駐程式託管
- **通道閘道** — 從 Discord、飛書、Email、Kook、企業微信與微信觸達你的智慧體
- **自動化** — 透過 cron 執行排程任務
- **團隊協作** — 透過相容 S3 的物件儲存同步團隊知識庫與文件；詳見 [團隊協作](#團隊協作)
- **MCP 支援** — 透過 Model Context Protocol 將智慧體連接到企業系統
- **Skills / 外掛** — 以工作區層級與全域技能來源擴充智慧體
- **知識庫** — 全團隊同步的 Markdown 知識庫，支援路徑層級 ACL 與版本歷史
- **內建編輯器** — Markdown 與 HTML（Tiptap）、程式碼（CodeMirror 6），以及智慧體優先的 diff 審查器
- **本地檔案操作** — 具備逐項操作的權限管理

## 運作方式

TeamClu 分為用戶端層、智慧體宿主與雲端後端三部分：

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

- **用戶端** 負責 UI 與本地檔案。安裝 TeamClu Desktop 時會一併安裝 `amuxd` 常駐程式，因此你的機器開箱即為智慧體宿主。
- **amuxd** 託管本地智慧體後端、執行通道閘道，並負責團隊同步。它也可以獨立安裝在伺服器上，不需要 GUI。
- **Cloud API**（`/v1`）是用戶端唯一對話的後端。介面契約請見 [`docs/openapi/teamclu-api.v1.yaml`](docs/openapi/teamclu-api.v1.yaml)，完整架構請見 [`docs/architecture/v2.md`](docs/architecture/v2.md)。

## 用戶端

| 用戶端 | 路徑 | 狀態 |
|---|---|---|
| **桌面端**（macOS / Windows / Linux） | `apps/desktop/` + `packages/app/` | 主力用戶端 |
| **iOS** | `apps/ios/` | 原生 SwiftUI，透過 TestFlight 發布 |
| **行動端**（iOS / Android） | `apps/expo/` | Expo；導引流程與工作階段 |
| **Chrome 擴充功能** | `apps/extension/` | MV3 |

## 安裝

從 [GitHub Releases](https://github.com/different-ai-studio/teamclu/releases) 下載對應平台的安裝程式 — macOS 為 `.dmg`，Windows 為 `.exe`。

### macOS 提示「已損毀」時

若 macOS 提示應用程式 **「已損毀」** 或 **「無法開啟，因為無法驗證開發者」**，這是 Gatekeeper 對未簽章下載檔案的反應。清除隔離屬性即可：

```bash
xattr -cr /Applications/TeamClu.app
```

若建置版本已使用 Apple 開發者憑證簽章並公證，則無需此步驟。

## 快速開始（開發）

**前置需求：** Node.js >= 20、pnpm >= 10、Rust >= 1.70

```bash
pnpm install
pnpm tauri:dev
```

啟動後，在 TeamClu 介面中選擇一個工作區目錄。

若要在開發時略過首次執行的設定精靈：

```bash
pnpm tauri:dev -- --skip-setup --skip-daemon-onboarding
```

若只要啟動前端（不建置 Rust），執行 `pnpm dev`。建置指令、共用的 Rust 建置快取、測試套件與倉庫結構，都記載於 [貢獻指南](CONTRIBUTING.md)。

## 團隊協作

團隊共享的是若干專用目錄，而非整個工作區。同步透過相容 S3 的物件儲存進行（阿里雲 OSS / WebDAV），沒有 Git 模式。

同步由 `amuxd` 常駐程式負責：每個團隊在 `~/.amuxd/teams/<team_id>/` 下保留一份全域副本，每個已連結的工作區以符號連結暴露被同步的目錄。

### 共享內容

只有被同步的目錄會離開本機，工作區其餘內容保留在本地：

- `team-knowledge/` — 團隊知識庫
- `team-documents/` — 團隊文件（檔案有擁有者，可限制存取）

團隊 Skills 與團隊 MCP 伺服器不再走這棵樹：Skills 來自技能註冊表，MCP 伺服器與團隊環境變數來自 Cloud API。

### 注意事項

- 同步會在應用程式啟動時執行，也可從側邊欄的團隊共享欄手動觸發。
- 衝突同樣出現在那裡，於主面板中解決。

## 設定

建置期設定位於倉庫根目錄的 `build.config.*.json`，並依此順序合併：

```
build.config.json → build.config.${BUILD_ENV}.json → build.config.local.json
```

複製範例檔即可開始：

```bash
cp build.config.example.json build.config.local.json
```

最關鍵的設定是 `cloudApiUrl`，它指向應用程式所使用的 TeamClu Cloud API 部署：

```json
{
  "cloudApiUrl": "https://api.teamclu-dev.ucar.cc",
  "features": {
    "channels": { "discord": true, "feishu": true, "email": true }
  }
}
```

`build.config.local.json` 已被 git 忽略。本地開發時，你也可以在 `packages/app/.env.local` 中以 `VITE_CLOUD_API_URL` 覆寫端點。變更後需重新建置才會生效。

Cloud API 的實作位於 `services/fc/`（Node.js 20），以 Supabase 為後盾，並可選用 LiteLLM proxy 來管理共享的 AI 預算。

## 文件

- [架構](docs/architecture/v2.md) — 元件、拓撲與資料模型
- [API 契約](docs/openapi/teamclu-api.v1.yaml) — TeamClu Cloud API `/v1`
- [上下文地圖](CONTEXT-MAP.md) — 倉庫如何劃分為各個界限上下文
- [貢獻指南](CONTRIBUTING.md) — 開發環境、測試、倉庫結構
- [安全政策](SECURITY.md)

## 參與貢獻

我們歡迎各種貢獻！詳情請見 [貢獻指南](CONTRIBUTING.md)。

- 📝 [文件與翻譯](CONTRIBUTING.md#-documentation--translation-easiest) — 無需開發環境
- 🐛 [問題回報](CONTRIBUTING.md#-bug-reports)
- ✨ [功能建議](CONTRIBUTING.md#-feature-suggestions)
- 🔧 [前端開發](CONTRIBUTING.md#-frontend-development)
- ⚙️ [Rust 開發](CONTRIBUTING.md#-rust-development)

## 技術棧

- **桌面端**：Tauri 2.0 (Rust)
- **常駐程式**：Rust (`amuxd`)，本地智慧體後端（opencode HTTP 等）
- **前端**：React 19 + TypeScript、Tailwind CSS 4、Zustand
- **iOS**：SwiftUI + SwiftPM (`AMUXCore`)
- **編輯器**：Tiptap（Markdown / HTML）、CodeMirror 6（程式碼）、Shiki（語法高亮）

## License

MIT
