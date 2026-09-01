# TeamClu

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/different-ai-studio/teamclu/actions/workflows/ci.yml/badge.svg)](https://github.com/different-ai-studio/teamclu/actions)
[![Contributors](https://img.shields.io/github/contributors/different-ai-studio/teamclu.svg)](https://github.com/different-ai-studio/teamclu/graphs/contributors)

ローカル AI エージェント — あらゆる職務のための AI パートナー

> **あなたの味方。ともに。**

- **👥 チーム向け設計** — Skills・ナレッジ・MCP 設定をチーム全体で共有しつつ、メンバーごとのプライベートなコンテキストも維持
- **🎭 Skills × ロール** — 合成可能なロールライブラリにより、同じエージェントを営業・サポート・運用・エンジニアリングなど、チームに必要な職務へ特化させられます
- **🔋 標準搭載** — チームナレッジベース、Auto UI 理解、音声認識、6 つのチャンネルゲートウェイ（WeCom / Feishu / Discord / Kook / WeChat / Email）を内蔵。糊付けコードは不要です
- **🧑‍💻 個人開発者から中小企業まで** — ローカル優先、デフォルトで非公開。一人での利用から小規模企業までスケールします

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | 日本語 | [한국어](README.ko.md) | [Bahasa Indonesia](README.id.md)

## スクリーンショット

| ホーム | チャンネル |
|---|---|
| ![TeamClu Home](images/home.png) | ![TeamClu Channels](images/channel.png) |

## 主な機能

- **3 カラムのワークスペース** — サイドバー、チャット、詳細パネル
- **ローカルエージェントランタイム** — エージェントは自分のマシン上で動作し、`amuxd` デーモンがホストします
- **チャンネルゲートウェイ** — Discord、Feishu、Email、Kook、WeCom、WeChat からエージェントにアクセス
- **自動化** — cron によるスケジュールタスク
- **チーム協力** — S3 互換オブジェクトストレージ経由でチームのナレッジとドキュメントを同期。[チーム協力](#チーム協力)を参照
- **MCP サポート** — Model Context Protocol でエージェントをエンタープライズシステムに接続
- **Skills / プラグイン** — ワークスペースレベルおよびグローバルなスキルソースでエージェントを拡張
- **ナレッジベース** — チーム全体で同期される Markdown ナレッジベース。パス単位の ACL とバージョン履歴に対応
- **内蔵エディター** — Markdown / HTML（Tiptap）、コード（CodeMirror 6）、エージェントファーストの Diff レビューア
- **ローカルファイル操作** — 操作単位の権限管理付き

## 仕組み

TeamClu はクライアント層、エージェントホスト、クラウドバックエンドに分かれています：

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

- **クライアント** は UI とローカルファイルを担当します。TeamClu Desktop をインストールすると `amuxd` デーモンも同時にインストールされるため、そのマシンは最初からエージェントホストになります。
- **amuxd** はローカルエージェントバックエンドをホストし、チャンネルゲートウェイを実行し、チーム同期を担当します。GUI なしでサーバー上に単体インストールすることもできます。
- **Cloud API**（`/v1`）はクライアントが通信する唯一のバックエンドです。契約は [`docs/openapi/teamclu-api.v1.yaml`](docs/openapi/teamclu-api.v1.yaml)、アーキテクチャ全体は [`docs/architecture/v2.md`](docs/architecture/v2.md) を参照してください。

## クライアント

| クライアント | パス | ステータス |
|---|---|---|
| **Desktop**（macOS / Windows / Linux） | `apps/desktop/` + `packages/app/` | 主要クライアント |
| **iOS** | `apps/ios/` | ネイティブ SwiftUI、TestFlight で配信 |
| **Mobile**（iOS / Android） | `apps/expo/` | Expo；オンボーディングとセッション |
| **Chrome 拡張機能** | `apps/extension/` | MV3 |

## インストール

[GitHub Releases](https://github.com/different-ai-studio/teamclu/releases) からプラットフォームに対応したインストーラーをダウンロードしてください — macOS は `.dmg`、Windows は `.exe` です。

### macOS で「壊れている」と表示される場合

macOS がアプリを **「壊れている」** または **「開発元を確認できないため開けません」** と表示する場合、それは未署名のダウンロードに対する Gatekeeper の反応です。次のコマンドで隔離属性を解除してください：

```bash
xattr -cr /Applications/TeamClu.app
```

Apple Developer 証明書で署名・公証されたビルドでは、この手順は不要です。

## クイックスタート（開発）

**必要条件:** Node.js >= 20、pnpm >= 10、Rust >= 1.70

```bash
pnpm install
pnpm tauri:dev
```

起動後、TeamClu の画面でワークスペースディレクトリを選択してください。

開発中に初回起動ウィザードをスキップするには：

```bash
pnpm tauri:dev -- --skip-setup --skip-daemon-onboarding
```

フロントエンドのみを起動する場合（Rust ビルドなし）は `pnpm dev` を実行します。ビルドコマンド、共有 Rust ビルドキャッシュ、テストスイート、リポジトリ構成については [コントリビューションガイド](CONTRIBUTING.md) を参照してください。

## チーム協力

チームが共有するのはいくつかの専用ディレクトリであり、ワークスペース全体ではありません。同期は S3 互換オブジェクトストレージ（Alibaba OSS / WebDAV）経由で行われ、Git モードはありません。

同期は `amuxd` デーモンが担当します。チームごとに `~/.amuxd/teams/<team_id>/` へグローバルコピーを保持し、リンク済みの各ワークスペースは同期対象のディレクトリをシンボリックリンクとして公開します。

### 共有される内容

同期対象のディレクトリだけがマシンの外に出ます。ワークスペースのその他の内容はローカルに残ります：

- `team-knowledge/` — チームナレッジベース
- `team-documents/` — チームドキュメント（所有者を持ち、アクセスを制限できます）

チームスキルとチーム MCP サーバーはこのツリーを通りません。スキルはスキルレジストリから、MCP サーバーとチーム環境変数は Cloud API から取得されます。

### 注意事項

- 同期はアプリ起動時に実行され、サイドバーのチーム共有カラムから手動でトリガーすることもできます。
- 競合もそこに表示され、メインパネルで解決します。

## 設定

ビルド時の設定はリポジトリルートの `build.config.*.json` にあり、次の順序でマージされます：

```
build.config.json → build.config.${BUILD_ENV}.json → build.config.local.json
```

サンプルをコピーして始めてください：

```bash
cp build.config.example.json build.config.local.json
```

最も重要な設定は `cloudApiUrl` で、アプリが接続する TeamClu Cloud API のデプロイ先を指定します：

```json
{
  "cloudApiUrl": "https://api.teamclu-dev.ucar.cc",
  "features": {
    "channels": { "discord": true, "feishu": true, "email": true }
  }
}
```

`build.config.local.json` は git 管理外です。ローカル開発では `packages/app/.env.local` の `VITE_CLOUD_API_URL` でエンドポイントを上書きすることもできます。変更を反映するには再ビルドしてください。

Cloud API の実装は `services/fc/`（Node.js 20）にあり、Supabase をバックエンドとし、オプションで共有 AI 予算管理のための LiteLLM プロキシを利用します。

## ドキュメント

- [アーキテクチャ](docs/architecture/v2.md) — コンポーネント、トポロジー、データモデル
- [API 契約](docs/openapi/teamclu-api.v1.yaml) — TeamClu Cloud API `/v1`
- [コンテキストマップ](CONTEXT-MAP.md) — リポジトリの境界づけられたコンテキストへの分割
- [コントリビューション](CONTRIBUTING.md) — 開発環境のセットアップ、テスト、リポジトリ構成
- [セキュリティポリシー](SECURITY.md)

## コントリビューション

コントリビューションを歓迎します！詳しくは [コントリビューションガイド](CONTRIBUTING.md) を参照してください。

- 📝 [ドキュメント・翻訳](CONTRIBUTING.md#-documentation--translation-easiest) — 開発環境は不要
- 🐛 [バグ報告](CONTRIBUTING.md#-bug-reports)
- ✨ [機能提案](CONTRIBUTING.md#-feature-suggestions)
- 🔧 [フロントエンド開発](CONTRIBUTING.md#-frontend-development)
- ⚙️ [Rust 開発](CONTRIBUTING.md#-rust-development)

## 技術スタック

- **デスクトップ**: Tauri 2.0 (Rust)
- **デーモン**: Rust (`amuxd`)、ローカルエージェントバックエンド（opencode HTTP など）
- **フロントエンド**: React 19 + TypeScript、Tailwind CSS 4、Zustand
- **iOS**: SwiftUI + SwiftPM (`AMUXCore`)
- **エディター**: Tiptap（Markdown / HTML）、CodeMirror 6（コード）、Shiki（ハイライト）

## License

MIT
