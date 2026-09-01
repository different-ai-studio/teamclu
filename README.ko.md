# TeamClu

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![CI](https://github.com/different-ai-studio/teamclu/actions/workflows/ci.yml/badge.svg)](https://github.com/different-ai-studio/teamclu/actions)
[![Contributors](https://img.shields.io/github/contributors/different-ai-studio/teamclu.svg)](https://github.com/different-ai-studio/teamclu/graphs/contributors)

로컬 AI 에이전트 — 모든 직무를 위한 당신의 AI 파트너

> **당신의 파트너, 함께.**

- **👥 팀을 위한 설계** — Skills, 지식 베이스, MCP 설정을 팀 전체에서 공유하면서도, 구성원별 개인 컨텍스트는 그대로 유지
- **🎭 Skills × 역할** — 조합 가능한 역할 라이브러리로 동일한 에이전트를 영업·지원·운영·엔지니어링 등 팀에 필요한 어떤 직무에도 특화
- **🔋 기본 탑재** — 팀 지식 베이스, Auto UI 이해, 음성 인식(STT), 6 개 채널 게이트웨이(WeCom, Feishu, Discord, Kook, WeChat, Email) 내장. 글루 코드 불필요
- **🧑‍💻 개인 개발자부터 중소기업까지** — 로컬 우선, 기본 비공개; 1 인 사용자부터 소규모 기업까지 확장 가능

[English](README.md) | [简体中文](README.zh-CN.md) | [繁體中文](README.zh-TW.md) | [日本語](README.ja.md) | 한국어 | [Bahasa Indonesia](README.id.md)

## 스크린샷

| 홈 | 채널 |
|---|---|
| ![TeamClu Home](images/home.png) | ![TeamClu Channels](images/channel.png) |

## 주요 기능

- **3단 워크스페이스** — 사이드바, 채팅, 상세 패널
- **로컬 에이전트 런타임** — 에이전트가 사용자 머신에서 실행되며, `amuxd` 데몬이 호스팅
- **채널 게이트웨이** — Discord, Feishu, Email, Kook, WeCom, WeChat 에서 에이전트에 접근
- **자동화** — cron 을 통한 예약 작업
- **팀 협업** — S3 호환 오브젝트 스토리지로 팀 지식 베이스와 문서를 동기화. [팀 협업](#팀-협업) 참조
- **MCP 지원** — Model Context Protocol 을 통해 에이전트를 엔터프라이즈 시스템에 연결
- **Skills / 플러그인** — 워크스페이스 수준 및 전역 스킬 소스로 에이전트 확장
- **지식 베이스** — 팀 전체에 동기화되는 Markdown 지식 베이스, 경로 단위 ACL 과 버전 기록 지원
- **내장 에디터** — Markdown 및 HTML(Tiptap), 코드(CodeMirror 6), 에이전트 우선 diff 리뷰어
- **로컬 파일 작업** — 작업 단위 권한 관리 지원

## 동작 방식

TeamClu 는 클라이언트 계층, 에이전트 호스트, 클라우드 백엔드로 나뉩니다:

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

- **클라이언트**는 UI 와 로컬 파일을 담당합니다. TeamClu Desktop 을 설치하면 `amuxd` 데몬도 함께 설치되므로, 사용자의 머신이 곧바로 에이전트 호스트가 됩니다.
- **amuxd**는 로컬 에이전트 백엔드를 호스팅하고, 채널 게이트웨이를 실행하며, 팀 동기화를 담당합니다. GUI 없이 서버에 단독으로 설치할 수도 있습니다.
- **Cloud API**(`/v1`)는 클라이언트가 통신하는 유일한 백엔드입니다. 계약은 [`docs/openapi/teamclu-api.v1.yaml`](docs/openapi/teamclu-api.v1.yaml), 전체 아키텍처는 [`docs/architecture/v2.md`](docs/architecture/v2.md) 를 참조하세요.

## 클라이언트

| 클라이언트 | 경로 | 상태 |
|---|---|---|
| **Desktop** (macOS / Windows / Linux) | `apps/desktop/` + `packages/app/` | 주력 클라이언트 |
| **iOS** | `apps/ios/` | 네이티브 SwiftUI, TestFlight로 배포 |
| **Mobile** (iOS / Android) | `apps/expo/` | Expo; 온보딩 및 세션 |
| **Chrome 확장 프로그램** | `apps/extension/` | MV3 |

## 설치

[GitHub Releases](https://github.com/different-ai-studio/teamclu/releases)에서 플랫폼별 설치 프로그램을 다운로드하세요 — macOS 는 `.dmg`, Windows 는 `.exe`.

### macOS "손상됨" 경고

macOS 가 앱이 **"손상됨"** 또는 **"개발자를 확인할 수 없어 열 수 없습니다"** 라고 표시한다면, 이는 서명되지 않은 다운로드에 대해 Gatekeeper 가 반응하는 것입니다. 격리 속성을 해제하세요:

```bash
xattr -cr /Applications/TeamClu.app
```

Apple 개발자 인증서로 서명 및 공증된 빌드에서는 이 단계가 필요하지 않습니다.

## 빠른 시작 (개발)

**필수 요구 사항:** Node.js >= 20, pnpm >= 10, Rust >= 1.70

```bash
pnpm install
pnpm tauri:dev
```

시작한 후 TeamClu UI 에서 워크스페이스 디렉토리를 선택하세요.

개발 중 최초 실행 마법사를 건너뛰려면:

```bash
pnpm tauri:dev -- --skip-setup --skip-daemon-onboarding
```

프론트엔드만 실행하려면(Rust 빌드 없음) `pnpm dev` 를 사용하세요. 빌드 명령어, 공유 Rust 빌드 캐시, 테스트 스위트, 리포지토리 구조는 [기여 가이드](CONTRIBUTING.md)에서 다룹니다.

## 팀 협업

팀이 공유하는 것은 몇 개의 전용 디렉터리이며, 워크스페이스 전체가 아닙니다. 동기화는 S3 호환 오브젝트 스토리지(Alibaba OSS / WebDAV)를 통해 이루어지며, Git 모드는 없습니다.

동기화는 `amuxd` 데몬이 담당합니다. 팀마다 `~/.amuxd/teams/<team_id>/` 아래에 글로벌 복사본을 두고, 연결된 각 워크스페이스는 동기화되는 디렉터리를 심볼릭 링크로 노출합니다.

### 공유 대상

동기화되는 디렉터리만 머신을 벗어나며, 워크스페이스의 나머지 내용은 로컬에 남습니다:

- `team-knowledge/` — 팀 지식 베이스
- `team-documents/` — 팀 문서(소유자가 있으며 접근을 제한할 수 있음)

팀 스킬과 팀 MCP 서버는 더 이상 이 트리를 통하지 않습니다. 스킬은 스킬 레지스트리에서, MCP 서버와 팀 환경 변수는 Cloud API 에서 옵니다.

### 참고 사항

- 동기화는 앱 시작 시 실행되며, 사이드바의 팀 공유 컬럼에서 수동으로 트리거할 수 있습니다.
- 충돌도 그곳에 표시되며 메인 패널에서 해결합니다.

## 설정

빌드 타임 설정은 리포지토리 루트의 `build.config.*.json` 에 있으며, 다음 순서로 병합됩니다:

```
build.config.json → build.config.${BUILD_ENV}.json → build.config.local.json
```

예제 파일을 복사해 시작하세요:

```bash
cp build.config.example.json build.config.local.json
```

핵심 설정은 `cloudApiUrl` 로, 앱이 바라볼 TeamClu Cloud API 배포를 지정합니다:

```json
{
  "cloudApiUrl": "https://api.teamclu-dev.ucar.cc",
  "features": {
    "channels": { "discord": true, "feishu": true, "email": true }
  }
}
```

`build.config.local.json` 은 git 에서 무시됩니다. 로컬 개발에서는 `packages/app/.env.local` 의 `VITE_CLOUD_API_URL` 로 엔드포인트를 재정의할 수도 있습니다. 변경 사항을 적용하려면 다시 빌드하세요.

Cloud API 구현은 `services/fc/` (Node.js 20)에 있으며, Supabase 를 백엔드로 사용하고 선택적으로 공유 AI 예산 관리를 위한 LiteLLM 프록시를 사용합니다.

## 문서

- [아키텍처](docs/architecture/v2.md) — 구성 요소, 토폴로지, 데이터 모델
- [API 계약](docs/openapi/teamclu-api.v1.yaml) — TeamClu Cloud API `/v1`
- [컨텍스트 맵](CONTEXT-MAP.md) — 리포지토리가 바운디드 컨텍스트로 나뉘는 방식
- [기여 가이드](CONTRIBUTING.md) — 개발 환경 설정, 테스트, 리포지토리 구조
- [보안 정책](SECURITY.md)

## 기여

기여를 환영합니다! 자세한 내용은 [기여 가이드](CONTRIBUTING.md)를 참조하세요.

- 📝 [문서 및 번역](CONTRIBUTING.md#-documentation--translation-easiest) — 개발 환경 불필요
- 🐛 [버그 리포트](CONTRIBUTING.md#-bug-reports)
- ✨ [기능 제안](CONTRIBUTING.md#-feature-suggestions)
- 🔧 [프론트엔드 개발](CONTRIBUTING.md#-frontend-development)
- ⚙️ [Rust 개발](CONTRIBUTING.md#-rust-development)

## 기술 스택

- **데스크톱**: Tauri 2.0 (Rust)
- **데몬**: Rust (`amuxd`), 로컬 에이전트 백엔드(opencode HTTP 등)
- **프론트엔드**: React 19 + TypeScript, Tailwind CSS 4, Zustand
- **iOS**: SwiftUI + SwiftPM (`AMUXCore`)
- **에디터**: Tiptap (Markdown / HTML), CodeMirror 6 (코드), Shiki (구문 강조)

## License

MIT
